import type { RunnableConfig } from "@langchain/core/runnables";
import { END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { readOnlySql } from "../../database/store.ts";
import { structured, text, type OrchestratorDeps, type Verifier } from "./llm.ts";
import { JevState, type JevStateType } from "./state.ts";
import { emit, nodeId, traced } from "./telemetry.ts";

/** Self-repairs after the first attempt; when they're used up the step fails. */
export const MAX_REPAIRS = 3;

const parseJson = (artifact: string): { value?: unknown; errors: string[] } => {
  try {
    return { value: JSON.parse(artifact), errors: [] };
  } catch (err) {
    return { errors: [`Neplatný JSON: ${(err as Error).message}`] };
  }
};

/** Errors of a zod schema over a JSON artifact, one line per issue. */
export function zodVerifier(schema: z.ZodType): Verifier {
  return (artifact) => {
    const { value, errors } = parseJson(artifact);
    if (errors.length) return errors;
    const result = schema.safeParse(value);
    return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".") || "(kořen)"}: ${i.message}`);
  };
}

const jsonLdNode = z.looseObject({ "@context": z.unknown(), "@type": z.union([z.string(), z.array(z.string()).min(1)]) });
const dtmi = z.string().regex(/^dtmi:[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?(?::[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?)*;[1-9][0-9]{0,8}(?:\.[1-9][0-9]{0,5})?$/, "neplatné DTMI");
const dtdlInterface = z.looseObject({
  "@context": z.union([z.string(), z.array(z.string())]).refine((c) => [c].flat().some((x) => x.startsWith("dtmi:dtdl:context;")), "chybí kontext dtmi:dtdl:context;N"),
  "@id": dtmi,
  "@type": z.literal("Interface"),
  contents: z.array(z.looseObject({ "@type": z.union([z.string(), z.array(z.string())]), name: z.string().regex(/^[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?$/) })).optional(),
});

/** Built-in checks; `sql` is a single read-only query as the tenant database runs them (`db_query`). */
// ponytail: syntax-level checks only, TS/code compilation or tests come as injected `verifiers`.
export const BUILTIN_VERIFIERS: Record<string, Verifier> = {
  json: (a) => parseJson(a).errors,
  jsonld: zodVerifier(z.union([jsonLdNode, z.array(jsonLdNode).min(1)])),
  dtdl: zodVerifier(z.union([dtdlInterface, z.array(dtdlInterface).min(1)])),
  sql: (a) => {
    try {
      readOnlySql(a);
      return [];
    } catch (err) {
      return [(err as Error).message];
    }
  },
};

/** A failed attempt: why, kept as a reflection the next attempt sees. */
const fail = (s: JevStateType, why: string) => {
  const failure = `Pokus ${s.attempts} ${why}`;
  return { lastFailure: failure, reflections: [failure] };
};

const Criteria = z.object({ criteria: z.array(z.string()).min(1).max(8) });
const Evaluation = z.object({ accepted: z.boolean(), feedback: z.string() });

/** Judge-Execute-Verify, and with `mode: "Reflexion"` its compiler-less sibling where a critic judges the artifact. */
export function createJevGraph(deps: OrchestratorDeps) {
  const verifiers = { ...BUILTIN_VERIFIERS, ...deps.verifiers };
  const at = (s: JevStateType, node: string, phase: "Judge" | "Execute" | "Verify" | "Critic", message: string) => ({ pattern: s.mode, phase, nodeId: nodeId(s.stepId, node), message });
  const brief = (s: JevStateType) => `Úkol: ${s.goal}${s.context ? `\n\n${s.context}` : ""}`;

  /** Judge, before anything is written: the criteria an acceptable artifact meets. */
  const judge = (s: JevStateType, config: RunnableConfig) =>
    traced(config, at(s, "judge", "Judge", "Určuji kritéria"), async () => {
      const { criteria } = await structured(deps, Criteria, "criteria",
        "Jsi soudce. Než vznikne výsledek, stanov přesná, ověřitelná kritéria, která musí splnit. Výsledek sám nepiš.", brief(s), config);
      return { criteria, status: "running" as const };
    });

  const execute = (s: JevStateType, config: RunnableConfig) =>
    traced(config, at(s, "execute", "Execute", `Pokus ${s.attempts + 1}`), async () => {
      const memory = s.reflections.length ? `\n\nPředchozí pokusy byly zamítnuty, tyto chyby neopakuj:\n${s.reflections.map((r) => `- ${r}`).join("\n")}` : "";
      const artifact = await text(deps,
        "Vytvoř požadovaný výsledek (kód, model, dotaz, schéma). Odpověz pouze samotným výsledkem, bez vysvětlení.",
        `${brief(s)}\n\nKritéria:\n${s.criteria.map((c) => `- ${c}`).join("\n")}${memory}`, config);
      return { artifact, attempts: s.attempts + 1, lastFailure: null };
    });

  /** Deterministic: the named verifier's errors become a reflection for the next attempt. */
  const verify = (s: JevStateType, config: RunnableConfig) =>
    traced(config, at(s, "verify", "Verify", s.verifier ?? ""), async () => {
      const check = verifiers[s.verifier!];
      const errors = check ? await check(s.artifact) : [`Neznámá kontrola ${s.verifier}`];
      return errors.length ? fail(s, `neprošel kontrolou ${s.verifier}: ${errors.join("; ")}`) : { lastFailure: null };
    }, (r) => (r.lastFailure ? { status: "failed", message: r.lastFailure, payload: { attempt: s.attempts } } : {}));

  /** Judge (or Critic) against the criteria. A rejection becomes a reflection; out of attempts, the step fails. */
  const evaluate = (s: JevStateType, config: RunnableConfig) => {
    const critic = s.mode === "Reflexion";
    return traced(config, at(s, critic ? "critic" : "evaluate", critic ? "Critic" : "Judge", "Hodnotím výsledek"), async () => {
      const verdict = await structured(deps, Evaluation, "evaluation",
        "Jsi přísný hodnotitel. Posuď výsledek podle kritérií. Přijmi ho jen tehdy, když splňuje všechna. Ve feedback uveď konkrétně, co je špatně.",
        `${brief(s)}\n\nKritéria:\n${s.criteria.map((c) => `- ${c}`).join("\n")}\n\nVýsledek:\n${s.artifact}`, config);
      return verdict.accepted ? { status: "success" as const, lastFailure: null } : fail(s, `zamítnut: ${verdict.feedback}`);
    }, (r) => (r.lastFailure ? { status: "failed", message: r.lastFailure, payload: { attempt: s.attempts } } : {}));
  };

  /** After a failed check or a rejection: repair while repairs remain, else stop failed. */
  const retryOr = (next: "evaluate" | typeof END) => (s: JevStateType) =>
    !s.lastFailure ? next : s.attempts <= MAX_REPAIRS ? "execute" : "give_up";
  const giveUp = (s: JevStateType, config: RunnableConfig) => {
    emit(config, { ...at(s, s.mode === "Reflexion" ? "critic" : "evaluate", s.mode === "Reflexion" ? "Critic" : "Judge", `Vyčerpány opravy (${MAX_REPAIRS})`), status: "failed" });
    return { status: "failed" as const };
  };

  return new StateGraph(JevState)
    .addNode("judge", judge)
    .addNode("execute", execute)
    .addNode("verify", verify)
    .addNode("evaluate", evaluate)
    .addNode("give_up", giveUp)
    .addEdge(START, "judge")
    .addEdge("judge", "execute")
    .addConditionalEdges("execute", (s) => (s.mode === "JEV" && s.verifier ? "verify" : "evaluate"), ["verify", "evaluate"])
    .addConditionalEdges("verify", retryOr("evaluate"), ["evaluate", "execute", "give_up"])
    .addConditionalEdges("evaluate", retryOr(END), [END, "execute", "give_up"])
    .addEdge("give_up", END)
    // Runs inside one node of the root graph, often several at once: no checkpoints of its own.
    .compile({ checkpointer: false });
}

export type JevGraph = ReturnType<typeof createJevGraph>;
