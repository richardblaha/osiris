import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import { HumanMessage } from "@langchain/core/messages";
import { LibSQLSaver } from "@osiris/core/checkpointer/libsql-saver.ts";
import { Command, createOrchestratorGraph, streamTelemetry } from "@osiris/core/agent/orchestrator/graph.ts";
import { BUILTIN_VERIFIERS, MAX_REPAIRS } from "@osiris/core/agent/orchestrator/jev.ts";
import type { ReactDelegate } from "@osiris/core/agent/orchestrator/llm.ts";
import type { PlanStep } from "@osiris/core/agent/orchestrator/state.ts";
import { planTopology } from "@osiris/core/agent/orchestrator/telemetry.ts";
import type { AgentTelemetryEvent } from "@osiris/shared";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers.ts";

/** Answers in script order: objects for structured calls, strings for text calls. */
class ScriptModel extends BaseChatModel {
  constructor(private readonly script: (string | object)[]) {
    super({});
  }

  _llmType() {
    return "script";
  }

  private next() {
    if (!this.script.length) throw new Error("script exhausted");
    return this.script.shift()!;
  }

  override withStructuredOutput() {
    return RunnableLambda.from(async () => ({ raw: new AIMessage(""), parsed: this.next() })) as never;
  }

  async _generate(_: BaseMessage[]): Promise<ChatResult> {
    const text = this.next();
    if (typeof text !== "string") throw new Error(`expected text, got ${JSON.stringify(text)}`);
    return { generations: [{ text, message: new AIMessage(text) }] };
  }
}

const step = (s: Partial<PlanStep> & Pick<PlanStep, "id" | "pattern">): PlanStep => ({ goal: s.id, dependsOn: [], destructive: false, ...s });
const config = (thread = "t1") => ({ configurable: { thread_id: thread, tenant_id: "acme", user_id: "bob", role: "admin", channel: "web" } });
const input = (text: string) => ({ messages: [new HumanMessage(text)] });

