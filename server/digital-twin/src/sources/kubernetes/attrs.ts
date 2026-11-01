/** OpenTelemetry's Kubernetes resource attributes, as the collector's k8sattributes processor sets them. */
export const NAMESPACE_ATTR = "k8s.namespace.name";
export const POD_ATTR = "k8s.pod.name";
export const CONTAINER_ATTR = "k8s.container.name";
export const NODE_ATTR = "k8s.node.name";
export const PVC_ATTR = "k8s.persistentvolumeclaim.name";
/**
 * A node's hardware twins: the node's attribute plus the component (cpu, memory, disk, port), and hostmetrics' own
 * point attributes where they name one part (a core's `cpu`, a disk's `device`); the root filesystem's disk is marked.
 * Never the node's attribute alone, which names the node's own telemetry.
 */
export const HW_ATTR = "hw.component";
export const CPU_ATTR = "cpu";
export const DEVICE_ATTR = "device";
export const ROOT_FS_ATTR = "hw.rootfs";
