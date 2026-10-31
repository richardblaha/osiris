import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UsageStore } from "@osiris/core/agent/usage.ts";
import { QuestionStore } from "@osiris/core/agent/questions.ts";
import { createThread, listThreads, threadIds } from "@osiris/core/repo/threads.ts";
import { idName } from "@osiris/core/projects/records.ts";
import { createTestRecords } from "./helpers.ts";

describe("records", () => {
  it("counts parallel token usage without losing any", async () => {
    const usage = new UsageStore(createTestRecords());
    await Promise.all(Array.from({ length: 50 }, () => usage.add(2, Date.UTC(2026, 9, 1), { user: "bob" })));
    expect(await usage.tokens(Date.UTC(2026, 9, 1))).toBe(100);
    expect(await usage.tokens(Date.UTC(2026, 9, 1), { user: "bob" })).toBe(100);
  });

  it("takes a question's answer once, whatever runs at the same time", async () => {
    const questions = new QuestionStore(createTestRecords());
    const q = await questions.create("bob", "t1", { title: "Potvrdit?", fields: [{ name: "ok", label: "OK", type: "boolean", required: true }] });
    const tries = await Promise.allSettled(Array.from({ length: 10 }, () => questions.resolve("bob", "t1", q.id, { ok: true }, false)));
    expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    expect(await questions.answer("bob", "t1", q.id)).toEqual({ ok: true });
  });

  it("leaves no temp file behind when a write fails", async () => {
    const records = createTestRecords();
    mkdirSync(records.path("a/b.json"), { recursive: true });
    writeFileSync(records.path("a/b.json/inside"), "x");
    await expect(records.write("a/b.json", { ok: true })).rejects.toThrow();
    expect(readdirSync(records.path("a"))).toEqual(["b.json"]);
  });

  it("lists a user's threads past a damaged one, and still counts that one as existing", async () => {
    const records = createTestRecords();
    await createThread(records, "bob", "t-good", "web");
    await createThread(records, "bob", "t-bad", "web");
    writeFileSync(records.path(`private/threads/${idName("t-bad")}/thread.json`), "");
    expect((await listThreads(records, "bob")).map((t) => t.id)).toEqual(["t-good"]);
    expect([...(await threadIds(records))].sort()).toEqual(["t-bad", "t-good"]);
  });
});
