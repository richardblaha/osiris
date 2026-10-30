import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** One step for the digital twin's view, carried to the PWA in the tool's artifact. */
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select").describe("Vybere objekt a přeletí k němu"), target: z.string().describe("Název nebo ID objektu (pod, node, namespace, disk osd.7…)") }),
  z.object({ action: z.literal("clear").describe("Zruší výběr (pohled zůstane)") }),
  z.object({ action: z.literal("home").describe("Pohled na celé dvojče") }),
  z.object({ action: z.literal("rotate"), degrees: z.number().min(-360).max(360).describe("Otočení kolem svislé osy, kladně doleva") }),
  z.object({ action: z.literal("tilt"), degrees: z.number().min(-90).max(90).describe("Naklonění pohledu, kladně shora") }),
  z.object({ action: z.literal("zoom"), factor: z.number().min(0.1).max(10).describe("Přiblížení (>1) nebo oddálení (<1)") }),
  z.object({
    action: z.literal("open"),
    page: z.enum(["dashboard", "logs", "metrics", "traces"]),
    filter: z.record(z.string(), z.string()).optional().describe("Filtr stránky: namespace, pod, node, container, service, severity (info|warn|error), q; u dashboardu id"),
  }),
  z.object({ action: z.literal("close").describe("Zavře otevřenou stránku") }),
  z.object({ action: z.literal("history"), at: z.string().optional().describe("Čas ISO 8601 pro stav v minulosti; bez něj živě") }),
]);
export type TwinAction = z.infer<typeof action>;

/**
 * Steering the digital twin's view from the chat: select and fly to objects, turn, tilt and zoom, open the logs,
 * metrics, traces or a dashboard with a filter, go back in time. The steps reach the twin's PWA in the result's
 * artifact (the model sees only the summary); the PWA runs them in order.
 */
export const twinViewTool = () =>
  tool(
    async ({ actions }) => [`Dvojče provede ${actions.length} ${actions.length === 1 ? "krok" : actions.length < 5 ? "kroky" : "kroků"}: ${actions.map((a) => a.action).join(", ")}.`, { twin: actions }],
    {
      name: "twin_view",
      responseFormat: "content_and_artifact",
      description:
        "Ovládá pohled digitálního dvojčete clusteru, ve kterém uživatel s tebou mluví: vybere a ukáže objekt (pod, node, namespace, workload, disk, pool), otočí, nakloní, přiblíží, " +
        "vrátí pohled na celé dvojče, otevře logy, metriky, trasy nebo dashboard s filtrem, nebo ukáže stav v minulosti. Kroky se provedou v daném pořadí. " +
        "Když uživatel chce něco ukázat nebo kam se podívat, použij tento nástroj; ke zjištění stavu použij kubectl nebo ceph.",
      schema: z.object({ actions: z.array(action).min(1).max(12) }),
    },
  );
