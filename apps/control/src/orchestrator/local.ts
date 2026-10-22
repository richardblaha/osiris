import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Orchestrator, TenantSpec, TenantStatus } from "./types.ts";

/**
 * Development stand-in for the operator: each tenant's runtime is a child process on its own port, started on the
 * first wake and stopped when the tenant is suspended. No sleeping, no isolation.
 */
export class LocalOrchestrator implements Orchestrator {
  private readonly ports = new Map<string, number>();
  private readonly running = new Map<string, ChildProcess>();
  private readonly suspended = new Set<string>();

  constructor(
    private readonly options: {
      entry: string;
      dataDir: string;
      basePort: number;
      /** Environment for every runtime (control URL, internal public key, model settings). */
      env: Record<string, string | undefined>;
    },
  ) {}

  async apply(spec: TenantSpec) {
    if (spec.suspended) {
      this.suspended.add(spec.id);
      this.running.get(spec.id)?.kill();
    } else this.suspended.delete(spec.id);
  }

  async statuses() {
    const ids = new Set([...this.running.keys(), ...this.suspended]);
    return new Map(
      [...ids].map((id): [string, TenantStatus] => [id, { phase: this.suspended.has(id) ? "Suspended" : this.running.has(id) ? "Running" : "Sleeping" }]),
    );
  }

  async wake(id: string) {
    if (this.suspended.has(id) || this.running.has(id)) return;
    const dataDir = resolve(this.options.dataDir, id);
    mkdirSync(dataDir, { recursive: true });
    const tsx = createRequire(import.meta.url).resolve("tsx");
    const child = spawn(process.execPath, ["--import", tsx, resolve(this.options.entry)], {
      // The runtime package is the working directory (bundled skills are found relative to it).
      cwd: resolve(dirname(resolve(this.options.entry)), ".."),
      env: { ...process.env, ...this.options.env, TENANT_ID: id, PORT: String(this.port(id)), DATA_DIR: dataDir },
      stdio: ["ignore", "inherit", "inherit"],
    });
    this.running.set(id, child);
    child.on("exit", () => {
      if (this.running.get(id) === child) this.running.delete(id);
    });
  }

  endpoint(id: string) {
    return `http://127.0.0.1:${this.port(id)}`;
  }

  private port(id: string) {
    let port = this.ports.get(id);
    if (!port) this.ports.set(id, (port = this.options.basePort + this.ports.size));
    return port;
  }

  async close() {
    for (const child of this.running.values()) child.kill();
  }
}
