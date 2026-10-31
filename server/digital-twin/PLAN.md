# Digital twin: alerting and data sources — plan

What the twin gains, how it is built, and what is done (✅) or next (⏭).

## 1. Windows and the agent ✅

- The agent arranges the windows over the twin: `twin_view`'s `window` steps (show, close, focus, maximize, restore, snap,
  merge, detach) and `layout` reset, run on the user's own layout (`windowStep` in `web/src/windowLayout.ts`).
- The controls hint is gone.

## 2. Alerting ✅ (first version)

**Pipeline.** The collector's own processor `twin_events` (deploy/observability/twin-events) already appends every warn/error
log record to the Redis stream `osiris:otel:events`. Alerting reads that stream; ClickHouse never waits on it.

**Service.** `digital-twin-alerts` (`src/alerts`, its own image and Deployment, part of the twin's code base):

1. Reads the stream with a consumer group of its own (`twin-alerts`); other readers keep theirs.
2. Turns events into alerts: a fingerprint of cluster, namespace, workload (from the pod's name), container and the
   message's shape (numbers, ids, addresses taken out). Repeats within `ALERTS_REOPEN_MINUTES` join the open alert
   (count, last seen, worst severity); no event for `ALERTS_RESOLVE_MINUTES` means resolved.
3. Each new alert gets a new conversation with Osiris's agent in project `twin`: investigate (twin_events, kubectl,
   ceph), explain, propose a fix, change nothing. At most `ALERTS_MAX_PER_HOUR` an hour; the rest are kept as
   `skipped`. Outcome and summary are written back to the alert (Redis, kept 30 days).

**Identity.** The service talks to Osiris as its own service account, never as a person: osiris-auth's app
`osiris-twin-alerts` acts as the user `twin-alerts` (OAuth 2.0 client credentials, a feature added to osiris-auth for
this). The gateway accepts that app's tokens. Only this service holds the secret.

**Reading the conversations.** The twin's API asks the alerts service with its ServiceAccount's token projected for
the audience `osiris-twin-alerts` (TokenReview, plus a NetworkPolicy that lets in only the twin). The PWA lists the
twin's cluster's alerts in the chat's history ("Alert investigations"). An alert's conversation opens read-only, and a
reply goes on in a new conversation of the user's own, seeded with the alert and what the agent found.

⏭ Next: rules per namespace or workload (severity, silence windows), notifying people (Osiris's WhatsApp or e-mail),
links from an alert to the twin's object (select it in the 3D view), and alerts from metrics (thresholds over the
data hub's values) besides logs.

## 3. Data sources: the twin as a universal digital twin ✅ (foundation)

**Model.** A DTDL model may carry `dataProfiles` (context `dtmi:osiris:data;1`, `@osiris/shared/dtdl.ts`): named
profiles of a kind (`live`, `simulation`, `replay`), each binding the model's Telemetry or Property contents to a
**connection** by id, with that connector's own, non-secret parameters. A simulation profile may also name a
**simulator**: a connection to the simulation's own tools (a simulated Kubernetes cluster…) with its scenario.
Profiles are inherited over `extends` (same name replaces).

```json
"dataProfiles": [
  { "name": "live", "kind": "live", "bindings": [
    { "telemetry": "temperature", "connection": "plant-mqtt", "topic": "plant/{twin.line}/{name}/temp", "path": "$.value" },
    { "telemetry": "cpu", "connection": "otel", "query": "SELECT avg(Value) AS value FROM otel_metrics_gauge WHERE ResourceAttributes['k8s.pod.name'] = {pod:String}", "params": { "pod": "{otel.k8s.pod.name}" }, "every": 30 } ] },
  { "name": "simulation", "kind": "simulation",
    "simulator": { "connection": "kwok", "scenario": { "nodes": 20, "podsPerNode": 30 } },
    "bindings": [ { "telemetry": "temperature", "connection": "gen", "pattern": "sine", "min": 20, "max": 80, "periodSeconds": 600 } ] }
]
```

**Connections** (per twin, admins, the twin's "Data sources" tab): `clickhouse`, `prometheus` (any Prometheus-API
backend of OpenTelemetry metrics), `mqtt`, `kafka`, `rabbitmq`, `generator` (simulated values) and
`kubernetes-simulation` (the simulation's cluster). Each kind is an entry of `CONNECTOR_TYPES` (`src/datasources/connectors.ts`):
its form, a zod schema for its settings and for a binding's parameters, and a connector that is asked (`poll`),
streams (`subscribe`) or is a simulation tool (`simulator`).

**Runtime.** Each twin runs a **data hub** (`src/datasources/hub.ts`) for its active profile (`PUT /api/instances/:id/data/profile`):
it plans the bindings of every twin whose model's profile has them (at most 1000), polls the asked ones when due (four
at a time), keeps one subscription per streaming connection, and writes each value to Redis
(`<prefix>:twin:<instance>:data`). The PWA shows them in the properties panel ("Data (profile)").

**Security.**
- Addresses and credentials live only in connections; secrets are sealed (`TWIN_SECRETS_KEY`), write-only, opened only
  for their connector. Models carry no secrets and are checked against the connections when saved.
- Connectors only read. ClickHouse gets a twin's values as typed query parameters, never in the SQL, one SELECT,
  `readonly=1` (use a read-only user too). PromQL label values are quoted. MQTT topics and AMQP routing keys take
  values as whole levels only (no separators or wildcards). RabbitMQ reads through an exclusive queue of its own.
- Hosts: this host and link-local (cloud metadata) addresses are refused; private networks stay allowed (brokers live
  there; restrict egress with a NetworkPolicy where it matters).
- Admins manage connections and switch profiles; viewers see profiles and values, connection errors only admins.

⏭ Next, in order:
1. The existing ClickHouse telemetry (errors, network, storage) as a built-in `live` profile of the Kubernetes models,
   so the 3D view reads every value through the hub.
2. The simulator: apply a simulation profile's scenario to its `kubernetes-simulation` connection (kwok: nodes and
   pods as the scenario says), and run the twin's structure from that cluster while the profile is active.
3. `replay`: a profile reading recorded values from ClickHouse at a time offset.
4. More connectors as needed (OPC UA, Modbus, InfluxDB, NATS), each an entry with its schemas and a test.
5. Values in the 3D view (a model's presentation naming the telemetry that colours or fills its solid) and alerts
   over values.
