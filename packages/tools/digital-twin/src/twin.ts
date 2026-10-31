import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { OpsClient } from "@osiris/tools-ops";
import type { TwinEvent } from "@osiris/shared";

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

/**
 * The warn/error log records the cluster's collector caught (its `twin/events` processor writes them to a Redis
 * stream; the twin's ops API reads them): the newest events, optionally of one severity. To react to one — look at
 * the pod's logs (`kubectl logs`), show it in the twin (`twin_view`) — use this first.
 */
export const twinEventsTool = (client: OpsClient) =>
  tool(
    async ({ limit, severity, instance }) => {
      const q = new URLSearchParams({ limit: String(limit) });
      if (severity) q.set("severity", severity);
      if (instance) q.set("instance", instance);
      const res = await (client.fetch ?? fetch)(`${client.url.replace(/\/$/, "")}/ops/events?${q}`, {
        headers: { authorization: `Bearer ${await client.token()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return `Události se nepodařilo načíst: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
      const { value } = (await res.json()) as { value: TwinEvent[] };
      if (!value.length) return "Žádné warn/error události teď nejsou.";
      const lines = value.map((e) => {
        const where = [e.cluster, e.namespace, e.pod ?? e.node, e.container].filter(Boolean).join(" / ");
        return `- ${new Date(e.ts).toISOString()} ${e.severity.toLowerCase()}${where ? ` ${where}` : ""}: ${e.message}${e.traceId ? ` (trace ${e.traceId})` : ""}`;
      });
      return `${value.length} událostí (nejnovější první):\n${lines.join("\n")}`;
    },
    {
      name: "twin_events",
      description:
        "Poslední zachycené warn/error události z clusteru (logy s úrovní warn a výš, jak je zachytil OpenTelemetry Collector do dvojčete): čas, úroveň, cluster, namespace, pod, zpráva, trace id. " +
        "Když uživatel řeší problém nebo chce vědět, co se děje, začni tady; k reakci na událost použij kubectl (např. logs) nebo twin_view.",
      schema: z.object({
        limit: z.number().int().min(1).max(100).default(20).describe("Kolik nejnovějších událostí (max 100)"),
        severity: z.enum(["warn", "error", "fatal"]).optional().describe("Jen události této úrovně a výš"),
        instance: z.string().optional().describe("Id dvojčete (instance); bez něj první běžící"),
      }),
    },
  );
