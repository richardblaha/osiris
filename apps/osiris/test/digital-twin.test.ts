import { describe, expect, it } from "vitest";
import { QuestionStore } from "@osiris/core/agent/questions.ts";
import { digitalTwinModule, twinEventsTool, twinViewTool } from "@osiris/tools-digital-twin";
import type { OpsOptions } from "@osiris/tools-ops";
import { createTestRecords } from "./helpers.ts";

describe("the digital-twin module", () => {
  it("gives the twin's tools only to the projects it names", () => {
    const ops = { ops: { url: "http://twin", token: async () => "t" }, projects: ["twin"] } satisfies OpsOptions;
    const m = digitalTwinModule(ops);
    const host = (projectId: string) => ({ projectId, questions: new QuestionStore(createTestRecords()) }) as never;
    expect(m.create(host("twin")).tools.map((t) => t.name)).toEqual(["twin_view", "twin_events"]);
    expect(m.create(host("acme")).tools).toEqual([]);
  });

  it("reads the warn/error events through the twin's ops API", async () => {
    const fetchFn = async () =>
      Response.json({
        value: [{ id: "1-0", ts: 1_700_000_000_000, severity: "ERROR", severityNumber: 17, message: "boom", cluster: "busiris", namespace: "osiris", pod: "gateway-abc", traceId: "0123456789abcdef0123456789abcdef" }],
      });
    const t = twinEventsTool({ url: "http://twin/", token: async () => "tok", fetch: fetchFn as unknown as typeof fetch });
    const out = await t.invoke({ id: "c", name: "twin_events", type: "tool_call", args: { limit: 5 } });
    const text = String((out as unknown as { content: string }).content);
    expect(text).toContain("error busiris / osiris / gateway-abc: boom (trace 0123456789abcdef0123456789abcdef)");
  });

  it("carries the twin's steps to the PWA in the artifact", async () => {
    const out = await twinViewTool().invoke({ id: "c1", name: "twin_view", type: "tool_call", args: { actions: [{ action: "select", target: "osd.7" }, { action: "zoom", factor: 1.5 }] } });
    expect(out.artifact).toEqual({ twin: [{ action: "select", target: "osd.7" }, { action: "zoom", factor: 1.5 }] });
  });
});
