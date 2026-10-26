import { FEATURES, NO_QUOTAS, type ReportedUsage, type AdminUser, type Guard, type SystemDefaults, type DirectoryUser, type ProjectQuotas, type Role, type ProjectFeatures, type ProjectMember, type ProjectSummary } from "@osiris/shared";
import { CLAIMS, claimList, isAuthorized, SYSTEM_ADMIN_ROLE, USER_ROLE, type Access } from "@osiris/platform/claims.ts";
import { randomUUID } from "node:crypto";
import type { ObjectStore } from "@osiris/platform/objects.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { Orchestrator, ProjectSpec } from "./orchestrator/types.ts";
import type { UserDirectory, UserRecord } from "./users.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

export interface ProjectRow {
  id: string;
  name: string;
  status: "active" | "archived";
  features: ProjectFeatures;
  idleMinutes: number;
  storageGb: number;
  createdAt: number;
  /** Public URL of the project's logo, or null. */
  logo: string | null;
  /** Built-in tools switched off for the project, by name. */
  disabledTools: string[];
  quotas: ProjectQuotas;
  /** Web analytics sites the project sees (system admins choose). */
  webSites: string[];
  /** What its runtime last reported of its use, and when (epoch ms). */
  usage: (ReportedUsage & { at: number }) | null;
}

export class ProjectExistsError extends Error {}
/** A quota is full; the message can be shown. */
export class QuotaError extends LocalizedError {}
export class ProjectNotFoundError extends Error {}

/** Everything is on until a system admin switches it off, so features added later reach existing projects. */
export const withDefaults = (stored: Partial<ProjectFeatures>): ProjectFeatures =>
  Object.fromEntries(FEATURES.map((f) => [f, stored[f] ?? true])) as ProjectFeatures;

interface Row {
  id: string;
  name: string;
  status: string;
  features: string;
  idle_minutes: number;
  storage_gb: number;
  created_at: number;
  logo: string | null;
  disabled_tools: string;
  quotas: string;
  web_sites: string | null;
  usage: string | null;
  usage_at: number | null;
}

const logoKey = (id: string, version: string) => `project-logos/${id}/${version}`;

const toProject = (r: Row, publicUrl = ""): ProjectRow => ({
  id: r.id,
  name: r.name,
  status: r.status === "archived" ? "archived" : "active",
  features: withDefaults(JSON.parse(r.features) as Partial<ProjectFeatures>),
  idleMinutes: Number(r.idle_minutes),
  storageGb: Number(r.storage_gb),
  createdAt: Number(r.created_at),
  logo: r.logo ? `${publicUrl}/project-logos/${r.id}/${r.logo}` : null,
  disabledTools: JSON.parse(r.disabled_tools ?? "[]") as string[],
  quotas: { ...NO_QUOTAS, ...(JSON.parse(r.quotas ?? "{}") as Partial<ProjectQuotas>) },
  webSites: JSON.parse(r.web_sites ?? "[]") as string[],
  usage: r.usage ? { ...(JSON.parse(r.usage) as ReportedUsage), at: Number(r.usage_at) } : null,
});

/** Projects in the central database. Members are not stored here: they are the users whose claims name the project. */
export class ProjectStore {
  constructor(
    private readonly db: Db,
    /** Where logos are kept and the browser reaches them; tools without it (the legacy import) don't touch logos. */
    private readonly logos?: { objects: ObjectStore; publicUrl: string },
  ) {}

  private toProject = (r: Row) => toProject(r, this.logos?.publicUrl);

  async list({ archived = false } = {}): Promise<ProjectRow[]> {
    const rows = await this.db.query<Row>(`SELECT * FROM projects ${archived ? "" : "WHERE status = 'active'"} ORDER BY id`);
    return rows.map(this.toProject);
  }

  async get(id: string, { fresh = false } = {}): Promise<ProjectRow | null> {
    const [row] = await this.db.query<Row>("SELECT * FROM projects WHERE id = ?", [id], { fresh });
    return row ? this.toProject(row) : null;
  }

