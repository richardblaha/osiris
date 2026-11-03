import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { DTDL_CONTEXT } from "@osiris/shared/dtdl.ts";
import { TWIN_ENTITY_MODEL } from "@osiris/shared";
import { ClickHouse, Telemetry } from "../telemetry.ts";
import type { TwinSource } from "../twin.ts";
import { Kube } from "./kubernetes/kube.ts";
import { parseKubeconfig } from "./kubernetes/kubeconfig.ts";
import { kubernetesSource } from "./kubernetes/source.ts";

/**
 * The kinds of system an instance can twin. Each type describes the settings form the PWA draws (its fields; a
 * secret field is write-only, sealed in the store) and makes the instance's source adapter and telemetry from them.
 * A new kind of system is a TwinSource adapter plus an entry in {@link SOURCE_TYPES}.
 */

/** One field of a type's settings form; its label and help are the PWA's (`instances.field.<type>.<name>`). */
export interface SourceField {
  name: string;
  kind: "text" | "url" | "textarea" | "list" | "select";
  /** Write-only: sealed in the store, never handed back (the form only shows whether it is set). */
  secret?: boolean;
  required?: boolean;
  options?: string[];
  default?: string;
  /** Shown only while another field has this value. */
  when?: { field: string; value: string };
}

/** What the service gives every instance: its own ClickHouse (the history's) and the pod's own Kubernetes access. */
export interface SourceDefaults {
  clickhouse?: ClickHouse;
  kube: { apiServer: string; tokenPath: string; token?: string };
  fetchFn?: typeof fetch;
}

export interface SourceContext {
  id: string;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  defaults: SourceDefaults;
}

/** A started instance's parts: its adapter, and the telemetry its twins' logs, metrics and traces come from. */
export interface BuiltSource {
  source: TwinSource;
  telemetry?: Telemetry;
}

export interface SourceType {
  id: string;
  fields: SourceField[];
  /** Validates the settings (secrets aside) before they are stored. */
  settings: z.ZodType<Record<string, string>>;
  create(ctx: SourceContext): Promise<BuiltSource>;
}

const optionalText = (max: number) => z.string().trim().max(max).default("");
const httpUrl = z.union([z.literal(""), z.url({ protocol: /^https?$/ })]);
const httpUrls = z
  .string()
  .trim()
  .max(2000)
  .default("")
  .refine((v) => list(v).every((u) => httpUrl.safeParse(u).success), { message: "errors.validation.urls" });
