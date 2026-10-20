import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { Client } from "@libsql/client";
import { createDb } from "@osiris/core/db/client.ts";
import { migrate } from "@osiris/core/db/migrate.ts";
import type { Skill } from "@osiris/core/agent/skills.ts";
import type { McpConnector } from "@osiris/core/mcp/toolset.ts";
import { openTenant, type Tenant, type TenantDeps } from "@osiris/core/tenants/tenant.ts";
import type { FeatureSource } from "@osiris/core/tenants/features.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { FEATURES, NO_QUOTAS, type Feature, type Guard, type TenantFeatures, type TenantQuotas } from "@osiris/shared";
import { accessFromClaims, membershipsFromClaims, isAuthorized } from "@osiris/platform/claims.ts";
import { generateInternalKeys, InternalSigner, InternalVerifier, tenantAudience } from "@osiris/platform/internal-auth.ts";
import { Activity } from "../src/activity.ts";
import { createRuntimeApp } from "../src/app.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "osiris-test-"));

/** Fresh migrated tenant database in a temp file (libSQL `:memory:` loses data across transactions). */
export async function createTestDb(): Promise<Client> {
  const db = createDb(`file:${join(tempDir(), "test.db")}`);
  await migrate(db);
  return db;
}

/** Features a test can switch, standing in for control. */
export class StaticFeatures implements FeatureSource {
  features = Object.fromEntries(FEATURES.map((f) => [f, true])) as TenantFeatures;

  async get() {
    return this.features;
  }

  async enabled(feature: Feature) {
    return this.features[feature];
  }

  disabled: string[] = [];
  limits: TenantQuotas = { ...NO_QUOTAS };

  async disabledTools() {
    return this.disabled;
  }

  async quotas() {
    return this.limits;
  }

  guards: Guard[] = [];

  async systemGuards() {
    return this.guards;
  }

  async set(changes: Partial<TenantFeatures>) {
    this.features = { ...this.features, ...changes };
    return this.features;
  }
}

export type TestTenant = Tenant & { features: StaticFeatures };

/** Tenants opened on demand, each on its own database and files in a temp dir, like one runtime per tenant. */
export class TestTenants {
  private readonly open = new Map<string, Promise<TestTenant>>();

  constructor(
    private readonly dir: string,
    private readonly deps: Omit<TenantDeps, "features" | "files">,
  ) {}

  get(id: string): Promise<TestTenant> {
    let t = this.open.get(id);
    if (!t) {
      t = (async () => {
        const db = createDb(`file:${join(this.dir, `${id}.db`)}`);
        await migrate(db);
        const features = new StaticFeatures();
        const tenant = openTenant(id, db, { ...this.deps, features, files: { dir: join(this.dir, "files", id) } }) as TestTenant;
        await tenant.init();
        return tenant;
      })();
      this.open.set(id, t);
    }
    return t;
  }
}

/** Tenants over temp files, with one scripted model shared by all tenants. */
export function createTestTenants(
  script: AIMessage[] = [],
  bundledSkills: Skill[] = [],
  mcpConnect?: McpConnector,
  extra: Partial<Omit<TenantDeps, "features" | "files">> = {},
) {
  const model = new ScriptedChatModel(script);
  const dir = tempDir();
  const tenants = new TestTenants(dir, {
    model,
    embeddings: new WordEmbeddings(),
    embeddingModel: "test:words",
    bundledSkills,
    timezone: "Europe/Prague",
    secrets: SecretBox.insecureDev(),
    mcp: { connect: mcpConnect },
    ...extra,
  });
  return { tenants, model, dir };
}

const keys = generateInternalKeys();

/**
 * The runtimes of all test tenants behind a stand-in for the gateway: a request carries a development bearer token
 * (`<user>` = admin of tenant `<user>`, or `<user>:<claims>`, e.g. `bob:tenant=acme`) and `X-Tenant-Id`; the
 * stand-in checks the membership like the gateway does and passes the request on with an internal token.
 */
export async function createTestApp(tenants: TestTenants) {
  const { privateKey, publicKey } = await keys;
  const signer = new InternalSigner(privateKey, "gateway");
  const verifier = new InternalVerifier(publicKey);
  const apps = new Map<string, ReturnType<typeof createRuntimeApp>>();
  const runtime = async (id: string) => {
    let app = apps.get(id);
    if (!app) {
      app = createRuntimeApp({ tenant: await tenants.get(id), verifier, activity: new Activity(), snapshot: async () => ({ key: "test", bytes: 0 }) });
      apps.set(id, app);
    }
    return app;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const token = headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return Response.json({ error: "Missing bearer token" }, { status: 401 });
    const [user = "", query] = token.split(":", 2);
    const claims = new URLSearchParams(query ?? `tenant-admin=${user}`);
    if (!claims.has("role")) claims.set("role", "osiris-user");
    const access = accessFromClaims((k) => claims.get(k) ?? undefined);
    if (!isAuthorized(access)) return Response.json({ error: "No Osiris role" }, { status: 403 });
    const memberships = membershipsFromClaims(access);
    const requested = headers.get("x-tenant-id");
    const m = requested ? memberships.find((x) => x.tenantId === requested) : memberships.length === 1 ? memberships[0] : undefined;
    if (!m) return Response.json({ error: "Not a member of this tenant" }, { status: requested ? 403 : 400 });
    headers.set(
      "authorization",
      await signer.header(tenantAudience(m.tenantId), {
        user: { sub: `dev:${user}`, name: user, email: `${user}@dev.local`, phone: null, picture: null },
        tenant: m.tenantId,
        role: m.role,
        channel: "web",
      }),
    );
    return (await runtime(m.tenantId)).request(path, { ...init, headers });
  };
  return { request, signer, runtime };
}

export class ScriptedChatModel extends BaseChatModel {
  calls: BaseMessage[][] = [];

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType() {
    return "scripted";
  }

  override bindTools() {
    return this as never;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const message = this.script.shift() ?? new AIMessage("(script exhausted)");
    return { generations: [{ text: message.text, message }] };
  }
}

/** Deterministic bag-of-words embeddings: texts sharing words get similar vectors. */
export class WordEmbeddings extends Embeddings {
  constructor() {
    super({});
  }

  private vector(text: string): number[] {
    const v = new Array<number>(64).fill(0);
    for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 64]! += 1;
    }
    return v.some((x) => x !== 0) ? v : v.map(() => 1e-6);
  }

  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string) {
    return this.vector(text);
  }
}
