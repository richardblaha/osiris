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
import { createAgentGraph } from "@osiris/core/agent/graph.ts";
import { QuestionStore } from "@osiris/core/agent/questions.ts";
import { streamRun } from "@osiris/core/agent/run.ts";
import { workflowTool, WORKFLOW_TOOL } from "@osiris/core/agent/orchestrator/tool.ts";
import { reactFromAgentGraph } from "@osiris/core/agent/orchestrator/graph.ts";
import type { RunContext } from "@osiris/core/agent/context.ts";
import type { RunEvent } from "@osiris/shared";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers.ts";

/** Answers in script order: objects for structured calls, strings or messages for text calls. */
class ScriptModel extends BaseChatModel {
  bound: string[][] = [];

  constructor(private readonly script: (string | object)[]) {
    super({});
  }

  override bindTools(tools: { name: string }[]) {
    this.bound.push(tools.map((t) => t.name));
    return this as never;
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
    const next = this.next();
    const message = typeof next === "string" ? new AIMessage(next) : next;
    if (!AIMessage.isInstance(message)) throw new Error(`expected text, got ${JSON.stringify(next)}`);
    return { generations: [{ text: message.text, message }] };
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

describe("run_workflow tool", () => {
  it("asks for approval in the chat, resumes only on the user's answer, and runs steps without ask_user", async () => {
    const db = await createTestDb();
    const checkpointer = new LibSQLSaver(db);
    await db.execute("INSERT INTO threads (id, user_id, channel) VALUES ('t1', 'bob', 'web')");
    const questions = new QuestionStore(db);
    const model = new ScriptModel([
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: WORKFLOW_TOOL, args: { request: "Smaž staré zakázky" } }] }),
      { rationale: "mazání", steps: [step({ id: "smazani", goal: "Smaž staré zakázky", pattern: "ReAct", destructive: true })] },
      new AIMessage({ content: "", tool_calls: [{ id: "c2", name: WORKFLOW_TOOL, args: { request: "", resume: true } }] }),
      "Smazáno 3 zakázky.",
      "Hotovo: smazány 3 zakázky.",
    ]);
    let agent!: ReturnType<typeof createAgentGraph>;
    const orchestrator = createOrchestratorGraph({ model, react: (g, c, k) => reactFromAgentGraph(agent)(g, c, k), checkpointer });
    const wf = workflowTool(orchestrator, questions);
    agent = createAgentGraph({ tenantId: "acme", model, tools: [questions.tool()], dynamicTools: async (ctx) => (ctx.workflow ? [] : [wf]), checkpointer, timezone: "Europe/Prague", questions });
    const ctx: RunContext = { thread_id: "t1", tenant_id: "acme", user_id: "bob", role: "admin", channel: "web", locale: "cs" };
    const run = async (text: string) => {
      const events: RunEvent[] = [];
      for await (const e of streamRun(agent, ctx, text)) events.push(e);
      return events;
    };

    const first = await run("Smaž staré zakázky");
    const telemetry = first.flatMap((e) => (e.type === "telemetry" ? [e.event] : []));
    expect(telemetry.find((e) => e.activeGraphTopology)?.sessionId).toBe("t1");
    expect(telemetry.at(-1)).toMatchObject({ nodeId: "smazani/approval", status: "waiting_approval" });
    const question = (await questions.get("bob", "t1"))!;
    expect(question).toMatchObject({ state: "open", fields: [{ name: "step_1", label: "Smaž staré zakázky", type: "boolean" }] });

    // The model can't approve on its own: resuming before the user answered changes nothing.
    expect(await wf.invoke({ request: "", resume: true }, { configurable: ctx })).toMatch(/neodpověděl/);

    const answer = await questions.prepare("bob", "t1", `@osiris-answer:${JSON.stringify({ id: question.id, values: { step_1: true } })}`);
    const second = await run(answer);
    expect(second.filter((e) => e.type === "text-delta").map((e) => (e as { delta: string }).delta).join("")).toBe("Hotovo: smazány 3 zakázky.");
    // agent turn 1, agent turn 2, the step's own run, the final answer: the step had neither ask_user nor run_workflow.
    expect(model.bound[2]).toEqual([]);
    expect(model.bound[0]).toEqual(["ask_user", WORKFLOW_TOOL]);

    const derived = async () => Number((await db.execute("SELECT count(*) AS n FROM checkpoints WHERE thread_id LIKE 't1:%'")).rows[0]!.n);
    expect(await derived()).toBeGreaterThan(0);
    await checkpointer.deleteDerivedThreads("t1");
    expect(await derived()).toBe(0);
  });

  it("withdraws an approval question that breaks the rules, like ask_user's", async () => {
    const db = await createTestDb();
    await db.execute("INSERT INTO threads (id, user_id, channel) VALUES ('t1', 'bob', 'web')");
    const checkpointer = new LibSQLSaver(db);
    const questions = new QuestionStore(db);
    const model = new ScriptModel([
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: WORKFLOW_TOOL, args: { request: "Smaž zákazníka Nováka" } }] }),
      { rationale: "mazání", steps: [step({ id: "smazani", goal: "Smaž zákazníka Nováka", pattern: "ReAct", destructive: true })] },
      "Tohle udělat nemohu.",
    ]);
    // Input check passes, the approval question breaks the rules, the final answer passes.
    const guard = new ScriptModel(["NE", "ANO", "NE"]);
    let agent!: ReturnType<typeof createAgentGraph>;
    const orchestrator = createOrchestratorGraph({ model, react: (g, c, k) => reactFromAgentGraph(agent)(g, c, k), checkpointer });
    const wf = workflowTool(orchestrator, questions);
    agent = createAgentGraph({
      tenantId: "acme", model, models: { agent: model, tools: model, guard, persona: model }, tools: [questions.tool()], dynamicTools: async () => [wf], checkpointer,
      timezone: "Europe/Prague", questions, rules: async () => ({ system: "Nemaž zákazníky.", tenant: "", user: "" }),
    });
    const ctx: RunContext = { thread_id: "t1", tenant_id: "acme", user_id: "bob", role: "admin", channel: "web" };
    const events: RunEvent[] = [];
    for await (const e of streamRun(agent, ctx, "Smaž zákazníka Nováka", undefined, { guarded: true })) events.push(e);
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ result: expect.stringMatching(/porušuje pravidla/) });
    expect(await questions.get("bob", "t1")).toBeNull();
    expect((await questions.latest("bob", "t1"))!.state).toBe("cancelled");
  });
});
