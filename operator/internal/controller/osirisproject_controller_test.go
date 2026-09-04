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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	osirisv1alpha1 "github.com/osiris-ide/osiris/operator/api/v1alpha1"
)

var _ = Describe("OsirisProject Controller", func() {
	Context("When reconciling a resource", func() {
		const (
			resourceName      = "test-resource"
			resourceNamespace = "default"
		)

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: resourceNamespace,
		}
		osirisproject := &osirisv1alpha1.OsirisProject{}

		BeforeEach(func() {
			By("creating the custom resource for the Kind OsirisProject")
			err := k8sClient.Get(ctx, typeNamespacedName, osirisproject)
			if err != nil && errors.IsNotFound(err) {
				resource := &osirisv1alpha1.OsirisProject{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: resourceNamespace,
					},
					Spec: osirisv1alpha1.OsirisProjectSpec{
						Path: "/workspace/demo",
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &osirisv1alpha1.OsirisProject{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			Expect(err).NotTo(HaveOccurred())

			By("Cleanup the specific resource instance OsirisProject")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
		})

		It("reports Ready=False when devContainer.image is unset, then Ready=True once it is set", func() {
			controllerReconciler := &OsirisProjectReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			var project osirisv1alpha1.OsirisProject
			Expect(k8sClient.Get(ctx, typeNamespacedName, &project)).To(Succeed())
			Expect(project.Status.Conditions).To(HaveLen(1))
			Expect(project.Status.Conditions[0].Type).To(Equal("Ready"))
			Expect(project.Status.Conditions[0].Status).To(Equal(metav1.ConditionFalse))
			Expect(project.Status.Conditions[0].Reason).To(Equal("DevContainerImageMissing"))

			project.Spec.DevContainer.Image = "example.registry/osiris/demo:latest"
			Expect(k8sClient.Update(ctx, &project)).To(Succeed())

			_, err = controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			Expect(k8sClient.Get(ctx, typeNamespacedName, &project)).To(Succeed())
			Expect(project.Status.Conditions[0].Status).To(Equal(metav1.ConditionTrue))
			Expect(project.Status.Conditions[0].Reason).To(Equal("DevContainerImageSet"))
		})
	})
})
