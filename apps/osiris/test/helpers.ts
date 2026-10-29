import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Embeddings } from "@langchain/core/embeddings";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { createDb } from "@osiris/core/db/client.ts";
import type { Client } from "@libsql/client";
import { Records } from "@osiris/core/projects/records.ts";
import { prepareCache } from "@osiris/core/projects/cache.ts";
import type { Skill } from "@osiris/core/agent/skills.ts";
import type { McpConnector } from "@osiris/core/mcp/toolset.ts";
import { openProject, type Project, type ProjectDeps } from "@osiris/core/projects/project.ts";
import type { FeatureSource } from "@osiris/core/projects/features.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { FEATURES, NO_QUOTAS, type Feature, type Guard, type ProjectFeatures, type ProjectQuotas, type UserDefaults } from "@osiris/shared";
import { accessFromClaims, membershipsFromClaims, isAuthorized } from "@osiris/platform/claims.ts";
import { generateInternalKeys, InternalSigner, InternalVerifier, projectAudience } from "@osiris/platform/internal-auth.ts";
import { Activity } from "../src/activity.ts";
import { createRuntimeApp } from "../src/app.ts";
import { loadToolModules, type ToolModuleOptions } from "../src/tool-modules.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "osiris-test-"));

/** A project's `.osiris/` data in a fresh temp folder. */
export function createTestRecords(): Records {
  return new Records(join(tempDir(), ".osiris"));
}

/** Everything stored under a project's `.osiris/`, as one text (to check nothing is stored in the clear). */
export async function allText(records: Records): Promise<string> {
  const texts = await Promise.all((await records.walk("")).map((p) => records.readText(p)));
  return texts.join("\n");
}

/** A fresh cache database (indexes) in a temp file (libSQL `:memory:` loses data across transactions). */
export async function createTestCache(): Promise<Client> {
  const db = createDb(`file:${join(tempDir(), "index.db")}`);
  await prepareCache(db);
  return db;
}

/** Features a test can switch, standing in for control. */
export class StaticFeatures implements FeatureSource {
  features = Object.fromEntries(FEATURES.map((f) => [f, true])) as ProjectFeatures;

  async get() {
    return this.features;
  }

  async enabled(feature: Feature) {
    return this.features[feature];
  }

  disabled: string[] = [];
  limits: ProjectQuotas = { ...NO_QUOTAS };

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

  defaults: Partial<UserDefaults> = {};

  async userDefaults() {
    return this.defaults;
  }

  async set(changes: Partial<ProjectFeatures>) {
    this.features = { ...this.features, ...changes };
    return this.features;
  }
}

export type TestProject = Project & { features: StaticFeatures };

/** Test projects' tool modules: every module (as `TOOL_MODULES=all`), or the ones named. */
export type TestToolOptions = Partial<Omit<ToolModuleOptions, "images">> & {
  images?: ToolModuleOptions["images"];
  comfyApiKey?: string;
};

/** Projects opened on demand, each in its own folder in a temp dir, like one runtime per project. */
export class TestProjects {
  private readonly open = new Map<string, Promise<TestProject>>();

  constructor(
    private readonly dir: string,
    private readonly deps: Omit<ProjectDeps, "features">,
    private readonly toolOptions: TestToolOptions = {},
  ) {}

  get(id: string): Promise<TestProject> {
    let t = this.open.get(id);
    if (!t) {
      t = (async () => {
        const features = new StaticFeatures();
        const { images, comfyApiKey, enabled = ["all"], ...rest } = this.toolOptions;
        const tools = this.deps.tools ?? (await loadToolModules({ ...rest, enabled, images: images && { ...images, comfyApiKey } }));
        const project = openProject(id, join(this.dir, id), { ...this.deps, tools, features }) as TestProject;
        await project.init();
        return project;
      })();
      this.open.set(id, t);
    }
    return t;
  }
}

/** Projects over temp files, with one scripted model shared by all projects. */
export function createTestProjects(
  script: AIMessage[] = [],
  bundledSkills: Skill[] = [],
  mcpConnect?: McpConnector,
  extra: Partial<Omit<ProjectDeps, "features">> & TestToolOptions = {},
) {
  const { images, comfyApiKey, gotenbergUrl, schedules, enabled, ...deps } = extra;
  const model = new ScriptedChatModel(script);
  const dir = tempDir();
  const projects = new TestProjects(dir, {
    model,
    embeddings: new WordEmbeddings(),
    embeddingModel: "test:words",
    bundledSkills,
    timezone: "Europe/Prague",
    secrets: SecretBox.insecureDev(),
    mcp: { connect: mcpConnect },
    ...deps,
  }, { images, comfyApiKey, gotenbergUrl, schedules, enabled });
  return { projects, model, dir };
}

const keys = generateInternalKeys();

/**
 * The runtimes of all test projects behind a stand-in for the gateway: a request carries a development bearer token
 * (`<user>` = admin of project `<user>`, or `<user>:<claims>`, e.g. `bob:project=acme`) and `X-Project-Id`; the
 * stand-in checks the membership like the gateway does and passes the request on with an internal token.
 */
export async function createTestApp(projects: TestProjects) {
  const { privateKey, publicKey } = await keys;
  const signer = new InternalSigner(privateKey, "gateway");
  const verifier = new InternalVerifier(publicKey);
  const apps = new Map<string, ReturnType<typeof createRuntimeApp>>();
  const runtime = async (id: string) => {
    let app = apps.get(id);
    if (!app) {
      app = createRuntimeApp({ project: await projects.get(id), verifier, activity: new Activity(), snapshot: async () => ({ key: "test", bytes: 0 }) });
      apps.set(id, app);
    }
    return app;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const token = headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return Response.json({ error: "Missing bearer token" }, { status: 401 });
    const [user = "", query] = token.split(":", 2);
    const claims = new URLSearchParams(query ?? `project-admin=${user}`);
    if (!claims.has("role")) claims.set("role", "osiris-user");
    const access = accessFromClaims((k) => claims.get(k) ?? undefined);
    if (!isAuthorized(access)) return Response.json({ error: "No Osiris role" }, { status: 403 });
    const memberships = membershipsFromClaims(access);
    const requested = headers.get("x-project-id");
    const m = requested ? memberships.find((x) => x.projectId === requested) : memberships.length === 1 ? memberships[0] : undefined;
    if (!m) return Response.json({ error: "Not a member of this project" }, { status: requested ? 403 : 400 });
    headers.set(
      "authorization",
      await signer.header(projectAudience(m.projectId), {
        user: { sub: `dev:${user}`, name: user, email: `${user}@dev.local`, phone: null, picture: null },
        project: m.projectId,
        role: m.role,
        channel: "web",
      }),
    );
    return (await runtime(m.projectId)).request(path, { ...init, headers });
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
