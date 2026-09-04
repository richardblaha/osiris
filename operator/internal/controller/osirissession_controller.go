/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	osirisv1alpha1 "github.com/osiris-ide/osiris/operator/api/v1alpha1"
)

// sessionFinalizer gates deletion until the owned Deployment and PVC are
// confirmed gone (the owned Lease is left to ordinary owner-reference
// garbage collection once the OsirisSession itself is removed).
const sessionFinalizer = "osiris.dev/session-cleanup"

// defaultIdleTimeoutSeconds matches the spec's stated 5-minute default and is
// used when neither the session nor its project override it.
const defaultIdleTimeoutSeconds = 300

// OsirisSessionReconciler reconciles a OsirisSession object.
type OsirisSessionReconciler struct {
	client.Client
	Scheme *runtime.Scheme

	// DefaultIdleTimeoutSeconds is the operator-wide fallback idle timeout,
	// used when neither OsirisSession.spec.idleTimeoutOverrideSeconds nor
	// OsirisProject.spec.idleTimeoutSeconds is set. Zero means "use
	// defaultIdleTimeoutSeconds".
	DefaultIdleTimeoutSeconds int32
}

// +kubebuilder:rbac:groups=osiris.osiris.dev,resources=osirissessions,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=osiris.osiris.dev,resources=osirissessions/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=osiris.osiris.dev,resources=osirissessions/finalizers,verbs=update
// +kubebuilder:rbac:groups=osiris.osiris.dev,resources=osirisprojects,verbs=get;list;watch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;delete
// +kubebuilder:rbac:groups=coordination.k8s.io,resources=leases,verbs=get;list;watch;create;update;patch

