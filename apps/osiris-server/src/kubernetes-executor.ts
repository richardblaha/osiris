import { randomUUID } from 'node:crypto';
import type { CustomObjectsApi, CoordinationV1Api } from '@kubernetes/client-node';
import { SESSION_SCHEMA_VERSION, type CreateSessionRequest, type SessionDescriptor, type SessionPhase } from '@osiris/protocol';
import type { SessionExecutor } from './executors.js';

/** `osiris-kind-operator`'s CRD group/version/plural — see `operator/api/v1alpha1`. */
const GROUP = 'osiris.osiris.dev';
const VERSION = 'v1alpha1';
const PLURAL = 'osirissessions';
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

/** Shape of an `OsirisSession` custom resource, as returned by the API server (untyped `any` on the wire). */
interface OsirisSessionResource {
  metadata: { name: string; namespace: string; creationTimestamp?: string };
  spec: {
    projectRef: string;
    desiredPhase: 'Running' | 'Suspended';
    idleTimeoutOverrideSeconds?: number;
  };
  status?: {
    phase?: SessionPhase;
    lastActivityAt?: string;
    effectiveIdleTimeoutSeconds?: number;
    webUrl?: string;
  };
}

export interface KubernetesSessionExecutorOptions {
  namespace: string;
  customObjectsApi: CustomObjectsApi;
  coordinationApi: CoordinationV1Api;
}

function leaseName(sessionId: string): string {
  return `sess-${sessionId}-activity`;
}

function toDescriptor(obj: OsirisSessionResource): SessionDescriptor {
  const createdAt = obj.metadata.creationTimestamp ?? new Date().toISOString();
  return {
    sessionId: obj.metadata.name,
    schemaVersion: SESSION_SCHEMA_VERSION,
    projectName: obj.spec.projectRef,
    phase: obj.status?.phase ?? 'Pending',
    idleTimeoutSeconds:
      obj.status?.effectiveIdleTimeoutSeconds ??
      obj.spec.idleTimeoutOverrideSeconds ??
      DEFAULT_IDLE_TIMEOUT_SECONDS,
    lastActivityAt: obj.status?.lastActivityAt ?? createdAt,
    createdAt,
    webUrl: obj.status?.webUrl,
  };
}

/**
 * The real session executor: every method maps to a CRUD or JSON-Patch call
 * against the `OsirisSession` custom resource, reconciled by
 * `osiris-kind-operator` (see `operator/internal/controller/osirissession_controller.go`).
 * There is no client-side state here — the cluster is the source of truth.
 *
 * `@kubernetes/client-node`'s object-style `CustomObjectsApi`/`CoordinationV1Api`
 * always negotiate `application/json-patch+json` for patch calls (it's first
 * in their internal media-type preference list), so every mutation below is
 * expressed as an RFC 6902 JSON Patch array, not a merge-patch object.
 */
export class KubernetesSessionExecutor implements SessionExecutor {
  constructor(private readonly options: KubernetesSessionExecutorOptions) {}

  async createSession(input: CreateSessionRequest): Promise<SessionDescriptor> {
    const name = randomUUID();
    const body = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: 'OsirisSession',
      metadata: { name, namespace: this.options.namespace },
      spec: {
        projectRef: input.projectName,
        desiredPhase: 'Running',
        ...(input.idleTimeoutSeconds !== undefined
          ? { idleTimeoutOverrideSeconds: input.idleTimeoutSeconds }
          : {}),
      },
    };
    const created = await this.options.customObjectsApi.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.options.namespace,
      plural: PLURAL,
      body,
    });
    return toDescriptor(created as OsirisSessionResource);
  }

  async getSession(sessionId: string): Promise<SessionDescriptor> {
    const obj = await this.options.customObjectsApi.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.options.namespace,
      plural: PLURAL,
      name: sessionId,
    });
    return toDescriptor(obj as OsirisSessionResource);
  }

  async suspendSession(sessionId: string): Promise<SessionDescriptor> {
    const obj = await this.options.customObjectsApi.patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.options.namespace,
      plural: PLURAL,
      name: sessionId,
      body: [{ op: 'replace', path: '/spec/desiredPhase', value: 'Suspended' }],
    });
    return toDescriptor(obj as OsirisSessionResource);
  }

  /**
   * Flips `spec.desiredPhase` back to Running AND bumps the activity Lease —
   * an idle-suspended session only needs the Lease bump (see
   * {@link reportActivity}), but an explicitly suspended one needs both, so
   * `resume` always does both to cover either case.
   */
  async resumeSession(sessionId: string): Promise<SessionDescriptor> {
    await this.reportActivity(sessionId);
    const obj = await this.options.customObjectsApi.patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.options.namespace,
      plural: PLURAL,
      name: sessionId,
      body: [{ op: 'replace', path: '/spec/desiredPhase', value: 'Running' }],
    });
    return toDescriptor(obj as OsirisSessionResource);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.options.customObjectsApi.deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.options.namespace,
      plural: PLURAL,
      name: sessionId,
    });
  }

  async reportActivity(sessionId: string): Promise<void> {
    await this.options.coordinationApi.patchNamespacedLease({
      name: leaseName(sessionId),
      namespace: this.options.namespace,
      body: [{ op: 'replace', path: '/spec/renewTime', value: new Date().toISOString() }],
    });
  }
}
