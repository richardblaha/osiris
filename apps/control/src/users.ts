import { randomUUID } from "node:crypto";
import type { ObjectStore } from "@osiris/platform/objects.ts";
import { DbError, run, type Db } from "@osiris/platform/rqlite.ts";
import { newToken, sha256 } from "./auth/secrets.ts";

/** A user with their claims (`phone_number`, `role`, `tenant`, `tenant-admin`, ...). */
export interface UserRecord {
  id: string;
  name: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  emailVerified: boolean;
  disabled: boolean;
  claims: Record<string, string>;
  /** Public URL of the profile picture, or null. */
  picture: string | null;
}

export interface NewUser {
  email: string | null;
  firstName: string;
  lastName: string;
  /** Kept when importing from PocketID, so the user's data in the tenants stays theirs; new users get a UUID. */
  id?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  claims?: Record<string, string>;
}

export interface ProfileChanges {
  firstName?: string;
  lastName?: string;
  email?: string;
}

/** What a one-time sign-in link is for; shown nowhere, kept for the audit trail. */
export type LinkPurpose = "invite" | "admin" | "email";

/** The users behind the tokens: tenant members, roles, profiles and lookup by phone. Only control has it. */
export interface UserDirectory {
  list(): Promise<UserRecord[]>;
  get(userId: string): Promise<UserRecord>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** Sets (string) or removes (null) claims of a user; other claims are kept. */
  setClaims(userId: string, changes: Record<string, string | null>): Promise<void>;
  create(user: NewUser): Promise<UserRecord>;
  updateProfile(userId: string, changes: ProfileChanges): Promise<UserRecord>;
  setPicture(userId: string, image: Uint8Array, mime: string): Promise<void>;
  /** The stored picture of a user, if `version` is the current one. */
  picture(userId: string, version: string): ReturnType<ObjectStore["get"]>;
  markEmailVerified(userId: string): Promise<void>;
  /** A disabled user can't sign in, and the gateway refuses their tokens. */
  setDisabled(userId: string, disabled: boolean): Promise<void>;
  /** A one-time sign-in link for the user, e.g. for a new user who has no way to sign in yet. */
  loginLink(userId: string, ttlHours: number, purpose?: LinkPurpose): Promise<string>;
}

export class UserNotFoundError extends Error {}
/** The data was refused, e.g. the email is taken; the message can be shown. */
export class UserInputError extends Error {}

interface Row {
  id: string;
  email: string | null;
  email_verified: number;
  first_name: string;
  last_name: string;
  claims: string;
  claims_version: number;
  disabled: number;
  picture: string | null;
}

const COLUMNS = "id, email, email_verified, first_name, last_name, claims, claims_version, disabled, picture";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const apply = (claims: Record<string, string>, changes: Record<string, string | null>) => {
  const next = { ...claims };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") delete next[key];
    else next[key] = value;
  }
  return next;
};

/** Object keys take a limited alphabet; user ids may be anything (`dev:alice`, UUIDs from PocketID). */
const pictureKey = (userId: string, version: string) => `pictures/${Buffer.from(userId).toString("base64url")}/${version}`;

const isUniqueViolation = (err: unknown) => err instanceof DbError && /UNIQUE constraint failed: users\.email/i.test(err.message);

/**
 * Users in the central database. `publicUrl` is where the browser reaches Osiris (picture and sign-in link URLs);
 * pictures live in object storage.
 */
