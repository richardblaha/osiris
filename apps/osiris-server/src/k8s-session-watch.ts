import type { CustomObjectsApi, KubeConfig, KubernetesObject } from '@kubernetes/client-node';
import { makeInformer } from '@kubernetes/client-node';
import { SESSION_SCHEMA_VERSION, type SessionDescriptor, type SessionPhase } from '@osiris/protocol';
import { createLogger } from '@osiris/shared-core';
import type { SessionStore } from './session-store.js';

const log = createLogger('server:k8s-session-watch');

const GROUP = 'osiris.osiris.dev';
const VERSION = 'v1alpha1';
const PLURAL = 'osirissessions';
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

interface OsirisSessionObject extends KubernetesObject {
  spec: { projectRef: string; idleTimeoutOverrideSeconds?: number };
  status?: { phase?: SessionPhase; lastActivityAt?: string; effectiveIdleTimeoutSeconds?: number; webUrl?: string };
}

function toDescriptor(obj: OsirisSessionObject): SessionDescriptor {
  const createdAt = obj.metadata?.creationTimestamp
    ? new Date(obj.metadata.creationTimestamp).toISOString()
    : new Date().toISOString();
  return {
    sessionId: obj.metadata?.name ?? '',
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
 * Runs one process-wide informer against `OsirisSession` custom resources and
 * fans phase transitions out through the existing per-session `store.publish`
 * mechanism — so every `GET .../events` connection keeps using the same
 * EventEmitter-based subscribe/unsubscribe path regardless of whether the
 * update originated from this process's own executor calls or from the
 * operator reconciling idle-timeout auto-suspend in the background.
 */
export function startSessionWatch(
  kubeConfig: KubeConfig,
  customObjectsApi: CustomObjectsApi,
  namespace: string,
  store: SessionStore,
): { stop: () => Promise<void> } {
  const path = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}`;
  const listFn = async () => {
    const list = await customObjectsApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL,
    });
    return list as { items: OsirisSessionObject[]; metadata?: { resourceVersion?: string } };
  };

  const informer = makeInformer<OsirisSessionObject>(kubeConfig, path, listFn);

  const upsertAndPublish = (obj: OsirisSessionObject): void => {
    const descriptor = toDescriptor(obj);
    if (!descriptor.sessionId) return;
    store.upsert(descriptor);
    store.publish(descriptor.sessionId, {
      type: 'session.phase-changed',
      sessionId: descriptor.sessionId,
      phase: descriptor.phase,
    });
  };

  informer.on('add', upsertAndPublish);
  informer.on('update', upsertAndPublish);
  informer.on('delete', (obj) => {
    const id = obj.metadata?.name;
    if (!id) return;
    store.publish(id, { type: 'session.terminated', sessionId: id });
    store.remove(id);
  });
  informer.on('error', (err) => {
    log.error('informer error: %s', err instanceof Error ? err.message : String(err));
    setTimeout(() => void informer.start(), 5000);
  });

  void informer.start().catch((err: unknown) => {
    log.error('failed to start session informer: %s', err instanceof Error ? err.message : String(err));
  });

  return { stop: () => informer.stop() };
}
