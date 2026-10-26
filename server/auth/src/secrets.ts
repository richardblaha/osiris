import type { Message } from "@osiris/shared";
import { argon2, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// --- passwords ------------------------------------------------------------------------------------------------------

/** argon2id with OWASP's baseline (19 MiB, 2 passes): about 30 ms per hash. */
const ARGON2 = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

const derive = (password: string, nonce: Buffer, p: typeof ARGON2) =>
  new Promise<Buffer>((resolve, reject) =>
    argon2("argon2id", { message: password.normalize("NFKC"), nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** A PHC string: `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>` (base64 without padding). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, ARGON2);
  const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const DUMMY = hashPassword("osiris-dummy-password");

/** Checks a password against a stored hash; without one it hashes anyway, so unknown accounts take as long. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const phc = stored ?? (await DUMMY);
  const m = phc.match(/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, "base64");
  const hash = await derive(password, Buffer.from(m[4]!, "base64"), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return timingSafeEqual(hash, expected) && stored !== null;
}

/** Why a new password is refused (a catalog key and its parameters); null when it is fine. Lengths count characters, not UTF-16 units. */
export function passwordProblem(password: string): Message | null {
  const chars = [...password];
  if (chars.length < PASSWORD_MIN) return { key: "errors.password.tooShort", params: { count: PASSWORD_MIN } };
  if (chars.length > PASSWORD_MAX) return { key: "errors.password.tooLong", params: { count: PASSWORD_MAX } };
  if (new Set(chars).size < 4) return { key: "errors.password.tooSimple" };
  return null;
}

// --- TOTP (RFC 6238: SHA-1, 6 digits, 30 s, as every authenticator app expects) -------------------------------------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_S = 30;

export function base32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.toUpperCase().replace(/[\s=]/g, "")) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const newTotpSecret = () => base32(randomBytes(20));

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_S);

/**
 * The time step a code belongs to (the current one or one either side, for clock drift), or null. Steps up to
 * `lastStep` are refused, so a code seen once can't be replayed.
 */
export function matchTotp(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStep(now);
  for (const step of [current, current - 1, current + 1]) {
    if (step > lastStep && timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(digits))) return step;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_S}`;

// --- recovery codes and tokens --------------------------------------------------------------------------------------

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** `xxxxx-xxxxx` from an alphabet without look-alikes; about 49 bits each. */
export const newRecoveryCode = () =>
  Array.from({ length: 2 }, () => Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("")).join("-");

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

/** An unguessable token for links and states (256 bits, base64url). */
export const newToken = () => randomBytes(32).toString("base64url");