  /** What new projects and users start with; until a system admin sets them, everything on and no limits. */
  async defaults(): Promise<SystemDefaults> {
    const [r] = await this.db.query<{ value: string }>("SELECT value FROM system_settings WHERE key = 'defaults'");
    const stored = r ? (JSON.parse(r.value) as Partial<SystemDefaults>) : {};
    return {
      project: {
        idleMinutes: 30,
        storageGb: 5,
        ...stored.project,
        features: withDefaults(stored.project?.features ?? {}),
        quotas: { ...NO_QUOTAS, ...stored.project?.quotas },
      },
      user: { address: "auto", language: "auto", signature: "", instructions: "", persona: null, ...stored.user },
    };
  }

  async setDefaults(d: SystemDefaults) {
    await this.db.execute([
      run(
        "INSERT INTO system_settings (key, value, updated_at) VALUES ('defaults', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        JSON.stringify(d),
        Date.now(),
      ),
    ]);
  }

  /** Rules every project's assistant keeps to, above the project's, the users' and the public assistants' own. */
  async systemGuards(): Promise<Guard[]> {
    return this.db.query<Guard>("SELECT name, description, rule FROM system_guards ORDER BY name");
  }

  async putSystemGuard(g: Guard) {
    await this.db.execute([
      run(
        `INSERT INTO system_guards (name, description, rule, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET description = excluded.description, rule = excluded.rule, updated_at = excluded.updated_at`,
        g.name,
        g.description,
        g.rule,
        Date.now(),
      ),
    ]);
  }

  async deleteSystemGuard(name: string): Promise<boolean> {
    const [r] = await this.db.execute([run("DELETE FROM system_guards WHERE name = ?", name)]);
    return (r?.rowsAffected ?? 0) > 0;
  }

  /** The rules once kept as one text (one per line) become a guard each, once; replicas doing it at once agree. */
  async migrateSystemGuards() {
    const [old] = await this.db.query<{ value: string }>("SELECT value FROM system_settings WHERE key = 'guards'");
    if (!old) return;
    const now = Date.now();
    const lines = old.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    await this.db.execute([
      ...lines.map((rule, i) => run("INSERT OR IGNORE INTO system_guards (name, description, rule, updated_at) VALUES (?, ?, ?, ?)", `pravidlo-${i + 1}`, rule.slice(0, 120), rule, now)),
      run("DELETE FROM system_settings WHERE key = 'guards'"),
    ]);
  }

  /** Replaces the project's logo; a new version gets a new URL, so browsers may cache each one for good. */
  async setLogo(id: string, image: Uint8Array, mime: string) {
    if (!this.logos) throw new Error("Logos are not configured");
    const [current] = await this.db.query<{ logo: string | null }>("SELECT logo FROM projects WHERE id = ?", [id]);
    const version = randomUUID();
    await this.logos.objects.put(logoKey(id, version), image, mime);
    await this.db.execute([run("UPDATE projects SET logo = ?, updated_at = ? WHERE id = ?", version, Date.now(), id)]);
    if (current?.logo) await this.logos.objects.delete([logoKey(id, current.logo)]).catch(() => {});
  }

  /** The stored logo of a project, if `version` is the current one. */
  async logo(id: string, version: string): ReturnType<ObjectStore["get"]> {
    const [r] = await this.db.query<{ logo: string | null }>("SELECT logo FROM projects WHERE id = ?", [id]);
    if (!this.logos || !r?.logo || r.logo !== version) return null;
    return this.logos.objects.get(logoKey(id, version));
  }

  async active(id: string): Promise<ProjectRow> {
    const project = await this.get(id);
    if (!project || project.status !== "active") throw new ProjectNotFoundError(`Project ${id} not found`);
    return project;
  }

  /** Creates the project, or brings back an archived one under the same id. */
  async create(
    id: string,
    name: string,
    features: Partial<ProjectFeatures> = {},
    start: { idleMinutes: number; storageGb: number; quotas: ProjectQuotas } = { idleMinutes: 30, storageGb: 5, quotas: NO_QUOTAS },
  ): Promise<ProjectRow> {
    const now = Date.now();
    const [result] = await this.db.execute([
      run(
        `INSERT INTO projects (id, name, status, features, quotas, idle_minutes, storage_gb, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = 'active', features = excluded.features, quotas = excluded.quotas,
           idle_minutes = excluded.idle_minutes, updated_at = excluded.updated_at
         WHERE projects.status = 'archived'`,
        id,
        name,
        JSON.stringify(features),
        JSON.stringify(start.quotas),
        start.idleMinutes,
        start.storageGb,
        now,
        now,
      ),
    ]);
    if (!result?.rowsAffected) throw new ProjectExistsError(`Project ${id} already exists`);
    return (await this.get(id, { fresh: true }))!;
  }

