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
  z.object({
    action: z.literal("window").describe("Práce s okny nad dvojčetem (panely vybraného objektu a konverzace)"),
    op: z
      .enum(["show", "close", "focus", "maximize", "restore", "snap", "merge", "detach"])
      .describe("show = zobrazí (i dříve zavřený), close = zavře, focus = přenese dopředu a ukáže jeho záložku, maximize/restore, snap = ukotví do části mřížky (pole snap), merge = sloučí do okna panelu `with` jako záložku, detach = vyjme záložku do vlastního okna"),
    panel: z.enum(["properties", "logs", "metrics", "traces", "chat"]).describe("Panel: properties (vlastnosti), logs, metrics, traces (vybraného objektu), chat (tato konverzace)"),
    snap: z
      .enum(["tl", "top", "tr", "left", "center", "right", "bl", "bottom", "br", "max"])
      .optional()
      .describe("Kam ukotvit: jedna z 9 částí mřížky (sloupce i řádky 20 %, 60 %, 20 %): rohy tl, tr, bl, br, středy okrajů top, left, right, bottom, střed center; max = celé zobrazení. Okno ukotvené do části, kde už okno je, se k němu připojí jako záložka"),
    with: z.enum(["properties", "logs", "metrics", "traces", "chat"]).optional().describe("U merge: panel, k jehož oknu se připojí"),
  }),
  z.object({ action: z.literal("layout").describe("Vrátí okna do výchozího rozložení"), op: z.literal("reset") }),
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
        "vrátí pohled na celé dvojče, otevře logy, metriky, trasy nebo dashboard s filtrem, nebo ukáže stav v minulosti. Uspořádá také okna nad dvojčetem (panely vlastností, logů, metrik a tras vybraného objektu a tuto konverzaci): " +
        "zobrazí, zavře, přenese dopředu, maximalizuje, ukotví do jedné z 9 částí mřížky, sloučí do jednoho okna se záložkami, vyjme záložku, nebo vrátí výchozí rozložení. Panely objektu existují jen při výběru (nejdřív select). Kroky se provedou v daném pořadí. " +
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

/** How much of an answer goes back to the model. */
const QUERY_OUTPUT = 12_000;

/**
 * Reading the digital twin itself (its DTDL models, objects and their relationships) through the twin's ops API,
 * read-only, as the runtime proves its project (no user's sign-in needed).
 */
export const twinQueryTool = (client: OpsClient) =>
  tool(
    async ({ what, instance, id, model, status, q, limit }) => {
      const params = new URLSearchParams();
      if (instance) params.set("instance", instance);
      let path: string;
      if (what === "instances") path = "/ops/twin/instances";
      else if (what === "models") path = "/ops/twin/models";
      else if (what === "twin") {
        if (!id) return "Chybí id objektu ($dtId); najdi ho přes what=twins.";
        path = `/ops/twin/digitaltwins/${encodeURIComponent(id)}`;
      } else {
        path = "/ops/twin/digitaltwins";
        if (model) params.set("model", model);
        if (status) params.set("status", status);
        if (q) params.set("q", q);
        params.set("limit", String(limit));
      }
      const res = await (client.fetch ?? fetch)(`${client.url.replace(/\/$/, "")}${path}${params.size ? `?${params}` : ""}`, {
        headers: { authorization: `Bearer ${await client.token()}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return what === "twin" ? `Objekt ${id} ve dvojčeti není.` : "Dvojče (instance) nenalezeno.";
      if (!res.ok) return `Dvojče odpovědělo ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
      const text = JSON.stringify(await res.json());
      return text.length > QUERY_OUTPUT ? `${text.slice(0, QUERY_OUTPUT)}… (zkráceno, celkem ${text.length} znaků; zužte dotaz)` : text;
    },
    {
      name: "twin_query",
      description:
        "Čte digitální dvojče clusteru (jen pro čtení): what=instances seznam dvojčat; models jejich DTDL modely (id, název, extends, obsah); " +
        "twins objekty dvojčete ($dtId, model, název, stav) s filtrem podle modelu, stavu nebo slova; twin jeden objekt se všemi vlastnostmi a vazbami (relationships ven, incoming dovnitř). " +
        "Použij ho ke zjištění, co v clusteru je a jak to souvisí (pod → node, Service → pody, PVC → pool); živý stav a logy čti kubectl nebo ceph, ukázat objekt uživateli twin_view.",
      schema: z.object({
        what: z.enum(["instances", "models", "twins", "twin"]),
        instance: z.string().max(40).optional().describe("Id dvojčete (instance); bez něj první"),
        id: z.string().max(500).optional().describe("U what=twin: $dtId objektu"),
        model: z.string().max(300).optional().describe("U what=twins: DTMI modelu, např. dtmi:osiris:k8s:Pod;3 (verzi lze vynechat)"),
        status: z.enum(["ok", "warn", "error"]).optional().describe("U what=twins: jen objekty v tomto stavu"),
        q: z.string().max(200).optional().describe("U what=twins: slovo v $dtId nebo názvu"),
        limit: z.number().int().min(1).max(500).default(50).describe("U what=twins: kolik nejvýš"),
      }),
    },
  );
