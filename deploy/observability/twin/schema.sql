-- The digital twin's history in ClickHouse (database `twin`), idempotent: run again after any change, it creates only what's missing.
--   kubectl -n observability exec -i clickhouse-0 -- sh -c 'clickhouse-client --user otel --password "$OTEL_PASSWORD" --multiquery' < deploy/observability/twin/schema.sql
--
-- The twin's recorder (server/digital-twin/src/history.ts, user twin) writes only changes: an entity or a relationship
-- added, changed or removed, plus a full checkpoint of every entity and relationship once a day. The state at any time
-- is the newest checkpoint before it with the changes after it, so nothing older than a day's changes is ever needed
-- and the 90-day TTL never loses a long-lived entity.

CREATE DATABASE IF NOT EXISTS twin;

-- One row per change of an entity (or per entity in a checkpoint). `twin` is the twin's name (CLUSTER_NAME),
-- `source` its adapter; `ancestors` are the ids up the contains tree, so an entity's history includes its descendants'.
CREATE TABLE IF NOT EXISTS twin.entity_events
(
    ts DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    twin LowCardinality(String),
    source LowCardinality(String),
    entity_id String CODEC(ZSTD(1)),
    change Enum8('added' = 1, 'changed' = 2, 'removed' = 3, 'checkpoint' = 4),
    model LowCardinality(String),
    kind LowCardinality(String),
    name String CODEC(ZSTD(1)),
    status Enum8('ok' = 1, 'warn' = 2, 'error' = 3),
    previous_status Enum8('' = 0, 'ok' = 1, 'warn' = 2, 'error' = 3),
    -- What changed: property names, and 'status'.
    changed Array(LowCardinality(String)),
    properties Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    telemetry Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ancestors Array(String) CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (twin, ts, entity_id)
TTL toDateTime(ts) + INTERVAL 90 DAY;

-- One row per relationship added or removed (or per relationship in a checkpoint).
CREATE TABLE IF NOT EXISTS twin.relationship_events
(
    ts DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    twin LowCardinality(String),
    source LowCardinality(String),
    name LowCardinality(String),
    source_id String CODEC(ZSTD(1)),
    target_id String CODEC(ZSTD(1)),
    change Enum8('added' = 1, 'removed' = 3, 'checkpoint' = 4)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (twin, ts, name, source_id, target_id)
TTL toDateTime(ts) + INTERVAL 90 DAY;
