import { randomUUID } from "node:crypto";
import type { ObjectStore } from "@osiris/platform/objects.ts";
import { DbError, run, type Db, type Statement } from "@osiris/platform/rqlite.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";
import { newToken, sha256 } from "./secrets.ts";

/** A user, with the groups that grant access (`osiris-user`, `osiris-admin`, `project:<slug>`, `project-admin:<slug>`). */
export interface UserRecord {
  id: string;
  name: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  emailVerified: boolean;
  disabled: boolean;
  /** E.164, verified over WhatsApp. */
  phone: string | null;
  /** Public URL of the profile picture, or null. */
  picture: string | null;
  /** Names of the user's groups, sorted. */
  groups: string[];
  createdAt: number;
  updatedAt: number;
}

export interface NewUser {
  email: string | null;
  firstName: string;
  lastName: string;
  /** Kept when importing, so the user's data in the projects stays theirs; new users get a UUID. */
  id?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  phone?: string | null;
  groups?: string[];
}

export interface UserChanges {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  disabled?: boolean;
}

export interface GroupRecord {
  /** The name: groups are known by it, so it never changes. */
  id: string;
  members: string[];
  createdAt: number;
}

/** What a one-time sign-in link is for; shown nowhere, kept for the audit trail. */
export type LinkPurpose = "invite" | "admin" | "email";

export class UserNotFoundError extends Error {}
/** The data was refused, e.g. the email is taken; the message can be shown. */
export class UserInputError extends LocalizedError {}

interface Row {
  id: string;
  email: string | null;
  email_verified: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  disabled: number;
  picture: string | null;
  created_at: number;
  updated_at: number;
  groups: string | null;
}

// Group names joined with a newline, which a name can't contain (GROUP_NAME).
const SELECT = `SELECT u.id, u.email, u.email_verified, u.first_name, u.last_name, u.phone, u.disabled, u.picture, u.created_at, u.updated_at,
  (SELECT group_concat(group_id, char(10)) FROM (SELECT group_id FROM group_members WHERE user_id = u.id ORDER BY group_id)) AS groups FROM users u`;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const GROUP_NAME = /^[a-z0-9][a-z0-9:._-]{0,99}$/;

/** Object keys take a limited alphabet; user ids may be anything (`dev:alice`, UUIDs from PocketID). */
const pictureKey = (userId: string, version: string) => `pictures/${Buffer.from(userId).toString("base64url")}/${version}`;

const uniqueViolation = (err: unknown, column: string) => err instanceof DbError && new RegExp(`UNIQUE constraint failed: ${column}`, "i").test(err.message);

/**
 * Users and groups in osiris-auth's database. `publicUrl` is where browsers reach osiris-auth (picture and sign-in
 * link URLs); pictures live in object storage (a folder on the service's volume).
 */
export class Users {
  private readonly base: string;

  constructor(
    private readonly db: Db,
    private readonly options: { objects: ObjectStore; publicUrl: string },
  ) {
    this.base = options.publicUrl.replace(/\/$/, "");
  }

  private record = (r: Row): UserRecord => {
    const firstName = r.first_name ?? "";
    const lastName = r.last_name ?? "";
    return {
      id: r.id,
      name: `${firstName} ${lastName}`.trim() || null,
      firstName,
      lastName,
      email: r.email,
      emailVerified: !!r.email_verified,
      disabled: !!r.disabled,
      phone: r.phone,
      picture: r.picture ? `${this.base}/pictures/${encodeURIComponent(r.id)}/${r.picture}` : null,
      groups: r.groups ? r.groups.split("\n") : [],
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  };

  private async write(statements: Statement[]) {
    try {
      return await this.db.execute(statements);
    } catch (err) {
      if (uniqueViolation(err, "users\\.email")) throw new UserInputError("errors.user.emailTaken");
      if (uniqueViolation(err, "users\\.id")) throw new UserInputError("errors.user.exists");
      throw err;
    }
  }

  /** Statements that make sure groups exist, and put the user in them. */
  private joins(userId: string, groups: string[], now: number): Statement[] {
    return groups.flatMap((g) => [
      run("INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", g, g, now),
      run("INSERT INTO group_members (group_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", g, userId),
    ]);
  }

  async list(): Promise<UserRecord[]> {
    return (await this.db.query<Row>(`${SELECT} ORDER BY u.created_at, u.id`)).map(this.record);
  }

