import { generateKeyPairSync, randomBytes } from "node:crypto";
import { DashboardStore } from "../src/dashboards.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "@osiris/shared";
import { CONTROL_AUDIENCE, generateInternalKeys, InternalSigner, InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { FsObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate } from "@osiris/platform/rqlite.ts";
import { RuntimeClient } from "@osiris/platform/runtime-client.ts";
import { devRuntimeVerifier } from "@osiris/platform/runtime-identity.ts";
import { createControlApp } from "../src/app.ts";
import { Backups } from "../src/backups.ts";
import type { Orchestrator, ProjectSpec, ProjectStatus } from "../src/orchestrator/types.ts";
import { ScheduleStore } from "../src/scheduler.ts";
import { ProjectDirectory, ProjectStore } from "../src/projects.ts";
import { createAuthDeps } from "../src/auth/index.ts";
import type { Mailer } from "../src/auth/mail.ts";
import type { SocialClient, SocialProviderId } from "../src/auth/social.ts";
import { dbUsers, type UserRecord } from "../src/users.ts";
import { WhatsAppClient } from "../src/whatsapp/cloud-api.ts";
import { Inbox } from "../src/whatsapp/inbox.ts";
import { PhoneVerification } from "../src/whatsapp/phones.ts";

export const tempDir = (prefix = "osiris-control-") => mkdtempSync(join(tmpdir(), prefix));
export const keys = await generateInternalKeys();
export const MIGRATIONS = join(import.meta.dirname, "../src/db/migrations");
export const SIGNING_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
export const PUBLIC_URL = "http://osiris.test";

export async function createTestDb() {
  const db = new LocalDb(join(tempDir(), "control.db"));
  await migrate(db, MIGRATIONS);
  return db;
}

/** Records what control asks of the cluster. */
export class FakeOrchestrator implements Orchestrator {
  applied = new Map<string, ProjectSpec>();
  woken: string[] = [];
  async apply(spec: ProjectSpec) {
    this.applied.set(spec.id, spec);
  }
  async wake(id: string) {
    this.woken.push(id);
  }
  endpoint(id: string) {
    return `http://runtime-${id}`;
  }
  async statuses() {
    return new Map([...this.applied.values()].map((s): [string, ProjectStatus] => [s.id, { phase: s.suspended ? "Suspended" : this.woken.includes(s.id) ? "Running" : "Sleeping" }]));
  }
}

export type RuntimeHandler = (project: string, path: string, init: RequestInit) => Response | Promise<Response>;

/** All of control over a temp database and folder, with fakes for the cluster, runtimes and WhatsApp. */
export async function createTestControl(
  options: {
    users?: Partial<UserRecord>[];
    runtime?: RuntimeHandler;
    social?: Partial<Record<SocialProviderId, SocialClient>>;
    socialFetch?: typeof fetch;
  } = {},
) {
  const db = await createTestDb();
  const orchestrator = new FakeOrchestrator();
  const objects = new FsObjectStore(tempDir("osiris-objects-"));
  const users = dbUsers(db, { objects, publicUrl: PUBLIC_URL });
  for (const u of options.users ?? []) {
    await users.create({ id: u.id, email: u.email ?? null, firstName: u.firstName ?? u.name ?? "", lastName: u.lastName ?? "", claims: u.claims, disabled: u.disabled });
  }
  const mail: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = { send: async (m) => void mail.push(m) };
  const auth = await createAuthDeps({
    db,
    users,
    publicUrl: PUBLIC_URL,
    secret: randomBytes(32).toString("base64"),
    signingKeyPem: SIGNING_KEY,
    socialClients: options.social,
    fetchFn: options.socialFetch,
    mailer,
  });
  const store = new ProjectStore(db, { objects, publicUrl: PUBLIC_URL });
  const directory = new ProjectDirectory(store, users, orchestrator);
  const runtimeCalls: { project: string; path: string; init: RequestInit }[] = [];
  let runtime: RuntimeHandler = options.runtime ?? (() => Response.json({}));
  const runtimeFetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const project = u.hostname.replace(/^runtime-/, "");
    if (u.pathname === "/health") return Response.json({ ok: true });
    runtimeCalls.push({ project, path: u.pathname + u.search, init });
    return runtime(project, u.pathname + u.search, init);
  }) as unknown as typeof fetch;
  const runtimes = new RuntimeClient({ endpoint: async (t) => orchestrator.endpoint(t), wake: (t) => orchestrator.wake(t) }, { fetchFn: runtimeFetch, wakeTimeoutMs: 2000 });
  const schedules = new ScheduleStore(db, "Europe/Prague");
  const backups = new Backups(db, objects, 30);
  const phones = new PhoneVerification(db, users);
  const inbox = new Inbox(db);
  const sent: { to: string; text?: string; status?: string; from: string }[] = [];
  const graphFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ to: body.to, text: body.text?.body, status: body.status, from: url.split("/").at(-2)! });
    return new Response("{}");
  }) as typeof fetch;
  const whatsappClient = new WhatsAppClient("token", graphFetch);
  const signer = new InternalSigner(keys.privateKey, "control");
  const snapshots: string[] = [];

  const app = createControlApp({
    verifier: new InternalVerifier(keys.publicKey, ["gateway"]),
    runtimeIdentity: devRuntimeVerifier(),
    directory,
    users,
    orchestrator,
    schedules,
    backups,
    phones,
    snapshot: async (t) => void snapshots.push(t),
    auth,
    dashboards: new DashboardStore(db),
    whatsapp: { inbox, verifyToken: "verify-me", appSecret: "app-secret", displayNumber: "+420 600 000 000" },
  });

  const gateway = new InternalSigner(keys.privateKey, "gateway");
  /** A user call as the gateway sends it: the user, their memberships and the active project. */
  const asUser = (sub: string, memberships: { projectId: string; role: Role }[] = [], options: { systemAdmin?: boolean; project?: string } = {}) =>
    async (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, {
        ...init,
        headers: {
          authorization: await gateway.header(CONTROL_AUDIENCE, {
            user: { sub, name: sub, email: `${sub}@example.cz`, phone: null, picture: null },
            memberships,
            systemAdmin: options.systemAdmin ?? false,
          }),
          "content-type": "application/json",
          ...(options.project ?? memberships[0]?.projectId ? { "x-project-id": options.project ?? memberships[0]!.projectId } : {}),
          ...(init.headers as Record<string, string>),
        },
      });
  const asRuntime = (project: string) => (path: string, init: RequestInit = {}) =>
    app.request(`/internal/runtime${path}`, { ...init, headers: { authorization: `Bearer dev-runtime:${project}`, "content-type": "application/json", ...(init.headers as Record<string, string>) } });

  return {
    app,
    db,
    orchestrator,
    users,
    store,
    directory,
    schedules,
    backups,
    phones,
    inbox,
    objects,
    runtimes,
    runtimeCalls,
    setRuntime: (h: RuntimeHandler) => (runtime = h),
    whatsappClient,
    sent,
    signer,
    snapshots,
    asUser,
    asRuntime,
    auth,
    mail,
  };
}