export function dbUsers(db: Db, options: { objects: ObjectStore; publicUrl: string }): UserDirectory {
  const base = options.publicUrl.replace(/\/$/, "");
  const record = (r: Row): UserRecord => {
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
      claims: JSON.parse(r.claims) as Record<string, string>,
      picture: r.picture ? `${base}/auth/pictures/${encodeURIComponent(r.id)}/${r.picture}` : null,
    };
  };
  const row = async (userId: string) => {
    const [r] = await db.query<Row>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [userId], { fresh: true });
    if (!r) throw new UserNotFoundError(`User ${userId} not found`);
    return r;
  };
  const write = async (statement: ReturnType<typeof run>) => {
    try {
      return (await db.execute([statement]))[0]!.rowsAffected;
    } catch (err) {
      if (isUniqueViolation(err)) throw new UserInputError("Uživatel s tímto e-mailem už existuje");
      throw err;
    }
  };

  const directory: UserDirectory = {
    async list() {
      return (await db.query<Row>(`SELECT ${COLUMNS} FROM users ORDER BY created_at`)).map(record);
    },

    async get(userId) {
      return record(await row(userId));
    },

    async findByEmail(email) {
      const [r] = await db.query<Row>(`SELECT ${COLUMNS} FROM users WHERE email = ?`, [normalizeEmail(email)], { fresh: true });
      return r ? record(r) : null;
    },

    async setClaims(userId, changes) {
      // Compare and swap on the version, so a concurrent change (another replica, another admin) isn't lost.
      for (let attempt = 0; ; attempt++) {
        const current = await row(userId);
        const claims = apply(JSON.parse(current.claims) as Record<string, string>, changes);
        const updated = await write(
          run(
            "UPDATE users SET claims = ?, claims_version = claims_version + 1, updated_at = ? WHERE id = ? AND claims_version = ?",
            JSON.stringify(claims),
            Date.now(),
            userId,
            current.claims_version,
          ),
        );
        if (updated) return;
        if (attempt >= 5) throw new Error(`Claims of ${userId} keep changing`);
      }
    },

    async create(user) {
      const id = user.id ?? randomUUID();
      const now = Date.now();
      await write(
        run(
          `INSERT INTO users (id, email, email_verified, first_name, last_name, claims, disabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          user.email ? normalizeEmail(user.email) : null,
          user.emailVerified ? 1 : 0,
          user.firstName.trim(),
          user.lastName.trim(),
          JSON.stringify(user.claims ?? {}),
          user.disabled ? 1 : 0,
          now,
          now,
        ),
      ).catch((err) => {
        if (err instanceof DbError && /UNIQUE constraint failed: users\.id/i.test(err.message)) throw new UserInputError("Uživatel už existuje");
        throw err;
      });
      return directory.get(id);
    },

    async updateProfile(userId, changes) {
      const current = await row(userId);
      const email = changes.email !== undefined ? normalizeEmail(changes.email) : current.email;
      await write(
        run(
          "UPDATE users SET first_name = ?, last_name = ?, email = ?, email_verified = ?, updated_at = ? WHERE id = ?",
          (changes.firstName ?? current.first_name).trim(),
          (changes.lastName ?? current.last_name).trim(),
          email,
          // A new address isn't verified until the user proves it (an emailed link, a social account).
          email === current.email ? current.email_verified : 0,
          Date.now(),
          userId,
        ),
      );
      return directory.get(userId);
    },

    async setPicture(userId, image, mime) {
      const current = await row(userId);
      const version = newToken().slice(0, 16);
      await options.objects.put(pictureKey(userId, version), image, mime);
      await write(run("UPDATE users SET picture = ?, updated_at = ? WHERE id = ?", version, Date.now(), userId));
      if (current.picture) await options.objects.delete([pictureKey(userId, current.picture)]).catch(() => {});
    },

    async picture(userId, version) {
      const [r] = await db.query<{ picture: string | null }>("SELECT picture FROM users WHERE id = ?", [userId]);
      if (!r?.picture || r.picture !== version) return null;
      return options.objects.get(pictureKey(userId, version));
    },

    async setDisabled(userId, disabled) {
      await row(userId);
      await write(run("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?", disabled ? 1 : 0, Date.now(), userId));
    },

    async markEmailVerified(userId) {
      await write(run("UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ? AND email_verified = 0", Date.now(), userId));
    },

    async loginLink(userId, ttlHours, purpose = "admin") {
      await row(userId);
      const token = newToken();
      await db.execute([
        run(
          "INSERT INTO login_links (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)",
          sha256(token),
          userId,
          purpose,
          Date.now() + ttlHours * 3_600_000,
        ),
      ]);
      return `${base}/auth/link/${token}`;
    },
  };
  return directory;
}
