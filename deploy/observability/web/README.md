# Web analytics (web-events)

Our own replacement for GoatCounter, built on the cluster's existing telemetry: no cookies, no stored IPs, no
consent banner.

```
<script defer src="/_e/e.js">  ──POST /_e──▶  Traefik (IngressRoute per site, rate limit, 4 kB)
                                                 │
                                    web-events (observability)    validates, enriches, hashes; never stores the IP
                                                 │ OTLP/HTTP log record, service.name=web-events
                                    otel-collector :4320 (otlp/web) → logs/web → clickhouse/web
                                                 │
                       ClickHouse web.web_events_raw (exporter's table, 7 days)
                                 └─ web_events_mv → web.web_events (typed, 2 years)
                                       └─ *_mv → stats_hourly, stats_daily, pages_daily, referrers_daily,
                                                 campaigns_daily, countries_daily, locations_daily, networks_daily, devices_daily, events_daily
                                                 │
                       Osiris System > Návštěvnost (control → /api/admin/telemetry/web)  ·  grafana-dashboard.json
```

- **Script** (`apps/web-events/src/e.js`, ~0.6 kB gzip): sends a pageview on load and on every SPA navigation
  (`pushState`, `replaceState`, `popstate`; the same path twice in a row once), with `navigator.sendBeacon` or
  `fetch(…, { keepalive })`. Silent with Do Not Track, for automated browsers (`navigator.webdriver`), on localhost and
  `file://`. Custom events: `window.wa?.event("signup", { plan: "pro" })` (at most 10 props). The path is `/_e`, not
  "analytics" or "track", so blockers don't catch it by name.
- **Service** (`apps/web-events`, TypeScript like the rest of Osiris): `GET /_e/e.js`, `POST /_e`, `GET /healthz`.
  It accepts a site from the allowlist (ConfigMap `web-events`, `SITES`) only when the page's URL and the request's
  Host are both among that site's hosts, the body is at most 4 kB, and it matches the schema. Bots (User-Agent
  patterns, none at all) and `DNT: 1` / `Sec-GPC: 1` are dropped. Each event gets the browser, OS and device (from the
  User-Agent), the referrer's domain and kind (search, social, referral, email, direct; the site's own pages count as
  direct), the UTM parameters, the country, approximate region/city, ASN/network and the visitor hash, then goes out as one OTLP log record (batched).
  Metrics: `web_events.received{outcome}` and `web_events.private_ip` (see below), in Osiris System > Metriky.
- **Collector**: its own receiver (`otlp/web`, port 4320, only web-events may connect: NetworkPolicy) and pipeline
  (`logs/web`: memory_limiter, batch) to a second ClickHouse exporter writing database `web`. Web events never mix with
  the cluster's `otel_logs`. A second exporter with its own table is cleaner than filtering `otel_logs` by service: the
  exporter keeps managing the raw table's schema, the raw data has its own short TTL, and the typed table is filled by a
  materialized view rather than by the collector.
- **ClickHouse**: `schema.sql`, idempotent. Aggregates are `AggregatingMergeTree` with `uniqState(visitor_hash)`.

## Privacy: why there is no consent banner

The ePrivacy rules (in Czechia § 89 of Act 127/2005) need consent for storing or reading anything on the visitor's
device; this stores and reads nothing (no cookie, no localStorage, no fingerprinting script). GDPR applies to personal
data; what is stored can't identify a person:

