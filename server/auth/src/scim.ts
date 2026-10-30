import { Hono, type Context } from "hono";
import { run, type Db } from "@osiris/platform/db.ts";
import type { Credentials } from "./credentials.ts";
import { newToken, sha256 } from "./secrets.ts";
import { UserInputError, UserNotFoundError, type GroupRecord, type LinkPurpose, type UserChanges, type UserRecord, type Users } from "./users.ts";

/**
 * SCIM 2.0 (RFC 7643, RFC 7644) over users and groups, for other services (control) with a bearer service token.
 * Supported: Users and Groups with GET (filter `attr eq "value"` joined by `and`, startIndex/count), POST, PUT, PATCH
 * (add/replace/remove), DELETE. Not: bulk, sorting, ETags, /Me, other filter operators.
 */
export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const MAX_COUNT = 1000;
const PICTURE_MAX_BYTES = 2 * 1024 * 1024;

type Json = Record<string, unknown>;

export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
  }
}

/** A service's SCIM token: shown once, stored as its hash. */
export async function createServiceToken(db: Db, name: string): Promise<string> {
  const token = `osiris_scim_${newToken()}`;
  await db.execute([
    run(
      "INSERT INTO service_tokens (token_hash, name, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at",
      sha256(token),
      name,
      Date.now(),
    ),
  ]);
  return token;
}

/** Services with a SCIM token (names and when made; the tokens themselves are only hashes). */
export const serviceTokens = async (db: Db) =>
  (await db.query<{ name: string; created_at: number }>("SELECT name, created_at FROM service_tokens ORDER BY name")).map((r) => ({ name: r.name, createdAt: Number(r.created_at) }));

export const deleteServiceToken = async (db: Db, name: string) => (await db.execute([run("DELETE FROM service_tokens WHERE name = ?", name)]))[0]!.rowsAffected > 0;

const iso = (ms: number) => new Date(ms).toISOString();

export function userResource(u: UserRecord, base: string): Json {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.email ?? u.id,
    name: { givenName: u.firstName, familyName: u.lastName, formatted: u.name ?? "" },
    displayName: u.name ?? u.email ?? u.id,
    active: !u.disabled,
    emails: u.email ? [{ value: u.email, primary: true, type: "work" }] : [],
    phoneNumbers: u.phone ? [{ value: u.phone, type: "mobile" }] : [],
    photos: u.picture ? [{ value: u.picture, type: "photo" }] : [],
    groups: u.groups.map((g) => ({ value: g, display: g, $ref: `${base}/Groups/${encodeURIComponent(g)}` })),
    meta: { resourceType: "User", created: iso(u.createdAt), lastModified: iso(u.updatedAt), location: `${base}/Users/${encodeURIComponent(u.id)}` },
  };
}

export function groupResource(g: GroupRecord, base: string): Json {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    displayName: g.id,
    members: g.members.map((m) => ({ value: m, $ref: `${base}/Users/${encodeURIComponent(m)}`, type: "User" })),
    meta: { resourceType: "Group", created: iso(g.createdAt), location: `${base}/Groups/${encodeURIComponent(g.id)}` },
  };
}

const isObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const first = (list: unknown) => (Array.isArray(list) ? (list.find((e) => (e as Json)?.primary) ?? list[0]) as Json | undefined : undefined);

/** What a full User resource (POST, PUT, or a patched one) sets. */
function userChanges(r: Json): UserChanges {
  const name = (r.name ?? {}) as Json;
  const email = str(first(r.emails)?.value) ?? (str(r.userName)?.includes("@") ? str(r.userName) : undefined);
  const changes: UserChanges = {
    firstName: str(name.givenName) ?? "",
    lastName: str(name.familyName) ?? "",
    email: email ?? null,
    phone: str(first(r.phoneNumbers)?.value) ?? null,
  };
  if (r.active !== undefined) {
    if (typeof r.active !== "boolean") throw new ScimError(400, "active must be a boolean", "invalidValue");
    changes.disabled = !r.active;
  }
  if (changes.phone && !/^\+?[\d ]{7,20}$/.test(changes.phone)) throw new ScimError(400, "phoneNumbers must be a phone number", "invalidValue");
  if (changes.firstName!.length > 100 || changes.lastName!.length > 100) throw new ScimError(400, "name too long", "invalidValue");
  return changes;
}

