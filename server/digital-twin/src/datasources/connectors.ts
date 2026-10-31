import { z } from "zod";
import type { DataBinding } from "@osiris/shared/dtdl.ts";
import { fill, MissingVariable, parsePayload, pick, safeHost, segment, type TwinVars } from "./template.ts";

/**
 * The kinds of data source a twin's models can bind telemetry to. Each kind describes the connection's form (its
 * fields; secret ones are write-only, sealed in the store), checks a binding's own parameters, and makes a connector:
 * asked for a value per twin (`poll`), streaming values in (`subscribe`), or a simulation's tool (`simulator`).
 * Every connector only reads. A new kind is an entry in {@link CONNECTOR_TYPES}.
 */

export interface ConnectorField {
  name: string;
  kind: "text" | "url" | "textarea" | "select" | "list";
  secret?: boolean;
  required?: boolean;
  options?: string[];
  default?: string;
}

/** A value read for one twin's telemetry. */
export type DataValue = number | string | boolean;

/** One binding for one twin: its key (twin and telemetry), the binding and the twin's placeholder values. */
export interface BoundTask {
  key: string;
  binding: DataBinding;
  vars: TwinVars;
}

export interface Connector {
  /** Asks for the value of one binding for one twin. */
  poll?(binding: DataBinding, vars: TwinVars): Promise<DataValue | undefined>;
  /** Streams values in for the bindings given (replaced as a whole when they change); returns a stop. */
  subscribe?(tasks: BoundTask[], onValue: (key: string, value: DataValue) => void): Promise<() => Promise<void>>;
  /** Whether the connection works (for the admin's "test"). */
  check(): Promise<void>;
  close?(): Promise<void>;
}

export interface ConnectorType {
  id: string;
  mode: "poll" | "stream" | "simulator";
  fields: ConnectorField[];
  settings: z.ZodType<Record<string, string>>;
  /** A binding's own parameters (besides telemetry, connection, every). */
  binding: z.ZodType<Record<string, unknown>>;
  create(settings: Record<string, string>, secrets: Record<string, string>, ctx: { fetchFn?: typeof fetch; now?: () => number }): Connector;
}

const text = (max: number) => z.string().trim().max(max).default("");
const reachable = (protocols: RegExp) =>
  z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => URL.canParse(v) && protocols.test(new URL(v).protocol) && safeHost(new URL(v).hostname), { message: "errors.validation.url" });
/** A template whose placeholders are only ours and which has no more than 50 of them. */
const template = (max: number) => z.string().min(1).max(max);
const commonBinding = { telemetry: z.string(), connection: z.string(), every: z.number().optional() };
const bindingOf = <T extends z.ZodRawShape>(shape: T) => z.object({ ...commonBinding, ...shape }).strict();