/** A list field's values: comma- or line-separated. */
export const list = (v: string | undefined) => (v ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

/** The `lanDevices` list's entries, one per line or comma: `kind:name` or `kind:model:name` (kind: ap, switch, router). */
export const parseLanDevices = (v: string | undefined): { kind: string; name: string; model?: string }[] =>
  list(v).map((entry) => {
    const parts = entry.split(":").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return undefined;
    return { kind: parts[0]!.toLowerCase(), name: parts.at(-1)!, ...(parts.length > 2 ? { model: parts.slice(1, -1).join(": ") } : {}) };
  }).filter((d): d is { kind: string; name: string; model?: string } => !!d);

/** A fetch that trusts a kubeconfig's certificate authority (or, when it says so, no certificate at all). */
const kubeFetchFor = (ca: string | undefined, insecure: boolean | undefined) =>
  ca || insecure
    ? (((url: Parameters<typeof undiciFetch>[0], init: Parameters<typeof undiciFetch>[1]) =>
        undiciFetch(url, { ...init, dispatcher: new Agent({ connect: { ca, rejectUnauthorized: !insecure } }) })) as unknown as typeof fetch)
    : undefined;

/** A Kubernetes cluster: the one the service runs in (its ServiceAccount) or any other through a kubeconfig. */
export const kubernetesType: SourceType = {
  id: "kubernetes",
  fields: [
    { name: "connection", kind: "select", options: ["inCluster", "kubeconfig"], default: "inCluster", required: true },
    { name: "kubeconfig", kind: "textarea", secret: true, when: { field: "connection", value: "kubeconfig" } },
    { name: "context", kind: "text", when: { field: "connection", value: "kubeconfig" } },
    { name: "clusterName", kind: "text" },
    { name: "cephManagers", kind: "list" },
    { name: "externalDisks", kind: "select", options: ["usb", "sata"], default: "usb" },
    { name: "lan", kind: "select", options: ["switch", "none"], default: "switch" },
    { name: "switchModel", kind: "text", when: { field: "lan", value: "switch" } },
    { name: "routerModel", kind: "text", when: { field: "lan", value: "switch" } },
    { name: "lanDevices", kind: "list", when: { field: "lan", value: "switch" } },
    { name: "externalServices", kind: "list" },
    { name: "clickhouseUrl", kind: "url" },
    { name: "clickhouseUser", kind: "text" },
    { name: "clickhousePassword", kind: "text", secret: true },
    { name: "clickhouseCluster", kind: "text" },
  ],
  settings: z.object({
    connection: z.enum(["inCluster", "kubeconfig"]).default("inCluster"),
    context: optionalText(200),
    clusterName: optionalText(100),
    cephManagers: httpUrls,
    externalDisks: z.enum(["usb", "sata"]).default("usb"),
    lan: z.enum(["switch", "none"]).default("switch"),
    switchModel: optionalText(100),
    routerModel: optionalText(100),
    lanDevices: z.string().trim().max(2000).default(""),
    externalServices: httpUrls,
    clickhouseUrl: z.string().trim().pipe(httpUrl).default(""),
    clickhouseUser: optionalText(100),
    clickhouseCluster: optionalText(100),
  }),
  async create({ id, settings, secrets, defaults }) {
    let kube: Kube;
    if (settings.connection === "kubeconfig") {
      if (!secrets.kubeconfig) throw new Error("The instance has no kubeconfig");
      const c = await parseKubeconfig(secrets.kubeconfig, settings.context || undefined);
      kube = new Kube({ apiServer: c.server, token: c.token, fetchFn: kubeFetchFor(c.ca, c.insecureTls) });
    } else {
      kube = new Kube({ apiServer: defaults.kube.apiServer, tokenPath: defaults.kube.tokenPath, token: defaults.kube.token });
    }
    const clickhouse = settings.clickhouseUrl
      ? new ClickHouse(settings.clickhouseUrl, settings.clickhouseUser || "default", secrets.clickhousePassword ?? "", defaults.fetchFn)
      : defaults.clickhouse;
    return {
      source: kubernetesSource(kube, settings.clusterName || id, {
        cephManagers: list(settings.cephManagers),
        externalBus: settings.externalDisks === "sata" ? "sata" : "usb",
        lan: settings.lan !== "none" ? { switchModel: settings.switchModel, routerModel: settings.routerModel, devices: parseLanDevices(settings.lanDevices) } : undefined,
        // Osiris's agent calls Mistral's API, so it is probed (and shown on the globe) unless the setting says otherwise.
        externalServices: list(settings.externalServices).length ? list(settings.externalServices) : ["https://api.mistral.ai/v1/models"],
        fetchFn: defaults.fetchFn,
      }),
      telemetry: clickhouse ? new Telemetry(clickhouse, settings.clickhouseCluster || undefined) : undefined,
    };
  },
};

/** A standalone DTDL digital twin: models, twins, relationships and data bindings live in SQLite, data cached in Redis. */
export const dtdlType: SourceType = {
  id: "dtdl",
  fields: [
    { name: "clickhouseUrl", kind: "url" },
    { name: "clickhouseUser", kind: "text" },
    { name: "clickhousePassword", kind: "text", secret: true },
    { name: "clickhouseCluster", kind: "text" },
  ],
  settings: z.object({
    clickhouseUrl: z.string().trim().pipe(httpUrl).default(""),
    clickhouseUser: optionalText(100),
    clickhouseCluster: optionalText(100),
  }),
  async create({ settings, secrets, defaults }) {
    const clickhouse = settings.clickhouseUrl
      ? new ClickHouse(settings.clickhouseUrl, settings.clickhouseUser || "default", secrets.clickhousePassword ?? "", defaults.fetchFn)
      : defaults.clickhouse;
    const source: TwinSource = {
      name: "dtdl",
      models: () => [
        {
          "@context": DTDL_CONTEXT,
          "@id": TWIN_ENTITY_MODEL,
          "@type": "Interface",
          displayName: { en: "Entity", cs: "Entita" },
          contents: [
            { "@type": "Property", name: "name", schema: "string", displayName: { en: "Name", cs: "Název" } },
            {
              "@type": "Property",
              name: "status",
              schema: { "@type": "Enum", valueSchema: "string", enumValues: [{ name: "ok", enumValue: "ok" }, { name: "warn", enumValue: "warn" }, { name: "error", enumValue: "error" }] },
              displayName: { en: "Status", cs: "Stav" },
            },
            {
              "@type": "Property",
              name: "otelResource",
              schema: { "@type": "Map", mapKey: { name: "attribute", schema: "string" }, mapValue: { name: "value", schema: "string" } },
              displayName: { en: "Telemetry", cs: "Telemetrie" },
            },
            { "@type": "Telemetry", name: "errorLogs", schema: "integer", displayName: { en: "Error logs", cs: "Chybové logy" } },
          ],
        },
      ],
      snapshot: async () => ({ twins: [], relationships: [] }),
    };
    return {
      source,
      telemetry: clickhouse ? new Telemetry(clickhouse, settings.clickhouseCluster || undefined) : undefined,
    };
  },
};

/** Every kind of system an instance can twin. */
export const SOURCE_TYPES: Record<string, SourceType> = { [kubernetesType.id]: kubernetesType, [dtdlType.id]: dtdlType };

/** A type's secret fields' names: the only secrets an instance of it may hold. */
export const secretFields = (type: SourceType) => type.fields.filter((f) => f.secret).map((f) => f.name);