  async update(
    id: string,
    changes: {
      name?: string;
      features?: Partial<ProjectFeatures>;
      idleMinutes?: number;
      storageGb?: number;
      disabledTools?: string[];
      quotas?: Partial<ProjectQuotas>;
      webSites?: string[];
    },
  ) {
    const project = await this.active(id);
    const features = changes.features ? { ...project.features, ...changes.features } : project.features;
    await this.db.execute([
      run(
        "UPDATE projects SET name = ?, features = ?, quotas = ?, disabled_tools = ?, web_sites = ?, idle_minutes = ?, storage_gb = ?, updated_at = ? WHERE id = ?",
        changes.name ?? project.name,
        JSON.stringify(features),
        JSON.stringify({ ...project.quotas, ...changes.quotas }),
        JSON.stringify([...new Set(changes.disabledTools ?? project.disabledTools)].sort()),
        JSON.stringify([...new Set(changes.webSites ?? project.webSites)].sort()),
        changes.idleMinutes ?? project.idleMinutes,
        // A volume can grow but not shrink.
        Math.max(project.storageGb, changes.storageGb ?? project.storageGb),
        Date.now(),
        id,
      ),
    ]);
    return (await this.get(id, { fresh: true }))!;
  }

  /** What the runtime reports of its use; it reports only changes, so this writes only then. */
  async reportUsage(id: string, usage: ReportedUsage) {
    await this.db.execute([run("UPDATE projects SET usage = ?, usage_at = ? WHERE id = ?", JSON.stringify(usage), Date.now(), id)]);
  }

  /** Each project's analytics sites, as a system admin gave them. */
  async webSites(): Promise<Map<string, string[]>> {
    return new Map((await this.list()).map((t) => [t.id, t.webSites]));
  }

