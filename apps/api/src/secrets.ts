import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Encrypts small secrets (MCP headers) at rest with AES-256-GCM. Format: `v1.<iv>.<tag>.<ciphertext>`, base64url. */
export class SecretBox {
  private readonly key: Buffer;

  /** `key` is 32 bytes, base64-encoded (`openssl rand -base64 32`). */
  constructor(key: string) {
    this.key = Buffer.from(key, "base64");
    if (this.key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");
  }

  /** Development fallback: a fixed key derived from a label, so stored secrets survive restarts. Never in production. */
  static insecureDev(): SecretBox {
    return new SecretBox(createHash("sha256").update("osiris-dev-secrets").digest("base64"));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unknown secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}
