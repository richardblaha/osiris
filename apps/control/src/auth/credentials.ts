import type { SecretBox } from "@osiris/platform/secrets.ts";
import { DbError, run, type Db } from "@osiris/platform/rqlite.ts";
import { normalizeEmail, type LinkPurpose } from "../users.ts";
import {
  hashPassword,
  matchTotp,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  sha256,
  verifyPassword,
} from "./secrets.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

export interface Passkey {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface LinkedIdentity {
  provider: string;
  subject: string;
  email: string | null;
  createdAt: number;
}

/** How a user can sign in, for the profile and for refusing to remove the last way in. */
export interface MethodSummary {
  password: boolean;
  totp: boolean;
  recoveryCodes: number;
  passkeys: Passkey[];
  identities: LinkedIdentity[];
}

export class CredentialError extends LocalizedError {}

const RECOVERY_CODES = 10;

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  userId: r.user_id,
  publicKey: r.public_key,
  counter: Number(r.counter),
  transports: JSON.parse(r.transports) as string[],
  name: r.name,
  createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
});

/**
 * Everything a user signs in with: password, TOTP and recovery codes, passkeys, linked social accounts, one-time
 * links, and the short-lived challenges of a sign-in. Single-use things (codes, links, challenges) are taken with one
 * conditional write whose row count says who won, as rqlite has no interactive transactions.
 */
export class Credentials {
  constructor(
    private readonly db: Db,
    /** Seals TOTP secrets at rest. */
    private readonly box: SecretBox,
  ) {}

  // --- password ---------------------------------------------------------------------------------------------------

  /** The user whose email and password these are, or null. Takes the same time for unknown emails. */
  async checkPassword(email: string, password: string): Promise<string | null> {
    const [row] = await this.db.query<{ id: string; password_hash: string | null; disabled: number }>(
      "SELECT id, password_hash, disabled FROM users WHERE email = ?",
      [normalizeEmail(email)],
      { fresh: true },
    );
    const ok = await verifyPassword(password, row?.password_hash ?? null);
    return ok && row && !row.disabled ? row.id : null;
  }

  async hasPassword(userId: string) {
    const [row] = await this.db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = ?", [userId], { fresh: true });
    return !!row?.password_hash;
  }

  async verifyOwnPassword(userId: string, password: string) {
    const [row] = await this.db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = ?", [userId], { fresh: true });
    return verifyPassword(password, row?.password_hash ?? null);
  }

