import { MediaReader } from "../agent/attachments.ts";
import { QuestionStore } from "../agent/questions.ts";
import { StandardAccounts } from "../integrations/standard.ts";
import type { AgentModels } from "../agent/model.ts";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Client } from "@libsql/client";
import { createAgentGraph, type AgentGraph } from "../agent/graph.ts";
import { MemoryStore } from "../agent/memory.ts";
import { UserSettingsStore } from "../agent/settings.ts";
import { SkillStore, type Skill } from "../agent/skills.ts";
import { FileSaver } from "../checkpointer/file-saver.ts";
import { McpServerStore } from "../mcp/store.ts";
import { McpToolset, type McpOptions } from "../mcp/toolset.ts";
import { KnowledgeStore } from "../rag/store.ts";
import type { SecretBox } from "../secrets.ts";
import { SecretVault } from "../vault/vault.ts";
import { FileStore, type FileStoreOptions } from "../files/store.ts";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { fileType } from "@osiris/shared";
import type { Feature, Inquiry } from "@osiris/shared";
import type { FeatureSource } from "./features.ts";
import { UsageStore } from "../agent/usage.ts";
import { McpOAuthStore } from "../mcp/oauth.ts";
import { FileIndex } from "../files/index.ts";
import { SiteTargetStore } from "../sites/sftp.ts";
import { GuardStore, guardsText } from "../agent/guards.ts";
import { buildPublicPrompt, InquiryStore, PublicAssistantStore, publicProfile, publicTools } from "../public/assistant.ts";
import { IntegrationAccounts, type IntegrationClient, type IntegrationProvider } from "../integrations/oauth.ts";
import { VitepressClient } from "../files/vitepress.ts";
import { FileIndexer } from "../files/sync.ts";
import { AssistantProfileStore, type GuardRules } from "../agent/assistant.ts";
import { DataStore } from "../database/store.ts";
import type { ToolHost, ToolModule } from "../tools/module.ts";
import { createDb } from "../db/client.ts";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Records } from "./records.ts";
import { prepareCache } from "./cache.ts";
import { createMemoryEngine } from "../memory/mem0.ts";
import { ProjectGit } from "./git.ts";
import { threadIds } from "../repo/threads.ts";
import { configuredLocale, translate } from "@osiris/platform/i18n.ts";

/** Everything one project owns: its folder, with its own data in `.osiris/`. */
export interface Project {
  id: string;
  /** The project folder (a git working tree when the project uses git). */
  root: string;
  /** The project's own data under `.osiris/` (settings, conversations, keys, ...). */
  records: Records;
  /** Derived indexes in `.osiris/cache/index.db`, rebuilt from the files at init. */
  cache: Client;
  checkpointer: FileSaver;
  /** The project folder as a git working tree (connected by its admins). */
  git: ProjectGit;
  knowledge: KnowledgeStore;
  skills: SkillStore;
  memory: MemoryStore;
  mcpServers: McpServerStore;
  mcp: McpToolset;
  settings: UserSettingsStore;
  secrets: SecretVault;
  features: FeatureSource;
  files: FileStore;
  /** The project's own database of the assistant's tables (contacts, deals…). */
  data: DataStore;
  /** Full-text index of the project's and users' text files. */
  fileIndex: FileIndex;
  /** Where the project's website is published over SFTP. */
  siteTargets: SiteTargetStore;
  /** Users' Google and Microsoft accounts. */
  integrations: IntegrationAccounts;
  standardAccounts: StandardAccounts;
  /** The assistant for the project's customers, and the inquiries it took. */
  publicAssistants: PublicAssistantStore;
  /** The VitePress builder, when there is one. */
  vitepress?: VitepressClient;
  inquiries: InquiryStore;
  /** Run once before serving: moves old database content to files and brings the indexes up to date. */
  init(): Promise<void>;
  /** The built-in tools of the loaded tool modules, each with the feature it belongs to. */
  builtinTools: [Feature, StructuredToolInterface][];
  usage: UsageStore;
  /** Persona and rules, project-wide (owner '') and per user. */
  profiles: AssistantProfileStore;
  guards: GuardStore;
  /** The rules a user's runs keep to: system, project and the user's own. */
  rules(userId: string): Promise<GuardRules>;
  model: BaseChatModel;
  personaModel: BaseChatModel;
  graph: AgentGraph;
  questions: QuestionStore;
  media: MediaReader;
}

