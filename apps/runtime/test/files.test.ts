import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileTools } from "@osiris/core/agent/tools/files.ts";
import type { RunContext } from "@osiris/core/agent/context.ts";
import { GotenbergClient } from "@osiris/core/files/gotenberg.ts";
import { FileError, FileStore, pathSegments, type FileLocation } from "@osiris/core/files/store.ts";
import { createTestTenants, createTestApp } from "./helpers.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001249444154789c63f8cfc0f01f8419a0f47f0043ce07f9fa814afd0000000049454e44ae426082", "hex");
const text = (s: string) => Buffer.from(s, "utf8");
const tenant: FileLocation = { scope: "tenant" };
const alice: FileLocation = { scope: "personal", userId: "dev:alice" };

function store(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "osiris-files-"));
  return { root, files: new FileStore(root, options) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof FileError) return err.code;
    throw err;
  }
};

describe("FileStore", () => {
  it("writes, lists, reads and deletes files per scope", async () => {
    const { files } = store();
    await files.write(tenant, "sablony/nabidka.html", text("<p>{{name}}</p>"));
    await files.write(alice, "poznamky.md", text("# Ahoj"));

    expect((await files.list(tenant)).map((e) => [e.path, e.type])).toEqual([["sablony", "dir"]]);
    const [entry] = await files.list(tenant, "sablony");
    expect(entry).toMatchObject({ scope: "tenant", path: "sablony/nabidka.html", name: "nabidka.html", type: "file", mime: "text/html" });
    expect((await files.read(alice, "/poznamky.md")).data.toString()).toBe("# Ahoj");
    // Another user's personal files are a different folder.
    expect(await files.list({ scope: "personal", userId: "dev:bob" })).toEqual([]);

    await files.delete(tenant, "sablony");
    expect(await files.list(tenant)).toEqual([]);
    expect(await files.usage()).toBe(6);
  });

  it("refuses paths that leave the scope or hide files", () => {
    for (const bad of ["../x.txt", "a/../../x.txt", "a/./b.txt", ".env", "a\\b.txt", "a\u0000.txt", "a//b.txt", " x.txt"]) {
      expect(() => pathSegments(bad), bad).toThrow(FileError);
    }
    expect(pathSegments("/a/b.txt/")).toEqual(["a", "b.txt"]);
  });

  it("never follows symlinks", async () => {
    const { root, files } = store();
    const outside = mkdtempSync(join(tmpdir(), "osiris-outside-"));
    writeFileSync(join(outside, "secret.txt"), "tajne");
    mkdirSync(join(root, "tenant"), { recursive: true });
    symlinkSync(outside, join(root, "tenant", "link"));
    symlinkSync(join(outside, "secret.txt"), join(root, "tenant", "file.txt"));

    expect(await code(files.read(tenant, "link/secret.txt"))).toBe("invalid");
    expect(await code(files.write(tenant, "link/new.txt", text("x")))).toBe("invalid");
    expect(await code(files.list(tenant, "link"))).toBe("invalid");
    expect(await code(files.read(tenant, "file.txt"))).toBe("invalid");
    // Symlinks are not listed.
    expect(await files.list(tenant)).toEqual([]);
  });

  it("accepts only known types whose content matches the extension", async () => {
    const { files } = store();
    expect(await code(files.write(tenant, "run.exe", text("MZ")))).toBe("type");
    expect(await code(files.write(tenant, "noext", text("x")))).toBe("type");
    expect(await code(files.write(tenant, "fake.png", text("not a png")))).toBe("type");
    expect(await code(files.write(tenant, "bin.txt", Buffer.from([0x61, 0x00, 0x62])))).toBe("type");
    expect(await code(files.write(tenant, "logo.png", PNG))).toBe("ok");
    // Renaming can't turn the content into another type.
    expect(await code(files.move(tenant, "logo.png", tenant, "logo.pdf"))).toBe("type");
  });

  it("enforces the file size and the tenant quota", async () => {
    const { files } = store({ maxFileBytes: 10, quotaBytes: 15 });
    expect(await code(files.write(tenant, "big.txt", text("x".repeat(11))))).toBe("too_large");
    await files.write(tenant, "a.txt", text("x".repeat(10)));
    expect(await code(files.write(alice, "b.txt", text("x".repeat(6))))).toBe("quota");
    // Overwriting counts only the difference.
    expect(await code(files.write(tenant, "a.txt", text("x".repeat(9))))).toBe("ok");
    expect(await files.usage()).toBe(9);
  });

  it("moves between scopes without overwriting", async () => {
    const { files } = store();
    const temp: FileLocation = { scope: "temp", threadId: "t1" };
    await files.write(temp, "nabidka.html", text("<p>x</p>"));
    await files.write(alice, "nabidka.html", text("<p>old</p>"));
    expect(await code(files.move(temp, "nabidka.html", alice, "nabidka.html"))).toBe("exists");
    await files.move(temp, "nabidka.html", alice, "nabidky/2026.html");
    expect((await files.read(alice, "nabidky/2026.html")).data.toString()).toBe("<p>x</p>");
    expect(await code(files.write(alice, "nabidka.html", text("new"), { overwrite: false }))).toBe("exists");
  });

  it("removes temp files of idle threads", async () => {
    const { root, files } = store({ tempTtlMs: 1000 });
    await files.write({ scope: "temp", threadId: "old" }, "a.txt", text("aaa"));
    await files.write({ scope: "temp", threadId: "new" }, "b.txt", text("b"));
    const past = new Date(Date.now() - 5000);
    const oldDir = join(root, "tmp", Buffer.from("old").toString("base64url"));
    utimesSync(join(oldDir, "a.txt"), past, past);
    utimesSync(oldDir, past, past);

    await files.sweepTemp();
    expect(await files.list({ scope: "temp", threadId: "old" })).toEqual([]);
    expect(await files.list({ scope: "temp", threadId: "new" })).toHaveLength(1);
    expect(await files.usage()).toBe(1);
  });
});

