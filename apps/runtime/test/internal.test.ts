import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createDb } from "@osiris/core/db/client.ts";
import { generateInternalKeys, InternalSigner, InternalVerifier, projectAudience } from "@osiris/platform/internal-auth.ts";
import { SLEEPING_HEADER } from "@osiris/platform/runtime-client.ts";
import { Activity } from "../src/activity.ts";
import { createRuntimeApp } from "../src/app.ts";
import { dbPath, hasDatabase, restoreSnapshot, withSnapshot } from "../src/snapshot.ts";
import { createTestProjects } from "./helpers.ts";

const keys = await generateInternalKeys();
const user = { sub: "u1", name: "Alice", email: null, phone: null, picture: null };

async function setup(script: AIMessage[] = []) {
  const { projects, model } = createTestProjects(script);
  const project = await projects.get("acme");
  const activity = new Activity();
  const snapshots: string[] = [];
  const app = createRuntimeApp({
    project,
    verifier: new InternalVerifier(keys.publicKey),
    activity,
    snapshot: async (reason) => (snapshots.push(reason), { key: `k-${reason}`, bytes: 1 }),
  });
  const as = (issuer: string, claims = {}, audience = projectAudience("acme")) => async (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: await new InternalSigner(keys.privateKey, issuer).header(audience, claims), "content-type": "application/json" },
    });
  return { app, project, activity, snapshots, model, as };
}

describe("runtime authentication", () => {
  it("accepts only internal tokens for its own project from the right services", async () => {
    const { as } = await setup();
    const userClaims = { user, project: "acme", role: "member" as const, channel: "web" as const };
    expect((await (await as("gateway", userClaims))("/api/threads")).status).toBe(200);
    expect((await (await as("gateway", userClaims, projectAudience("beta")))("/api/threads")).status).toBe(401);
    expect((await (await as("gateway", { ...userClaims, project: "beta" }))("/api/threads")).status).toBe(401);
    expect((await (await as("gateway", { ...userClaims, user: undefined }))("/api/threads")).status).toBe(401);
    // A token from an unknown signer or a forged issuer.
    const other = await generateInternalKeys();
    const forged = await new InternalSigner(other.privateKey, "gateway").header(projectAudience("acme"), userClaims);
    expect((await (await setup()).app.request("/api/threads", { headers: { authorization: forged } })).status).toBe(401);
    // Internal routes are for control and the operator, not the gateway.
    expect((await (await as("gateway"))("/internal/activity")).status).toBe(403);
    expect((await (await as("operator"))("/internal/activity")).status).toBe(200);
  });
});

describe("runtime internal routes", () => {
  it("runs a scheduled task once per idempotency key in a new thread of its owner", async () => {
    const { as, project, model } = await setup([new AIMessage("Hotovo: 3 zakázky.")]);
    const control = await as("control", { user, project: "acme", role: "member", channel: "web" });
    const body = JSON.stringify({ title: "Ranní souhrn", prompt: "Shrň zakázky", idempotencyKey: "s1:100" });
    const first = await (await control("/internal/runs", { method: "POST", body })).json();
    const again = await (await control("/internal/runs", { method: "POST", body })).json();
    expect(first.reply).toBe("Hotovo: 3 zakázky.");
    expect(again).toEqual(first);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.at(-1)!.text).toContain("Plánovaná úloha „Ranní souhrn“");
    const { rows } = await project.db.execute({ sql: "SELECT user_id, title FROM threads WHERE id = ?", args: [first.threadId] });
    expect(rows[0]).toMatchObject({ user_id: "u1", title: "⏰ Ranní souhrn" });
  });

  it("keeps a WhatsApp conversation per user until a new thread is asked for, and drops redeliveries", async () => {
    const { as, model } = await setup([new AIMessage("Ahoj"), new AIMessage("Druhá"), new AIMessage("Nová")]);
    const control = await as("control", { user, project: "acme", role: "member", channel: "whatsapp" });
    const send = (messageId: string, text: string) => control("/internal/whatsapp/message", { method: "POST", body: JSON.stringify({ messageId, text }) });
    expect(await (await send("m1", "ahoj")).json()).toMatchObject({ reply: "Ahoj" });
    expect(await (await send("m1", "ahoj")).json()).toMatchObject({ reply: "Ahoj" });
    await send("m2", "dál");
    // The second message saw the first (same thread).
    expect(model.calls[1]!.map((m) => m.text)).toContain("ahoj");
    await control("/internal/whatsapp/new-thread", { method: "POST" });
    await send("m3", "znovu");
    expect(model.calls[2]!.map((m) => m.text)).not.toContain("ahoj");
  });

  it("goes to sleep only when idle, then turns requests away for the gateway to wake a new runtime", async () => {
    const { as, activity, snapshots } = await setup();
    const operator = await as("operator");
    activity.activeRuns = 1;
    expect((await operator("/internal/snapshot?reason=sleep", { method: "POST" })).status).toBe(409);
    activity.activeRuns = 0;
    expect(await (await operator("/internal/snapshot?reason=sleep", { method: "POST" })).json()).toEqual({ key: "k-sleep", bytes: 1 });
    expect(snapshots).toEqual(["sleep"]);
    const res = await (await as("gateway", { user, project: "acme", role: "member", channel: "web" }))("/api/threads");
    expect(res.status).toBe(503);
    expect(res.headers.get(SLEEPING_HEADER)).toBe("1");
  });
});