  async setPassword(userId: string, password: string | null) {
    const hash = password === null ? null : await hashPassword(password);
    await this.db.execute([run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", hash, Date.now(), userId)]);
  }

  // --- TOTP and recovery codes ------------------------------------------------------------------------------------

  /** A new secret for the user to scan; it takes effect once confirmed with a code (`confirmTotp`). */
  async startTotp(userId: string, account: string) {
    const secret = newTotpSecret();
    await this.db.execute([run("UPDATE users SET totp_pending = ?, updated_at = ? WHERE id = ?", this.box.seal(secret), Date.now(), userId)]);
    return { secret, url: otpauthUrl(secret, account) };
  }

  /** Turns on the pending secret if the code matches; returns fresh recovery codes, shown to the user once. */
  async confirmTotp(userId: string, code: string): Promise<string[] | null> {
    const [row] = await this.db.query<{ totp_pending: string | null }>("SELECT totp_pending FROM users WHERE id = ?", [userId], { fresh: true });
    if (!row?.totp_pending) throw new CredentialError("errors.totp.notStarted");
    const step = matchTotp(this.box.open(row.totp_pending), code, 0);
    if (step === null) return null;
    const updated = await this.db.execute([
      run(
        "UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_step = ?, updated_at = ? WHERE id = ? AND totp_pending = ?",
        step,
        Date.now(),
        userId,
        row.totp_pending,
      ),
    ]);
    if (!updated[0]!.rowsAffected) return null;
    return this.newRecoveryCodes(userId);
  }

  async disableTotp(userId: string) {
    await this.db.execute([
      run("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_step = 0, updated_at = ? WHERE id = ?", Date.now(), userId),
      run("DELETE FROM recovery_codes WHERE user_id = ?", userId),
    ]);
  }

  async hasTotp(userId: string) {
    const [row] = await this.db.query<{ totp_secret: string | null }>("SELECT totp_secret FROM users WHERE id = ?", [userId], { fresh: true });
    return !!row?.totp_secret;
  }

  /** Checks a code from the authenticator app; each code is accepted once. */
  async checkTotp(userId: string, code: string): Promise<boolean> {
    const [row] = await this.db.query<{ totp_secret: string | null; totp_step: number }>(
      "SELECT totp_secret, totp_step FROM users WHERE id = ?",
      [userId],
      { fresh: true },
    );
    if (!row?.totp_secret) return false;
    const step = matchTotp(this.box.open(row.totp_secret), code, Number(row.totp_step));
    if (step === null) return false;
    const [updated] = await this.db.execute([
      run("UPDATE users SET totp_step = ? WHERE id = ? AND totp_step < ?", step, userId, step),
    ]);
    return !!updated!.rowsAffected;
  }

  /** Uses up one recovery code. */
  async useRecoveryCode(userId: string, code: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(code);
    if (normalized.length !== 10) return false;
    const [deleted] = await this.db.execute([run("DELETE FROM recovery_codes WHERE user_id = ? AND code_hash = ?", userId, sha256(normalized))]);
    return !!deleted!.rowsAffected;
  }

  /** Replaces the user's recovery codes. */
  async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
    await this.db.execute([
      run("DELETE FROM recovery_codes WHERE user_id = ?", userId),
      ...codes.map((c) => run("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)", userId, sha256(normalizeRecoveryCode(c)))),
    ]);
    return codes;
  }

  // --- passkeys ---------------------------------------------------------------------------------------------------

  async passkeys(userId: string): Promise<Passkey[]> {
    return (await this.db.query<PasskeyRow>("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at", [userId], { fresh: true })).map(toPasskey);
  }

  async passkey(id: string): Promise<Passkey | null> {
    const [row] = await this.db.query<PasskeyRow>("SELECT * FROM passkeys WHERE id = ?", [id], { fresh: true });
    return row ? toPasskey(row) : null;
  }

  async addPasskey(p: Omit<Passkey, "createdAt" | "lastUsedAt">) {
    try {
      await this.db.execute([
        run(
          "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          p.id,
          p.userId,
          p.publicKey,
          p.counter,
          JSON.stringify(p.transports),
          p.name,
          Date.now(),
        ),
      ]);
    } catch (err) {
      if (err instanceof DbError && /UNIQUE/i.test(err.message)) throw new CredentialError("errors.passkey.exists");
      throw err;
    }
  }

  /** Records a use; the counter only moves forward, which catches cloned authenticators that report one. */
  async usePasskey(id: string, counter: number) {
    await this.db.execute([run("UPDATE passkeys SET counter = MAX(counter, ?), last_used_at = ? WHERE id = ?", counter, Date.now(), id)]);
  }

  async renamePasskey(userId: string, id: string, name: string) {
    const [r] = await this.db.execute([run("UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?", name, id, userId)]);
    if (!r!.rowsAffected) throw new CredentialError("errors.passkey.notFound");
  }

  async removePasskey(userId: string, id: string) {
    const [r] = await this.db.execute([run("DELETE FROM passkeys WHERE id = ? AND user_id = ?", id, userId)]);
    if (!r!.rowsAffected) throw new CredentialError("errors.passkey.notFound");
  }

  // --- linked accounts (Google, Facebook, Microsoft) --------------------------------------------------------------

  async identities(userId: string): Promise<LinkedIdentity[]> {
    const rows = await this.db.query<{ provider: string; subject: string; email: string | null; created_at: number }>(
      "SELECT provider, subject, email, created_at FROM user_identities WHERE user_id = ? ORDER BY provider",
      [userId],
      { fresh: true },
    );
    return rows.map((r) => ({ provider: r.provider, subject: r.subject, email: r.email, createdAt: Number(r.created_at) }));
  }

  async userForIdentity(provider: string, subject: string): Promise<string | null> {
    const [row] = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?",
      [provider, subject],
      { fresh: true },
    );
    return row?.user_id ?? null;
  }

