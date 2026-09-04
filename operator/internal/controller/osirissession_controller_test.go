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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	osirisv1alpha1 "github.com/osiris-ide/osiris/operator/api/v1alpha1"
)

// markDeploymentReady simulates what a real kubelet + deployment controller
// would eventually do: envtest runs no controllers of its own, so the
// reconciler's "observed replicas" never advances past zero unless a test
// pokes the Deployment's status subresource directly.
func markDeploymentReady(ctx context.Context, name types.NamespacedName, replicas, ready int32) {
	var deploy appsv1.Deployment
	Expect(k8sClient.Get(ctx, name, &deploy)).To(Succeed())
	deploy.Status.Replicas = replicas
	deploy.Status.ReadyReplicas = ready
	Expect(k8sClient.Status().Update(ctx, &deploy)).To(Succeed())
}

// releasePVCProtectionFinalizer simulates the real cluster's PVC-protection
// controller (part of kube-controller-manager), which envtest does not run:
// in a real cluster it removes the "kubernetes.io/pvc-protection" finalizer
// once it observes no Pod references the PVC, letting a Delete complete.
// Without this, a PVC's DeletionTimestamp would stick forever in envtest,
// which is a test-environment artifact, not a bug in the reconciler.
func releasePVCProtectionFinalizer(ctx context.Context, name types.NamespacedName) {
	var pvc corev1.PersistentVolumeClaim
	if err := k8sClient.Get(ctx, name, &pvc); err != nil {
		return
	}
	if pvc.DeletionTimestamp.IsZero() {
		return
	}
	kept := pvc.Finalizers[:0]
	for _, f := range pvc.Finalizers {
		if f != "kubernetes.io/pvc-protection" {
			kept = append(kept, f)
		}
	}
	pvc.Finalizers = kept
	_ = k8sClient.Update(ctx, &pvc)
}