/** Filters of the form `attr eq "value"` joined by `and`; attributes are matched case-insensitively. */
export function parseFilter(filter: string | undefined): { attr: string; value: string }[] {
  if (!filter?.trim()) return [];
  return filter.split(/\s+and\s+/i).map((part) => {
    const m = /^\s*([A-Za-z][\w.]*)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)\s*$/i.exec(part);
    if (!m) throw new ScimError(400, `Unsupported filter: ${part}`, "invalidFilter");
    return { attr: m[1]!.toLowerCase(), value: String(JSON.parse(m[2]!)) };
  });
}

/** The values of a dotted attribute in a resource (`emails.value` gives every email). */
function valuesOf(resource: Json, attr: string): string[] {
  let current: unknown[] = [resource];
  for (const key of attr.split(".")) {
    current = current.flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const found = Object.entries(v as Json).find(([k]) => k.toLowerCase() === key)?.[1];
      return Array.isArray(found) ? found : found === undefined ? [] : [found];
    });
  }
  return current.map((v) => String(v));
}

// shortcut: filters run over the full list in memory, fine for thousands of users; an indexed query when far more.
const matches = (resource: Json, filters: { attr: string; value: string }[]) =>
  filters.every(({ attr, value }) => {
    const caseless = attr === "username" || attr.startsWith("emails");
    return valuesOf(resource, attr).some((v) => (caseless ? v.toLowerCase() === value.toLowerCase() : v === value));
  });

/** Applies PATCH operations to a resource as plain JSON (paths `a`, `a.b`, and `members[value eq "x"]`). */
export function applyPatch(resource: Json, body: Json): Json {
  if (!Array.isArray(body.schemas) || !body.schemas.includes(PATCH_SCHEMA) || !Array.isArray(body.Operations)) {
    throw new ScimError(400, "Expected a PatchOp with Operations", "invalidSyntax");
  }
  const out = structuredClone(resource);
  for (const raw of body.Operations as Json[]) {
    const op = String(raw.op ?? "").toLowerCase();
    const path = str(raw.path);
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, `Unsupported op ${raw.op}`, "invalidSyntax");
    if (!path) {
      if (op === "remove" || !raw.value || typeof raw.value !== "object") throw new ScimError(400, "An operation without path needs an object value", "noTarget");
      for (const [k, v] of Object.entries(raw.value as Json)) Object.assign(out, applyPatch(out, { schemas: [PATCH_SCHEMA], Operations: [{ op, path: k, value: v }] }));
      continue;
    }
    const filtered = /^(\w+)\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i.exec(path);
    if (filtered) {
      const key = filtered[1]!;
      const value = JSON.parse(`"${filtered[2]}"`) as string;
      if (op !== "remove") throw new ScimError(400, "Only remove takes a value filter", "invalidPath");
      out[key] = ((out[key] as Json[]) ?? []).filter((e) => e.value !== value);
      continue;
    }
    const keys = path.split(".");
    if (keys.length > 2 || keys.some((k) => !/^\w+$/.test(k))) throw new ScimError(400, `Unsupported path ${path}`, "invalidPath");
    const parent = keys.length === 2 ? ((out[keys[0]!] ??= {}) as Json) : out;
    const key = keys.at(-1)!;
    if (op === "remove") delete parent[key];
    else if (op === "add" && Array.isArray(parent[key]) && Array.isArray(raw.value)) parent[key] = [...(parent[key] as unknown[]), ...raw.value];
    // A complex attribute keeps the sub-attributes the value doesn't name (RFC 7644 3.5.2.3).
    else if (isObject(parent[key]) && isObject(raw.value)) parent[key] = { ...(parent[key] as Json), ...(raw.value as Json) };
    else parent[key] = raw.value;
  }
  return out;
}

const memberIds = (list: unknown): string[] => {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ScimError(400, "members must be a list", "invalidValue");
  return list.map((m) => {
    const value = str((m as Json)?.value);
    if (!value) throw new ScimError(400, "Every member needs a value", "invalidValue");
    return value;
  });
};