  async linkIdentity(userId: string, provider: string, subject: string, email: string | null) {
    try {
      await this.db.execute([
        run("INSERT INTO user_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)", provider, subject, userId, email, Date.now()),
      ]);
    } catch (err) {
      if (err instanceof DbError && /UNIQUE/i.test(err.message)) {
        throw new CredentialError("errors.identity.taken");
      }
      throw err;
    }
  }

  async unlinkIdentity(userId: string, provider: string) {
    const [r] = await this.db.execute([run("DELETE FROM user_identities WHERE user_id = ? AND provider = ?", userId, provider)]);
    if (!r!.rowsAffected) throw new CredentialError("errors.identity.notLinked");
  }

  // --- overview ---------------------------------------------------------------------------------------------------

  async summary(userId: string): Promise<MethodSummary> {
    const [row] = await this.db.query<{ password_hash: string | null; totp_secret: string | null; codes: number }>(
      `SELECT password_hash, totp_secret, (SELECT COUNT(*) FROM recovery_codes WHERE user_id = users.id) AS codes FROM users WHERE id = ?`,
      [userId],
      { fresh: true },
    );
    return {
      password: !!row?.password_hash,
      totp: !!row?.totp_secret,
      recoveryCodes: Number(row?.codes ?? 0),
      passkeys: await this.passkeys(userId),
      identities: await this.identities(userId),
    };
  }

  /** Ways in besides the one being removed; the last one can't go, or the user would be locked out. */
  async assertAnotherMethod(userId: string, removing: "password" | "passkey" | "identity") {
    const s = await this.summary(userId);
    const count = (s.password ? 1 : 0) + s.passkeys.length + s.identities.length;
    if (count <= 1 && (removing !== "password" || s.password)) {
      throw new CredentialError("errors.identity.lastMethod");
    }
  }

  // --- one-time links ---------------------------------------------------------------------------------------------

  /** Uses up a sign-in link; the user it was for, or null if unknown, used or expired. */
  async takeLink(token: string, now = Date.now()): Promise<{ userId: string; purpose: LinkPurpose } | null> {
    const hash = sha256(token);
    const [row] = await this.db.query<{ user_id: string; purpose: LinkPurpose; expires_at: number; used_at: number | null }>(
      "SELECT user_id, purpose, expires_at, used_at FROM login_links WHERE token_hash = ?",
      [hash],
      { fresh: true },
    );
    if (!row || row.used_at !== null || Number(row.expires_at) < now) return null;
    const [r] = await this.db.execute([run("UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", now, hash)]);
    return r!.rowsAffected ? { userId: row.user_id, purpose: row.purpose } : null;
  }

  // --- challenges -------------------------------------------------------------------------------------------------

  async putChallenge(id: string, data: unknown, ttlMs: number) {
    await this.db.execute([
      run(
        "INSERT INTO auth_challenges (id, data, expires_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at",
        id,
        JSON.stringify(data),
        Date.now() + ttlMs,
      ),
    ]);
  }

  async peekChallenge<T>(id: string): Promise<T | null> {
    const [row] = await this.db.query<{ data: string; expires_at: number }>("SELECT data, expires_at FROM auth_challenges WHERE id = ?", [id], { fresh: true });
    return row && Number(row.expires_at) >= Date.now() ? (JSON.parse(row.data) as T) : null;
  }

  /** Reads and removes a challenge; only one caller gets it. */
  async takeChallenge<T>(id: string): Promise<T | null> {
    const [row] = await this.db.query<{ data: string; expires_at: number }>("SELECT data, expires_at FROM auth_challenges WHERE id = ?", [id], { fresh: true });
    if (!row) return null;
    const [r] = await this.db.execute([run("DELETE FROM auth_challenges WHERE id = ? AND data = ?", id, row.data)]);
    return r!.rowsAffected && Number(row.expires_at) >= Date.now() ? (JSON.parse(row.data) as T) : null;
  }

  async cleanup(now = Date.now()) {
    await this.db.execute(
      [
        run("DELETE FROM auth_challenges WHERE expires_at < ?", now),
        run("DELETE FROM login_links WHERE expires_at < ?", now - 7 * 86_400_000),
        run("DELETE FROM oidc_store WHERE expires_at < ?", now),
      ],
      { transaction: false },
    );
  }
}