describe("file tools", () => {
  const ctx = (role: "admin" | "member"): { configurable: RunContext } => ({
    configurable: { thread_id: "t1", tenant_id: "acme", user_id: "dev:alice", role, channel: "web" },
  });
  const byName = (files: FileStore, gotenberg?: GotenbergClient) =>
    Object.fromEntries(fileTools(files, gotenberg).map((t) => [t.name, t]));

  it("lets members write only their own and temp files", async () => {
    const { files } = store();
    const tools = byName(files);
    expect(await tools.write_file!.invoke({ scope: "tenant", path: "a.txt", content: "x" }, ctx("member"))).toMatch(/jen správce/);
    expect(await tools.write_file!.invoke({ scope: "tenant", path: "a.txt", content: "x" }, ctx("admin"))).toMatch(/^Uloženo: tenant:a.txt/);
    expect(await tools.read_file!.invoke({ scope: "tenant", path: "a.txt" }, ctx("member"))).toBe("x");
    expect(await tools.write_file!.invoke({ scope: "temp", path: "b.txt", content: "y" }, ctx("member"))).toMatch(/^Uloženo: temp:b.txt/);
    expect((await files.read({ scope: "temp", threadId: "t1" }, "b.txt")).data.toString()).toBe("y");
    expect(await tools.read_file!.invoke({ scope: "tenant", path: "../x.txt" }, ctx("member"))).toMatch(/^Nelze:/);
  });

  it("renders Mustache templates, escaping only markup", async () => {
    const { files } = store();
    const tools = byName(files);
    await files.write(tenant, "sablony/n.html", text("<h1>{{klient}}</h1>{{#polozky}}<li>{{.}}</li>{{/polozky}}"));
    await files.write(tenant, "sablony/n.md", text("# {{klient}}"));
    const data = { klient: "<b>Novák & syn</b>", polozky: ["okno", "dveře"] };

    await tools.render_template!.invoke(
      { template_scope: "tenant", template_path: "sablony/n.html", data, output_scope: "temp", output_path: "n.html" },
      ctx("member"),
    );
    expect((await files.read({ scope: "temp", threadId: "t1" }, "n.html")).data.toString()).toBe(
      "<h1>&lt;b&gt;Novák &amp; syn&lt;&#x2F;b&gt;</h1><li>okno</li><li>dveře</li>",
    );
    await tools.render_template!.invoke(
      { template_scope: "tenant", template_path: "sablony/n.md", data, output_scope: "temp", output_path: "n.md" },
      ctx("member"),
    );
    expect((await files.read({ scope: "temp", threadId: "t1" }, "n.md")).data.toString()).toBe("# <b>Novák & syn</b>");
  });

  it("converts HTML with its images to PDF through Gotenberg", async () => {
    const { files } = store();
    const sent: { url: string; names: string[] }[] = [];
    const fakeFetch = (async (url: URL, init: RequestInit) => {
      const form = init.body as FormData;
      sent.push({ url: String(url), names: form.getAll("files").map((f) => (f as File).name) });
      return new Response(Buffer.from("%PDF-1.7 fake"));
    }) as unknown as typeof fetch;
    const tools = byName(files, new GotenbergClient("http://gotenberg:3000", fakeFetch));
    await files.write(alice, "faktura/f.html", text('<img src="logo.png">'));
    await files.write(alice, "faktura/logo.png", PNG);

    const result = await tools.convert_to_pdf!.invoke(
      { scope: "personal", path: "faktura/f.html", output_scope: "personal", output_path: "faktura/f.pdf" },
      ctx("member"),
    );
    expect(result).toMatch(/^PDF vytvořeno: personal:faktura\/f.pdf/);
    expect(sent).toEqual([{ url: "http://gotenberg:3000/forms/chromium/convert/html", names: ["index.html", "logo.png"] }]);
    expect((await files.read(alice, "faktura/f.pdf")).entry.mime).toBe("application/pdf");
  });

  it("resizes images", async () => {
    const { files } = store();
    const tools = byName(files);
    await files.write(alice, "logo.png", PNG);
    expect(
      await tools.resize_image!.invoke({ scope: "personal", path: "logo.png", width: 10, output_scope: "personal", output_path: "logo.webp" }, ctx("member")),
    ).toMatch(/^Uloženo: personal:logo.webp/);
    expect((await files.read(alice, "logo.webp")).data.subarray(8, 12).toString()).toBe("WEBP");
  });
});