  async archive(id: string) {
    await this.db.execute([run("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), id)]);
  }

  /** What the operator should run for the project (the `Project` resource spec). */
  async spec(id: string): Promise<ProjectSpec> {
    const project = await this.get(id, { fresh: true });
    if (!project) throw new ProjectNotFoundError(`Project ${id} not found`);
    return {
      id,
      name: project.name,
      suspended: project.status === "archived",
      idleMinutes: project.idleMinutes,
      storageGb: project.storageGb,
    };
  }
}

/** The user's role in a project from their claims; `project-admin` wins over `project`. */
export const roleIn = (user: UserRecord, id: string): Role | null =>
  claimList(user.claims[CLAIMS.projectAdmin]).includes(id) ? "admin" : claimList(user.claims[CLAIMS.project]).includes(id) ? "member" : null;

/** The claim value with `id` added or removed, or null when nothing is left. */
const withProject = (value: string | undefined, id: string, present: boolean) => {
  const ids = claimList(value).filter((t) => t !== id);
  if (present) ids.push(id);
  return ids.length ? ids.join(",") : null;
};

export const userAccess = (user: UserRecord): Access => ({
  roles: claimList(user.claims[CLAIMS.role]),
  projects: claimList(user.claims[CLAIMS.project]),
  adminProjects: claimList(user.claims[CLAIMS.projectAdmin]),
});

const byName = (a: { name: string | null; email: string | null }, b: { name: string | null; email: string | null }) =>
  (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "", "cs");

/**
 * Projects with their members, kept in step with the cluster: every change is applied to the project's `Project`
 * resource, from which the operator runs (or suspends) the project's runtime.
 */
export class ProjectDirectory {
  constructor(
    readonly store: ProjectStore,
    private readonly users: UserDirectory,
    private readonly orchestrator: Orchestrator,
  ) {}

  private activeUsers = async () => (await this.users.list()).filter((u) => !u.disabled);

  async list(): Promise<ProjectSummary[]> {
    const all = await this.activeUsers();
    return (await this.store.list()).map((t) => ({ id: t.id, name: t.name, logo: t.logo, members: all.filter((u) => roleIn(u, t.id)).length }));
  }

  async sync(id: string) {
    await this.orchestrator.apply(await this.store.spec(id));
  }

  /** A new project starts with the system's defaults (features, quotas, sleep, volume), the given features over them. */
  async create(id: string, name: string, features?: Partial<ProjectFeatures>) {
    const { project: d } = await this.store.defaults();
    const project = await this.store.create(id, name, { ...d.features, ...features }, d);
    await this.sync(id);
    return project;
  }

  async update(id: string, changes: Parameters<ProjectStore["update"]>[1]) {
    const project = await this.store.update(id, changes);
    await this.sync(id);
    return project;
  }

  /** Removes the project from everyone's claims and archives it: the runtime is suspended, its volume and backups kept. */
  async remove(id: string) {
    await this.store.active(id);
    for (const user of await this.users.list()) {
      if (!roleIn(user, id)) continue;
      await this.users.setClaims(user.id, {
        [CLAIMS.project]: withProject(user.claims[CLAIMS.project], id, false),
        [CLAIMS.projectAdmin]: withProject(user.claims[CLAIMS.projectAdmin], id, false),
      });
    }
    await this.store.archive(id);
    await this.sync(id);
  }

  async members(id: string): Promise<ProjectMember[]> {
    await this.store.active(id);
    return (await this.activeUsers())
      .flatMap((u) => {
        const role = roleIn(u, id);
        return role ? [{ userId: u.id, name: u.name, email: u.email, role }] : [];
      })
      .sort(byName);
  }

  /** Makes the user a member or admin of the project, or removes them (`null`). */
  async setRole(id: string, userId: string, role: Role | null) {
    const project = await this.store.active(id);
    const user = await this.users.get(userId);
    // A new member needs room; changing a member's role or removing them always works.
    if (role && !roleIn(user, id) && project.quotas.members !== null && (await this.memberCount(id)) >= project.quotas.members) {
      throw new QuotaError("errors.quota.members", { count: project.quotas.members });
    }
    await this.users.setClaims(userId, {
      // A user is in one of the two claims only.
      [CLAIMS.project]: withProject(user.claims[CLAIMS.project], id, role === "member"),
      [CLAIMS.projectAdmin]: withProject(user.claims[CLAIMS.projectAdmin], id, role === "admin"),
      // A new member also needs the Osiris role, or the project claim alone would get them nowhere.
      ...(role && !isAuthorized(userAccess(user)) ? { [CLAIMS.role]: USER_ROLE } : {}),
    });
  }

  /**
   * Adds a person by email: an existing user joins the project, otherwise a new user is created. New users get a
   * one-time sign-in link, as they have no way to sign in yet (they set one up in their profile, or use a Google or
   * Facebook account with the same address).
   */
  async invite(id: string, person: { email: string; firstName: string; lastName: string }, role: Role) {
    await this.store.active(id);
    const existing = await this.users.findByEmail(person.email);
    if (existing) {
      await this.setRole(id, existing.id, role);
      return { userId: existing.id, created: false as const };
    }
    const user = await this.users.create({ email: person.email, firstName: person.firstName, lastName: person.lastName });
    await this.setRole(id, user.id, role);
    return { userId: user.id, created: true as const, loginLink: await this.users.loginLink(user.id, 72, "invite") };
  }

  /** Users a system admin can add to a project. */
  /** Active users whose claims name the project. */
  async memberCount(id: string): Promise<number> {
    return (await this.activeUsers()).filter((u) => roleIn(u, id)).length;
  }

  /** Every user with their access, for system admins; disabled ones too. */
  async adminUsers(): Promise<AdminUser[]> {
    const [all, active] = await Promise.all([this.users.list(), this.store.list()]);
    return all
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        picture: u.picture,
        disabled: u.disabled,
        systemAdmin: claimList(u.claims[CLAIMS.role]).includes(SYSTEM_ADMIN_ROLE),
        projects: active.flatMap((t) => {
          const role = roleIn(u, t.id);
          return role ? [{ id: t.id, role }] : [];
        }),
      }))
      .sort(byName);
  }

  async allUsers(): Promise<DirectoryUser[]> {
    return (await this.activeUsers()).map((u) => ({ id: u.id, name: u.name, email: u.email })).sort(byName);
  }
}
