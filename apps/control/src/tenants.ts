import { FEATURES, NO_QUOTAS, type AdminUser, type Guard, type SystemDefaults, type DirectoryUser, type TenantQuotas, type Role, type TenantFeatures, type TenantMember, type TenantSummary } from "@osiris/shared";
import { CLAIMS, claimList, isAuthorized, SYSTEM_ADMIN_ROLE, USER_ROLE, type Access } from "@osiris/platform/claims.ts";
import { randomUUID } from "node:crypto";
import type { ObjectStore } from "@osiris/platform/objects.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import type { Orchestrator, TenantSpec } from "./orchestrator/types.ts";
import type { UserDirectory, UserRecord } from "./users.ts";

export interface TenantRow {
  id: string;
  name: string;
  status: "active" | "archived";
  features: TenantFeatures;
  idleMinutes: number;
  storageGb: number;
  createdAt: number;
  /** Public URL of the tenant's logo, or null. */
  logo: string | null;
  /** Built-in tools switched off for the tenant, by name. */
  disabledTools: string[];
  quotas: TenantQuotas;
}

export class TenantExistsError extends Error {}
/** A quota is full; the message can be shown. */
export class QuotaError extends Error {}
export class TenantNotFoundError extends Error {}

/** Everything is on until a system admin switches it off, so features added later reach existing tenants. */
export const withDefaults = (stored: Partial<TenantFeatures>): TenantFeatures =>
  Object.fromEntries(FEATURES.map((f) => [f, stored[f] ?? true])) as TenantFeatures;

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
}

const logoKey = (id: string, version: string) => `tenant-logos/${id}/${version}`;

const toTenant = (r: Row, publicUrl = ""): TenantRow => ({
  id: r.id,
  name: r.name,
  status: r.status === "archived" ? "archived" : "active",
  features: withDefaults(JSON.parse(r.features) as Partial<TenantFeatures>),
  idleMinutes: Number(r.idle_minutes),
  storageGb: Number(r.storage_gb),
  createdAt: Number(r.created_at),
  logo: r.logo ? `${publicUrl}/auth/tenant-logos/${r.id}/${r.logo}` : null,
  disabledTools: JSON.parse(r.disabled_tools ?? "[]") as string[],
  quotas: { ...NO_QUOTAS, ...(JSON.parse(r.quotas ?? "{}") as Partial<TenantQuotas>) },
});

/** Tenants in the central database. Members are not stored here: they are the users whose claims name the tenant. */
export class TenantStore {
  constructor(
    private readonly db: Db,
    /** Where logos are kept and the browser reaches them; tools without it (the legacy import) don't touch logos. */
    private readonly logos?: { objects: ObjectStore; publicUrl: string },
  ) {}

  private toTenant = (r: Row) => toTenant(r, this.logos?.publicUrl);

  async list({ archived = false } = {}): Promise<TenantRow[]> {
    const rows = await this.db.query<Row>(`SELECT * FROM tenants ${archived ? "" : "WHERE status = 'active'"} ORDER BY id`);
    return rows.map(this.toTenant);
  }

  async get(id: string, { fresh = false } = {}): Promise<TenantRow | null> {
    const [row] = await this.db.query<Row>("SELECT * FROM tenants WHERE id = ?", [id], { fresh });
    return row ? this.toTenant(row) : null;
  }