describe("files API", () => {
  async function setup() {
    const { tenants } = createTestTenants();
    const app = await createTestApp(tenants);
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "x-tenant-id": "acme", ...init.headers } });
    return { as, tenants };
  }

  it("searches the tenant's text files and the caller's own by words", async () => {
    const { as } = await setup();
    await as("acme")("/files/content?scope=tenant&path=www/index.html", { method: "PUT", body: "<h1>Elektro Novák Brno</h1>" });
    await as("bob:tenant=acme")("/files/content?scope=personal&path=poznamky.md", { method: "PUT", body: "Novák chce nabídku do pátku" });
    await as("eva:tenant=acme")("/files/content?scope=personal&path=tajne.md", { method: "PUT", body: "Novák dluží" });
    const bob = as("bob:tenant=acme");
    const hits = (await (await bob("/files/search?q=novak")).json()) as { scope: string; path: string }[];
    expect(hits.map((h) => `${h.scope}:${h.path}`).sort()).toEqual(["personal:poznamky.md", "tenant:www/index.html"]);
    expect(await (await bob("/files/search?q=brno&scope=tenant")).json()).toEqual([{ scope: "tenant", path: "www/index.html", snippet: "<h1>Elektro Novák «Brno»</h1>" }]);
  });

  it("uploads, lists, downloads and deletes", async () => {
    const { as } = await setup();
    const admin = as("acme");
    const put = await admin("/files/content?scope=tenant&path=sablony/logo.png", { method: "PUT", body: PNG });
    expect(put.status).toBe(201);

    const list = await (await admin("/files?scope=tenant&path=sablony")).json();
    expect(list).toMatchObject([{ path: "sablony/logo.png", size: PNG.length, mime: "image/png" }]);

    const download = await admin("/files/content?scope=tenant&path=sablony/logo.png");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''logo.png");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG);

    expect((await admin("/files?scope=tenant&path=sablony", { method: "DELETE" })).status).toBe(204);
    expect(await (await admin("/files?scope=tenant")).json()).toEqual([]);
  });

  it("lets members read tenant files but write only their own", async () => {
    const { as } = await setup();
    await as("acme")("/files/content?scope=tenant&path=a.txt", { method: "PUT", body: "firemni" });
    const bob = as("bob:tenant=acme");
    expect(await (await bob("/files/content?scope=tenant&path=a.txt")).text()).toBe("firemni");
    expect((await bob("/files/content?scope=tenant&path=b.txt", { method: "PUT", body: "x" })).status).toBe(403);
    expect((await bob("/files?scope=tenant&path=a.txt", { method: "DELETE" })).status).toBe(403);
    expect((await bob("/files/content?scope=personal&path=b.txt", { method: "PUT", body: "x" })).status).toBe(201);
    // Personal files are the caller's own.
    expect(await (await as("carol:tenant=acme")("/files?scope=personal")).json()).toEqual([]);
  });

  it("serves temp files only to the thread's owner and removes them with the thread", async () => {
    const { as, tenants } = await setup();
    const alice = as("alice:tenant=acme");
    const { id } = await (await alice("/threads", { method: "POST" })).json();
    const acme = await tenants.get("acme");
    await acme.files.write({ scope: "temp", threadId: id }, "nabidka.html", Buffer.from("<p>x</p>"));

    expect((await alice(`/files/content?scope=temp&thread=${id}&path=nabidka.html`)).status).toBe(200);
    expect((await as("bob:tenant=acme")(`/files/content?scope=temp&thread=${id}&path=nabidka.html`)).status).toBe(404);
    expect((await alice("/files?scope=temp")).status).toBe(400);

    await alice(`/threads/${id}`, { method: "DELETE" });
    expect(await acme.files.list({ scope: "temp", threadId: id })).toEqual([]);
  });

  it("maps refusals to HTTP statuses and respects the feature switch", async () => {
    const { as, tenants } = await setup();
    const admin = as("acme");
    expect((await admin("/files/content?scope=personal&path=x.exe", { method: "PUT", body: "MZ" })).status).toBe(415);
    expect((await admin("/files/content?scope=personal&path=../x.txt", { method: "PUT", body: "x" })).status).toBe(400);
    expect((await admin("/files/content?scope=personal&path=missing.txt")).status).toBe(404);
    expect(
      (await admin("/files/move", { method: "POST", body: JSON.stringify({ from: { scope: "personal", path: "missing.txt" }, to: { scope: "personal", path: "b.txt" } }) }))
        .status,
    ).toBe(404);

    await (await tenants.get("acme")).features.set({ files: false });
    expect((await admin("/files?scope=personal")).status).toBe(403);
  });
});
