import { hkdfSync } from "node:crypto";

/**
 * The key a tenant's runtime seals its secrets with (MCP headers, API keys): HKDF-SHA256 of the master key and the
 * tenant id. Only the operator (which hands it to the runtime) and the legacy import hold the master key, so a leak
 * from one tenant's pod doesn't expose the others' secrets. Base64, 32 bytes, as `SecretBox` expects.
 */
export function deriveTenantKey(masterKeyBase64: string, tenantId: string): string {
  const master = Buffer.from(masterKeyBase64, "base64");
  if (master.length !== 32) throw new Error("SECRETS_MASTER_KEY must be 32 bytes, base64-encoded");
  return Buffer.from(hkdfSync("sha256", master, "osiris-tenant-secrets", tenantId, 32)).toString("base64");
}
