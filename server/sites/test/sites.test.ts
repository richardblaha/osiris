import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsObjectStore } from "@osiris/platform/objects.ts";
import { LocalDb, migrate, run } from "@osiris/platform/rqlite.ts";
import { createSitesApp, sitePath } from "../src/app.ts";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "osiris-sites-"));
  const db = new LocalDb(join(dir, "control.db"));
  await migrate(db, join(import.meta.dirname, "../../control/src/db/migrations"));
  const objects = new FsObjectStore(join(dir, "objects"));
  await db.execute([
    run("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('acme', 'ACME', 0, 0)"),
    run("INSERT INTO domains (domain, project_id, status, token, release_id, created_at) VALUES ('www.acme.cz', 'acme', 'verified', 't', 'r1', 0)"),
    run("INSERT INTO domains (domain, project_id, status, token, release_id, created_at) VALUES ('pending.acme.cz', 'acme', 'pending', 't', 'r1', 0)"),
  ]);
  for (const [path, body] of Object.entries({ "index.html": "<h1>ACME</h1>", "about/index.html": "o nás", "css/a.css": "h1{}", "404.html": "nic" })) {
    await objects.put(`sites/acme/r1/${path}`, Buffer.from(body));
  }
  const app = createSitesApp({ db, objects });
  const get = (host: string, path: string, method = "GET") => app.request(path, { method, headers: { host } });
  return { app, get, db };
}

describe("sites", () => {
  it("maps request paths to site files and refuses escapes", () => {
    expect(sitePath("/")).toBe("index.html");
    expect(sitePath("/about/")).toBe("about/index.html");
    expect(sitePath("/css/a.css")).toBe("css/a.css");
    expect(sitePath("/%2e%2e/secret")).toBeNull();
    expect(sitePath("/a/../../b")).toBeNull();
    expect(sitePath("/.env")).toBeNull();
    expect(sitePath("/.well-known/security.txt")).toBe(".well-known/security.txt");
  });

  it("serves the current release of verified domains only, with safe headers", async () => {
    const { get } = await setup();
    const home = await get("www.acme.cz", "/");
    expect(await home.text()).toBe("<h1>ACME</h1>");
    expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(home.headers.get("x-content-type-options")).toBe("nosniff");
    expect(home.headers.get("set-cookie")).toBeNull();
    expect(await (await get("www.acme.cz:443", "/about")).text()).toBe("o nás");
    expect((await get("www.acme.cz", "/css/a.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
    const missing = await get("www.acme.cz", "/nope.html");
    expect([missing.status, await missing.text()]).toEqual([404, "nic"]);
    expect((await get("pending.acme.cz", "/")).status).toBe(404);
    expect((await get("other.cz", "/")).status).toBe(404);
    expect((await get("www.acme.cz", "/", "POST")).status).toBe(405);
    expect(await (await get("www.acme.cz", "/", "HEAD")).text()).toBe("");
  });

  it("stops serving the sites of archived projects", async () => {
    const { db } = await setup();
    await db.execute([run("UPDATE projects SET status = 'archived'")]);
    // A fresh process (hosts are cached for a minute per process) sees the change.
    const app = createSitesApp({ db, objects: new FsObjectStore(mkdtempSync(join(tmpdir(), "osiris-empty-"))) });
    expect((await app.request("/", { headers: { host: "www.acme.cz" } })).status).toBe(404);
  });
});
