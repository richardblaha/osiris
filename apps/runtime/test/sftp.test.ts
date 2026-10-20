import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore } from "@osiris/core/files/store.ts";
import { SecretBox } from "@osiris/core/secrets.ts";
import { HostKeyMismatchError, MANIFEST, publishFolder, SiteTargetStore } from "@osiris/core/sites/sftp.ts";
import { createTestApp, createTestDb, createTestTenants } from "./helpers.ts";

/** An SFTP server in memory: files by absolute path, and the host key it presents. */
function fakeServer(hostKey = "server-key-1") {
  const files = new Map<string, Buffer>();
  const server = { files, hostKey, logins: [] as Record<string, unknown>[] };
  const client = () =>
    ({
      async connect(options: Record<string, unknown> & { hostVerifier: (key: Buffer) => boolean }) {
        server.logins.push(options);
        if (!options.hostVerifier(Buffer.from(server.hostKey))) throw new Error("Host denied (verification failed)");
      },
      async mkdir() {},
      async exists(path: string) {
        return [...files.keys()].some((f) => f.startsWith(`${path}/`)) && "d";
      },
      async list(path: string) {
        return [...files.keys()].filter((f) => f.startsWith(`${path}/`)).map((f) => ({ name: f.slice(path.length + 1) }));
      },
      async get(path: string) {
        if (!files.has(path)) throw new Error("No such file");
        return files.get(path)!;
      },
      async put(data: Buffer, path: string) {
        files.set(path, Buffer.from(data));
      },
      async delete(path: string) {
        files.delete(path);
      },
      async end() {},
    }) as unknown as NonNullable<Parameters<typeof publishFolder>[5]>;
  return { server, client };
}

describe("publishing a site over SFTP", () => {
  it("uploads what changed, deletes only its own files, and pins the server's host key", async () => {
    const files = new FileStore(mkdtempSync(join(tmpdir(), "osiris-site-")));
    const tenant = { scope: "tenant" } as const;
    const targets = new SiteTargetStore(await createTestDb(), SecretBox.insecureDev());
    await targets.put("firma", { host: "vps.example.cz", port: 22, username: "web", remoteDir: "/var/www/firma", auth: "password", secret: "heslo" });
    const { server, client } = fakeServer();
    server.files.set("/var/www/firma/cizi.txt", Buffer.from("someone else's"));

    await files.write(tenant, "www/index.html", Buffer.from("<h1>Ahoj</h1>"));
    await files.write(tenant, "www/img/logo.svg", Buffer.from("<svg/>"));
    expect(await publishFolder(files, tenant, "www", targets, "firma", client())).toMatchObject({ ok: true, uploaded: 2, deleted: 0, unchanged: 0 });
    expect(server.logins[0]).toMatchObject({ host: "vps.example.cz", username: "web", password: "heslo" });
    expect(server.files.get("/var/www/firma/img/logo.svg")?.toString()).toBe("<svg/>");
    expect(JSON.parse(server.files.get(`/var/www/firma/${MANIFEST}`)!.toString())).toHaveProperty("index.html");
    const pinned = (await targets.get("firma"))!.hostKey;
    expect(pinned).toMatch(/^SHA256:/);

    // Next time only the change goes up, and a removed file is deleted; the stranger's file stays.
    await files.write(tenant, "www/index.html", Buffer.from("<h1>Nový</h1>"));
    await files.delete(tenant, "www/img");
    expect(await publishFolder(files, tenant, "www", targets, "firma", client())).toMatchObject({ uploaded: 1, deleted: 1, unchanged: 0 });
    expect(server.files.has("/var/www/firma/img/logo.svg")).toBe(false);
    expect(server.files.get("/var/www/firma/cizi.txt")?.toString()).toBe("someone else's");
    expect((await targets.list())[0]!.lastPublish).toMatchObject({ ok: true, uploaded: 1, deleted: 1 });

    // A different host key is refused, and the failure is recorded.
    server.hostKey = "server-key-2";
    await expect(publishFolder(files, tenant, "www", targets, "firma", client())).rejects.toBeInstanceOf(HostKeyMismatchError);
    expect((await targets.list())[0]!.lastPublish).toMatchObject({ ok: false });
    // The secret is never listed.
    expect(JSON.stringify(await targets.list())).not.toContain("heslo");
  });

  it("refuses a folder without index.html", async () => {
    const files = new FileStore(mkdtempSync(join(tmpdir(), "osiris-site-")));
    const targets = new SiteTargetStore(await createTestDb(), SecretBox.insecureDev());
    await targets.put("firma", { host: "h", port: 22, username: "u", remoteDir: "/w", auth: "password", secret: "s" });
    await files.write({ scope: "tenant" }, "www/a.css", Buffer.from("a{}"));
    await expect(publishFolder(files, { scope: "tenant" }, "www", targets, "firma", fakeServer().client())).rejects.toThrow("index.html");
  });
});

describe("site targets API", () => {
  it("lets admins manage targets, never returns the secret, refuses members", async () => {
    const { tenants } = createTestTenants();
    const app = await createTestApp(tenants);
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "x-tenant-id": "acme", "content-type": "application/json", ...init.headers } });
    const admin = as("acme");
    const body = { host: "vps.example.cz", username: "web", remoteDir: "/var/www/firma", auth: "password", secret: "tajne-heslo" };
    expect((await as("bob:tenant=acme")("/site-targets")).status).toBe(403);
    expect((await admin("/site-targets/firma", { method: "PUT", body: JSON.stringify({ ...body, remoteDir: "relative" }) })).status).toBe(400);
    expect((await admin("/site-targets/firma", { method: "PUT", body: JSON.stringify(body) })).status).toBe(204);
    const list = await (await admin("/site-targets")).json();
    expect(list).toEqual([
      { name: "firma", host: "vps.example.cz", port: 22, username: "web", remoteDir: "/var/www/firma", auth: "password", hostKey: null, lastPublish: null },
    ]);
    expect(JSON.stringify(list)).not.toContain("tajne");
    // Changing the folder keeps the stored password.
    expect((await admin("/site-targets/firma", { method: "PUT", body: JSON.stringify({ ...body, remoteDir: "/srv/web", secret: undefined }) })).status).toBe(204);
    expect((await (await tenants.get("acme")).siteTargets.get("firma"))?.secret).toBe("tajne-heslo");
    expect((await admin("/site-targets/firma", { method: "DELETE" })).status).toBe(204);
  });
});
