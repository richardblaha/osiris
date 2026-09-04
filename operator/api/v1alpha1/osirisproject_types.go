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
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// DevContainerSpec is the built, ready-to-run image for a project's `.dev`
// container. The operator never builds images itself: osiris-server (or CI)
// builds and pushes the image via the existing devcontainer tooling and sets
// Image before a session of this project can go Running.
type DevContainerSpec struct {
	// image is the fully-qualified, already-pushed image ref.
	// +required
	Image string `json:"image"`

	// command overrides the image entrypoint.
	// +optional
	Command []string `json:"command,omitempty"`

	// args are appended after command.
	// +optional
	Args []string `json:"args,omitempty"`

	// port is the port the in-container web-ide / agent process listens on.
	// +kubebuilder:default=8000
	// +optional
	Port int32 `json:"port,omitempty"`

	// env is injected into the pod's single container.
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// resources for the pod's single container.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`
}

// OsirisProjectSpec defines the desired state of OsirisProject.
type OsirisProjectSpec struct {
	// path is the project's source location (host bind path or git URL).
	// Informational for the pod's init step; not interpreted by the operator.
	// +required
	Path string `json:"path"`

	// devContainer is the pod template source for every session of this project.
	// +required
	DevContainer DevContainerSpec `json:"devContainer"`

	// idleTimeoutSeconds is the project-level default idle timeout, overriding
	// the operator's global default. A session may still override this further
	// via OsirisSession.spec.idleTimeoutOverrideSeconds.
	// +optional
	IdleTimeoutSeconds *int32 `json:"idleTimeoutSeconds,omitempty"`

	// defaultWorkspaceSize is the PVC size new sessions of this project get
	// unless they override it.
	// +kubebuilder:default="5Gi"
	// +optional
	DefaultWorkspaceSize string `json:"defaultWorkspaceSize,omitempty"`

	// storageClassName for session PVCs. Empty means the cluster default.
	// +optional
	StorageClassName *string `json:"storageClassName,omitempty"`
}

// OsirisProjectStatus defines the observed state of OsirisProject.
type OsirisProjectStatus struct {
	// sessionCount is a best-effort convenience counter, updated by the
	// OsirisSession controller (not this one) — not authoritative.
	// +optional
	SessionCount int32 `json:"sessionCount,omitempty"`

	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=oproj
// +kubebuilder:validation:XValidation:rule="self.metadata.name.matches('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')",message="project name must be a valid RFC1123 label"
// +kubebuilder:printcolumn:name="Path",type=string,JSONPath=`.spec.path`
// +kubebuilder:printcolumn:name="Image",type=string,JSONPath=`.spec.devContainer.image`

// OsirisProject is the Schema for the osirisprojects API. Its metadata.name
// IS the project's unique name — the API server already guarantees
// uniqueness for free, so "register a project" is a plain Create() call that
// naturally 409s on a duplicate name.
type OsirisProject struct {
	metav1.TypeMeta `json:",inline"`

	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// +required
	Spec OsirisProjectSpec `json:"spec"`

	// +optional
	Status OsirisProjectStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// OsirisProjectList contains a list of OsirisProject.
type OsirisProjectList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []OsirisProject `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &OsirisProject{}, &OsirisProjectList{})
		return nil
	})
}