describe("snapshots", () => {
  it("round-trips the database and files, and restores only them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osiris-snap-"));
    mkdirSync(join(dir, "db"), { recursive: true });
    const db = createDb(`file:${dbPath(dir)}`);
    await db.execute("CREATE TABLE t (v TEXT)");
    await db.execute("INSERT INTO t VALUES ('ahoj')");
    mkdirSync(join(dir, "files", "project", "sablony"), { recursive: true });
    writeFileSync(join(dir, "files", "project", "sablony", "a.html"), "<p>x</p>");

    const chunks: Buffer[] = [];
    await withSnapshot(db, dir, undefined, async (archive: Readable) => {
      for await (const c of archive) chunks.push(Buffer.from(c as Uint8Array));
    });
    db.close();

    const target = mkdtempSync(join(tmpdir(), "osiris-restore-"));
    expect(hasDatabase(target)).toBe(false);
    const stream = new PassThrough();
    stream.end(Buffer.concat(chunks));
    await restoreSnapshot(target, stream);
    expect(hasDatabase(target)).toBe(true);
    const restored = createDb(`file:${dbPath(target)}`);
    expect((await restored.execute("SELECT v FROM t")).rows[0]?.v).toBe("ahoj");
    expect(readFileSync(join(target, "files", "project", "sablony", "a.html"), "utf8")).toBe("<p>x</p>");
  });
});

describe("WhatsApp file delivery authorization", () => {
  it("returns only current-turn offered files to the thread owner", async () => {
    const { as, project } = await setup([
      new AIMessage({ content: "", tool_calls: [{ id: "file1", name: "send_chat_file", args: { scope: "project", path: "offered.txt" } }] }),
      new AIMessage("Posílám soubor."),
      new AIMessage("Další odpověď."),
    ]);
    await project.files.write({ scope: "project" }, "offered.txt", Buffer.from("Nabídka"));
    await project.files.write({ scope: "project" }, "other.txt", Buffer.from("Jiný soubor"));
    const control = as("control", { user, project: "acme", role: "member", channel: "whatsapp" });
    const send = (id: string) => control("/internal/whatsapp/message", { method: "POST", body: JSON.stringify({ messageId: id, text: "Pošli soubor" }) });
    const result = await (await send("offer1")).json();
    expect(result.files).toEqual([{ scope: "project", path: "offered.txt", mime: "text/plain" }]);
    const read = (path: string, who = control) => who("/internal/whatsapp/file", { method: "POST", body: JSON.stringify({ threadId: result.threadId, scope: "project", path }) });
    expect(Buffer.from((await (await read("offered.txt")).json()).data, "base64").toString()).toBe("Nabídka");
    expect((await read("other.txt")).status).toBe(404);
    expect((await read("offered.txt", as("control", { user: { ...user, sub: "u2" }, project: "acme", role: "member", channel: "whatsapp" }))).status).toBe(404);
    await send("offer2");
    expect((await read("offered.txt")).status).toBe(404);
  });
});