/** Shared, project-independent dependencies. */
export interface ProjectDeps {
  /** The tool modules the runtime loaded (its configuration); a module left out has no tools at all. */
  tools?: ToolModule[];
  media?: MediaReader;
  model: BaseChatModel;
  models?: AgentModels;
  embeddings: EmbeddingsInterface;
  embeddingModel: string;
  bundledSkills: Skill[];
  timezone: string;
  secrets: SecretBox;
  mcp?: McpOptions;
  /** Limits of the project's files. */
  files?: FileStoreOptions;
  /** Which features the project may use (from control). */
  features: FeatureSource;
  /** Emails the project's admins (a new inquiry from the public assistant); through control. */
  notifyAdmins?: (subject: string, text: string) => Promise<void>;
  /** Osiris's OAuth clients at Google and Microsoft, for users' mail, contacts and calendar (none: no such tools). */
  integrations?: { clients: Partial<Record<IntegrationProvider, IntegrationClient>>; redirectUrl: string; fetch?: typeof fetch };
  /** The VitePress builder; without it there is no build_vitepress_site tool. */
  vitepressUrl?: string;
  /** Lets Mem0 pick the user's facts from every finished turn (costs a few model calls per turn). */
  learnMemories?: boolean;
  /** Replaces global fetch for the http_request tool and the builders (tests). */
  fetch?: typeof fetch;
}

/** The project's own data folder in its root. */
export const OSIRIS_DIR = ".osiris";
/** What git leaves out: personal and sealed data, rebuildable indexes, chats' scratchpads. */
const GITIGNORE = "private/\ncache/\ntmp/\ndata.db*\n";

