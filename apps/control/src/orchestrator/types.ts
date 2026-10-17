/** What should run for a tenant: the spec of its `Tenant` resource. */
export interface TenantSpec {
  id: string;
  name: string;
  /** Archived tenants: runtime stopped and never woken, data kept. */
  suspended: boolean;
  /** Minutes without activity before the runtime sleeps; 0 = always on. */
  idleMinutes: number;
  storageGb: number;
  /** Verified custom domains of the tenant's sites (the operator creates their ingresses). */
  domains: string[];
}

/** Runs tenant runtimes: the operator through `Tenant` resources in the cluster, child processes locally. */
export interface Orchestrator {
  apply(spec: TenantSpec): Promise<void>;
  /** Asks for the runtime to be started; returns at once. */
  wake(id: string): Promise<void>;
  /** Base URL of the tenant's runtime. */
  endpoint(id: string): string;
  close?(): Promise<void>;
}
