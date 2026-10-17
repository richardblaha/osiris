import { describe, expect, it } from "vitest";
import { CONTROL_AUDIENCE, generateInternalKeys, InternalSigner, InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { RqliteDb, run } from "@osiris/platform/rqlite.ts";
import { deriveTenantKey } from "@osiris/platform/tenant-keys.ts";

describe("rqlite client", () => {
  it("sends parameterised statements in one transaction and reads rows as objects", async () => {
    const requests: { url: string; body: unknown; auth: string | null }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      if (url.includes("/db/execute")) return Response.json({ results: [{ rows_affected: 1 }, { rows_affected: 0 }] });
      return Response.json({ results: [{ types: { id: "text" }, rows: [{ id: "acme", n: 2 }] }] });
    }) as unknown as typeof fetch;
    const db = new RqliteDb("http://rqlite:4001/", { username: "control", password: "pw", fetchFn });

    expect(await db.execute([run("INSERT INTO t VALUES (?, ?)", "a", 1), run("DELETE FROM t WHERE id = ?", "b")])).toEqual([{ rowsAffected: 1 }, { rowsAffected: 0 }]);
    expect(await db.query("SELECT id, n FROM t WHERE id = ?", ["acme"], { fresh: true })).toEqual([{ id: "acme", n: 2 }]);
    expect(requests[0]).toEqual({
      url: "http://rqlite:4001/db/execute?transaction",
      body: [["INSERT INTO t VALUES (?, ?)", "a", 1], ["DELETE FROM t WHERE id = ?", "b"]],
      auth: `Basic ${Buffer.from("control:pw").toString("base64")}`,
    });
    expect(requests[1]!.url).toBe("http://rqlite:4001/db/query?associative&level=linearizable");
  });

  it("turns statement errors into exceptions", async () => {
    const fetchFn = (async () => Response.json({ results: [{ error: "UNIQUE constraint failed: t.id" }] })) as unknown as typeof fetch;
    await expect(new RqliteDb("http://rqlite:4001", { fetchFn }).execute([run("INSERT INTO t VALUES (1)")])).rejects.toThrow("UNIQUE constraint failed");
    const down = (async () => new Response("leader not found", { status: 503 })) as unknown as typeof fetch;
    await expect(new RqliteDb("http://rqlite:4001", { fetchFn: down }).query("SELECT 1")).rejects.toThrow("503");
  });
});

describe("internal tokens", () => {
  it("carry the user between services and are refused for another audience, issuer or key", async () => {
    const keys = await generateInternalKeys();
    const signer = new InternalSigner(keys.privateKey, "gateway");
    const token = await signer.sign(CONTROL_AUDIENCE, { user: { sub: "u1", name: "A", email: null, phone: null, picture: null }, systemAdmin: true });
    expect(await new InternalVerifier(keys.publicKey).verify(token, CONTROL_AUDIENCE)).toMatchObject({ issuer: "gateway", user: { sub: "u1" }, systemAdmin: true });
    await expect(new InternalVerifier(keys.publicKey).verify(token, "tenant:acme")).rejects.toThrow("Invalid internal token");
    await expect(new InternalVerifier(keys.publicKey, ["control"]).verify(token, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
    const other = await generateInternalKeys();
    await expect(new InternalVerifier(other.publicKey).verify(token, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
    const expired = await signer.sign(CONTROL_AUDIENCE, {}, -10);
    await expect(new InternalVerifier(keys.publicKey).verify(expired, CONTROL_AUDIENCE)).rejects.toThrow("Invalid internal token");
  });
});

describe("tenant keys", () => {
  it("derives a different stable key per tenant", () => {
    const master = Buffer.alloc(32, 7).toString("base64");
    expect(deriveTenantKey(master, "acme")).toBe(deriveTenantKey(master, "acme"));
    expect(deriveTenantKey(master, "acme")).not.toBe(deriveTenantKey(master, "beta"));
    expect(Buffer.from(deriveTenantKey(master, "acme"), "base64")).toHaveLength(32);
    expect(() => deriveTenantKey("short", "acme")).toThrow("32 bytes");
  });
});
