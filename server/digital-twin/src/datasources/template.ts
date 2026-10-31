import { DATA_PLACEHOLDER as PLACEHOLDER, type DigitalTwin } from "@osiris/shared/dtdl.ts";

/**
 * A binding's parameters name the twin they are for with placeholders — `{id}`, `{name}`, `{twin.<property>}`,
 * `{otel.<attribute>}` (its OpenTelemetry resource) — filled per twin. Each connector says how a value may appear
 * where it goes: never as code (a query gets values as typed parameters), never as structure (a topic's value can't
 * add a level or a wildcard).
 */
export type TwinVars = Record<string, string>;

/** A twin's values for placeholders: its id and name, its scalar properties, its OpenTelemetry resource. */
export function varsOf(twin: DigitalTwin): TwinVars {
  const out: TwinVars = { id: twin.$dtId, name: String(twin.name ?? twin.$dtId) };
  for (const [k, v] of Object.entries(twin)) if (!k.startsWith("$") && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) out[`twin.${k}`] = String(v);
  for (const [k, v] of Object.entries((twin.otelResource ?? {}) as Record<string, unknown>)) if (typeof v === "string") out[`otel.${k}`] = v;
  return out;
}

/** The placeholders a template uses. */
export const placeholdersOf = (template: string) => [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);

export class MissingVariable extends Error {}

/**
 * A template with its placeholders filled, each value passed through `escape` (which refuses what can't stand there).
 * A placeholder the twin has no value for refuses the whole: that twin isn't bound.
 */
export function fill(template: string, vars: TwinVars, escape: (value: string) => string = (v) => v): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new MissingVariable(name);
    return escape(v);
  });
}

/** A value inside a topic, subject or key segment: no separators, wildcards or control characters. */
export function segment(value: string): string {
  if (!value || value.length > 200 || /[/#+*>\s\u0000-\u001f]/.test(value)) throw new MissingVariable("a value that can't be a segment");
  return value;
}

/** A value at a path in a message (`$.a.b[0].c` or `a.b.0.c`; empty: the whole message), as a number, text or flag. */
export function pick(message: unknown, path = ""): number | string | boolean | undefined {
  let at: unknown = message;
  for (const key of path.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "boolean") return at;
  if (typeof at === "string") {
    const n = Number(at);
    return at.trim() !== "" && Number.isFinite(n) ? n : at.slice(0, 500);
  }
  return undefined;
}

/** A message's payload as JSON where it is JSON, else its text. */
export function parsePayload(raw: Buffer | string): unknown {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (text.length > 1_000_000) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * An address a connection may reach: http(s), mqtt(s), amqp(s) or a host:port, never this host itself or the
 * link-local range (cloud metadata). Private networks stay allowed: brokers live there.
 */
export function safeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::" || h === "::1") return false;
  if (/^127\./.test(h) || /^169\.254\./.test(h) || /^fe80:/i.test(h) || h === "metadata.google.internal") return false;
  return true;
}
