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
	appsv1 "k8s.io/api/apps/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"

	osirisv1alpha1 "github.com/osiris-ide/osiris/operator/api/v1alpha1"
)

const (
	workspaceMountPath = "/workspaces"
	sessionLabelKey    = "osiris.dev/session"
	projectLabelKey    = "osiris.dev/project"
)

// pvcName, deploymentName, and leaseName derive the owned child object names
// from the session's own name so a reconcile can always look them up
// deterministically, independent of status.{workloadRef,pvcRef,leaseRef}.
func pvcName(session *osirisv1alpha1.OsirisSession) string {
	return "sess-" + session.Name + "-workspace"
}

func deploymentName(session *osirisv1alpha1.OsirisSession) string {
	return "sess-" + session.Name
}

func leaseName(session *osirisv1alpha1.OsirisSession) string {
	return "sess-" + session.Name + "-activity"
}

func sessionLabels(session *osirisv1alpha1.OsirisSession) map[string]string {
	return map[string]string{
		sessionLabelKey: session.Name,
		projectLabelKey: session.Spec.ProjectRef,
	}
}

// buildPVC returns the desired PersistentVolumeClaim for a session. Callers
// must only Create() this once — its fields (size, storage class) are never
// reconciled again, so the workspace volume survives every later scale-to-0.
func buildPVC(session *osirisv1alpha1.OsirisSession, project *osirisv1alpha1.OsirisProject) *corev1.PersistentVolumeClaim {
	size := session.Spec.WorkspaceSize
	if size == "" {
		size = project.Spec.DefaultWorkspaceSize
	}
	if size == "" {
		size = "5Gi"
	}

	return &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pvcName(session),
			Namespace: session.Namespace,
			Labels:    sessionLabels(session),
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(size),
				},
			},
			StorageClassName: project.Spec.StorageClassName,
		},
	}
}

// buildLease returns the desired activity heartbeat Lease for a session,
// initialized to "active right now" at creation time. osiris-server bumps
// spec.renewTime on every subsequent user interaction; the controller reads
// it back to decide whether the session has gone idle.
func buildLease(session *osirisv1alpha1.OsirisSession, now metav1.MicroTime) *coordinationv1.Lease {
	holder := session.Name
	return &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{
			Name:      leaseName(session),
			Namespace: session.Namespace,
			Labels:    sessionLabels(session),
		},
		Spec: coordinationv1.LeaseSpec{
			HolderIdentity: &holder,
			RenewTime:      &now,
		},
	}
}

// buildDeployment returns the desired Deployment for a session, running the
// project's devContainer image at the given replica count (0 = suspended,
// 1 = running). A Deployment (not a StatefulSet) is used deliberately: this
// is a strictly single-replica scale-to-0/1 pattern with no need for stable
// per-ordinal identity, and the operator wants to own the PVC directly,
// independent of and outliving the Deployment's own create/delete cycle.
func buildDeployment(session *osirisv1alpha1.OsirisSession, project *osirisv1alpha1.OsirisProject, replicas int32) *appsv1.Deployment {
	dc := project.Spec.DevContainer
	port := dc.Port
	if port == 0 {
		port = 8000
	}

	labels := sessionLabels(session)

	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      deploymentName(session),
			Namespace: session.Namespace,
			Labels:    labels,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr.To(replicas),
			Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:      "devcontainer",
							Image:     dc.Image,
							Command:   dc.Command,
							Args:      dc.Args,
							Env:       dc.Env,
							Resources: dc.Resources,
							Ports: []corev1.ContainerPort{
								{ContainerPort: port},
							},
							VolumeMounts: []corev1.VolumeMount{
								{Name: "workspace", MountPath: workspaceMountPath},
							},
						},
					},
					Volumes: []corev1.Volume{
						{
							Name: "workspace",
							VolumeSource: corev1.VolumeSource{
								PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
									ClaimName: pvcName(session),
								},
							},
						},
					},
				},
			},
		},
	}
}
