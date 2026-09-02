/**
 * Canonical route table for the migration protocol. Kept here so the server and
 * the `osiris-workspace` extension build their URLs from one source.
 */
export const API_BASE = '/api/v1' as const;

export const routes = {
  createSession: () => `${API_BASE}/sessions`,
  session: (id: string) => `${API_BASE}/sessions/${id}`,
  events: (id: string) => `${API_BASE}/sessions/${id}/events`,
  volume: (id: string) => `${API_BASE}/sessions/${id}/volume`,
  leaseRenew: (id: string) => `${API_BASE}/sessions/${id}/lease/renew`,

  handoverPrepare: (id: string) => `${API_BASE}/sessions/${id}/handover/prepare`,
  handoverCommit: (id: string) => `${API_BASE}/sessions/${id}/handover/commit`,
  handoverAbort: (id: string) => `${API_BASE}/sessions/${id}/handover/abort`,
  handoverFinalize: (id: string) => `${API_BASE}/sessions/${id}/handover/finalize`,

  fetchPrepare: (id: string) => `${API_BASE}/sessions/${id}/fetch/prepare`,
  fetchCommit: (id: string) => `${API_BASE}/sessions/${id}/fetch/commit`,
  fetchAbort: (id: string) => `${API_BASE}/sessions/${id}/fetch/abort`,
} as const;

/** Header names the protocol relies on. */
export const headers = {
  lease: 'If-Match',
  leaseNext: 'ETag',
  idempotencyKey: 'Idempotency-Key',
} as const;