// Reconcile moves an OsirisSession's owned Deployment/PVC/Lease towards the
// state described by spec.desiredPhase and the session's activity Lease.
func (r *OsirisSessionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var session osirisv1alpha1.OsirisSession
	if err := r.Get(ctx, req.NamespacedName, &session); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !session.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &session)
	}

	if !controllerutil.ContainsFinalizer(&session, sessionFinalizer) {
		controllerutil.AddFinalizer(&session, sessionFinalizer)
		if err := r.Update(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil
	}

	var project osirisv1alpha1.OsirisProject
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.ProjectRef}, &project); err != nil {
		if apierrors.IsNotFound(err) {
			log.Info("project not found, backing off", "projectRef", session.Spec.ProjectRef)
			meta_SetReadyCondition(&session, metav1.ConditionFalse, "ProjectNotFound",
				fmt.Sprintf("OsirisProject %q not found", session.Spec.ProjectRef))
			if statusErr := r.Status().Update(ctx, &session); statusErr != nil {
				return ctrl.Result{}, statusErr
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}

	effectiveTimeout := r.resolveIdleTimeout(&session, &project)

	pvc, err := r.ensurePVC(ctx, &session, &project)
	if err != nil {
		return ctrl.Result{}, err
	}

	lease, err := r.ensureLease(ctx, &session)
	if err != nil {
		return ctrl.Result{}, err
	}

	now := time.Now()
	var idleExpired bool
	var renewTime time.Time
	if lease.Spec.RenewTime != nil {
		renewTime = lease.Spec.RenewTime.Time
		idleExpired = now.Sub(renewTime) >= time.Duration(effectiveTimeout)*time.Second
	}

	wantRunning := session.Spec.DesiredPhase != osirisv1alpha1.DesiredPhaseSuspended && !idleExpired
	targetReplicas := int32(0)
	if wantRunning {
		targetReplicas = 1
	}

	deploy, err := r.ensureDeployment(ctx, &session, &project, targetReplicas)
	if err != nil {
		return ctrl.Result{}, err
	}

	session.Status.WorkloadRef = deploy.Name
	session.Status.PVCRef = pvc.Name
	session.Status.LeaseRef = lease.Name
	session.Status.Replicas = deploy.Status.Replicas
	session.Status.EffectiveIdleTimeoutSeconds = effectiveTimeout
	session.Status.ObservedGeneration = session.Generation
	if lease.Spec.RenewTime != nil {
		mirrored := metav1.NewTime(lease.Spec.RenewTime.Time)
		session.Status.LastActivityAt = &mirrored
	}
	session.Status.Phase = derivePhase(targetReplicas, deploy)
	meta_SetReadyCondition(&session, metav1.ConditionTrue, "Reconciled", "session reconciled")

	if err := r.Status().Update(ctx, &session); err != nil {
		return ctrl.Result{}, err
	}

	if wantRunning && lease.Spec.RenewTime != nil {
		remaining := time.Duration(effectiveTimeout)*time.Second - now.Sub(renewTime)
		if remaining < time.Second {
			remaining = time.Second
		}
		return ctrl.Result{RequeueAfter: remaining}, nil
	}

	return ctrl.Result{}, nil
}

// reconcileDelete drains the owned Deployment and PVC before releasing the
// finalizer — this is precisely what "osiris session rm <id>" means: the
// container, its workspace volume, and (via ordinary owner-reference GC once
// the CR itself is gone) the activity Lease are all removed.
func (r *OsirisSessionReconciler) reconcileDelete(ctx context.Context, session *osirisv1alpha1.OsirisSession) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(session, sessionFinalizer) {
		return ctrl.Result{}, nil
	}

	if session.Status.Phase != osirisv1alpha1.SessionPhaseTerminating {
		session.Status.Phase = osirisv1alpha1.SessionPhaseTerminating
		if err := r.Status().Update(ctx, session); err != nil {
			return ctrl.Result{}, err
		}
	}

	var deploy appsv1.Deployment
	err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: deploymentName(session)}, &deploy)
	switch {
	case err == nil:
		if delErr := r.Delete(ctx, &deploy); delErr != nil && !apierrors.IsNotFound(delErr) {
			return ctrl.Result{}, delErr
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	case !apierrors.IsNotFound(err):
		return ctrl.Result{}, err
	}

	var pvc corev1.PersistentVolumeClaim
	err = r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: pvcName(session)}, &pvc)
	switch {
	case err == nil:
		if delErr := r.Delete(ctx, &pvc); delErr != nil && !apierrors.IsNotFound(delErr) {
			return ctrl.Result{}, delErr
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	case !apierrors.IsNotFound(err):
		return ctrl.Result{}, err
	}

	controllerutil.RemoveFinalizer(session, sessionFinalizer)
	if err := r.Update(ctx, session); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *OsirisSessionReconciler) resolveIdleTimeout(session *osirisv1alpha1.OsirisSession, project *osirisv1alpha1.OsirisProject) int32 {
	if session.Spec.IdleTimeoutOverrideSeconds != nil {
		return *session.Spec.IdleTimeoutOverrideSeconds
	}
	if project.Spec.IdleTimeoutSeconds != nil {
		return *project.Spec.IdleTimeoutSeconds
	}
	if r.DefaultIdleTimeoutSeconds > 0 {
		return r.DefaultIdleTimeoutSeconds
	}
	return defaultIdleTimeoutSeconds
}

// ensurePVC creates the workspace PVC once and never touches it again: its
// size/storage-class are fixed at session creation, which is what makes "the
// FS mount survives suspend" true regardless of how many times the
// Deployment below is scaled to zero and back.
func (r *OsirisSessionReconciler) ensurePVC(ctx context.Context, session *osirisv1alpha1.OsirisSession, project *osirisv1alpha1.OsirisProject) (*corev1.PersistentVolumeClaim, error) {
	var existing corev1.PersistentVolumeClaim
	err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: pvcName(session)}, &existing)
	if err == nil {
		return &existing, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}

	pvc := buildPVC(session, project)
	if err := controllerutil.SetControllerReference(session, pvc, r.Scheme); err != nil {
		return nil, err
	}
	if err := r.Create(ctx, pvc); err != nil && !apierrors.IsAlreadyExists(err) {
		return nil, err
	}
	return pvc, nil
}

