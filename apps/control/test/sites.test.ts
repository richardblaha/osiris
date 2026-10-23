import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createClient } from "@libsql/client";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { readAll } from "@osiris/platform/objects.ts";
import { SecretBox } from "@osiris/platform/secrets.ts";
import { siteKey } from "../src/sites/publisher.ts";
import { createTestControl, fakeDns, tempDir } from "./helpers.ts";

/** A site folder packed as the runtime sends it. */
function site(files: Record<string, string>, extra?: (dir: string) => void): Readable {
  const dir = tempDir("osiris-site-src-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...path.split("/")), content);
  }
  extra?.(dir);
  return tar.c({ gzip: true, cwd: dir, portable: true }, ["."]) as unknown as Readable;
}

async function setup() {
  const dns = fakeDns({
    "_osiris-challenge.www.acme.cz": { txt: [] },
    "www.acme.cz": { a: ["203.0.113.10"] },
    "half.acme.cz": { a: ["203.0.113.10", "198.51.100.1"] },
  });
  const control = await createTestControl({ dns });
  await control.directory.create("acme", "ACME");
  await control.directory.create("beta", "Beta");
  return { ...control, dns };
}

describe("domains", () => {
  it("validates, keeps one project per domain, refuses our own domains and limits the count", async () => {
    const { domains } = await setup();
    await expect(domains.add("acme", "not a domain")).rejects.toThrow("Invalid domain");
    await expect(domains.add("acme", "osiris.k6labs.cz")).rejects.toThrow("can't be used");
    const d = await domains.add("acme", "WWW.acme.cz.");
    expect(d).toMatchObject({ domain: "www.acme.cz", status: "pending", token: expect.stringMatching(/^osiris-/) });
    await expect(domains.add("beta", "www.acme.cz")).rejects.toThrow("Another project");
    await domains.add("acme", "b.acme.cz");
    await domains.add("acme", "c.acme.cz");
    await expect(domains.add("acme", "d.acme.cz")).rejects.toThrow("at most 3");
  });

  it("verifies by TXT record and where the domain points, and takes a moved domain offline", async () => {
    const control = await setup();
    const { domains, asUser, orchestrator } = control;
    const alice = asUser("alice", [{ projectId: "acme", role: "admin" }]);
    const bob = asUser("bob", [{ projectId: "acme", role: "member" }]);
    expect((await bob("/domains", { method: "POST", body: JSON.stringify({ domain: "www.acme.cz" }) })).status).toBe(403);
    const { token } = await (await alice("/domains", { method: "POST", body: JSON.stringify({ domain: "www.acme.cz" }) })).json();

    const failed = await (await alice("/domains/www.acme.cz/verify", { method: "POST" })).json();
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("TXT") });

    const dns = control.dns as unknown as { resolveTxt: (n: string) => Promise<string[][]> };
    dns.resolveTxt = async () => [[token]];
    expect(await (await alice("/domains/www.acme.cz/verify", { method: "POST" })).json()).toMatchObject({ status: "verified", error: null });
    expect(orchestrator.applied.get("acme")!.domains).toEqual(["www.acme.cz"]);

    // Half pointing elsewhere is not enough.
    const half = await domains.add("acme", "half.acme.cz");
    dns.resolveTxt = async (name) => [[name.includes("half") ? half.token : token]];
    expect((await domains.verify("acme", "half.acme.cz")).error).toContain("doesn't point");

    // Six hours later the domain points elsewhere: it goes offline.
    (control.dns as unknown as { resolve4: (n: string) => Promise<string[]> }).resolve4 = async () => ["198.51.100.7"];
    expect(await domains.recheck(Date.now() + 7 * 60 * 60_000)).toEqual(["acme"]);
    expect((await domains.get("acme", "www.acme.cz"))!.status).toBe("failed");
  });
});

describe("site publishing", () => {
  async function verified() {
    const control = await setup();
    await control.domains.add("acme", "www.acme.cz");
    await control.db.execute([{ sql: "UPDATE domains SET status = 'verified' WHERE domain = 'www.acme.cz'" }]);
    return control;
  }

  it("publishes a release, serves it from object storage keys and keeps a few for rollback", async () => {
    const { sites, objects, domains, asRuntime } = await verified();
    const res = await asRuntime("acme")("/sites/publish?domain=www.acme.cz&user=bob", {
      method: "POST",
      body: new Uint8Array(await readAll(site({ "index.html": "<h1>ACME</h1>", "css/a.css": "h1{}", ".well-known/security.txt": "x" }))),
      headers: { "content-type": "application/gzip" },
    });
    expect(res.status).toBe(201);
    const release = await res.json();
    expect(release).toMatchObject({ domain: "www.acme.cz", files: 3, createdBy: "bob", current: true });
    expect((await readAll((await objects.get(siteKey("acme", release.id, "css/a.css")))!.body)).toString()).toBe("h1{}");
    expect((await domains.get("acme", "www.acme.cz"))!.releaseId).toBe(release.id);

    // Another project's runtime can't publish to this domain.
    expect((await asRuntime("beta")("/sites/publish?domain=www.acme.cz", { method: "POST", body: new Uint8Array(await readAll(site({ "index.html": "x" }))) })).status).toBe(400);

    for (let i = 0; i < 6; i++) await sites.publish("acme", "www.acme.cz", site({ "index.html": `v${i}` }), null, Date.now() + i * 1000);
    const all = await sites.releases("acme", "www.acme.cz");
    expect(all).toHaveLength(5);
    await sites.activate("acme", "www.acme.cz", all[3]!.id);
    expect((await domains.get("acme", "www.acme.cz"))!.releaseId).toBe(all[3]!.id);
    await expect(sites.activate("acme", "www.acme.cz", release.id)).rejects.toThrow("not found");
  });

  it("refuses sites without index.html, with links, scripts for servers or unsafe paths", async () => {
    const { sites } = await verified();
    const publish = (s: Readable) => sites.publish("acme", "www.acme.cz", s, null);
    await expect(publish(site({ "about.html": "x" }))).rejects.toThrow("index.html");
    await expect(publish(site({ "index.html": "x", "run.php": "<?php" }))).rejects.toThrow("File type not allowed");
    await expect(publish(site({ "index.html": "x", ".env": "SECRET=1" }))).rejects.toThrow("Path not allowed");
    await expect(publish(site({ "index.html": "x" }, (dir) => symlinkSync("/etc/passwd", join(dir, "passwd.txt"))))).rejects.toThrow("Entry type not allowed");
    await expect(sites.publish("acme", "unknown.cz", site({ "index.html": "x" }), null)).rejects.toThrow("doesn't belong");
  });
});

describe("backups", () => {
  it("keeps the newest backups and prunes old ones beyond the minimum", async () => {
    const { backups } = await setup();
    const day = 24 * 60 * 60_000;
    for (let i = 0; i < 5; i++) await backups.store("acme", Readable.from([Buffer.from(`b${i}`)]), "daily", Date.now() - (60 - i) * day);
    expect((await readAll((await backups.latest("acme"))!.body)).toString()).toBe("b4");
    await backups.prune();
    expect((await backups.list("acme")).map((b) => b.bytes)).toHaveLength(3);
    await expect(backups.store("acme", Readable.from([]), "../x")).rejects.toThrow("Invalid backup reason");
  });
});
