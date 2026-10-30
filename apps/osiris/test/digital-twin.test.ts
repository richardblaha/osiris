import { describe, expect, it } from "vitest";
import { QuestionStore } from "@osiris/core/agent/questions.ts";
import { digitalTwinModule, twinViewTool } from "@osiris/tools-digital-twin";
import { createTestRecords } from "./helpers.ts";

describe("the digital-twin module", () => {
  it("gives the twin_view tool only to the projects it names", () => {
    const m = digitalTwinModule(["twin"]);
    const host = (projectId: string) => ({ projectId, questions: new QuestionStore(createTestRecords()) }) as never;
    expect(m.create(host("twin")).tools.map((t) => t.name)).toEqual(["twin_view"]);
    expect(m.create(host("acme")).tools).toEqual([]);
  });

  it("carries the twin's steps to the PWA in the artifact", async () => {
    const out = await twinViewTool().invoke({ id: "c1", name: "twin_view", type: "tool_call", args: { actions: [{ action: "select", target: "osd.7" }, { action: "zoom", factor: 1.5 }] } });
    expect(out.artifact).toEqual({ twin: [{ action: "select", target: "osd.7" }, { action: "zoom", factor: 1.5 }] });
  });
});