  /** What new tenants and users start with; until a system admin sets them, everything on and no limits. */
  async defaults(): Promise<SystemDefaults> {
    const [r] = await this.db.query<{ value: string }>("SELECT value FROM system_settings WHERE key = 'defaults'");
    const stored = r ? (JSON.parse(r.value) as Partial<SystemDefaults>) : {};
    return {
      tenant: {
        idleMinutes: 30,
        storageGb: 5,
        ...stored.tenant,
        features: withDefaults(stored.tenant?.features ?? {}),
        quotas: { ...NO_QUOTAS, ...stored.tenant?.quotas },
      },
      user: { address: "auto", language: "auto", ...stored.user },
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

  /** Rules every tenant's assistant keeps to, above the tenant's, the users' and the public assistants' own. */
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

  /** Replaces the tenant's logo; a new version gets a new URL, so browsers may cache each one for good. */
  async setLogo(id: string, image: Uint8Array, mime: string) {
    if (!this.logos) throw new Error("Logos are not configured");
    const [current] = await this.db.query<{ logo: string | null }>("SELECT logo FROM tenants WHERE id = ?", [id]);
    const version = randomUUID();
    await this.logos.objects.put(logoKey(id, version), image, mime);
    await this.db.execute([run("UPDATE tenants SET logo = ?, updated_at = ? WHERE id = ?", version, Date.now(), id)]);
    if (current?.logo) await this.logos.objects.delete([logoKey(id, current.logo)]).catch(() => {});
  }

  /** The stored logo of a tenant, if `version` is the current one. */
  async logo(id: string, version: string): ReturnType<ObjectStore["get"]> {
    const [r] = await this.db.query<{ logo: string | null }>("SELECT logo FROM tenants WHERE id = ?", [id]);
    if (!this.logos || !r?.logo || r.logo !== version) return null;
    return this.logos.objects.get(logoKey(id, version));
  }

  async active(id: string): Promise<TenantRow> {
    const tenant = await this.get(id);
    if (!tenant || tenant.status !== "active") throw new TenantNotFoundError(`Tenant ${id} not found`);
    return tenant;
  }

  /** Creates the tenant, or brings back an archived one under the same id. */
  async create(
    id: string,
    name: string,
    features: Partial<TenantFeatures> = {},
    start: { idleMinutes: number; storageGb: number; quotas: TenantQuotas } = { idleMinutes: 30, storageGb: 5, quotas: NO_QUOTAS },
  ): Promise<TenantRow> {
    const now = Date.now();
    const [result] = await this.db.execute([
      run(
        `INSERT INTO tenants (id, name, status, features, quotas, idle_minutes, storage_gb, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = 'active', features = excluded.features, quotas = excluded.quotas,
           idle_minutes = excluded.idle_minutes, updated_at = excluded.updated_at
         WHERE tenants.status = 'archived'`,
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
    if (!result?.rowsAffected) throw new TenantExistsError(`Tenant ${id} already exists`);
    return (await this.get(id, { fresh: true }))!;
  }

  async update(
    id: string,
    changes: {
      name?: string;
      features?: Partial<TenantFeatures>;
      idleMinutes?: number;
      storageGb?: number;
      disabledTools?: string[];
      quotas?: Partial<TenantQuotas>;
    },
  ) {
    const tenant = await this.active(id);
    const features = changes.features ? { ...tenant.features, ...changes.features } : tenant.features;
    await this.db.execute([
      run(
        "UPDATE tenants SET name = ?, features = ?, quotas = ?, disabled_tools = ?, idle_minutes = ?, storage_gb = ?, updated_at = ? WHERE id = ?",
        changes.name ?? tenant.name,
        JSON.stringify(features),
        JSON.stringify({ ...tenant.quotas, ...changes.quotas }),
        JSON.stringify([...new Set(changes.disabledTools ?? tenant.disabledTools)].sort()),
        changes.idleMinutes ?? tenant.idleMinutes,
        // A volume can grow but not shrink.
        Math.max(tenant.storageGb, changes.storageGb ?? tenant.storageGb),
        Date.now(),
        id,
      ),
    ]);
    return (await this.get(id, { fresh: true }))!;
  }

  async archive(id: string) {
    await this.db.execute([run("UPDATE tenants SET status = 'archived', updated_at = ? WHERE id = ?", Date.now(), id)]);
  }

  /** What the operator should run for the tenant (the `Tenant` resource spec). */
  async spec(id: string): Promise<TenantSpec> {
    const tenant = await this.get(id, { fresh: true });
    if (!tenant) throw new TenantNotFoundError(`Tenant ${id} not found`);
    const domains = await this.db.query<{ domain: string }>(
      "SELECT domain FROM domains WHERE tenant_id = ? AND status = 'verified' ORDER BY domain",
      [id],
      { fresh: true },
    );
    return {
      id,
      name: tenant.name,
      suspended: tenant.status === "archived",
      idleMinutes: tenant.idleMinutes,
      storageGb: tenant.storageGb,
      domains: domains.map((d) => d.domain),
    };
  }
}

/** The user's role in a tenant from their claims; `tenant-admin` wins over `tenant`. */
export const roleIn = (user: UserRecord, id: string): Role | null =>
  claimList(user.claims[CLAIMS.tenantAdmin]).includes(id) ? "admin" : claimList(user.claims[CLAIMS.tenant]).includes(id) ? "member" : null;

/** The claim value with `id` added or removed, or null when nothing is left. */
const withTenant = (value: string | undefined, id: string, present: boolean) => {
  const ids = claimList(value).filter((t) => t !== id);
  if (present) ids.push(id);
  return ids.length ? ids.join(",") : null;
};

export const userAccess = (user: UserRecord): Access => ({
  roles: claimList(user.claims[CLAIMS.role]),
  tenants: claimList(user.claims[CLAIMS.tenant]),
  adminTenants: claimList(user.claims[CLAIMS.tenantAdmin]),
});

const byName = (a: { name: string | null; email: string | null }, b: { name: string | null; email: string | null }) =>
  (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "", "cs");

/**
 * Tenants with their members, kept in step with the cluster: every change is applied to the tenant's `Tenant`
 * resource, from which the operator runs (or suspends) the tenant's runtime.
 */
export class TenantDirectory {
  constructor(
    readonly store: TenantStore,
    private readonly users: UserDirectory,
    private readonly orchestrator: Orchestrator,
  ) {}

  private activeUsers = async () => (await this.users.list()).filter((u) => !u.disabled);

  async list(): Promise<TenantSummary[]> {
    const all = await this.activeUsers();
    return (await this.store.list()).map((t) => ({ id: t.id, name: t.name, logo: t.logo, members: all.filter((u) => roleIn(u, t.id)).length }));
  }

  async sync(id: string) {
    await this.orchestrator.apply(await this.store.spec(id));
  }

  /** A new tenant starts with the system's defaults (features, quotas, sleep, volume), the given features over them. */
  async create(id: string, name: string, features?: Partial<TenantFeatures>) {
    const { tenant: d } = await this.store.defaults();
    const tenant = await this.store.create(id, name, { ...d.features, ...features }, d);
    await this.sync(id);
    return tenant;
  }

  async update(id: string, changes: Parameters<TenantStore["update"]>[1]) {
    const tenant = await this.store.update(id, changes);
    await this.sync(id);
    return tenant;
  }

  /** Removes the tenant from everyone's claims and archives it: the runtime is suspended, its volume and backups kept. */
  async remove(id: string) {
    await this.store.active(id);
    for (const user of await this.users.list()) {
      if (!roleIn(user, id)) continue;
      await this.users.setClaims(user.id, {
        [CLAIMS.tenant]: withTenant(user.claims[CLAIMS.tenant], id, false),
        [CLAIMS.tenantAdmin]: withTenant(user.claims[CLAIMS.tenantAdmin], id, false),
      });
    }
    await this.store.archive(id);
    await this.sync(id);
  }

  async members(id: string): Promise<TenantMember[]> {
    await this.store.active(id);
    return (await this.activeUsers())
      .flatMap((u) => {
        const role = roleIn(u, id);
        return role ? [{ userId: u.id, name: u.name, email: u.email, role }] : [];
      })
      .sort(byName);
  }

  /** Makes the user a member or admin of the tenant, or removes them (`null`). */
  async setRole(id: string, userId: string, role: Role | null) {
    const tenant = await this.store.active(id);
    const user = await this.users.get(userId);
    // A new member needs room; changing a member's role or removing them always works.
    if (role && !roleIn(user, id) && tenant.quotas.members !== null && (await this.memberCount(id)) >= tenant.quotas.members) {
      throw new QuotaError(`Tenant může mít nejvýš ${tenant.quotas.members} uživatelů`);
    }
    await this.users.setClaims(userId, {
      // A user is in one of the two claims only.
      [CLAIMS.tenant]: withTenant(user.claims[CLAIMS.tenant], id, role === "member"),
      [CLAIMS.tenantAdmin]: withTenant(user.claims[CLAIMS.tenantAdmin], id, role === "admin"),
      // A new member also needs the Osiris role, or the tenant claim alone would get them nowhere.
      ...(role && !isAuthorized(userAccess(user)) ? { [CLAIMS.role]: USER_ROLE } : {}),
    });
  }

  /**
   * Adds a person by email: an existing user joins the tenant, otherwise a new user is created. New users get a
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

  /** Users a system admin can add to a tenant. */
  /** Active users whose claims name the tenant. */
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
        tenants: active.flatMap((t) => {
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
