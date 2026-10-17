import { createHash } from "node:crypto";
import { TENANT_NAMESPACE_PREFIX, RUNTIME_AUDIENCE } from "@osiris/platform/runtime-identity.ts";
import type { KubeObject } from "./kube.ts";

export const TENANT_LABEL = "osiris.k6labs.cz/tenant";
export const SITE_LABEL = "osiris.k6labs.cz/site";
export const RUNTIME_PORT = 8080;

export interface TenantResource extends KubeObject {
  metadata: KubeObject["metadata"] & { uid?: string; generation?: number; deletionTimestamp?: string; finalizers?: string[]; creationTimestamp?: string };
  spec: {
    displayName: string;
    suspended?: boolean;
    idleMinutes?: number;
    storageGi?: number;
    domains?: string[];
    wakeRequestedAt?: string;
  };
  status?: {
    phase?: "Sleeping" | "Running" | "Suspended";
    sleptAt?: string;
    lastActivity?: string;
    message?: string;
  };
}

/** What the operator puts into every tenant: images, where services live, shared settings and keys. */
export interface OperatorSettings {
  /** Namespace of the shared services (gateway, control, operator, sites, gotenberg). */
  namespace: string;
  runtimeImage: string;
  imagePullSecret?: { dockerconfigjson: string };
  storageClass: string;
  controlUrl: string;
  gotenbergUrl?: string;
  internalPublicKey: string;
  /** Plain settings for every runtime (model, time zone). */
  runtimeEnv: Record<string, string>;
  /** Provider API keys for every runtime. */
  runtimeSecrets: Record<string, string>;
  /** The tenant's own key for sealing secrets. */
  tenantSecretsKey: (tenant: string) => string;
  sites: { service: string; port: number; clusterIssuer: string; ingressClass: string; middleware?: string };
}

export const namespaceOf = (tenant: string) => `${TENANT_NAMESPACE_PREFIX}${tenant}`;
const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/** Cluster-internal and link-local ranges the runtime must not reach (API server, pods, nodes, metadata). */
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"];

