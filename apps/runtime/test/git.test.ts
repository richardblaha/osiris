import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp, createTestProjects } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

describe("the project as a git repository", () => {
  it("connects, commits its shared files without the private ones, pushes, pulls and refuses a diverged pull", async () => {
    const remote = mkdtempSync(join(tmpdir(), "osiris-remote-"));
    git(remote, "init", "-q", "--bare", "-b", "main");
    const { projects } = createTestProjects([], [], undefined, { mcp: { allowPrivate: true } });
    const app = await createTestApp(projects);
    const as = (who: string) => (path: string, init: RequestInit = {}) =>
      app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${who}`, "x-project-id": "acme", "content-type": "application/json" } });
    const admin = as("acme");
    const acme = await projects.get("acme");
    await acme.files.write({ scope: "project" }, "web/index.md", Buffer.from("# Firma"));
    await acme.knowledge.putDocument("cenik.md", "Hodina 650 Kč");
    await acme.secrets.put("CRM", "", { value: "tajne", allowedHosts: ["crm.example.com"], description: "" });

    expect((await as("bob:project=acme")("/git")).status).toBe(403);
    expect(await (await admin("/git")).json()).toMatchObject({ connected: false });
    expect((await admin("/git", { method: "PUT", body: JSON.stringify({ url: "https://user:pass@example.com/r.git" }) })).status).toBe(400);
    const connected = await (await admin("/git", { method: "PUT", body: JSON.stringify({ url: `file://${remote}`, branch: "main" }) })).json();
    expect(connected).toMatchObject({ connected: true, branch: "main", changes: [], ahead: 0, behind: 0 });

    // A clone has the project's shared files and none of its private ones.
    const clone = mkdtempSync(join(tmpdir(), "osiris-clone-"));
    git(clone, "clone", "-q", remote, ".");
    const tracked = git(clone, "ls-files").split("\n").filter(Boolean);
    expect(tracked).toEqual(expect.arrayContaining(["web/index.md", ".osiris/knowledge/cenik.md", ".osiris/.gitignore", ".gitignore"]));
    expect(tracked.some((p) => p.startsWith(".osiris/private/") || p.startsWith(".osiris/cache/"))).toBe(false);
    expect(() => git(clone, "grep", "-I", "tajne", "HEAD")).toThrow();

    // Someone pushes a change; the project pulls it, and the knowledge base takes it in.
    writeFileSync(join(clone, ".osiris/knowledge/cenik.md"), "Hodina 700 Kč");
    git(clone, "commit", "-q", "-am", "Nový ceník");
    git(clone, "push", "-q");
    expect(await (await admin("/git/pull", { method: "POST" })).json()).toMatchObject({ behind: 0 });
    expect((await acme.knowledge.getDocument("cenik.md"))?.content).toBe("Hodina 700 Kč");
    expect((await acme.knowledge.search("hodina"))[0]?.content).toBe("Hodina 700 Kč");

    // A local change goes out with commit and push.
    await acme.files.write({ scope: "project" }, "web/index.md", Buffer.from("# Firma Novák"));
    expect(await (await admin("/git/commit", { method: "POST", body: JSON.stringify({ message: "Nadpis" }) })).json()).toMatchObject({ committed: true, status: { ahead: 1 } });
    expect(await (await admin("/git/push", { method: "POST" })).json()).toMatchObject({ ahead: 0 });
    git(clone, "pull", "-q");
    expect(readFileSync(join(clone, "web/index.md"), "utf8")).toBe("# Firma Novák");

    // Both sides changed: the pull is refused, naming the files.
    writeFileSync(join(clone, "web/index.md"), "# Jinak");
    git(clone, "commit", "-q", "-am", "Jinak");
    git(clone, "push", "-q");
    await acme.files.write({ scope: "project" }, "web/o-nas.md", Buffer.from("# O nás"));
    await admin("/git/commit", { method: "POST", body: JSON.stringify({ message: "O nás" }) });
    const refused = await admin("/git/pull", { method: "POST" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("web/index.md");
  });
});