/** Opens the project in `root` (created on first use). */
export function openProject(id: string, root: string, deps: ProjectDeps): Project {
  const records = new Records(join(root, OSIRIS_DIR));
  const cache = createDb(`file:${join(records.dir, "cache", "index.db")}`);
  const checkpointer = new FileSaver(records);
  const engine = createMemoryEngine({ records, cache, embeddings: deps.embeddings, model: deps.models?.tools ?? deps.model });
  const knowledge = new KnowledgeStore(records, engine, deps.embeddings, deps.embeddingModel);
  const memory = new MemoryStore(engine);
  const mcpServers = new McpServerStore(records, deps.secrets);
  const secrets = new SecretVault(records, deps.secrets);
  const mcp = new McpToolset(mcpServers, secrets, new McpOAuthStore(records, deps.secrets), deps.mcp);
  const userDefaults = async () => (await deps.features.userDefaults?.()) ?? {};
  const settings = new UserSettingsStore(records, async () => {
    const { persona: _, ...defaults } = await userDefaults();
    return defaults;
  });
  const features = deps.features;
  const usage = new UsageStore(records);
  const profiles = new AssistantProfileStore(records);
  // Guards are files, so the store comes after the file store; rules() runs only in runs, long after.
  let guards!: GuardStore;
  const rules = async (userId: string): Promise<GuardRules> => {
    const [system, project, user] = await Promise.all([features.systemGuards(), guards.list({ level: "project" }), guards.list({ level: "user", userId })]);
    return { system: guardsText(system), project: guardsText(project), user: guardsText(user) };
  };
  // The public assistants (customers): each its own persona and rules after the system's and the project's.
  const publicAssistants = new PublicAssistantStore(records);
  const publicRules = async (name = ""): Promise<GuardRules> => {
    const [system, project, open] = await Promise.all([
      features.systemGuards(),
      guards.list({ level: "project" }),
      name ? guards.list({ level: "assistant", assistant: name }) : [],
    ]);
    return { system: guardsText(system), project: guardsText(project), user: guardsText(open) };
  };
  const inquiries = new InquiryStore(records);
  const fileIndex = new FileIndex(cache);
  // The files are the truth for the knowledge base and skills; the indexes follow every change.
  let indexer: FileIndexer | undefined;
  const files = new FileStore(root, {
    ...deps.files,
    quota: async () => {
      const mb = (await features.quotas()).storageMb;
      return mb === null ? null : mb * 1024 * 1024;
    },
    onChange: (change) => indexer!.apply(change),
  });
  indexer = new FileIndexer(files, fileIndex);
  const dataPath = join(records.dir, "data.db");
  const data = new DataStore(createDb(`file:${dataPath}`), dataPath, async () => {
    const q = await features.quotas();
    return { tables: q.tables, bytes: q.databaseMb === null ? null : q.databaseMb * 1024 * 1024 };
  });
  const skills = new SkillStore(records, deps.bundledSkills);
  guards = new GuardStore(records);
  const siteTargets = new SiteTargetStore(records, deps.secrets);
  const integrations = new IntegrationAccounts(
    records,
    deps.secrets,
    deps.integrations?.clients ?? {},
    deps.integrations?.redirectUrl ?? "http://localhost:5173/integration-callback",
    deps.integrations?.fetch,
  );
  const standardAccounts = new StandardAccounts(records, deps.secrets);
  const vitepress = deps.vitepressUrl ? new VitepressClient(deps.vitepressUrl, deps.fetch) : undefined;
  const questions = new QuestionStore(records);
  // The loaded tool modules get the project's stores; each module's tools belong to a feature a system admin can switch off.
  const host: ToolHost = {
    projectId: id,
    timezone: deps.timezone,
    records,
    checkpointer,
    features,
    usage,
    questions,
    files,
    fileIndex,
    knowledge,
    memory,
    skills,
    data,
    secrets,
    mcp,
    mcpServers,
    siteTargets,
    integrations,
    standardAccounts,
    vitepress,
    models: { agent: deps.models?.agent ?? deps.model, tools: deps.models?.tools ?? deps.model },
    graph: () => graph,
    allowPrivate: deps.mcp?.allowPrivate ?? false,
    fetch: deps.fetch,
    integrationsFetch: deps.integrations?.fetch,
  };
  const modules = (deps.tools ?? []).map((m) => ({ module: m, set: m.create(host) }));
  const builtins: [Feature, StructuredToolInterface][] = modules.flatMap(({ module, set }) => set.tools.map((t): [Feature, StructuredToolInterface] => [module.feature, t]));
  const graph = createAgentGraph({
    questions,
    images: async (threadId, paths) => {
      if (!(await features.get()).files) return [];
      return Promise.all(paths.map(async path => {
        const { data } = await files.read({ scope: "temp", threadId }, path);
        return { type: "image_url" as const, image_url: { url: `data:${fileType(path)!.mime};base64,${data.toString("base64")}` } };
      }));
    },
    projectId: id,
    model: deps.model,
    models: deps.models,
    tools: [questions.tool()],
    // Resolved on every step, so switching a feature or a tool applies from the next step.
    dynamicTools: async (ctx) => {
      if (ctx.channel === "public") {
        const assistant = await publicAssistants.get(ctx.assistant);
        if (!assistant) return [];
        const notify = deps.notifyAdmins
          ? (i: Inquiry) =>
              deps.notifyAdmins!(
                translate(configuredLocale(), "email.inquiry.subject", { name: i.name }),
                translate(configuredLocale(), "email.inquiry.text", {
                  assistant: assistant.title || assistant.name,
                  name: i.name,
                  contact: i.contact,
                  time: i.preferredTime ? `${translate(configuredLocale(), "email.inquiry.time", { time: i.preferredTime })}\n` : "",
                  description: i.description,
                }),
              )
          : undefined;
        return publicTools({ knowledge, inquiries, skills, notify }, assistant);
      }
      const [on, off] = await Promise.all([features.get(), features.disabledTools()]);
      const tools: StructuredToolInterface[] = [];
      for (const { module, set } of modules) {
        if (!on[module.feature]) continue;
        const usable = (await set.usable?.(ctx, on)) ?? (() => true);
        tools.push(...set.tools.filter((t) => !off.includes(t.name) && usable(t.name)));
      }
      if (!on.mcp) return tools;
      const hidden = (name: string) => modules.some(({ set }) => set.hidesMcpTool?.(name));
      return [...tools, ...(await mcp.tools(ctx.user_id)).filter((t) => !hidden(t.name))];
    },
    features,
    usage,
    rules: (ctx) => (ctx.channel === "public" ? publicRules(ctx.assistant) : rules(ctx.user_id)),
    persona: async (ctx) =>
      ctx.channel === "public"
        ? (await profiles.get(publicProfile(ctx.assistant ?? ""))).persona
        : ((await profiles.get(ctx.user_id)).persona ?? (await userDefaults()).persona ?? null),
    publicPrompt: async (ctx) => {
      const a = await publicAssistants.get(ctx.assistant);
      if (!a) throw new Error(`No public assistant ${ctx.assistant}`);
      const [r, profile, own, facts] = await Promise.all([
        publicRules(a.name),
        profiles.get(publicProfile(a.name)),
        skills.projectSkills(),
        memory.projectByIds(a.memories),
      ]);
      return buildPublicPrompt({
        title: a.title || id,
        timezone: deps.timezone,
        rules: r,
        persona: profile.persona,
        skills: own.filter((s) => a.skills.includes(s.name)),
        memories: facts,
        knowledge: a.knowledge.length > 0,
        tools: a.tools,
      });
    },
    publicLimit: async (ctx) => (await publicAssistants.get(ctx.assistant))?.tokensPerMonth ?? null,
    checkpointer,
    timezone: deps.timezone,
    skills,
    memory,
    settings,
    secrets,
    database: () => data.tables(),
    learn: deps.learnMemories
      ? (ctx, message, answer) =>
          memory.extract(ctx.user_id, [{ role: "user", content: message }, { role: "assistant", content: answer }], (tokens) => void usage.add(tokens, Date.now(), { user: ctx.user_id }))
      : undefined,
  });
  // The indexes catch up with the files on disk (a restored snapshot, a git pull, a lost cache).
  const init = async () => {
    await mkdir(records.dir, { recursive: true });
    await writeFile(join(records.dir, ".gitignore"), GITIGNORE, { flag: "wx" }).catch((err) => (err.code === "EEXIST" ? undefined : Promise.reject(err)));
    if (!(await records.read("project.json"))) await records.write("project.json", { id });
    await prepareCache(cache);
    await engine.initialize();
    await indexer!.reconcile();
    await knowledge.reindexStale();
    // A chat's scratchpad lives as long as the chat; one whose chat is gone goes now.
    const threads = await threadIds(records);
    for (const thread of await files.tempThreads()) if (!threads.has(thread)) await files.removeTemp(thread);
    for (const { set } of modules) await set.init?.();
  };
  return {
    id,
    root,
    records,
    cache,
    git: new ProjectGit(root, secrets, { allowPrivate: deps.mcp?.allowPrivate }),
    checkpointer,
    knowledge,
    skills,
    memory,
    mcpServers,
    mcp,
    settings,
    secrets,
    features,
    files,
    data,
    fileIndex,
    siteTargets,
    integrations,
    standardAccounts,
    publicAssistants,
    inquiries,
    vitepress,
    builtinTools: builtins,
    usage,
    profiles,
    guards,
    rules,
    model: deps.models?.agent ?? deps.model,
    personaModel: deps.models?.persona ?? deps.model,
    graph,
    questions,
    media: deps.media ?? new MediaReader(undefined),
    init,
  };
}
