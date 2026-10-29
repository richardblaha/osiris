import { format } from "node:util";
import { context, metrics, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const SEVERITY = {
  debug: SeverityNumber.DEBUG,
  log: SeverityNumber.INFO,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

/**
 * Sends traces, metrics and logs over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the standard OTel variables
 * configure the rest), and does nothing otherwise. Outgoing `fetch` calls get client spans and carry `traceparent`, so
 * a request is one trace across gateway, control and runtime; `console` output also goes out as log records tied to
 * the active span, while still printing as before. Call it first in a service's entry point.
 */
export function startTelemetry(serviceName: string, attributes: Record<string, string> = {}) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  process.env.OTEL_SERVICE_NAME ??= serviceName;
  if (Object.keys(attributes).length) {
    const extra = Object.entries(attributes).map(([k, v]) => `${k}=${v}`);
    process.env.OTEL_RESOURCE_ATTRIBUTES = [process.env.OTEL_RESOURCE_ATTRIBUTES, ...extra].filter(Boolean).join(",");
  }
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 30_000 })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [new UndiciInstrumentation()],
  });
  sdk.start();

  const logger = logs.getLogger("console");
  for (const level of Object.keys(SEVERITY) as (keyof typeof SEVERITY)[]) {
    const print = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      print(...args);
      const error = args.find((a): a is Error => a instanceof Error);
      logger.emit({
        severityNumber: SEVERITY[level],
        severityText: level === "log" ? "INFO" : level.toUpperCase(),
        body: format(...args),
        attributes: error ? { "exception.type": error.name, "exception.message": error.message, "exception.stacktrace": error.stack ?? "" } : {},
      });
    };
  }
  const stop = () => void sdk.shutdown().catch(() => {});
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

/**
 * Emits events as OpenTelemetry log records (INFO, body = the event's name, `event.name` among the attributes), at
 * their own time. They go out with the service's other logs once `startTelemetry` ran, and nowhere otherwise.
 */
export function eventEmitter(scope: string) {
  const logger = logs.getLogger(scope);
  return (name: string, attributes: Record<string, string>, timestampMs: number) =>
    logger.emit({ severityNumber: SeverityNumber.INFO, severityText: "INFO", body: name, timestamp: timestampMs, attributes: { "event.name": name, ...attributes } });
}

const tracer = trace.getTracer("osiris-http");
const duration = metrics.getMeter("osiris-http").createHistogram("http.server.request.duration", { unit: "s", description: "Duration of HTTP requests" });

/** What the middleware needs of Hono's context (structural, so this package doesn't depend on Hono). */
interface HttpContext {
  req: { method: string; path: string; raw: Request; matchedRoutes?: { path: string }[] };
  res: Response;
  error?: Error;
}

/**
 * Hono middleware: a server span per request, continuing the caller's trace (`traceparent`), and a duration metric.
 * Spans are named by route pattern, never by the concrete path (which carries ids).
 */
export function telemetryMiddleware() {
  return async (c: HttpContext, next: () => Promise<void>) => {
    const parent = propagation.extract(context.active(), Object.fromEntries(c.req.raw.headers));
    const start = performance.now();
    await tracer.startActiveSpan(`${c.req.method}`, { kind: SpanKind.SERVER, attributes: { "http.request.method": c.req.method } }, parent, async (span) => {
      try {
        await next();
      } finally {
        // The last specific route that matched is the handler's: middleware comes first, and catch-alls (the web
        // app's static files) match everything after it.
        const route = c.req.matchedRoutes?.map((r) => r.path).filter((p) => p !== "/*" && p !== "*").at(-1) ?? "unmatched";
        const status = c.res.status;
        span.updateName(`${c.req.method} ${route}`);
        // The path carries ids, so it's an attribute for finding a request, never the span's name.
        span.setAttributes({ "http.route": route, "http.response.status_code": status, "url.path": c.req.path });
        if (status >= 500 || c.error) span.setStatus({ code: SpanStatusCode.ERROR, message: c.error?.message });
        if (c.error) span.recordException(c.error);
        span.end();
        duration.record((performance.now() - start) / 1000, { "http.request.method": c.req.method, "http.route": route, "http.response.status_code": status });
      }
    });
  };
}
