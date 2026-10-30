import { describe, expect, it } from "vitest";
import { CONTROL_AUDIENCE, generateInternalKeys, InternalSigner, InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { deriveProjectKey } from "@osiris/platform/project-keys.ts";

describe("internal tokens", () => {
  it("carry the user between services and are refused for another audience, issuer or key", async () => {
    const keys = await generateInternalKeys();
    const signer = new InternalSigner(keys.privateKey, "gateway");
    const token = await signer.sign(CONTROL_AUDIENCE, { user: { sub: "u1", name: "A", email: null, phone: null, picture: null }, systemAdmin: true });
    expect(await new InternalVerifier(keys.publicKey).verify(token, CONTROL_AUDIENCE)).toMatchObject({ issuer: "gateway", user: { sub: "u1" }, systemAdmin: true });
    await expect(new InternalVerifier(keys.publicKey).verify(token, "project:acme")).rejects.toThrow("Invalid internal token");
    await expect(new InternalVerifier(keys.publicKey, ["control"]).verify(token, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
    const other = await generateInternalKeys();
    await expect(new InternalVerifier(other.publicKey).verify(token, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
    const expired = await signer.sign(CONTROL_AUDIENCE, {}, -10);
    await expect(new InternalVerifier(keys.publicKey).verify(expired, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
  });
});

describe("project keys", () => {
  it("derives a different stable key per project", () => {
    const master = Buffer.alloc(32, 7).toString("base64");
    expect(deriveProjectKey(master, "acme")).toBe(deriveProjectKey(master, "acme"));
    expect(deriveProjectKey(master, "acme")).not.toBe(deriveProjectKey(master, "beta"));
    expect(Buffer.from(deriveProjectKey(master, "acme"), "base64")).toHaveLength(32);
    expect(() => deriveProjectKey("short", "acme")).toThrow("32 bytes");
  });
});
