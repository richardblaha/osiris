import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileTools } from "@osiris/tools-files/tools.ts";
import type { RunContext } from "@osiris/core/agent/context.ts";
import { GotenbergClient } from "@osiris/core/files/gotenberg.ts";
import { FileError, FileStore, pathSegments, type FileLocation } from "@osiris/core/files/store.ts";
import { createTestProjects, createTestApp } from "./helpers.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001249444154789c63f8cfc0f01f8419a0f47f0043ce07f9fa814afd0000000049454e44ae426082", "hex");
const text = (s: string) => Buffer.from(s, "utf8");
const project: FileLocation = { scope: "project" };
const alice: FileLocation = { scope: "personal", userId: "dev:alice" };
const firm: FileLocation = { scope: "project" };

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
    await files.write(project, "sablony/nabidka.html", text("<p>{{name}}</p>"));
    await files.write(alice, "poznamky.md", text("# Ahoj"));

    expect((await files.list(project)).map((e) => [e.path, e.type])).toEqual([["sablony", "dir"]]);
    const [entry] = await files.list(project, "sablony");
    expect(entry).toMatchObject({ scope: "project", path: "sablony/nabidka.html", name: "nabidka.html", type: "file", mime: "text/html" });
    expect((await files.read(alice, "/poznamky.md")).data.toString()).toBe("# Ahoj");
    // Another user's personal files are a different folder.
    expect(await files.list({ scope: "personal", userId: "dev:bob" })).toEqual([]);

    await files.delete(project, "sablony");
    expect(await files.list(project)).toEqual([]);
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
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "secret.txt"), join(root, "file.txt"));

    expect(await code(files.read(project, "link/secret.txt"))).toBe("invalid");
    expect(await code(files.write(project, "link/new.txt", text("x")))).toBe("invalid");
    expect(await code(files.list(project, "link"))).toBe("invalid");
    expect(await code(files.read(project, "file.txt"))).toBe("invalid");
    // Symlinks are not listed.
    expect(await files.list(project)).toEqual([]);
  });

  it("accepts only known types whose content matches the extension", async () => {
    const { files } = store();
    expect(await code(files.write(project, "run.exe", text("MZ")))).toBe("type");
    expect(await code(files.write(project, "noext", text("x")))).toBe("type");
    expect(await code(files.write(project, "fake.png", text("not a png")))).toBe("type");
    expect(await code(files.write(project, "bin.txt", Buffer.from([0x61, 0x00, 0x62])))).toBe("type");
    expect(await code(files.write(project, "logo.png", PNG))).toBe("ok");
    // Renaming can't turn the content into another type.
    expect(await code(files.move(project, "logo.png", project, "logo.pdf"))).toBe("type");
  });

  it("enforces the file size and the project quota", async () => {
    const { files } = store({ maxFileBytes: 10, quotaBytes: 15 });
    expect(await code(files.write(project, "big.txt", text("x".repeat(11))))).toBe("too_large");
    await files.write(project, "a.txt", text("x".repeat(10)));
    expect(await code(files.write(alice, "b.txt", text("x".repeat(6))))).toBe("quota");
    // Overwriting counts only the difference.
    expect(await code(files.write(project, "a.txt", text("x".repeat(9))))).toBe("ok");
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

  it("keeps temp files until their thread goes, and lists the threads that have any", async () => {
    const { files } = store();
    await files.write({ scope: "temp", threadId: "old" }, "a.txt", text("aaa"));
    await files.write({ scope: "temp", threadId: "new" }, "b.txt", text("b"));
    expect((await files.tempThreads()).sort()).toEqual(["new", "old"]);
    await files.removeTemp("old");
    expect(await files.tempThreads()).toEqual(["new"]);
    expect(await files.usage()).toBe(1);
  });
});