  async get(userId: string): Promise<UserRecord> {
    const [r] = await this.db.query<Row>(`${SELECT} WHERE u.id = ?`, [userId], { fresh: true });
    if (!r) throw new UserNotFoundError(`User ${userId} not found`);
    return this.record(r);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [r] = await this.db.query<Row>(`${SELECT} WHERE u.email = ?`, [normalizeEmail(email)], { fresh: true });
    return r ? this.record(r) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    const id = user.id ?? randomUUID();
    const now = Date.now();
    const groups = user.groups ?? [];
    if (groups.some((g) => !GROUP_NAME.test(g))) throw new UserInputError("errors.group.name");
    await this.write([
      run(
        `INSERT INTO users (id, email, email_verified, first_name, last_name, phone, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        user.email ? normalizeEmail(user.email) : null,
        user.emailVerified ? 1 : 0,
        user.firstName.trim(),
        user.lastName.trim(),
        user.phone ?? null,
        user.disabled ? 1 : 0,
        now,
        now,
      ),
      ...this.joins(id, groups, now),
    ]);
    return this.get(id);
  }

  async update(userId: string, changes: UserChanges): Promise<UserRecord> {
    const current = await this.get(userId);
    const email = changes.email !== undefined ? (changes.email ? normalizeEmail(changes.email) : null) : current.email;
    await this.write([
      run(
        "UPDATE users SET first_name = ?, last_name = ?, email = ?, email_verified = ?, phone = ?, disabled = ?, updated_at = ? WHERE id = ?",
        (changes.firstName ?? current.firstName).trim(),
        (changes.lastName ?? current.lastName).trim(),
        email,
        // A new address isn't verified until the user proves it (an emailed link, a social account).
        email === current.email && current.emailVerified ? 1 : 0,
        changes.phone !== undefined ? changes.phone : current.phone,
        (changes.disabled ?? current.disabled) ? 1 : 0,
        Date.now(),
        userId,
      ),
    ]);
    return this.get(userId);
  }

  /** Removes the user with their sign-in methods, memberships and sessions. */
  async remove(userId: string): Promise<void> {
    const user = await this.get(userId);
    await this.db.execute([
      ...["group_members", "recovery_codes", "passkeys", "user_identities", "login_links", "auth_events", "auth_session_info"].map((t) => run(`DELETE FROM ${t} WHERE user_id = ?`, userId)),
      run("DELETE FROM oidc_store WHERE json_extract(payload, '$.accountId') = ?", userId),
      run("DELETE FROM users WHERE id = ?", userId),
    ]);
    if (user.picture) await this.options.objects.delete([pictureKey(userId, user.picture.split("/").at(-1)!)]).catch(() => {});
  }

  async setPicture(userId: string, image: Uint8Array, mime: string): Promise<void> {
    const [current] = await this.db.query<{ picture: string | null }>("SELECT picture FROM users WHERE id = ?", [userId], { fresh: true });
    if (!current) throw new UserNotFoundError(`User ${userId} not found`);
    const version = newToken().slice(0, 16);
    await this.options.objects.put(pictureKey(userId, version), image, mime);
    await this.write([run("UPDATE users SET picture = ?, updated_at = ? WHERE id = ?", version, Date.now(), userId)]);
    if (current.picture) await this.options.objects.delete([pictureKey(userId, current.picture)]).catch(() => {});
  }

  /** The stored picture of a user, if `version` is the current one. */
  async picture(userId: string, version: string): ReturnType<ObjectStore["get"]> {
    const [r] = await this.db.query<{ picture: string | null }>("SELECT picture FROM users WHERE id = ?", [userId]);
    if (!r?.picture || r.picture !== version) return null;
    return this.options.objects.get(pictureKey(userId, version));
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.write([run("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ? AND email_verified = 0", Date.now(), userId)]);
  }

  /** A one-time sign-in link for the user, e.g. for a new user who has no way to sign in yet. */
  async loginLink(userId: string, ttlHours: number, purpose: LinkPurpose = "admin"): Promise<string> {
    await this.get(userId);
    const token = newToken();
    await this.db.execute([
      run("INSERT INTO login_links (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)", sha256(token), userId, purpose, Date.now() + ttlHours * 3_600_000),
    ]);
    return `${this.base}/link/${token}`;
  }

  // --- groups ---------------------------------------------------------------------------------------------------------

  async groups(): Promise<GroupRecord[]> {
    const rows = await this.db.query<{ id: string; created_at: number; members: string | null }>(
      "SELECT g.id, g.created_at, (SELECT group_concat(user_id, char(10)) FROM group_members WHERE group_id = g.id) AS members FROM groups g ORDER BY g.id",
    );
    return rows.map((r) => ({ id: r.id, createdAt: Number(r.created_at), members: r.members ? r.members.split("\n").sort() : [] }));
  }

  async group(id: string): Promise<GroupRecord | null> {
    return (await this.groups()).find((g) => g.id === id) ?? null;
  }

  async createGroup(id: string, members: string[] = []): Promise<GroupRecord> {
    if (!GROUP_NAME.test(id)) throw new UserInputError("errors.group.name");
    const now = Date.now();
    try {
      await this.db.execute([run("INSERT INTO groups (id, display_name, created_at) VALUES (?, ?, ?)", id, id, now), ...(await this.memberStatements(id, members, []))]);
    } catch (err) {
      if (uniqueViolation(err, "groups\\.")) throw new UserInputError("errors.group.exists");
      throw err;
    }
    return (await this.group(id))!;
  }

  /** Adds and removes members in one write; unknown users are refused. */
  async changeMembers(id: string, add: string[], remove: string[]): Promise<GroupRecord> {
    if (!(await this.group(id))) throw new UserNotFoundError(`Group ${id} not found`);
    await this.db.execute(await this.memberStatements(id, add, remove));
    return (await this.group(id))!;
  }

  async deleteGroup(id: string): Promise<boolean> {
    const [, r] = await this.db.execute([run("DELETE FROM group_members WHERE group_id = ?", id), run("DELETE FROM groups WHERE id = ?", id)]);
    return r!.rowsAffected > 0;
  }

  private async memberStatements(id: string, add: string[], remove: string[]): Promise<Statement[]> {
    for (const userId of add) await this.get(userId).catch(() => {
      throw new UserInputError("errors.group.unknownMember", { id: userId });
    });
    return [
      ...add.map((userId) => run("INSERT INTO group_members (group_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, userId)),
      ...remove.map((userId) => run("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", id, userId)),
    ];
  }
}
