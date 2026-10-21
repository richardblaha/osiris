-- Web analytics in ClickHouse (database `web`), idempotent: run again after any change, it creates only what's missing.
--   kubectl -n observability exec -i clickhouse-0 -- sh -c 'clickhouse-client --user otel --password "$OTEL_PASSWORD" --multiquery' < deploy/observability/web/schema.sql
--
-- web-events → collector (pipeline logs/web) → web.web_events_raw (the ClickHouse exporter's log table, 7 days)
--   → web_events_mv → web.web_events (typed, 2 years) → the *_mv views → the aggregate tables the dashboards read.
-- The raw table is the exporter's own (create_schema), so this script runs once the collector has created it.
-- A changed view is dropped and created again by hand (DROP VIEW web.<name>): CREATE ... IF NOT EXISTS keeps the old one.

CREATE DATABASE IF NOT EXISTS web;

-- One row per pageview or custom event. No IP, no cookie: visitor_hash is a keyed hash that changes every day.
CREATE TABLE IF NOT EXISTS web.web_events
(
    timestamp DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    site LowCardinality(String),
    event LowCardinality(String),
    path String CODEC(ZSTD(1)),
    referrer_domain LowCardinality(String),
    referrer_source LowCardinality(String),
    utm_source LowCardinality(String),
    utm_medium LowCardinality(String),
    utm_campaign LowCardinality(String),
    utm_content String CODEC(ZSTD(1)),
    utm_term String CODEC(ZSTD(1)),
    country LowCardinality(String),
    browser LowCardinality(String),
    os LowCardinality(String),
    device LowCardinality(String),
    screen UInt16,
    lang LowCardinality(String),
    visitor_hash UInt64,
    props Map(String, String) CODEC(ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (site, toDate(timestamp), event, path)
TTL toDateTime(timestamp) + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.web_events_mv TO web.web_events AS
SELECT
    Timestamp AS timestamp,
    LogAttributes['site'] AS site,
    LogAttributes['event'] AS event,
    LogAttributes['path'] AS path,
    LogAttributes['referrer_domain'] AS referrer_domain,
    LogAttributes['referrer_source'] AS referrer_source,
    LogAttributes['utm_source'] AS utm_source,
    LogAttributes['utm_medium'] AS utm_medium,
    LogAttributes['utm_campaign'] AS utm_campaign,
    LogAttributes['utm_content'] AS utm_content,
    LogAttributes['utm_term'] AS utm_term,
    LogAttributes['country'] AS country,
    LogAttributes['browser'] AS browser,
    LogAttributes['os'] AS os,
    LogAttributes['device'] AS device,
    toUInt16OrZero(LogAttributes['screen']) AS screen,
    LogAttributes['lang'] AS lang,
    toUInt64OrZero(LogAttributes['visitor_hash']) AS visitor_hash,
    -- Custom event properties come as attributes `prop.<name>`.
    CAST(mapApply((k, v) -> (substring(toString(k), 6), v), mapFilter((k, v) -> startsWith(k, 'prop.'), LogAttributes)), 'Map(String, String)') AS props
FROM web.web_events_raw
WHERE ServiceName = 'web-events';

-- Aggregates per site, by day and by hour: pageviews (sum) and unique visitors (uniq state of visitor_hash; merged
-- over a range it counts a visitor once per day, as the hash changes daily). Dimension tables count pageviews only.

CREATE TABLE IF NOT EXISTS web.stats_hourly
(
    site LowCardinality(String),
    hour DateTime('UTC'),
    pageviews SimpleAggregateFunction(sum, UInt64),
    events SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (site, hour)
TTL hour + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.stats_hourly_mv TO web.stats_hourly AS
SELECT site, toStartOfHour(timestamp) AS hour, countIf(event = 'pageview') AS pageviews, countIf(event != 'pageview') AS events,
       uniqStateIf(visitor_hash, event = 'pageview') AS visitors
FROM web.web_events GROUP BY site, hour;

CREATE TABLE IF NOT EXISTS web.stats_daily
(
    site LowCardinality(String),
    day Date,
    pageviews SimpleAggregateFunction(sum, UInt64),
    events SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (site, day)
TTL day + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.stats_daily_mv TO web.stats_daily AS
SELECT site, toDate(timestamp) AS day, countIf(event = 'pageview') AS pageviews, countIf(event != 'pageview') AS events,
       uniqStateIf(visitor_hash, event = 'pageview') AS visitors
FROM web.web_events GROUP BY site, day;

CREATE TABLE IF NOT EXISTS web.pages_daily
(
    site LowCardinality(String),
    day Date,
    path String,
    pageviews SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (site, day, path)
TTL day + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.pages_daily_mv TO web.pages_daily AS
SELECT site, toDate(timestamp) AS day, path, count() AS pageviews, uniqState(visitor_hash) AS visitors
FROM web.web_events WHERE event = 'pageview' GROUP BY site, day, path;

CREATE TABLE IF NOT EXISTS web.referrers_daily
(
    site LowCardinality(String),
    day Date,
    referrer_source LowCardinality(String),
    referrer_domain LowCardinality(String),
    pageviews SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (site, day, referrer_source, referrer_domain)
TTL day + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.referrers_daily_mv TO web.referrers_daily AS
SELECT site, toDate(timestamp) AS day, referrer_source, referrer_domain, count() AS pageviews, uniqState(visitor_hash) AS visitors
FROM web.web_events WHERE event = 'pageview' GROUP BY site, day, referrer_source, referrer_domain;

CREATE TABLE IF NOT EXISTS web.campaigns_daily
(
    site LowCardinality(String),
    day Date,
    utm_source LowCardinality(String),
    utm_medium LowCardinality(String),
    utm_campaign LowCardinality(String),
    pageviews SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (site, day, utm_source, utm_medium, utm_campaign)
TTL day + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.campaigns_daily_mv TO web.campaigns_daily AS
SELECT site, toDate(timestamp) AS day, utm_source, utm_medium, utm_campaign, count() AS pageviews, uniqState(visitor_hash) AS visitors
FROM web.web_events WHERE event = 'pageview' AND utm_source != '' GROUP BY site, day, utm_source, utm_medium, utm_campaign;

CREATE TABLE IF NOT EXISTS web.countries_daily
(
    site LowCardinality(String),
    day Date,
    country LowCardinality(String),
    pageviews SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (site, day, country)
TTL day + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.countries_daily_mv TO web.countries_daily AS
SELECT site, toDate(timestamp) AS day, country, count() AS pageviews, uniqState(visitor_hash) AS visitors
FROM web.web_events WHERE event = 'pageview' GROUP BY site, day, country;

CREATE TABLE IF NOT EXISTS web.devices_daily
(
    site LowCardinality(String),
    day Date,
    device LowCardinality(String),
    browser LowCardinality(String),
    os LowCardinality(String),
    pageviews SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (site, day, device, browser, os)
TTL day + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.devices_daily_mv TO web.devices_daily AS
SELECT site, toDate(timestamp) AS day, device, browser, os, count() AS pageviews, uniqState(visitor_hash) AS visitors
FROM web.web_events WHERE event = 'pageview' GROUP BY site, day, device, browser, os;

CREATE TABLE IF NOT EXISTS web.events_daily
(
    site LowCardinality(String),
    day Date,
    event LowCardinality(String),
    count SimpleAggregateFunction(sum, UInt64),
    visitors AggregateFunction(uniq, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (site, day, event)
TTL day + INTERVAL 2 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS web.events_daily_mv TO web.events_daily AS
SELECT site, toDate(timestamp) AS day, event, count() AS count, uniqState(visitor_hash) AS visitors
FROM web.web_events WHERE event != 'pageview' GROUP BY site, day, event;