/** Everything in the tenant's namespace, given whether the runtime should run now. */
export function tenantResources(t: TenantResource, s: OperatorSettings, replicas: 0 | 1): KubeObject[] {
  const id = t.metadata.name;
  const ns = namespaceOf(id);
  const storageGi = t.spec.storageGi ?? 5;
  const labels = { [TENANT_LABEL]: id, "app.kubernetes.io/managed-by": "osiris-operator" };
  const meta = (name: string, extra: Record<string, unknown> = {}) => ({ name, namespace: ns, labels, ...extra });

  const config: Record<string, string> = {
    NODE_ENV: "production",
    TENANT_ID: id,
    DATA_DIR: "/data",
    PORT: String(RUNTIME_PORT),
    CONTROL_URL: s.controlUrl,
    INTERNAL_JWT_PUBLIC_KEY: s.internalPublicKey,
    // Files may use most of the volume; the database needs the rest.
    FILES_QUOTA_MB: String(Math.floor(storageGi * 1024 * 0.8)),
    ...(s.gotenbergUrl ? { GOTENBERG_URL: s.gotenbergUrl } : {}),
    ...s.runtimeEnv,
  };
  const secret: Record<string, string> = { TENANT_SECRETS_KEY: s.tenantSecretsKey(id), ...s.runtimeSecrets };
  // A change of settings or keys restarts the runtime.
  const configHash = short(JSON.stringify([config, secret, s.runtimeImage]));

  const objects: KubeObject[] = [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: ns,
        labels: {
          ...labels,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "latest",
        },
      },
    },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta("runtime"), automountServiceAccountToken: false },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta("runtime-config"), data: config },
    { apiVersion: "v1", kind: "Secret", metadata: meta("runtime-env"), type: "Opaque", stringData: secret },
    ...(s.imagePullSecret
      ? [{ apiVersion: "v1", kind: "Secret", metadata: meta("image-pull"), type: "kubernetes.io/dockerconfigjson", data: { ".dockerconfigjson": s.imagePullSecret.dockerconfigjson } }]
      : []),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta("runtime"),
      spec: { selector: { app: "runtime" }, ports: [{ name: "http", port: RUNTIME_PORT, targetPort: "http" }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: meta("runtime"),
      spec: {
        replicas,
        serviceName: "runtime",
        selector: { matchLabels: { app: "runtime" } },
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        template: {
          metadata: { labels: { app: "runtime", ...labels }, annotations: { "osiris.k6labs.cz/config": configHash } },
          spec: {
            serviceAccountName: "runtime",
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            terminationGracePeriodSeconds: 60,
            ...(s.imagePullSecret ? { imagePullSecrets: [{ name: "image-pull" }] } : {}),
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "runtime",
                image: s.runtimeImage,
                // Images follow a moving tag; a runtime picks up the new one whenever it wakes.
                imagePullPolicy: "Always",
                ports: [{ name: "http", containerPort: RUNTIME_PORT }],
                envFrom: [{ configMapRef: { name: "runtime-config" } }, { secretRef: { name: "runtime-env" } }],
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
                readinessProbe: { httpGet: { path: "/health", port: "http" }, periodSeconds: 2, failureThreshold: 3 },
                livenessProbe: { httpGet: { path: "/health", port: "http" }, initialDelaySeconds: 60, periodSeconds: 30 },
                resources: { requests: { cpu: "50m", memory: "256Mi" }, limits: { memory: "1Gi" } },
                volumeMounts: [
                  { name: "data", mountPath: "/data" },
                  { name: "tmp", mountPath: "/tmp" },
                  { name: "control-token", mountPath: "/var/run/secrets/osiris", readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
              // Proves the tenant to control (TokenReview); usable for nothing else.
              {
                name: "control-token",
                projected: { sources: [{ serviceAccountToken: { audience: RUNTIME_AUDIENCE, expirationSeconds: 3600, path: "token" } }] },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data", labels },
            spec: { accessModes: ["ReadWriteOnce"], storageClassName: s.storageClass, resources: { requests: { storage: `${storageGi}Gi` } } },
          },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta("default-deny"),
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta("runtime"),
      spec: {
        podSelector: { matchLabels: { app: "runtime" } },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": s.namespace } },
                podSelector: { matchExpressions: [{ key: "app", operator: "In", values: ["gateway", "control", "operator"] }] },
              },
            ],
            ports: [{ port: RUNTIME_PORT, protocol: "TCP" }],
          },
        ],
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
            ports: [{ port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" }],
          },
          {
            to: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": s.namespace } },
                podSelector: { matchExpressions: [{ key: "app", operator: "In", values: ["control", "gotenberg"] }] },
              },
            ],
          },
          // The internet (model APIs, MCP servers, http_request), but nothing inside the cluster or its network.
          { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: PRIVATE } }] },
        ],
      },
    },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: meta("tenant"),
      spec: { hard: { pods: "2", persistentvolumeclaims: "1", "requests.storage": `${storageGi}Gi`, "limits.memory": "2Gi", "services.loadbalancers": "0", "services.nodeports": "0" } },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: meta("defaults"),
      spec: { limits: [{ type: "Container", default: { memory: "1Gi" }, defaultRequest: { cpu: "50m", memory: "256Mi" } }] },
    },
  ];
  return objects;
}

/** Ingresses (in the shared namespace, in front of the sites service) for the tenant's verified domains. */
export function siteIngresses(t: TenantResource, s: OperatorSettings): KubeObject[] {
  const id = t.metadata.name;
  return (t.spec.domains ?? []).map((domain) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: `site-${id}-${short(domain)}`,
      namespace: s.namespace,
      labels: { [TENANT_LABEL]: id, [SITE_LABEL]: "true", "app.kubernetes.io/managed-by": "osiris-operator" },
      annotations: {
        "cert-manager.io/cluster-issuer": s.sites.clusterIssuer,
        "traefik.ingress.kubernetes.io/router.entrypoints": "web,websecure",
        ...(s.sites.middleware ? { "traefik.ingress.kubernetes.io/router.middlewares": s.sites.middleware } : {}),
      },
    },
    spec: {
      ingressClassName: s.sites.ingressClass,
      rules: [{ host: domain, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: s.sites.service, port: { number: s.sites.port } } } }] } }],
      tls: [{ hosts: [domain], secretName: `site-tls-${short(domain)}` }],
    },
  }));
}