// ensureLease creates the activity heartbeat Lease once. It is deliberately
// never updated here — only osiris-server's activity-report calls (and the
// initial "now" at creation) ever change renewTime, so the reconciler's own
// writes can't race with them.
func (r *OsirisSessionReconciler) ensureLease(ctx context.Context, session *osirisv1alpha1.OsirisSession) (*coordinationv1.Lease, error) {
	var existing coordinationv1.Lease
	err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: leaseName(session)}, &existing)
	if err == nil {
		return &existing, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}

	lease := buildLease(session, metav1.NewMicroTime(time.Now()))
	if err := controllerutil.SetControllerReference(session, lease, r.Scheme); err != nil {
		return nil, err
	}
	if err := r.Create(ctx, lease); err != nil && !apierrors.IsAlreadyExists(err) {
		return nil, err
	}
	return lease, nil
}

// ensureDeployment creates the session's Deployment if absent, otherwise
// patches only its replica count when it has drifted from targetReplicas —
// scaling is the entire suspend/resume mechanism, so the Deployment itself
// is never deleted here (only reconcileDelete deletes it, on session removal).
func (r *OsirisSessionReconciler) ensureDeployment(ctx context.Context, session *osirisv1alpha1.OsirisSession, project *osirisv1alpha1.OsirisProject, targetReplicas int32) (*appsv1.Deployment, error) {
	var existing appsv1.Deployment
	err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: deploymentName(session)}, &existing)
	if apierrors.IsNotFound(err) {
		deploy := buildDeployment(session, project, targetReplicas)
		if err := controllerutil.SetControllerReference(session, deploy, r.Scheme); err != nil {
			return nil, err
		}
		if err := r.Create(ctx, deploy); err != nil {
			return nil, err
		}
		return deploy, nil
	}
	if err != nil {
		return nil, err
	}

	if existing.Spec.Replicas == nil || *existing.Spec.Replicas != targetReplicas {
		existing.Spec.Replicas = &targetReplicas
		if err := r.Update(ctx, &existing); err != nil {
			return nil, err
		}
	}
	return &existing, nil
}

// derivePhase folds desiredPhase and idle-expiry (already collapsed into
// targetReplicas by the caller) together with the Deployment's own observed
// rollout state into a single user-facing phase.
func derivePhase(targetReplicas int32, deploy *appsv1.Deployment) osirisv1alpha1.SessionPhase {
	observed := deploy.Status.Replicas
	ready := deploy.Status.ReadyReplicas > 0

	switch {
	case targetReplicas == 0 && observed == 0:
		return osirisv1alpha1.SessionPhaseSuspended
	case targetReplicas == 0 && observed > 0:
		return osirisv1alpha1.SessionPhaseSuspending
	case targetReplicas > 0 && observed >= targetReplicas && ready:
		return osirisv1alpha1.SessionPhaseRunning
	case targetReplicas > 0:
		return osirisv1alpha1.SessionPhaseResuming
	default:
		return osirisv1alpha1.SessionPhasePending
	}
}

// meta_SetReadyCondition is a tiny local helper (kept dependency-free of
// k8s.io/apimachinery/pkg/api/meta's generic condition helpers) that
// upserts a single "Ready" condition by type.
func meta_SetReadyCondition(session *osirisv1alpha1.OsirisSession, status metav1.ConditionStatus, reason, message string) {
	now := metav1.Now()
	for i := range session.Status.Conditions {
		if session.Status.Conditions[i].Type == "Ready" {
			if session.Status.Conditions[i].Status != status {
				session.Status.Conditions[i].LastTransitionTime = now
			}
			session.Status.Conditions[i].Status = status
			session.Status.Conditions[i].Reason = reason
			session.Status.Conditions[i].Message = message
			session.Status.Conditions[i].ObservedGeneration = session.Generation
			return
		}
	}
	session.Status.Conditions = append(session.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: now,
		ObservedGeneration: session.Generation,
	})
}

// SetupWithManager sets up the controller with the Manager.
func (r *OsirisSessionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&osirisv1alpha1.OsirisSession{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Owns(&coordinationv1.Lease{}).
		Named("osirissession").
		Complete(r)
}
