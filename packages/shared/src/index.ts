export * from "./i18n.ts";

/** `public`: the project's customers, anonymous, on its public chat page or website widget. */
export type Channel = "web" | "whatsapp" | "public";

export interface ThreadSummary {
  id: string;
  title: string | null;
  channel: Channel;
  updatedAt: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: string; artifact?: unknown };

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: MessagePart[];
}

/** Server-sent events emitted by `POST /api/threads/:id/runs`, one JSON object per SSE `data` line. */
/** What a run is doing now: the model thinking, tools running, or the rules being checked. */
export type RunStatus = "thinking" | "tools" | "checking";

export type RunEvent =
  | { type: "text-delta"; delta: string }
  | { type: "status"; status: RunStatus }
  /** The model has started writing a tool call (its arguments follow in `tool-call`). */
  | { type: "tool-call-start"; toolCallId: string; toolName: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  /** `artifact`: what the UI shows beside the result and the model never sees (a workflow's diagram). */
  | { type: "tool-result"; toolCallId: string; result: string; artifact?: unknown }
  | { type: "image-progress"; id: string; status: string; progress?: { value: number; max: number } }
  /** A state change of a multi-step workflow (`run_workflow`), for the UI's live diagram. */
  | { type: "telemetry"; event: AgentTelemetryEvent }
  | { type: "done" }
  | { type: "error"; message: string };

export type Role = "admin" | "member";

/** Identity and memberships from the user's claims (`role`, `project`, `project-admin`); see `@osiris/platform/claims.ts`. */
export interface MeResponse {
  user: { id: string; email: string | null; name: string | null; phone: string | null; picture: string | null };
  /** Claim `role=osiris-admin`: admin of every project, manages projects. */
  systemAdmin: boolean;
  projects: { id: string; name: string; role: Role; logo: string | null }[];
  /** `local`: a local agent answers (one project, one user, no server parts); absent from osiris-server. */
  mode?: "local";
}

/** What a system admin can switch on or off per project. */
export const FEATURES = ["knowledge", "skills", "memory", "mcp", "http", "whatsapp", "files", "scheduler", "sites", "integrations", "public", "database", "workflows", "infrastructure"] as const;
export type Feature = (typeof FEATURES)[number];
export type ProjectFeatures = Record<Feature, boolean>;

/** The active project (`GET /api/project`). */
export interface ProjectInfo {
  id: string;
  name: string;
  role: Role;
  features: ProjectFeatures;
  /** Public URL of the project's logo, or null. */
  logo: string | null;
}

/** How the assistant talks, written from a character of a book or film; the description is what goes to the prompt. */
export interface Persona {
  character: string;
  source: string;
  description: string;
}

/** The assistant's persona: a user's own or a public assistant's (personalization is the user's, not the project's). */
export interface AssistantProfile {
  persona: Persona | null;
}

/** Everything that shapes the assistant's persona for the current user (`/api/assistant`). */
export interface AssistantProfiles {
  personal: AssistantProfile;
  /** A public assistant's own persona (customers; `?assistant=<name>`); for admins. */
  public?: AssistantProfile;
}

/**
 * A rule the assistant keeps to: in the prompt, and every message and answer is checked against it. Stored as a
 * Markdown file per guard (frontmatter name and description, the rule as the body): the system's in control, the
 * project's in its files under `guards/`, a user's under `guards/users/<id>/`, a public assistant's under
 * `guards/assistants/<name>/`.
 */
export interface Guard {
  name: string;
  description: string;
  rule: string;
}

/** Guards by level (`/api/guards`): the system's read-only here; the assistants' for admins. */
export interface Guards {
  system: Guard[];
  project: Guard[];
  /** The caller's own. */
  user: Guard[];
  assistants?: Record<string, Guard[]>;
}

/** What new projects and users start with (system admins, System > Nastavení, `/api/admin/defaults`). */
export interface SystemDefaults {
  project: { features: ProjectFeatures; quotas: ProjectQuotas; idleMinutes: number; storageGb: number };
  /** A user's personalization until they save their own (the persona until they set one). */
  user: UserDefaults;
}

/** A row of a web analytics breakdown: a page, a referrer, a country… with its pageviews and unique visitors. */
export interface WebTopRow {
  key: string;
  /** A second part of the key (the referrer's source, a campaign's medium…), "" when there is none. */
  detail: string;
  pageviews: number;
  visitors: number;
}

/** One site's web analytics over a range (System > Návštěvnost, `/api/admin/telemetry/web`). */
export interface WebStats {
  sites: string[];
  totals: { pageviews: number; visitors: number; events: number };
  /** Hourly up to two days, daily beyond; epoch ms. */
  step: "hour" | "day";
  series: { t: number; pageviews: number; visitors: number }[];
  pages: WebTopRow[];
  referrers: WebTopRow[];
  campaigns: WebTopRow[];
  countries: WebTopRow[];
  regions: WebTopRow[];
  cities: WebTopRow[];
  networks: WebTopRow[];
  browsers: WebTopRow[];
  systems: WebTopRow[];
  devices: WebTopRow[];
  /** Custom events: `pageviews` is their count. */
  events: WebTopRow[];
}

/** The cluster's telemetry in ClickHouse (System > Logy, Metriky, Trasy; `/api/admin/telemetry/*`). */
export interface TelemetryFacets {
  services: string[];
  namespaces: string[];
  /** The digital twin's: nodes, and pods and containers (of the asked namespace). */
  nodes?: string[];
  pods?: string[];
  containers?: string[];
}

export interface LogRecord {
  /** Epoch ms. */
  ts: number;
  severity: string;
  severityNumber: number;
  service: string;
  namespace: string;
  pod: string;
  body: string;
  traceId: string;
  spanId: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}

/** A trace by its root span. */
export interface TraceSummary {
  ts: number;
  traceId: string;
  service: string;
  name: string;
  durationMs: number;
  error: boolean;
  spans: number;
}

export interface SpanRecord {
  spanId: string;
  parentSpanId: string;
  service: string;
  name: string;
  kind: string;
  /** Epoch ms, with fractions. */
  startMs: number;
  durationMs: number;
  error: boolean;
  statusMessage: string;
  attributes: Record<string, string>;
  resource: Record<string, string>;
}

export interface MetricInfo {
  name: string;
  type: "gauge" | "sum" | "histogram";
  unit: string;
  description: string;
}

export interface MetricSeries {
  /** The group's value ('' without grouping). */
  name: string;
  /** [epoch ms, value]. */
  points: [number, number][];
}

/**
 * The digital twin (twin.k6labs.cz): its models are DTDL v3 interfaces and its instances follow the Azure Digital
 * Twins API (`@osiris/shared/dtdl.ts`). Every entity's model extends `dtmi:osiris:twin:Entity;1`, which gives it a
 * `name`, a `status` and the OpenTelemetry resource attributes naming its telemetry (`otelResource`).
 */
export type TwinStatus = "ok" | "warn" | "error";
export const TWIN_ENTITY_MODEL = "dtmi:osiris:twin:Entity;1";
/** The relationship whose instances nest twins in one another (the 3D view's boxes). */
export const TWIN_CONTAINS = "contains";

/** One change of a twin in the history (`/api/digitaltwins/{id}/history`), read back from OpenTelemetry's logs. */
export interface TwinChange {
  ts: number;
  dtId: string;
  model: string;
  name: string;
  change: "added" | "changed" | "removed";
  status: TwinStatus;
  /** The status before a change; null when it was added. */
  previousStatus: TwinStatus | null;
  /** What changed: property names (status among them). */
  changed: string[];
}

/** Guard names, also their file names: kebab-case. */
export const GUARD_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Limits a system admin sets per project; null = no limit (storage: 80 % of the project's volume). */
export interface ProjectQuotas {
  /** Files, in MB. */
  storageMb: number | null;
  /** Tokens of the language model per calendar month. */
  tokensPerMonth: number | null;
  members: number | null;
  /** Scheduled tasks in the project. */
  schedules: number | null;
  /** Tokens of the language model per calendar month for each member (their runs, scheduled ones too). */
  tokensPerUserMonth: number | null;
  /** Tables in the project's database. */
  tables: number | null;
  /** The project's database, in MB. */
  databaseMb: number | null;
  /** The project's own dashboards (the built-in ones don't count). */
  dashboards: number | null;
}

export const NO_QUOTAS: ProjectQuotas = {
  storageMb: null,
  tokensPerMonth: null,
  members: null,
  schedules: null,
  tokensPerUserMonth: null,
  tables: null,
  databaseMb: null,
  dashboards: null,
};

/** One quota's use; `limit` null = no limit. */
export interface Meter {
  used: number;
  limit: number | null;
}

/** How much of its quotas the project uses (`/api/usage`); storage in bytes, tokens this calendar month. */
export interface ProjectUsage {
  storage: Meter;
  tokens: Meter;
  members: Meter;
  schedules: Meter;
  /** The caller's own tokens this calendar month. */
  userTokens: Meter;
  tables: Meter;
  /** The database file, in bytes. */
  database: Meter;
  dashboards: Meter;
}

/** A built-in tool of the assistant (`/api/tools`); a system admin can switch each one off per project. */
export interface BuiltinTool {
  name: string;
  description: string;
  feature: Feature;
  /** Its feature is on for the project. */
  featureOn: boolean;
  /** Switched off by a system admin. */
  disabled: boolean;
}

/** A project as system admins see it (`/api/admin/projects`). */
export interface ProjectSummary {
  id: string;
  name: string;
  logo: string | null;
  /** Users whose claim `project` or `project-admin` names the project. */
  members: number;
}

export interface ProjectMember {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
}

export interface ProjectDetail extends ProjectSummary {
  features: ProjectFeatures;
  memberList: ProjectMember[];
  /** Minutes without activity before the project's runtime sleeps; 0 = always on. */
  idleMinutes: number;
  /** Size of the project's volume (database and files). */
  storageGb: number;
  /** Built-in tools switched off for the project, by name. */
  disabledTools: string[];
  quotas: ProjectQuotas;
  /** Web analytics sites it sees besides those of its domains. */
  webSites: string[];
  backups: { key: string; bytes: number; reason: string; createdAt: string }[];
}

/** A user of Osiris, for adding members to a project. */
export interface DirectoryUser {
  id: string;
  name: string | null;
  email: string | null;
}

/** A user as system admins manage them (`/api/admin/users`). */
export interface AdminUser extends DirectoryUser {
  firstName: string;
  lastName: string;
  picture: string | null;
  /** Can't sign in, and their tokens stop working. */
  disabled: boolean;
  /** Claim `role=osiris-admin`. */
  systemAdmin: boolean;
  /** Active projects their claims name. */
  projects: { id: string; role: Role }[];
}

/** Who a setting applies to: the whole project (managed by admins) or only the current user. */
export type Scope = "project" | "personal";

/**
 * A user's own layer over the project's settings: each list holds the project's records and the viewer's own, and a
 * project record the viewer replaced with their own copy (same name, id or path) is `overridden` for them.
 */
export interface Layered {
  overridden?: boolean;
}

export interface SkillSummary extends Layered {
  name: string;
  description: string;
  /** Precedence for one name: `personal` (this user) > `project` (admin) > `bundled` (ships with the app). */
  source: "bundled" | Scope;
  /** Frontmatter `requires`: offered only while the project has that feature (its tools). */
  requires?: Feature;
}

export interface Skill extends SkillSummary {
  instructions: string;
}

export interface Memory extends Layered {
  id: string;
  content: string;
  /** `project`: shared with everyone in the project (admins manage it); `personal`: only this user. */
  scope: Scope;
  /** A personal memory that replaces this project memory for its owner. */
  overrides?: string;
  createdAt: string;
}

/** A remote MCP server, project-wide or personal. Header values are write-only: the API returns only their names. */
export interface McpServer extends Layered {
  name: string;
  scope: Scope;
  /** Empty for project servers when the viewer isn't an admin (the URL may carry an API key). */
  url: string;
  enabled: boolean;
  /** `oauth`: signed in at the provider (vas-hosting.cz…), not with static headers. */
  auth: "headers" | "oauth";
  /** For OAuth servers: whether the owner has signed in. */
  signedIn?: boolean;
  headerNames: string[];
  updatedAt: string;
  /** Result of the last connection attempt; absent if not tried yet (or disabled). */
  status?: McpServerStatus;
}

export type McpServerStatus = { ok: true; tools: string[] } | { ok: false; error: string };

export interface DocumentSummary extends Layered {
  id: string;
  title: string;
  chunks: number;
  scope: Scope;
  createdAt: string;
}

/** "Můj profil": how the agent should treat this user. */
export interface UserSettings {
  address: "auto" | "ty" | "vy";
  /** The language the user reads: the web app's and the assistant's. `auto` follows the browser (web) and the user's own messages (assistant). */
  language: "auto" | "en" | "cs" | "sk";
  /** Appended to e-mails, quotes and other texts written on the user's behalf. */
  signature: string;
  /** The user's own standing instructions for the agent. */
  instructions: string;
}

/**
 * The `character` of a persona written as a free description rather than after a known character. It goes into the
 * agent's (Czech) prompt as the persona's name, so it is model-facing text, not UI.
 */
export const CUSTOM_PERSONA = "Vlastní";

/** The system's default personalization for users (System > Nastavení). */
export type UserDefaults = UserSettings & { persona: Persona | null };

/** A secret without its value: values are write-only and never leave the server. */
export interface SecretSummary extends Layered {
  name: string;
  scope: Scope;
  /** Hosts the secret may be sent to (`api.example.com` or `*.example.com`). */
  allowedHosts: string[];
  description: string;
  updatedAt: string;
}

/** A scheduled task: a prompt the agent runs on the owner's behalf at set times (`/api/schedules`). */
export interface Schedule {
  id: string;
  ownerId: string;
  ownerName: string | null;
  title: string;
  prompt: string;
  /** Cron expression (5 fields) for repeating tasks, or null for a one-off at `runAt`. */
  cron: string | null;
  runAt: string | null;
  timezone: string;
  /** Where the result goes; WhatsApp results also stay in a web thread. */
  delivery: "web" | "whatsapp";
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "done" | "failed" | "skipped" | null;
  lastError: string | null;
  lastThreadId: string | null;
}

export interface ScheduleInput {
  title: string;
  prompt: string;
  cron?: string | null;
  runAt?: string | null;
  timezone?: string;
  delivery?: "web" | "whatsapp";
  enabled?: boolean;
}

/** The user's account profile (`/api/me/profile`). */
export interface UserProfile {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** A pending phone verification: send `OVERENI <code>` from the phone to `whatsappNumber`. */
  phoneChallenge?: { phone: string; code: string; whatsappNumber: string | null; expiresAt: string };
}

export const SOCIAL_PROVIDERS = ["google", "facebook", "microsoft", "seznam"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** How the user signs in (`/api/me/security`); secrets never leave the server. */
export interface SecurityOverview {
  password: boolean;
  /** An authenticator app (TOTP) is the second factor after a password or social sign-in. */
  totp: boolean;
  recoveryCodes: number;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  social: { provider: SocialProvider; email: string | null; linkedAt: string }[];
  /** Social sign-ins this deployment offers. */
  providers: SocialProvider[];
}

/** One step of signing in (`/auth/interaction/:uid/state`), for the sign-in screen. */
export interface SignInState {
  step: "login" | "second-factor";
  methods: { passkey: boolean; emailLink: boolean; social: SocialProvider[] };
  /** The application the user is signing in to, as its admin registered it. */
  client: { name: string; logo: string | null };
}

/** Result of adding someone to a project by email (`POST /api/members`). */
export interface InviteResult {
  userId: string;
  created: boolean;
  /** One-time sign-in link for a new user, to pass on to them. */
  loginLink?: string;
}

/** Project files (`/api/files`): shared by the project (admins write), the user's own, or one thread's temporary files. */
export type FileScope = "project" | "personal" | "temp";

/** Tools a public assistant may get besides searching its knowledge and loading its skills; the project admin picks them. */
export const PUBLIC_TOOLS = ["estimate_price", "create_inquiry"] as const;
export type PublicTool = (typeof PUBLIC_TOOLS)[number];

/** Public assistant names: in its link (`/c/<project>/<name>`), kebab-case. */
export const PUBLIC_ASSISTANT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One of the project's assistants for its customers (`/api/public-assistants`); it knows only what the admin picked. */
export interface PublicAssistantSettings {
  name: string;
  enabled: boolean;
  /** The business's name as customers see it. */
  title: string;
  greeting: string;
  /** Knowledge base documents and folders it searches, relative to knowledge/ (e.g. `public` or `cenik.md`). */
  knowledge: string[];
  /** Ids of the project's memories it is told. */
  memories: string[];
  /** Project skills it may load. */
  skills: string[];
  tools: PublicTool[];
  /** Model tokens per calendar month for its chats (null = only the project's quota). */
  tokensPerMonth: number | null;
}

/** What the public chat page shows before the first message (`/public/<project>/<assistant>/info`). */
export interface PublicInfo {
  enabled: boolean;
  title: string;
  greeting: string;
}

/** A customer's inquiry taken by the public assistant (`/api/inquiries`). */
export interface Inquiry {
  id: string;
  name: string;
  contact: string;
  description: string;
  preferredTime: string | null;
  threadId: string | null;
  /** The public assistant that took it. */
  assistant: string | null;
  status: "new" | "done";
  createdAt: string;
}

/** A user's account at Google or Microsoft the assistant may use (`/api/integrations`). */
export interface Integration {
  provider: "google" | "microsoft";
  /** The account's address, when connected. */
  account: string | null;
  connected: boolean;
}

/** Where the project's site is published over SFTP (`/api/site-targets`); the password or key is never returned. */
export interface SiteTarget {
  name: string;
  host: string;
  port: number;
  username: string;
  remoteDir: string;
  auth: "password" | "key";
  /** The server's host key, pinned on the first connection (null until then). */
  hostKey: string | null;
  lastPublish: PublishResult | null;
}

export interface PublishResult {
  at: string;
  ok: boolean;
  uploaded: number;
  deleted: number;
  unchanged: number;
  bytes: number;
  error?: string;
}

/** A full-text match in the project's or the user's files (`/api/files/search`). */
export interface FileSearchHit {
  scope: "project" | "personal";
  path: string;
  /** The matching passage, matches marked with « and ». */
  snippet: string;
}

export interface FileEntry {
  scope: FileScope;
  /** Relative to the scope root, `/`-separated. */
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  mime: string | null;
  modifiedAt: string;
}
export * from "./files.ts";

/** Column types of the project's database; `date` is `YYYY-MM-DD`, `datetime` ISO 8601, `json` any JSON value. */
export const DB_COLUMN_TYPES = ["text", "integer", "real", "boolean", "date", "datetime", "json"] as const;
export type DbColumnType = (typeof DB_COLUMN_TYPES)[number];

/** A column of a table in the project's database; `id`, `created_at` and `updated_at` are every table's own (`system`). */
export interface DbColumn {
  name: string;
  type: DbColumnType;
  required: boolean;
  unique: boolean;
  /** The table whose `id` it points to. */
  references: string | null;
  system?: boolean;
}

/** A table of the project's database (`/api/database/tables`). */
export interface DbTable {
  name: string;
  description: string;
  columns: DbColumn[];
  rows: number;
}

/** A page of a table's rows, values decoded by column type (booleans, JSON). */
export interface DbRows {
  table: DbTable;
  rows: Record<string, unknown>[];
  /** Rows matching the search. */
  total: number;
}

/** A read-only SQL query's answer; `truncated` when more rows matched than were returned. */
export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** How far back a dashboard looks. */
export const DASHBOARD_RANGES = ["1h", "24h", "7d", "30d", "90d"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

/** How a panel shows its data: tiles of the first row, lines over time (first column), bars, a table, quota meters. */
export const PANEL_KINDS = ["stat", "line", "bar", "table", "meters"] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

/**
 * Where a panel's data comes from. System dashboards: metric, logs, cluster, web (all sites), usage `projects`.
 * Project dashboards: web (the project's sites), usage (`quotas`, `users`, `assistants`, `months`), database (one SELECT).
 */
export type PanelSource =
  | { type: "metric"; name: string; metricType: "gauge" | "sum" | "histogram"; groupBy?: string; service?: string }
  | { type: "logs"; view: "by_service" | "list"; severity?: "warn" | "error" | "fatal"; service?: string; namespace?: string; q?: string }
  | { type: "cluster"; view: "summary" | "projects" | "pods" | "events" | "backups" }
  | { type: "web"; view: "totals" | "series" | "sites" | "pages" | "referrers" | "countries" }
  | { type: "usage"; view: "quotas" | "users" | "assistants" | "months" | "projects" }
  | { type: "database"; sql: string };

export interface DashboardPanel {
  title: string;
  kind: PanelKind;
  source: PanelSource;
  /** Columns of a four-column grid; default 2. */
  width?: 1 | 2 | 3 | 4;
}

export interface DashboardDefinition {
  range: DashboardRange;
  panels: DashboardPanel[];
}

/** A dashboard of the system (system admins) or of a project (its admins edit, members see). */
export interface Dashboard {
  id: string;
  name: string;
  definition: DashboardDefinition;
  /** Shipped with Osiris (Systém, Weby, Využití): can't be changed or deleted, doesn't count for the quota. */
  builtin?: boolean;
  updatedAt?: string;
}

/** A panel's data as a table; `formats` say how to show each column. */
export interface PanelData {
  columns: string[];
  rows: unknown[][];
  formats?: (PanelFormat | null)[];
}
/** `meter` / `meterBytes`: the cell is `{ used, limit }` (limit null = none). `time`: epoch ms. */
export type PanelFormat = "bytes" | "number" | "time" | "date" | "percent" | "text" | "meter" | "meterBytes";

/** The web analytics of several sites together (Weby dashboards); visitors are unique per day. */
export interface WebSummary {
  sites: { site: string; project: string | null; pageviews: number; visitors: number }[];
  totals: { pageviews: number; visitors: number; events: number };
  step: "hour" | "day";
  series: { t: number; pageviews: number; visitors: number }[];
  pages: WebTopRow[];
  referrers: WebTopRow[];
  countries: WebTopRow[];
}

/** Tokens this month by member, by public assistant, and the project's per month (`/api/usage/breakdown`). */
export interface UsageBreakdown {
  /** By user id; a member sees only themselves. */
  users: { userId: string; tokens: number }[];
  assistants: { name: string; tokens: number }[];
  months: { month: string; tokens: number }[];
}

/** What a runtime last reported of its use (System > Dashboard > Využití); members, schedules and dashboards are control's. */
export interface ReportedUsage {
  storage: number;
  tokens: number;
  month: string;
  tables: number;
  database: number;
}


export interface LoginEvent {
  id: string;
  at: number;
  success: boolean;
  method: string;
  ip: string;
  country: string;
  region: string;
  city: string;
  asn: string;
  network: string;
  browser: string;
  os: string;
  device: string;
}
export interface LoginSession extends Omit<LoginEvent, "success" | "method"> {
  current: boolean;
  lastSeenAt: number;
  expiresAt: number;
}
export interface AccountActivity { events: LoginEvent[]; sessions: LoginSession[] }

export interface ChatQuestion {
  id: string;
  title: string;
  fields: { name: string; label: string; type: "text" | "number" | "date" | "select" | "multiselect" | "boolean"; required: boolean; options?: { value: string; label: string }[] }[];
  state: "open" | "answered" | "cancelled" | "expired";
  expiresAt: number;
}

/** Tools whose result may be a chat question (`{ question }`), shown as a form even with tool calls hidden. */
export const QUESTION_TOOLS: readonly string[] = ["ask_user", "run_workflow"];

/** Agent orchestration patterns (`@osiris/tools-workflows`). `Composite`: a plan mixing several of them. */
export type AgentPattern = "ReAct" | "PEV" | "JEV" | "MapReduce" | "Reflexion" | "HITL" | "Composite";
export type AgentPhase = "Router" | "Plan" | "Judge" | "Execute" | "Verify" | "Critic" | "Map" | "Reduce" | "HumanApproval" | "Complete";
/** `skipped`: never ran (what it needed failed or was rejected, or the workflow ended without it). */
export type AgentNodeStatus = "pending" | "running" | "success" | "failed" | "waiting_approval" | "skipped";

/** The graph the UI draws: sent once with the router's result, before any step runs. */
export interface AgentGraphTopology {
  nodes: { id: string; label: string; pattern: AgentPattern; type: AgentPhase }[];
  edges: { from: string; to: string; condition?: string }[];
}

/** One state change of an orchestrated run; `nodeId` is a node of `activeGraphTopology`. */
export interface AgentTelemetryEvent {
  /** The run's thread. */
  sessionId: string;
  timestamp: number;
  pattern: AgentPattern;
  phase: AgentPhase;
  nodeId: string;
  status: AgentNodeStatus;
  activeGraphTopology?: AgentGraphTopology;
  payload?: Record<string, unknown>;
  message: string;
}

/** A workflow's diagram as it stands: the planned graph and each node's latest state. */
export interface WorkflowView {
  pattern: AgentPattern;
  topology: AgentGraphTopology;
  nodes: Record<string, { status: AgentNodeStatus; message: string }>;
  /** What happened last, for a line under the diagram: the user sees the workflow is busy and with what. */
  latest?: { nodeId: string; status: AgentNodeStatus; message: string; at: number };
}

const isNodeState = (v: unknown): v is WorkflowView["nodes"][string] =>
  !!v && typeof v === "object" && typeof (v as { status?: unknown }).status === "string" && typeof (v as { message?: unknown }).message === "string";

/**
 * The view after an event. One carrying `activeGraphTopology` starts it over (every node pending, unless its
 * `payload.nodes` restores their states, as on resuming); the others update their node.
 */
export function applyTelemetry(view: WorkflowView | undefined, e: AgentTelemetryEvent): WorkflowView | undefined {
  if (e.activeGraphTopology) {
    const restored = e.payload?.nodes && typeof e.payload.nodes === "object" ? (e.payload.nodes as Record<string, unknown>) : {};
    const nodes: WorkflowView["nodes"] = {};
    for (const n of e.activeGraphTopology.nodes) {
      const r = restored[n.id];
      nodes[n.id] = isNodeState(r) ? r : { status: "pending", message: n.label };
    }
    nodes[e.nodeId] = { status: e.status, message: e.message };
    return { pattern: e.pattern, topology: e.activeGraphTopology, nodes, latest: latestOf(e) };
  }
  if (!view || !view.nodes[e.nodeId]) return view;
  return { ...view, nodes: { ...view.nodes, [e.nodeId]: { status: e.status, message: e.message } }, latest: latestOf(e) };
}

const latestOf = (e: AgentTelemetryEvent): WorkflowView["latest"] => ({ nodeId: e.nodeId, status: e.status, message: e.message, at: e.timestamp });

/** The view of a workflow that ended: whatever hadn't run by then never will. */
export function finishedView(view: WorkflowView): WorkflowView {
  const nodes = Object.fromEntries(
    Object.entries(view.nodes).map(([id, n]) => [id, n.status === "pending" || n.status === "running" ? { ...n, status: "skipped" as const } : n]),
  );
  return { ...view, nodes };
}

/** The view as stored with a tool result, or undefined for anything else. */
export function asWorkflowView(v: unknown): WorkflowView | undefined {
  const w = v as WorkflowView | undefined;
  return w && typeof w === "object" && Array.isArray(w.topology?.nodes) && Array.isArray(w.topology?.edges) && w.nodes && typeof w.nodes === "object" ? w : undefined;
}