export interface ScimDeps {
  db: Db;
  users: Users;
  credentials: Credentials;
  /** Where SCIM is reached: `<issuer>/scim/v2`. */
  base: string;
  /** Whether the call comes from an admin's browser (the admin pages), besides service tokens. */
  admin?: (c: Context) => Promise<boolean>;
}

/** The SCIM API at `/scim/v2`, plus three endpoints SCIM has no standard for (sign-in link, photo, second factor). */
export function scimRoutes({ db, users, credentials, base, admin }: ScimDeps) {
  const json = async (c: Context): Promise<Json> => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScimError(400, "Invalid JSON", "invalidSyntax");
    return body as Json;
  };
  const scim = (c: Context, body: Json, status: 200 | 201 = 200) => c.body(JSON.stringify(body), status, { "content-type": "application/scim+json" });
  const list = (c: Context, all: Json[]) => {
    const start = Math.max(1, Number(c.req.query("startIndex") ?? 1) || 1);
    const count = Math.min(MAX_COUNT, Math.max(0, Number(c.req.query("count") ?? MAX_COUNT) || 0));
    const page = all.slice(start - 1, start - 1 + count);
    return scim(c, { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex: start, itemsPerPage: page.length, Resources: page });
  };
  const user = async (id: string) => users.get(id).catch((err) => {
    if (err instanceof UserNotFoundError) throw new ScimError(404, `User ${id} not found`);
    throw err;
  });
  const group = async (id: string) => {
    const g = await users.group(id);
    if (!g) throw new ScimError(404, `Group ${id} not found`);
    return g;
  };
  /** A full User resource replaces what it names; `groups` is read-only (memberships go through Groups). */
  const saveUser = async (id: string, resource: Json) => userResource(await users.update(id, userChanges(resource)), base);

  return new Hono()
    .use(async (c, next) => {
      const token = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      const [known] = token ? await db.query("SELECT name FROM service_tokens WHERE token_hash = ?", [sha256(token)]) : [];
      if (!known && !(admin && !token && (await admin(c)))) throw new ScimError(401, "A service token is required");
      await next();
    })
    .get("/ServiceProviderConfig", (c) =>
      scim(c, {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: MAX_COUNT },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [{ type: "oauthbearertoken", name: "Service token", description: "Bearer token made by `pnpm --filter @osiris/auth cli token <name>`", primary: true }],
      }),
    )
    .get("/ResourceTypes", (c) =>
      list(c, [
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA },
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP_SCHEMA },
      ]),
    )
    .get("/Schemas", (c) =>
      list(c, [
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], id: USER_SCHEMA, name: "User", attributes: ["userName", "name", "displayName", "active", "emails", "phoneNumbers", "photos", "groups"].map((name) => ({ name, mutability: name === "groups" || name === "photos" ? "readOnly" : "readWrite" })) },
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], id: GROUP_SCHEMA, name: "Group", attributes: [{ name: "displayName", mutability: "immutable" }, { name: "members", mutability: "readWrite" }] },
      ]),
    )

    .get("/Users", async (c) => {
      const filters = parseFilter(c.req.query("filter"));
      return list(c, (await users.list()).map((u) => userResource(u, base)).filter((r) => matches(r, filters)));
    })
    .get("/Users/:id", async (c) => scim(c, userResource(await user(c.req.param("id")), base)))
    .post("/Users", async (c) => {
      const r = await json(c);
      const changes = userChanges(r);
      const created = await users.create({
        email: changes.email ?? null,
        firstName: changes.firstName ?? "",
        lastName: changes.lastName ?? "",
        phone: changes.phone,
        disabled: changes.disabled,
      });
      return scim(c, userResource(created, base), 201);
    })
    .put("/Users/:id", async (c) => {
      await user(c.req.param("id"));
      return scim(c, await saveUser(c.req.param("id"), await json(c)));
    })
    .patch("/Users/:id", async (c) => {
      const id = c.req.param("id");
      return scim(c, await saveUser(id, applyPatch(userResource(await user(id), base), await json(c))));
    })
    .delete("/Users/:id", async (c) => {
      await user(c.req.param("id"));
      await users.remove(c.req.param("id"));
      return c.body(null, 204);
    })

    // Extension: a one-time sign-in link (an invitation, or a link an admin passes on).
    .post("/Users/:id/signInLink", async (c) => {
      const u = await user(c.req.param("id"));
      const r = await json(c);
      const purpose = (["invite", "admin"] as LinkPurpose[]).find((p) => p === r.purpose) ?? "admin";
      const hours = Math.min(168, Math.max(1, Number(r.ttlHours) || 72));
      if (u.disabled) throw new ScimError(400, "The user is disabled", "invalidValue");
      // Where the browser goes once the link is opened (the app's page that starts its sign-in); checked then.
      const returnTo = typeof r.returnTo === "string" && r.returnTo.length <= 500 ? r.returnTo : undefined;
      return scim(c, { link: await users.loginLink(u.id, hours, purpose, returnTo) }, 201);
    })
    // Extension: the profile picture (PNG or JPEG, at most 2 MB), served at the user's `photos` URL.
    .put("/Users/:id/photo", async (c) => {
      await user(c.req.param("id"));
      const data = new Uint8Array(await c.req.arrayBuffer());
      const mime = data[0] === 0x89 && data[1] === 0x50 ? "image/png" : data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg" : null;
      if (!mime || data.length > PICTURE_MAX_BYTES) throw new ScimError(400, "A PNG or JPEG of at most 2 MB", "invalidValue");
      await users.setPicture(c.req.param("id"), data, mime);
      return c.body(null, 204);
    })
    // Extension: for a user who lost both their authenticator and recovery codes.
    .delete("/Users/:id/secondFactor", async (c) => {
      await user(c.req.param("id"));
      await credentials.disableTotp(c.req.param("id"));
      return c.body(null, 204);
    })

    .get("/Groups", async (c) => {
      const filters = parseFilter(c.req.query("filter"));
      return list(c, (await users.groups()).map((g) => groupResource(g, base)).filter((r) => matches(r, filters)));
    })
    .get("/Groups/:id", async (c) => scim(c, groupResource(await group(c.req.param("id")), base)))
    .post("/Groups", async (c) => {
      const r = await json(c);
      const name = str(r.displayName);
      if (!name) throw new ScimError(400, "displayName is required", "invalidValue");
      return scim(c, groupResource(await users.createGroup(name, memberIds(r.members)), base), 201);
    })
    .put("/Groups/:id", async (c) => {
      const current = await group(c.req.param("id"));
      const r = await json(c);
      if (r.displayName !== undefined && r.displayName !== current.id) throw new ScimError(400, "displayName can't change", "mutability");
      const next = new Set(memberIds(r.members));
      const updated = await users.changeMembers(current.id, [...next].filter((m) => !current.members.includes(m)), current.members.filter((m) => !next.has(m)));
      return scim(c, groupResource(updated, base));
    })
    .patch("/Groups/:id", async (c) => {
      const current = await group(c.req.param("id"));
      const patched = applyPatch(groupResource(current, base), await json(c));
      if (patched.displayName !== current.id) throw new ScimError(400, "displayName can't change", "mutability");
      const next = new Set(memberIds(patched.members));
      const updated = await users.changeMembers(current.id, [...next].filter((m) => !current.members.includes(m)), current.members.filter((m) => !next.has(m)));
      return scim(c, groupResource(updated, base));
    })
    .delete("/Groups/:id", async (c) => {
      if (!(await users.deleteGroup(c.req.param("id")))) throw new ScimError(404, `Group ${c.req.param("id")} not found`);
      return c.body(null, 204);
    })

    .onError((err, c) => {
      const e =
        err instanceof ScimError
          ? err
          : err instanceof UserInputError
            ? new ScimError(/exists|taken/i.test(err.key) ? 409 : 400, err.message, /exists|taken/i.test(err.key) ? "uniqueness" : "invalidValue")
            : null;
      if (!e) {
        console.error(err);
        return c.body(JSON.stringify({ schemas: [ERROR_SCHEMA], status: "500", detail: "Internal server error" }), 500, { "content-type": "application/scim+json" });
      }
      return c.body(JSON.stringify({ schemas: [ERROR_SCHEMA], status: String(e.status), ...(e.scimType ? { scimType: e.scimType } : {}), detail: e.message }), e.status as 400, {
        "content-type": "application/scim+json",
      });
    });
}