describe("file tools", () => {
  const ctx = (role: "admin" | "member"): { configurable: RunContext } => ({
    configurable: { thread_id: "t1", project_id: "acme", user_id: "dev:alice", role, channel: "web" },
  });
  const byName = (files: FileStore, gotenberg?: GotenbergClient) =>
    Object.fromEntries(fileTools(files, gotenberg).map((t) => [t.name, t]));

  it("lets admins write the project's files, everyone their own and their thread's temp files", async () => {
    const { files } = store();
    const tools = byName(files);
    expect(await tools.write_file!.invoke({ scope: "project", path: "a.txt", content: "x" }, ctx("admin"))).toMatch(/^Uloženo: project:a.txt/);
    expect(await tools.write_file!.invoke({ scope: "project", path: "a.txt", content: "y" }, ctx("member"))).toMatch(/^Do souborů firmy zapisuje jen správce/);
    expect(await tools.delete_file!.invoke({ scope: "project", path: "a.txt" }, ctx("member"))).toMatch(/^Do souborů firmy zapisuje jen správce/);
    expect(await tools.read_file!.invoke({ scope: "project", path: "a.txt" }, ctx("member"))).toBe("x");
    // The member's own copy at the same path replaces the project's file for them, and only for them.
    expect(await tools.write_file!.invoke({ scope: "personal", path: "a.txt", content: "moje" }, ctx("member"))).toMatch(/^Uloženo: personal:a.txt/);
    expect(await tools.read_file!.invoke({ scope: "project", path: "a.txt" }, ctx("member"))).toMatch(/nahrazuje firemní soubor\.\)\nmoje$/);
    expect(await tools.read_file!.invoke({ scope: "project", path: "a.txt" }, { configurable: { ...ctx("member").configurable, user_id: "dev:bob" } })).toBe("x");
    expect(await tools.write_file!.invoke({ scope: "temp", path: "b.txt", content: "y" }, ctx("member"))).toMatch(/^Uloženo: temp:b.txt/);
    expect((await files.read({ scope: "temp", threadId: "t1" }, "b.txt")).data.toString()).toBe("y");
    expect(await tools.read_file!.invoke({ scope: "project", path: "../x.txt" }, ctx("member"))).toMatch(/^Nelze:/);
  });

  it("renders Mustache templates, escaping only markup", async () => {
    const { files } = store();
    const tools = byName(files);
    await files.write(project, "sablony/n.html", text("<h1>{{klient}}</h1>{{#polozky}}<li>{{.}}</li>{{/polozky}}"));
    await files.write(project, "sablony/n.md", text("# {{klient}}"));
    const data = { klient: "<b>Novák & syn</b>", polozky: ["okno", "dveře"] };

    await tools.render_template!.invoke(
      { template_scope: "project", template_path: "sablony/n.html", data, output_scope: "temp", output_path: "n.html" },
      ctx("member"),
    );
    expect((await files.read({ scope: "temp", threadId: "t1" }, "n.html")).data.toString()).toBe(
      "<h1>&lt;b&gt;Novák &amp; syn&lt;&#x2F;b&gt;</h1><li>okno</li><li>dveře</li>",
    );
    await tools.render_template!.invoke(
      { template_scope: "project", template_path: "sablony/n.md", data, output_scope: "temp", output_path: "n.md" },
      ctx("member"),
    );
    expect((await files.read({ scope: "temp", threadId: "t1" }, "n.md")).data.toString()).toBe("# <b>Novák & syn</b>");
  });

  it("refuses a template whose data lacks a key, naming it", async () => {
    const { files } = store();
    const tools = byName(files);
    await files.write(project, "sablony/f.md", text("{{klient}} {{#polozky}}{{nazev}} {{cena}}{{/polozky}}{{^poznamka}}-{{/poznamka}}"));
    const call = (data: object) =>
      tools.render_template!.invoke({ template_scope: "project", template_path: "sablony/f.md", data, output_scope: "temp", output_path: "f.md" }, ctx("member"));

    const refused = JSON.parse(await call({ klient: "Novák", polozky: [{ nazev: "okno" }] }));
    expect(refused).toMatchObject({ success: false, error_code: "MISSING_KEYS" });
    expect(refused.message).toContain("cena, poznamka");
    expect(JSON.parse(await call({ klient: "Novák", polozky: [{ nazev: "okno", cena: "100 Kč" }], poznamka: null }))).toMatchObject({ success: true });
    expect((await files.read({ scope: "temp", threadId: "t1" }, "f.md")).data.toString()).toBe("Novák okno 100 Kč-");
    // Not strict: blanks, as Mustache does.
    await tools.render_template!.invoke(
      { template_scope: "project", template_path: "sablony/f.md", data: { klient: "X" }, output_scope: "temp", output_path: "f.md", strict: false },
      ctx("member"),
    );
    expect((await files.read({ scope: "temp", threadId: "t1" }, "f.md")).data.toString()).toBe("X -");
  });

  it("edits a text file exactly, by pattern, at a line or by a patch, and refuses what's ambiguous", async () => {
    const { files } = store();
    const tools = byName(files);
    const edit = async (args: object) => JSON.parse(await tools.edit_text!.invoke({ scope: "project", path: "c.txt", ...args }, ctx("admin")));
    const content = async () => (await files.read(project, "c.txt")).data.toString();
    await files.write(project, "c.txt", text("a = 1\r\nb = 2\r\nb = 2\r\nc = 3\r\n"));

    const ambiguous = await edit({ operation: "replace_exact", search: "b = 2", replacement: "b = 5" });
    expect(ambiguous).toMatchObject({ success: false, error_code: "AMBIGUOUS_MATCH" });
    expect(ambiguous.message).toContain("na řádcích 2, 3");
    expect(await edit({ operation: "replace_exact", search: "x", replacement: "y" })).toMatchObject({ success: false, error_code: "NOT_FOUND" });
    expect(await edit({ operation: "replace_exact", search: "b = 2", replacement: "b = 5", expected_occurrences: 2, dry_run: true })).toMatchObject({
      success: true,
      meta: { lines_changed: 4, dry_run: true },
    });
    expect(await content()).toContain("b = 2");
    const done = await edit({ operation: "replace_exact", search: "a = 1\r\nb = 2", replacement: "a = 1\r\nb = 9" });
    expect(done).toMatchObject({ success: true, result: expect.stringMatching(/^Uloženo: project:c.txt/) });
    expect(done.meta.diff).toContain("-b = 2\r\n+b = 9");

    expect(await edit({ operation: "replace_regex", pattern: "^(\\w) = 3", flags: "m", replacement: "$1 = 4" })).toMatchObject({ success: true });
    expect(await edit({ operation: "replace_regex", pattern: "= \\d", replacement: "= 0", max_matches: 2 })).toMatchObject({ error_code: "TOO_MANY_MATCHES" });
    expect(await edit({ operation: "insert_at", line_number: 1, position: "after", content: "x = 0\n" })).toMatchObject({ success: true });
    expect(await edit({ operation: "insert_at", line_number: 9, position: "after", content: "y" })).toMatchObject({ error_code: "LINE_OUT_OF_RANGE" });
    expect(await content()).toBe("a = 1\r\nx = 0\r\nb = 9\r\nb = 2\r\nc = 4\r\n");

    const patch = "--- a\n+++ b\n@@ -4,2 +4,2 @@\n b = 2\n-c = 4\n+c = 5\n";
    expect(await edit({ operation: "diff_patch", patch })).toMatchObject({ success: true });
    expect(await content()).toBe("a = 1\r\nx = 0\r\nb = 9\r\nb = 2\r\nc = 5\r\n");
    const rejected = await edit({ operation: "diff_patch", patch });
    expect(rejected).toMatchObject({ success: false, error_code: "HUNK_REJECTED" });
    expect(rejected.message).toContain('patch čeká "c = 4"');
    expect(await edit({ operation: "diff_patch" })).toMatchObject({ error_code: "MISSING_PARAMETERS" });
  });

  it("stops a regular expression that runs too long", async () => {
    const { files } = store();
    await files.write(project, "r.txt", text(`${"a".repeat(40)}!`));
    const started = Date.now();
    const out = JSON.parse(
      await byName(files).edit_text!.invoke({ scope: "project", path: "r.txt", operation: "replace_regex", pattern: "(a+)+$", replacement: "" }, ctx("admin")),
    );
    expect(out).toMatchObject({ success: false, error_code: "REGEX_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(3000);
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
    await files.write(firm, "faktura/f.html", text('<img src="logo.png">'));
    await files.write(firm, "faktura/logo.png", PNG);

    const result = await tools.convert_to_pdf!.invoke(
      { scope: "project", path: "faktura/f.html", output_scope: "project", output_path: "faktura/f.pdf" },
      ctx("admin"),
    );
    expect(result).toMatch(/^PDF vytvořeno: project:faktura\/f.pdf/);
    expect(sent).toEqual([{ url: "http://gotenberg:3000/forms/chromium/convert/html", names: ["index.html", "logo.png"] }]);
    expect((await files.read(firm, "faktura/f.pdf")).entry.mime).toBe("application/pdf");
  });

  it("resizes images", async () => {
    const { files } = store();
    const tools = byName(files);
    await files.write(firm, "logo.png", PNG);
    expect(
      await tools.resize_image!.invoke({ scope: "project", path: "logo.png", width: 10, output_scope: "project", output_path: "logo.webp" }, ctx("admin")),
    ).toMatch(/^Uloženo: project:logo.webp/);
    expect((await files.read(firm, "logo.webp")).data.subarray(8, 12).toString()).toBe("WEBP");
  });
});

describe("files API", () => {
  async function setup() {
    const { projects } = createTestProjects();
    const app = await createTestApp(projects);
    const as = (user: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${user}`, "x-project-id": "acme", ...init.headers } });
    return { as, projects };
  }

  it("searches the project's text files and the caller's own by words", async () => {
    const { as } = await setup();
    await as("acme")("/files/content?scope=project&path=www/index.html", { method: "PUT", body: "<h1>Elektro Novák Brno</h1>" });
    await as("bob:project=acme")("/files/content?scope=personal&path=poznamky.md", { method: "PUT", body: "Novák chce nabídku do pátku" });
    const bob = as("bob:project=acme");
    const hits = (await (await bob("/files/search?q=novak")).json()) as { scope: string; path: string }[];
    expect(hits.map((h) => `${h.scope}:${h.path}`).sort()).toEqual(["personal:poznamky.md", "project:www/index.html"]);
    expect(await (await as("carol:project=acme")("/files/search?q=pátku")).json()).toEqual([]);
    expect(await (await bob("/files/search?q=brno")).json()).toEqual([{ scope: "project", path: "www/index.html", snippet: "<h1>Elektro Novák «Brno»</h1>" }]);
  });

  it("uploads, lists, downloads and deletes", async () => {
    const { as } = await setup();
    const admin = as("acme");
    const put = await admin("/files/content?scope=project&path=sablony/logo.png", { method: "PUT", body: PNG });
    expect(put.status).toBe(201);

    const list = await (await admin("/files?scope=project&path=sablony")).json();
    expect(list).toMatchObject([{ path: "sablony/logo.png", size: PNG.length, mime: "image/png" }]);

    const download = await admin("/files/content?scope=project&path=sablony/logo.png");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''logo.png");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(PNG);

    expect((await admin("/files?scope=project&path=sablony", { method: "DELETE" })).status).toBe(204);
    expect(await (await admin("/files?scope=project")).json()).toEqual([]);
  });

  it("lets members read the project's files and keep their own, which only they see", async () => {
    const { as } = await setup();
    await as("acme")("/files/content?scope=project&path=a.txt", { method: "PUT", body: "firemni" });
    const bob = as("bob:project=acme");
    expect(await (await bob("/files/content?scope=project&path=a.txt")).text()).toBe("firemni");
    expect((await bob("/files/content?scope=project&path=b.txt", { method: "PUT", body: "x" })).status).toBe(403);
    expect((await bob("/files?scope=project&path=a.txt", { method: "DELETE" })).status).toBe(403);
    expect((await bob("/files/move", { method: "POST", body: JSON.stringify({ from: { scope: "project", path: "a.txt" }, to: { scope: "personal", path: "a.txt" } }) })).status).toBe(403);
    expect((await bob("/files/content?scope=personal&path=a.txt", { method: "PUT", body: "moje" })).status).toBe(201);
    expect(await (await bob("/files/content?scope=personal&path=a.txt")).text()).toBe("moje");
    expect((await as("carol:project=acme")("/files/content?scope=personal&path=a.txt")).status).toBe(404);
    expect(await (await as("carol:project=acme")("/files/content?scope=project&path=a.txt")).text()).toBe("firemni");
  });

  it("serves temp files only to the thread's owner and removes them with the thread", async () => {
    const { as, projects } = await setup();
    const alice = as("alice:project=acme");
    const { id } = await (await alice("/threads", { method: "POST" })).json();
    const acme = await projects.get("acme");
    await acme.files.write({ scope: "temp", threadId: id }, "nabidka.html", Buffer.from("<p>x</p>"));

    expect((await alice(`/files/content?scope=temp&thread=${id}&path=nabidka.html`)).status).toBe(200);
    expect((await as("bob:project=acme")(`/files/content?scope=temp&thread=${id}&path=nabidka.html`)).status).toBe(404);
    expect((await alice("/files?scope=temp")).status).toBe(400);

    await alice(`/threads/${id}`, { method: "DELETE" });
    expect(await acme.files.list({ scope: "temp", threadId: id })).toEqual([]);
  });

  it("maps refusals to HTTP statuses and respects the feature switch", async () => {
    const { as, projects } = await setup();
    const admin = as("acme");
    expect((await admin("/files/content?scope=project&path=x.exe", { method: "PUT", body: "MZ" })).status).toBe(415);
    expect((await admin("/files/content?scope=project&path=../x.txt", { method: "PUT", body: "x" })).status).toBe(400);
    expect((await admin("/files/content?scope=project&path=missing.txt")).status).toBe(404);
    expect(
      (await admin("/files/move", { method: "POST", body: JSON.stringify({ from: { scope: "project", path: "missing.txt" }, to: { scope: "project", path: "b.txt" } }) }))
        .status,
    ).toBe(404);

    await (await projects.get("acme")).features.set({ files: false });
    expect((await admin("/files?scope=project")).status).toBe(403);
  });
});