var _ = Describe("OsirisSession Controller", func() {
	const namespace = "default"

	var (
		ctx         context.Context
		projectName string
		sessionName string
		projectKey  types.NamespacedName
		sessionKey  types.NamespacedName
		reconciler  *OsirisSessionReconciler
	)

	BeforeEach(func() {
		ctx = context.Background()
		projectName = "proj"
		sessionName = "sess"

		reconciler = &OsirisSessionReconciler{
			Client:                    k8sClient,
			Scheme:                    k8sClient.Scheme(),
			DefaultIdleTimeoutSeconds: 300,
		}

		project := &osirisv1alpha1.OsirisProject{
			ObjectMeta: metav1.ObjectMeta{Name: projectName, Namespace: namespace},
			Spec: osirisv1alpha1.OsirisProjectSpec{
				Path: "/workspace/demo",
				DevContainer: osirisv1alpha1.DevContainerSpec{
					Image: "example.registry/osiris/demo:latest",
					Port:  8000,
				},
				DefaultWorkspaceSize: "1Gi",
			},
		}
		Expect(k8sClient.Create(ctx, project)).To(Succeed())
		projectKey = types.NamespacedName{Name: projectName, Namespace: namespace}

		session := &osirisv1alpha1.OsirisSession{
			ObjectMeta: metav1.ObjectMeta{Name: sessionName, Namespace: namespace},
			Spec: osirisv1alpha1.OsirisSessionSpec{
				ProjectRef:   projectName,
				DesiredPhase: osirisv1alpha1.DesiredPhaseRunning,
			},
		}
		Expect(k8sClient.Create(ctx, session)).To(Succeed())
		sessionKey = types.NamespacedName{Name: sessionName, Namespace: namespace}
	})

	AfterEach(func() {
		session := &osirisv1alpha1.OsirisSession{}
		if err := k8sClient.Get(ctx, sessionKey, session); err == nil {
			_ = k8sClient.Delete(ctx, session)
			pvcKey := types.NamespacedName{Name: pvcName(session), Namespace: namespace}
			for i := 0; i < 10; i++ {
				_, rErr := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
				releasePVCProtectionFinalizer(ctx, pvcKey)
				if err := k8sClient.Get(ctx, sessionKey, session); apierrors.IsNotFound(err) {
					break
				}
				if rErr != nil {
					break
				}
			}
		}
		project := &osirisv1alpha1.OsirisProject{}
		if err := k8sClient.Get(ctx, projectKey, project); err == nil {
			_ = k8sClient.Delete(ctx, project)
		}
	})

	reconcileUntilStable := func() {
		// finalizer-add reconcile, then the "real" reconcile that creates children.
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())
		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())
	}

	It("adds a finalizer and provisions PVC, Lease and a running Deployment", func() {
		reconcileUntilStable()

		var session osirisv1alpha1.OsirisSession
		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(Succeed())
		Expect(session.Finalizers).To(ContainElement(sessionFinalizer))
		Expect(session.Status.PVCRef).To(Equal(pvcName(&session)))
		Expect(session.Status.LeaseRef).To(Equal(leaseName(&session)))
		Expect(session.Status.WorkloadRef).To(Equal(deploymentName(&session)))

		var pvc corev1.PersistentVolumeClaim
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: pvcName(&session), Namespace: namespace}, &pvc)).To(Succeed())

		var deploy appsv1.Deployment
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}, &deploy)).To(Succeed())
		Expect(*deploy.Spec.Replicas).To(Equal(int32(1)))
		Expect(session.Status.Phase).To(Equal(osirisv1alpha1.SessionPhaseResuming))

		markDeploymentReady(ctx, types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}, 1, 1)
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())

		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(Succeed())
		Expect(session.Status.Phase).To(Equal(osirisv1alpha1.SessionPhaseRunning))
		Expect(session.Status.Replicas).To(Equal(int32(1)))
	})

	It("scales the Deployment to zero when explicitly suspended, and back to one on resume", func() {
		reconcileUntilStable()

		var session osirisv1alpha1.OsirisSession
		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(Succeed())
		markDeploymentReady(ctx, types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}, 1, 1)
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())

		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(Succeed())
		session.Spec.DesiredPhase = osirisv1alpha1.DesiredPhaseSuspended
		Expect(k8sClient.Update(ctx, &session)).To(Succeed())

		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())

		var deploy appsv1.Deployment
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}, &deploy)).To(Succeed())
		Expect(*deploy.Spec.Replicas).To(Equal(int32(0)))

		markDeploymentReady(ctx, types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}, 0, 0)
		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(Succeed())
		Expect(session.Status.Phase).To(Equal(osirisv1alpha1.SessionPhaseSuspended))

		// The workspace PVC must survive the suspend.
		var pvc corev1.PersistentVolumeClaim
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: pvcName(&session), Namespace: namespace}, &pvc)).To(Succeed())

		session.Spec.DesiredPhase = osirisv1alpha1.DesiredPhaseRunning
		Expect(k8sClient.Update(ctx, &session)).To(Succeed())
		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}, &deploy)).To(Succeed())
		Expect(*deploy.Spec.Replicas).To(Equal(int32(1)))
	})

	It("auto-suspends an idle session without flipping spec.desiredPhase", func() {
		reconciler.DefaultIdleTimeoutSeconds = 1
		reconcileUntilStable()

		time.Sleep(1100 * time.Millisecond)
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())

		var session osirisv1alpha1.OsirisSession
		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(Succeed())
		Expect(session.Spec.DesiredPhase).To(Equal(osirisv1alpha1.DesiredPhaseRunning))

		var deploy appsv1.Deployment
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}, &deploy)).To(Succeed())
		Expect(*deploy.Spec.Replicas).To(Equal(int32(0)))
	})

	It("deletes the Deployment and PVC and removes the finalizer on rm", func() {
		reconcileUntilStable()

		var session osirisv1alpha1.OsirisSession
		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(Succeed())
		Expect(k8sClient.Delete(ctx, &session)).To(Succeed())

		deployKey := types.NamespacedName{Name: deploymentName(&session), Namespace: namespace}
		pvcKey := types.NamespacedName{Name: pvcName(&session), Namespace: namespace}

		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())
		var deploy appsv1.Deployment
		Expect(k8sClient.Get(ctx, deployKey, &deploy)).To(HaveOccurred())

		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())
		// envtest runs no PVC-protection controller to drop the finalizer a
		// real cluster's admission plugin adds, so simulate it here.
		releasePVCProtectionFinalizer(ctx, pvcKey)
		var pvc corev1.PersistentVolumeClaim
		Expect(k8sClient.Get(ctx, pvcKey, &pvc)).To(HaveOccurred())

		_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: sessionKey})
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, sessionKey, &session)).To(HaveOccurred())
	})
})