async function collect(stream: AsyncGenerator<AgentTelemetryEvent>) {
  const events: AgentTelemetryEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

async function setup(script: (string | object)[], react: ReactDelegate = async (goal) => `hotovo: ${goal.split("\n")[0]}`) {
  const calls: string[] = [];
  const graph = createOrchestratorGraph({
    model: new ScriptModel(script),
    react: async (goal, cfg, key) => (calls.push(key), react(goal, cfg, key)),
    checkpointer: new LibSQLSaver(await createTestDb()),
  });
  return { graph, calls };
}

describe("orchestrator", () => {
  it("runs a composite plan: ReAct, JEV with a self-repair, then a destructive step after approval", async () => {
    const plan = [
      step({ id: "analyza", pattern: "ReAct" }),
      step({ id: "model", pattern: "JEV", verifier: "json", dependsOn: ["analyza"] }),
      step({ id: "zapis", pattern: "ReAct", dependsOn: ["model"], destructive: true }),
    ];
    const { graph, calls } = await setup([
      { rationale: "pipeline", steps: plan },
      { criteria: ["platný JSON"] },
      "{nejde",
      "```json\n{\"a\":1}\n```",
      { accepted: true, feedback: "" },
      "Hotovo, zapsáno.",
    ]);

    const first = await collect(streamTelemetry(graph, input("Analyzuj, vytvoř model a zapiš ho"), config()));
    const routed = first.find((e) => e.nodeId === "router" && e.status === "success")!;
    expect(routed.pattern).toBe("Composite");
    expect(routed.activeGraphTopology!.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["router", "analyza", "model/judge", "model/verify", "zapis/approval", "zapis", "verify", "complete"]));
    expect(first.filter((e) => e.nodeId === "model/verify").map((e) => e.status)).toEqual(["running", "failed", "running", "success"]);
    expect(first.at(-1)).toMatchObject({ nodeId: "zapis/approval", status: "waiting_approval", phase: "HumanApproval" });
    expect(calls).toEqual(["analyza"]);
    expect((await graph.getState(config())).tasks[0]!.interrupts[0]!.value).toEqual({ type: "approval", steps: [{ id: "zapis", goal: "zapis" }] });

    const rest = await collect(streamTelemetry(graph, new Command({ resume: { zapis: true } }), config()));
    expect(calls).toEqual(["analyza", "zapis"]);
    expect(rest.find((e) => e.nodeId === "verify")).toMatchObject({ status: "success" });
    const state = (await graph.getState(config())).values;
    expect(state.results.model).toMatchObject({ status: "success", output: "{\"a\":1}", attempts: 2 });
    expect(state.messages.at(-1)!.text).toBe("Hotovo, zapsáno.");
  });

  it("fails a JEV step once its repairs are used up, and skips what depends on it", async () => {
    const { graph, calls } = await setup([
      { rationale: "x", steps: [step({ id: "sql", pattern: "JEV", verifier: "sql" }), step({ id: "dalsi", pattern: "ReAct", dependsOn: ["sql"] })] },
      { criteria: ["jen SELECT"] },
      ...Array.from({ length: MAX_REPAIRS + 1 }, () => "DELETE FROM t"),
      "Nepovedlo se.",
    ]);
    await graph.invoke(input("dotaz"), config());
    const { results, verdict } = (await graph.getState(config())).values;
    expect(results.sql).toMatchObject({ status: "failed", attempts: MAX_REPAIRS + 1 });
    expect(results.dalsi!.status).toBe("skipped");
    expect(verdict).toEqual({ ok: false, failed: ["sql", "dalsi"] });
    expect(calls).toEqual([]);
  });

  it("maps items in parallel through the agent and reduces them in order", async () => {
    const { graph, calls } = await setup(
      [{ rationale: "kolekce", steps: [step({ id: "senzory", pattern: "MapReduce", items: ["s1", "s2", "s3"] })] }, "Všechny tři v pořádku."],
      async (goal) => `ok ${goal.split(": ").at(-1)}`,
    );
    const events = await collect(streamTelemetry(graph, input("Zkontroluj senzory"), config()));
    expect(calls.sort()).toEqual(["senzory:0", "senzory:1", "senzory:2"]);
    expect(events.filter((e) => e.nodeId === "senzory/map" && e.status === "success")).toHaveLength(3);
    expect((await graph.getState(config())).values.messages.at(-1)!.text).toBe("Všechny tři v pořádku.");
  });

  it("falls back to a single ReAct step when the plan is invalid, and resets results on the next turn", async () => {
    const cyclic = [step({ id: "a", pattern: "ReAct", dependsOn: ["b"] }), step({ id: "b", pattern: "ReAct", dependsOn: ["a"] })];
    const { graph, calls } = await setup([{ rationale: "x", steps: cyclic }, { rationale: "y", steps: [step({ id: "druhy", pattern: "ReAct" })] }]);
    await graph.invoke(input("ahoj"), config());
    expect(calls).toEqual(["task"]);
    expect((await graph.getState(config())).values.messages.at(-1)!.text).toBe("hotovo: ahoj");
    await graph.invoke(input("znovu"), config());
    expect(Object.keys((await graph.getState(config())).values.results)).toEqual(["druhy"]);
  });

  it("never runs a rejected step", async () => {
    const { graph, calls } = await setup([{ rationale: "x", steps: [step({ id: "smaz", pattern: "ReAct", destructive: true })] }]);
    await graph.invoke(input("smaž vše"), config());
    await graph.invoke(new Command({ resume: { smaz: false } }), config());
    expect(calls).toEqual([]);
    expect((await graph.getState(config())).values.messages.at(-1)!.text).toMatch(/zamítl/);
  });
});

describe("verifiers and topology", () => {
  it("checks DTDL and JSON-LD", () => {
    const dtdl = { "@context": "dtmi:dtdl:context;3", "@id": "dtmi:com:example:Thermostat;1", "@type": "Interface", contents: [{ "@type": "Telemetry", name: "temp" }] };
    expect(BUILTIN_VERIFIERS.dtdl!(JSON.stringify(dtdl))).toEqual([]);
    expect(BUILTIN_VERIFIERS.dtdl!(JSON.stringify({ ...dtdl, "@id": "thermostat" }))).toHaveLength(1);
    expect(BUILTIN_VERIFIERS.jsonld!(JSON.stringify({ "@type": "Person" }))).toHaveLength(1);
  });

  it("wires dependencies from each step's exit to the next one's entry", () => {
    const t = planTopology([step({ id: "a", pattern: "JEV", verifier: "json" }), step({ id: "b", pattern: "Reflexion", dependsOn: ["a"], destructive: true })], "Composite");
    expect(t.edges).toEqual(expect.arrayContaining([
      { from: "router", to: "a/judge" },
      { from: "a/judge", to: "b/approval" },
      { from: "b/critic", to: "verify" },
    ]));
    expect(t.edges.some((e) => e.from === "a/judge" && e.to === "verify")).toBe(false);
  });
});
