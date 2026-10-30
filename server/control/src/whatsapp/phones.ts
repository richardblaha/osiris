import { randomInt } from "node:crypto";
import { run, type Db } from "@osiris/platform/db.ts";
import type { InternalUser } from "@osiris/platform/internal-auth.ts";
import type { Access } from "@osiris/platform/claims.ts";
import { userAccess } from "../projects.ts";
import type { UserDirectory } from "../users.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

/** Digits only, so a stored "+420 777 123 456" matches WhatsApp's "420777123456". */
export const phoneKey = (phone: string) => phone.replace(/\D/g, "");

export const PHONE_CLAIM = "phone_number";

/** The user whose `phone_number` claim is this number, or null (unknown, disabled, or claimed by several users). */
export async function userByPhone(users: UserDirectory, phone: string): Promise<(InternalUser & { access: Access }) | null> {
  const key = phoneKey(phone);
  if (!key) return null;
  const matches = (await users.list()).filter((u) => {
    const claim = u.claims[PHONE_CLAIM];
    return claim && !u.disabled && phoneKey(claim) === key;
  });
  if (matches.length !== 1) return null;
  const user = matches[0]!;
  return { sub: user.id, name: user.name, email: user.email, phone: user.claims[PHONE_CLAIM]!, picture: null, access: userAccess(user) };
}

const CODE_TTL_MS = 15 * 60_000;

/** "OVERENI 123456" (also with diacritics, in Slovak, or "VERIFY 123456"), sent from the phone being verified. */
export const VERIFY_MESSAGE = /^\s*(?:ov[eě][rř]en[ií]e?|verify)\s+(\d{6})\s*$/iu;

/**
 * Proves that a user owns a number: they ask for a code in their profile and send it from that phone to our WhatsApp
 * number. WhatsApp can't be used to start the conversation without an approved template, and this way the number is
 * proven by the message itself. The verified number is taken away from anyone else who claimed it.
 */
export class PhoneVerification {
  constructor(
    private readonly db: Db,
    private readonly users: UserDirectory,
  ) {}

  async start(userId: string, phone: string, now = Date.now()): Promise<{ code: string; expiresAt: number }> {
    const digits = phoneKey(phone);
    if (digits.length < 8 || digits.length > 15) throw new LocalizedError("errors.phone.invalid");
    for (let attempt = 0; ; attempt++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      try {
        await this.db.execute([
          run("DELETE FROM phone_challenges WHERE expires_at < ?", now),
          run(
            `INSERT INTO phone_challenges (user_id, phone, code, expires_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET phone = excluded.phone, code = excluded.code, expires_at = excluded.expires_at`,
            userId,
            digits,
            code,
            now + CODE_TTL_MS,
          ),
        ]);
        return { code, expiresAt: now + CODE_TTL_MS };
      } catch (err) {
        // Another user holds the same code right now.
        if (attempt >= 5) throw err;
      }
    }
  }

  /** Completes a verification sent from `from`; returns the user it was for, or null if the code doesn't match. */
  async confirm(from: string, code: string, now = Date.now()): Promise<string | null> {
    const [row] = await this.db.query<{ user_id: string; phone: string; expires_at: number }>(
      "SELECT user_id, phone, expires_at FROM phone_challenges WHERE code = ?",
      [code],
      { fresh: true },
    );
    if (!row || Number(row.expires_at) < now || row.phone !== phoneKey(from)) return null;
    await this.db.execute([run("DELETE FROM phone_challenges WHERE user_id = ?", row.user_id)]);
    for (const other of await this.users.list()) {
      const claim = other.claims[PHONE_CLAIM];
      if (other.id !== row.user_id && claim && phoneKey(claim) === row.phone) await this.users.setClaims(other.id, { [PHONE_CLAIM]: null });
    }
    await this.users.setClaims(row.user_id, { [PHONE_CLAIM]: `+${row.phone}` });
    return row.user_id;
  }

  async remove(userId: string) {
    await this.db.execute([run("DELETE FROM phone_challenges WHERE user_id = ?", userId)]);
    await this.users.setClaims(userId, { [PHONE_CLAIM]: null });
  }
}