/** ClickHouse over HTTP: a SELECT per twin, the twin's values as typed query parameters, never in the SQL. */
const clickhouse: ConnectorType = {
  id: "clickhouse",
  mode: "poll",
  fields: [
    { name: "url", kind: "url", required: true },
    { name: "user", kind: "text" },
    { name: "password", kind: "text", secret: true },
    { name: "database", kind: "text" },
  ],
  settings: z.object({ url: reachable(/^https?:$/), user: text(100), database: text(100) }),
  binding: bindingOf({
    // One read-only statement; its parameters are `{name:Type}` placeholders ClickHouse fills from `params`.
    query: z
      .string()
      .min(1)
      .max(4000)
      .refine((q) => /^\s*(select|with)\b/i.test(q) && !q.replace(/'(?:[^'\\]|\\.)*'/g, "").includes(";"), { message: "one SELECT only" }),
    params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), template(300)).default({}),
    /** The column of the first row that is the value. */
    column: z.string().max(100).default("value"),
  }),
  create(settings, secrets, ctx) {
    const f = ctx.fetchFn ?? fetch;
    const ask = async (query: string, params: Record<string, string>) => {
      const q = new URLSearchParams({ default_format: "JSONEachRow", readonly: "1", max_execution_time: "10", max_result_rows: "1", result_overflow_mode: "break" });
      if (settings.database) q.set("database", settings.database);
      for (const [k, v] of Object.entries(params)) q.set(`param_${k}`, v);
      const res = await f(`${settings.url!.replace(/\/$/, "")}/?${q}`, {
        method: "POST",
        headers: { "content-type": "text/plain", ...(settings.user ? { "x-clickhouse-user": settings.user, "x-clickhouse-key": secrets.password ?? "" } : {}) },
        body: query,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`ClickHouse answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    };
    return {
      async poll(binding, vars) {
        const b = binding as unknown as { query: string; params: Record<string, string>; column: string };
        const params = Object.fromEntries(Object.entries(b.params ?? {}).map(([k, v]) => [k, fill(v, vars)]));
        const [row] = await ask(b.query, params);
        return row ? pick(row, b.column || "value") : undefined;
      },
      async check() {
        await ask("SELECT 1 AS value", {});
      },
    };
  },
};

/** Prometheus' HTTP API (any backend that speaks it: Prometheus, Mimir, VictoriaMetrics, Thanos…): an instant PromQL query. */
const prometheus: ConnectorType = {
  id: "prometheus",
  mode: "poll",
  fields: [
    { name: "url", kind: "url", required: true },
    { name: "token", kind: "text", secret: true },
  ],
  settings: z.object({ url: reachable(/^https?:$/) }),
  binding: bindingOf({ query: template(2000) }),
  create(settings, secrets, ctx) {
    const f = ctx.fetchFn ?? fetch;
    // A label value inside "…": quotes and backslashes escaped, so a value can't end the string.
    const quoted = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
    const ask = async (query: string) => {
      const res = await f(`${settings.url!.replace(/\/$/, "")}/api/v1/query?${new URLSearchParams({ query })}`, {
        headers: secrets.token ? { authorization: `Bearer ${secrets.token}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Prometheus answered ${res.status}`);
      return (await res.json()) as { data?: { result?: { value?: [number, string] }[] } };
    };
    return {
      async poll(binding, vars) {
        const answer = await ask(fill((binding as unknown as { query: string }).query, vars, quoted));
        const v = answer.data?.result?.[0]?.value?.[1];
        return v === undefined ? undefined : pick(v);
      },
      async check() {
        await ask("vector(1)");
      },
    };
  },
};

/** MQTT: a topic per twin (its placeholders as whole levels), the value at a path in each message. */
const mqtt: ConnectorType = {
  id: "mqtt",
  mode: "stream",
  fields: [
    { name: "url", kind: "url", required: true },
    { name: "username", kind: "text" },
    { name: "password", kind: "text", secret: true },
    { name: "clientId", kind: "text" },
  ],
  settings: z.object({ url: reachable(/^(mqtts?|wss?):$/), username: text(200), clientId: text(100) }),
  binding: bindingOf({
    topic: template(500).refine((t) => !/[#+]/.test(t), { message: "no wildcards" }),
    path: z.string().max(200).default(""),
  }),
  create(settings, secrets) {
    const connect = async () => {
      const { connectAsync } = await import("mqtt");
      return connectAsync(settings.url!, {
        username: settings.username || undefined,
        password: secrets.password || undefined,
        clientId: settings.clientId || `osiris-twin-${Math.random().toString(16).slice(2, 10)}`,
        reconnectPeriod: 5_000,
        connectTimeout: 10_000,
      });
    };
    return {
      async subscribe(tasks, onValue) {
        const client = await connect();
        const byTopic = new Map<string, BoundTask[]>();
        for (const t of tasks) {
          try {
            const topic = fill((t.binding as unknown as { topic: string }).topic, t.vars, segment);
            byTopic.set(topic, [...(byTopic.get(topic) ?? []), t]);
          } catch (err) {
            if (!(err instanceof MissingVariable)) throw err;
          }
        }
        client.on("message", (topic, payload) => {
          const message = parsePayload(payload);
          for (const t of byTopic.get(topic) ?? []) {
            const v = pick(message, (t.binding as unknown as { path?: string }).path);
            if (v !== undefined) onValue(t.key, v);
          }
        });
        if (byTopic.size) await client.subscribeAsync([...byTopic.keys()], { qos: 0 });
        return async () => void (await client.endAsync());
      },
      async check() {
        await (await connect()).endAsync();
      },
    };
  },
};

/** Kafka: a topic (fixed), each message matched to its twin by a key or a field, the value at a path. */
const kafka: ConnectorType = {
  id: "kafka",
  mode: "stream",
  fields: [
    { name: "brokers", kind: "list", required: true },
    { name: "ssl", kind: "select", options: ["true", "false"], default: "true" },
    { name: "mechanism", kind: "select", options: ["none", "plain", "scram-sha-256", "scram-sha-512"], default: "none" },
    { name: "username", kind: "text" },
    { name: "password", kind: "text", secret: true },
    { name: "groupId", kind: "text" },
  ],
  settings: z.object({
    brokers: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine((v) => v.split(",").every((b) => /^[A-Za-z0-9.-]+:\d{1,5}$/.test(b.trim()) && safeHost(b.trim().split(":")[0]!)), { message: "host:port, comma-separated" }),
    ssl: z.enum(["true", "false"]).default("true"),
    mechanism: z.enum(["none", "plain", "scram-sha-256", "scram-sha-512"]).default("none"),
    username: text(200),
    groupId: text(100),
  }),
  binding: bindingOf({
    topic: z.string().regex(/^[A-Za-z0-9._-]{1,249}$/),
    /** Which twin a message is for: its key, or a field of it, equal to this template filled for the twin. */
    match: template(300),
    matchOn: z.string().max(200).default("key"),
    path: z.string().max(200).default(""),
  }),
  create(settings, secrets) {
    const make = async () => {
      const { Kafka, logLevel } = await import("kafkajs");
      const sasl =
        settings.mechanism === "none"
          ? undefined
          : ({ mechanism: settings.mechanism, username: settings.username ?? "", password: secrets.password ?? "" } as unknown as import("kafkajs").SASLOptions);
      return new Kafka({ clientId: "osiris-digital-twin", brokers: settings.brokers!.split(",").map((b) => b.trim()), ssl: settings.ssl === "true", sasl, logLevel: logLevel.ERROR });
    };
    return {
      async subscribe(tasks, onValue) {
        const kafkaClient = await make();
        const consumer = kafkaClient.consumer({ groupId: settings.groupId || "osiris-digital-twin" });
        await consumer.connect();
        const topics = [...new Set(tasks.map((t) => (t.binding as unknown as { topic: string }).topic))];
        for (const topic of topics) await consumer.subscribe({ topic, fromBeginning: false });
        const wanted = tasks.flatMap((t) => {
          try {
            return [{ t, match: fill((t.binding as unknown as { match: string }).match, t.vars) }];
          } catch {
            return [];
          }
        });
        await consumer.run({
          eachMessage: async ({ topic, message }) => {
            const body = message.value ? parsePayload(message.value) : undefined;
            const key = message.key?.toString("utf8");
            for (const { t, match } of wanted) {
              const b = t.binding as unknown as { topic: string; matchOn: string; path: string };
              if (b.topic !== topic) continue;
              const on = b.matchOn === "key" ? key : String(pick(body, b.matchOn) ?? "");
              if (on !== match) continue;
              const v = pick(body, b.path);
              if (v !== undefined) onValue(t.key, v);
            }
          },
        });
        return async () => void (await consumer.disconnect());
      },
      async check() {
        const admin = (await make()).admin();
        await admin.connect();
        await admin.disconnect();
      },
    };
  },
};

/** RabbitMQ (AMQP 0-9-1): a queue of its own bound to an exchange by a routing key per twin, the value at a path. */
const rabbitmq: ConnectorType = {
  id: "rabbitmq",
  mode: "stream",
  fields: [
    { name: "url", kind: "url", required: true },
    { name: "username", kind: "text" },
    { name: "password", kind: "text", secret: true },
  ],
  settings: z.object({ url: reachable(/^amqps?:$/), username: text(200) }),
  binding: bindingOf({
    exchange: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
    routingKey: template(300).refine((t) => !/[#*]/.test(t), { message: "no wildcards" }),
    path: z.string().max(200).default(""),
  }),
  create(settings, secrets) {
    const connect = async () => {
      const amqp = await import("amqplib");
      const url = new URL(settings.url!);
      if (settings.username) url.username = encodeURIComponent(settings.username);
      if (secrets.password) url.password = encodeURIComponent(secrets.password);
      return amqp.connect(url.toString(), { timeout: 10_000 });
    };
    return {
      async subscribe(tasks, onValue) {
        const connection = await connect();
        const channel = await connection.createChannel();
        // A queue of our own that goes with us: we only read, never take another consumer's messages.
        const { queue } = await channel.assertQueue("", { exclusive: true, autoDelete: true, durable: false });
        const byKey = new Map<string, BoundTask[]>();
        for (const t of tasks) {
          const b = t.binding as unknown as { exchange: string; routingKey: string };
          try {
            const key = fill(b.routingKey, t.vars, segment);
            await channel.bindQueue(queue, b.exchange, key);
            byKey.set(`${b.exchange} ${key}`, [...(byKey.get(`${b.exchange} ${key}`) ?? []), t]);
          } catch (err) {
            if (!(err instanceof MissingVariable)) throw err;
          }
        }
        await channel.consume(
          queue,
          (msg) => {
            if (!msg) return;
            const body = parsePayload(msg.content);
            for (const t of byKey.get(`${msg.fields.exchange} ${msg.fields.routingKey}`) ?? []) {
              const v = pick(body, (t.binding as unknown as { path?: string }).path);
              if (v !== undefined) onValue(t.key, v);
            }
          },
          { noAck: true },
        );
        return async () => void (await connection.close());
      },
      async check() {
        await (await connect()).close();
      },
    };
  },
};

/**
 * A generator for simulations: values from a pattern over time — constant, a sine wave, a random walk, steps — per
 * twin (its id seeds the phase and the walk, so twins differ but repeat). Reaches nothing.
 */
const generator: ConnectorType = {
  id: "generator",
  mode: "poll",
  fields: [],
  settings: z.object({}),
  binding: bindingOf({
    pattern: z.enum(["constant", "sine", "random", "step"]),
    min: z.number().default(0),
    max: z.number().default(1),
    periodSeconds: z.number().min(1).max(86_400 * 7).default(600),
  }),
  create(_settings, _secrets, ctx) {
    const walks = new Map<string, number>();
    const seed = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) / 4294967296;
    return {
      async poll(binding, vars) {
        const b = binding as unknown as { pattern: string; min: number; max: number; periodSeconds: number };
        const t = (ctx.now?.() ?? Date.now()) / 1000;
        const phase = seed(vars.id ?? "") * Math.PI * 2;
        const span = b.max - b.min;
        if (b.pattern === "constant") return b.min;
        if (b.pattern === "sine") return b.min + span * (0.5 + 0.5 * Math.sin((t / b.periodSeconds) * Math.PI * 2 + phase));
        if (b.pattern === "step") return Math.floor(t / b.periodSeconds + seed(vars.id ?? "")) % 2 ? b.max : b.min;
        const key = `${vars.id}|${binding.telemetry}`;
        const prev = walks.get(key) ?? b.min + span * seed(key);
        const next = Math.min(b.max, Math.max(b.min, prev + (Math.random() - 0.5) * span * 0.1));
        walks.set(key, next);
        return next;
      },
      async check() {},
    };
  },
};

/**
 * A simulated Kubernetes cluster (kwok, kind, a cluster of its own for experiments): the simulation profile's tool.
 * The connection holds its API and token; the profile's `simulator.scenario` says what to run on it. Phase one keeps
 * and checks the configuration (the API answers with the token); running scenarios comes next. It never points at
 * the twinned cluster's own API from the service's account: only a kubeconfig's.
 */
const kubernetesSimulation: ConnectorType = {
  id: "kubernetes-simulation",
  mode: "simulator",
  fields: [
    { name: "server", kind: "url", required: true },
    { name: "token", kind: "text", secret: true, required: true },
    { name: "ca", kind: "textarea" },
    { name: "tool", kind: "select", options: ["kwok", "kind", "cluster"], default: "kwok" },
  ],
  settings: z.object({ server: reachable(/^https:$/), ca: z.string().max(20_000).default(""), tool: z.enum(["kwok", "kind", "cluster"]).default("kwok") }),
  binding: bindingOf({}),
  create(settings, secrets, ctx) {
    return {
      async check() {
        const res = await (ctx.fetchFn ?? fetch)(`${settings.server!.replace(/\/$/, "")}/version`, { headers: { authorization: `Bearer ${secrets.token ?? ""}` }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`The simulation's API answered ${res.status}`);
      },
    };
  },
};

export const CONNECTOR_TYPES: Record<string, ConnectorType> = Object.fromEntries(
  [clickhouse, prometheus, mqtt, kafka, rabbitmq, generator, kubernetesSimulation].map((t) => [t.id, t]),
);

/** What's wrong with a binding's own parameters for its connection's kind (empty: fine). */
export function bindingErrors(binding: DataBinding, type: ConnectorType | undefined): string[] {
  if (!type) return [`connection ${binding.connection} doesn't exist`];
  if (type.mode === "simulator") return [`connection ${binding.connection} is a simulator, not a data source`];
  const parsed = type.binding.safeParse(binding);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${binding.telemetry}: ${i.path.join(".") || "binding"} ${i.message}`);
}