- The **IP address** is used in memory for the country and the hash and then dropped: it isn't stored, logged or sent
  on (the tests check the emitted event doesn't contain it).
- The **visitor hash** is HMAC-SHA256 of site, IP and User-Agent with a salt that changes every day (derived from the
  `SALT_SEED` Secret and the date, so both replicas agree; only today's is in memory). It can't be reversed, and the
  same person gets a new hash every day and on every site, so visits can't be linked across days or sites.
- Location is stored as country, approximate region/city and ASN/provider, without coordinates or raw IPs. User-Agent is kept only as browser, OS and device type. These records are not linked to signed-in user accounts.

This is the same model as Plausible or Fathom. Mention it in the site's privacy policy anyway ("anonymous visit
statistics without cookies"). Rotating `SALT_SEED` (a new Secret value) makes even the current day's hashes unlinkable.

## Deployment

1. `.env`: `OSIRIS_WEB_EVENTS_SALT_SEED` (`openssl rand -hex 32`), then the Secret:
   ```bash
   kubectl -n observability create secret generic web-events --dry-run=client -o yaml \
     --from-literal=SALT_SEED="$OSIRIS_WEB_EVENTS_SALT_SEED" | kubectl apply -f -
   ```
2. The pull secret for the private images, copied from namespace osiris:
   `kubectl -n osiris get secret ghcr-pull -o json | jq '.metadata = {name: "ghcr-pull", namespace: "observability"}' | kubectl apply -f -`.
3. `kubectl apply -k deploy/observability` (ClickHouse users, the collector's pipeline, web-events, the IngressRoute).
   The ClickHouse users file is mounted with `subPath`, so a change needs `kubectl -n observability rollout restart
   statefulset/clickhouse`.
4. Once the collector has created `web.web_events_raw` (on its start), the schema:
   ```bash
   kubectl -n observability exec -i clickhouse-0 -- sh -c 'clickhouse-client --user otel --password "$OTEL_PASSWORD" --multiquery' \
     < deploy/observability/web/schema.sql
   ```
5. The visitor's IP must reach Traefik. Civo's load balancer and Cilium replace it with a cluster address, so the
   load balancer sends it with the PROXY protocol and Traefik reads it on every entrypoint (Helm release `traefik`):
   ```bash
   T='{10.0.0.0/8,192.168.0.0/16}'
   # First Traefik (it still takes connections without the header), then the load balancer.
   helm -n traefik upgrade traefik traefik/traefik --version 41.6.1 --reuse-values \
     --set ports.web.proxyProtocol.trustedIPs=$T --set ports.websecure.proxyProtocol.trustedIPs=$T \
     --set ports.minecraft.proxyProtocol.trustedIPs=$T --set ports.ssh.proxyProtocol.trustedIPs=$T
   helm -n traefik upgrade traefik traefik/traefik --version 41.6.1 --reuse-values \
     --set service.annotations.kubernetes\.civo\.com/loadbalancer-enable-proxy-protocol=send-proxy-v2
   ```
   (`service.spec.externalTrafficPolicy=Local` is set too, so a connection isn't forwarded between nodes.) Sites
   behind Cloudflare reach Traefik from Cloudflare's addresses: web-events then takes `CF-Connecting-IP`, but only
   when the address is Cloudflare's (`CDN_PROXIES`, its published ranges), so nobody can fake it on a direct site.
   `web_events.private_ip` growing means the IP doesn't arrive (hashes and countries are then wrong).

The image (`ghcr.io/richardblaha/osiris-web-events`) comes from CI with the rest; it carries DB-IP's free
IP-to-Country Lite database (CC BY 4.0, https://db-ip.com) of the month it was built, so a rebuild refreshes it.
GeoIP is in the service rather than the collector's `geoipprocessor`: the IP never leaves the service, while the
processor would need it as an attribute of the record, removed again afterwards (one mistake and it is stored).

## A site

Put the script on every page, in the `<head>`:

```html
<script defer src="/_e/e.js" data-site="example.cz"></script>
```

VitePress: `head: [["script", { defer: "", src: "/_e/e.js", "data-site": "example.cz" }]]` in `.vitepress/config`.

A new site: add `{ "id": "example.cz", "hosts": ["example.cz", "www.example.cz"] }` to `SITES` in
`deploy/observability/web-events.yaml` and its hosts to the IngressRoute's `match` there, then
`kubectl apply -k deploy/observability` and `kubectl -n observability rollout restart deployment/web-events`. The
site's own Ingress needs TLS for those hosts (the route takes its certificate by SNI).

## Schema

`web.web_events`: `timestamp`, `site`, `event` (`pageview` or a custom name), `path` (without query and fragment),
`referrer_domain`, `referrer_source` (search, social, referral, email, direct), `utm_source`, `utm_medium`,
`utm_campaign`, `utm_content`, `utm_term`, `country` (ISO code), `browser`, `os`, `device` (desktop, mobile,
tablet), `screen` (width in px), `lang`, `visitor_hash` (UInt64), `props` (custom event properties). Partitioned by
month, ordered by `(site, day, event, path)`, kept two years.

Aggregates (all per site and day, `stats_hourly` per hour; `pageviews` a sum, `visitors` a `uniq` state to merge with
`uniqMerge`): `stats_hourly`, `stats_daily` (also `events`), `pages_daily` (path), `referrers_daily`,
`campaigns_daily`, `countries_daily`, `devices_daily` (device, browser, os), `events_daily` (custom events, `count`).

Room for later: Web Vitals as further custom events (`wa.event("web-vital", { name, value })`) or their own log
attributes, and a `traceparent` on the beacon to tie a page view to the backend's traces.

## From GoatCounter

1. Run both: add the script next to GoatCounter's `count.js` on each site (k6labs.cz, richardblaha.cz, tras.cz).
2. After a week or two compare pageviews per day and the top pages. Expect web-events a little lower (bots and DNT
   are dropped, GoatCounter counts some of them) and unique visitors different (GoatCounter's sessions vs. our daily
   hash).
3. Remove `count.js` from the sites, then GoatCounter itself: `kubectl delete namespace goatcounter` (its ingresses
   `stats.*` go with it; remove their DNS records). Export its data first if the history is wanted
   (GoatCounter: Settings → Export, CSV): its rows can be inserted into `web.web_events` (path, time, referrer,
   browser, system, screen size, location) with `visitor_hash` 0, which the aggregates then include.


## GeoIP enrichment upgrade

`packages/platform/src/geoip.ts` is shared with control's account security history. Control and web-events
images include DB-IP City/ASN Lite databases; `GEOIP_DIR` (default `/tmp/osiris-geo`) is a writable cache.
At startup and daily the updater checks for the current month's release, validates MMDB before replacing
files, and retains the previous in-memory database if a download fails. Monthly ready markers avoid
repeated downloads. Set `GEOIP_AUTO_UPDATE=false` to manage databases externally; `GEOIP_BUNDLED_DIR`
(default `/app/geo`) supplies read-only fallback files. Legacy `GEOIP_DB` country files remain supported.
Downloads contain public database files only, never visitor IPs. Both UIs attribute DB-IP (CC BY 4.0).

Before rolling out these images, apply the updated `schema.sql` to ClickHouse using the command at its top.
It adds the location/network columns and aggregates and replaces the raw ingestion materialized view.
Old events retain empty fields; no location backfill is possible because raw IPs were never retained.
Apply during a quiet period: replacing the materialized view briefly pauses enrichment of incoming raw rows.
Existing browser/device, referrer, page and UTM breakdowns continue unchanged.

Production manifests currently set `GEOIP_AUTO_UPDATE=false` to avoid the memory peak of loading
a replacement database while the bundled one is still resident. Rebuild and redeploy control and
web-events monthly to refresh the bundled City/ASN data.
