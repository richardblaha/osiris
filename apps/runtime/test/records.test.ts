import { describe, expect, it } from "vitest";
import { UsageStore } from "@osiris/core/agent/usage.ts";
import { QuestionStore } from "@osiris/core/agent/questions.ts";
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
});
