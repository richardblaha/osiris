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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	osirisv1alpha1 "github.com/osiris-ide/osiris/operator/api/v1alpha1"
)

// OsirisProjectReconciler reconciles a OsirisProject object. It is
// deliberately thin: OsirisProject is a passive template read by the
// OsirisSession controller (see osirissession_controller.go), so this
// controller only reports readiness — it never creates or owns any
// workload itself.
type OsirisProjectReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=osiris.osiris.dev,resources=osirisprojects,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=osiris.osiris.dev,resources=osirisprojects/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=osiris.osiris.dev,resources=osirisprojects/finalizers,verbs=update

// Reconcile validates that a project's devContainer image is set and
// reflects that as a Ready condition; it does not provision any resources.
func (r *OsirisProjectReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var project osirisv1alpha1.OsirisProject
	if err := r.Get(ctx, req.NamespacedName, &project); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	status := metav1.ConditionTrue
	reason := "DevContainerImageSet"
	message := "devContainer.image is set"
	if project.Spec.DevContainer.Image == "" {
		status = metav1.ConditionFalse
		reason = "DevContainerImageMissing"
		message = "spec.devContainer.image must be set before any session of this project can run"
		log.Info("project has no devContainer image yet", "project", project.Name)
	}

	now := metav1.Now()
	found := false
	for i := range project.Status.Conditions {
		if project.Status.Conditions[i].Type == "Ready" {
			found = true
			if project.Status.Conditions[i].Status != status {
				project.Status.Conditions[i].LastTransitionTime = now
			}
			project.Status.Conditions[i].Status = status
			project.Status.Conditions[i].Reason = reason
			project.Status.Conditions[i].Message = message
			project.Status.Conditions[i].ObservedGeneration = project.Generation
		}
	}
	if !found {
		project.Status.Conditions = append(project.Status.Conditions, metav1.Condition{
			Type:               "Ready",
			Status:             status,
			Reason:             reason,
			Message:            message,
			LastTransitionTime: now,
			ObservedGeneration: project.Generation,
		})
	}
	project.Status.ObservedGeneration = project.Generation

	if err := r.Status().Update(ctx, &project); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *OsirisProjectReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&osirisv1alpha1.OsirisProject{}).
		Named("osirisproject").
		Complete(r)
}
