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

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// DesiredPhase is the client-owned intent for a session. The controller
// never writes this field itself except via the finalizer/delete path.
// +kubebuilder:validation:Enum=Running;Suspended
type DesiredPhase string

const (
	DesiredPhaseRunning   DesiredPhase = "Running"
	DesiredPhaseSuspended DesiredPhase = "Suspended"
)

// OsirisSessionSpec defines the desired state of OsirisSession.
type OsirisSessionSpec struct {
	// projectRef names the OsirisProject in the same namespace this session
	// belongs to. Immutable after creation.
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="projectRef is immutable"
	// +required
	ProjectRef string `json:"projectRef"`

	// desiredPhase is what the client wants. Idle-timeout auto-suspend does
	// NOT flip this field — it stays Running to represent "the user hasn't
	// asked to suspend", distinct from the controller's own idle-driven
	// scale-to-0 (see status.phase for the observed state).
	// +kubebuilder:default=Running
	// +optional
	DesiredPhase DesiredPhase `json:"desiredPhase,omitempty"`

	// idleTimeoutOverrideSeconds overrides the project/global default for
	// this session only.
	// +optional
	IdleTimeoutOverrideSeconds *int32 `json:"idleTimeoutOverrideSeconds,omitempty"`

	// workspaceSize for this session's PVC; defaults to the project's
	// defaultWorkspaceSize if unset.
	// +optional
	WorkspaceSize string `json:"workspaceSize,omitempty"`
}

// SessionPhase is the controller-observed state of a session.
// +kubebuilder:validation:Enum=Pending;Running;Suspending;Suspended;Resuming;Terminating
type SessionPhase string

const (
	SessionPhasePending     SessionPhase = "Pending"
	SessionPhaseRunning     SessionPhase = "Running"
	SessionPhaseSuspending  SessionPhase = "Suspending"
	SessionPhaseSuspended   SessionPhase = "Suspended"
	SessionPhaseResuming    SessionPhase = "Resuming"
	SessionPhaseTerminating SessionPhase = "Terminating"
)

// OsirisSessionStatus defines the observed state of OsirisSession.
type OsirisSessionStatus struct {
	// phase is the controller-observed session state.
	// +optional
	Phase SessionPhase `json:"phase,omitempty"`

	// lastActivityAt mirrors the activity Lease's renewTime for this session,
	// kept here purely for kubectl get/describe visibility. The controller's
	// own idle-timeout math reads the Lease directly, not this field.
	// +optional
	LastActivityAt *metav1.Time `json:"lastActivityAt,omitempty"`

	// workloadRef/pvcRef/leaseRef name the owned child objects.
	// +optional
	WorkloadRef string `json:"workloadRef,omitempty"`
	// +optional
	PVCRef string `json:"pvcRef,omitempty"`
	// +optional
	LeaseRef string `json:"leaseRef,omitempty"`

	// replicas mirrors the underlying Deployment's observed replica count (0 or 1).
	// +optional
	Replicas int32 `json:"replicas,omitempty"`

	// effectiveIdleTimeoutSeconds is the resolved timeout (session override ->
	// project default -> operator flag default) as of the last reconcile.
	// +optional
	EffectiveIdleTimeoutSeconds int32 `json:"effectiveIdleTimeoutSeconds,omitempty"`

	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=osess
// +kubebuilder:printcolumn:name="Project",type=string,JSONPath=`.spec.projectRef`
// +kubebuilder:printcolumn:name="Desired",type=string,JSONPath=`.spec.desiredPhase`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="LastActivity",type=date,JSONPath=`.status.lastActivityAt`

// OsirisSession is the Schema for the osirissessions API.
type OsirisSession struct {
	metav1.TypeMeta `json:",inline"`

	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// +required
	Spec OsirisSessionSpec `json:"spec"`

	// +optional
	Status OsirisSessionStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// OsirisSessionList contains a list of OsirisSession.
type OsirisSessionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []OsirisSession `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &OsirisSession{}, &OsirisSessionList{})
		return nil
	})
}
