# Deployment

Optional conversational image generation: [Comfy Cloud integration](images/README.md).

Osiris runs in the `busiris` microk8s cluster at https://osiris.k6labs.cz. Shared services live in the `osiris`
namespace; each project gets its own namespace `osiris-p-<slug>`, created by the operator.

```
Internet ─ Traefik ─── osiris.k6labs.cz ──▶ gateway ──┬─▶ control ──▶ SQLite (own volume) ─▶ S3 (control backups)
                                                      │      │  └──▶ WhatsApp, S3, Emailit, Google/Facebook/Microsoft/Seznam (sign-in)
                                                      │      └──▶ Project objects ◀── operator ──▶ project namespaces
                                                      └─▶ runtime (osiris-p-<slug>, 0–1 pod, own volume) ─▶ gotenberg
```

- **Images:** GitHub Actions (`.github/workflows/ci.yml`) runs the tests and, on `main`, pushes one image per service:
  `ghcr.io/richardblaha/osiris-{gateway,auth,control,runtime,operator,vitepress,web-events}` with the tags `main` and `sha-<commit>`.
  Runtimes pull `:main` whenever they wake, so a new runtime version reaches a project on its next wake-up.
- **Projects sleep:** a runtime idle for `idleMinutes` (30 by default, 0 = always on) is snapshotted to S3 and scaled to
  zero; the next request, WhatsApp message or scheduled task wakes it (the gateway waits for it, usually 10–30 s).
- **Data:** project database and files on the project's volume (`ceph-rbd`), snapshots in S3 (before every sleep and
  daily); control's SQLite (`/data/control.db`) on its own volume, copied daily to the volume and to S3
  (`backups/control/`, CronJob `control-backup`).
- **TLS:** cert-manager (`letsencrypt` ClusterIssuer); project domains get their certificates through HTTP-01.
- **Sign-in:** osiris-auth at `https://auth.k6labs.cz`, on the **busiris** cluster (`.kubeconfig.busiris`, namespace
  `osiris-auth`, `deploy/auth`): the OpenID Connect provider, the account page, users and groups (SCIM 2.0).

Commands below use `KUBECONFIG=.kubeconfig.busiris` and read keys from the gitignored root `.env`.

## Sign-in (osiris-auth on busiris)

Users sign in on `https://auth.k6labs.cz/login` with a passkey, email and password, Google, Facebook, Microsoft or
Seznam, or a one-time link; an authenticator app (TOTP) is an optional second factor after a password or social sign-in.
They manage those at `https://auth.k6labs.cz/account` (Osiris's Profile → Sign-in and security links there). Users,
groups, credentials and the provider's sessions and tokens live in osiris-auth's SQLite (`/data/auth.db` on the
`auth-data` volume, `ceph-rbd`), copied daily to `/data/backups/` (last 7; CronJob `auth-backup`).

It is an identity provider for any application, not only Osiris. Admins (group `admin`, `ADMIN_GROUP`) work at
`https://auth.k6labs.cz/admin`: users, groups, applications and API keys.

- **A new application:** Admin → Applications → Add. Give a client id, a name, web or native, whether it has a secret
  (server-side apps; shown once), its redirect URIs and who may sign in (groups; none = everyone). The app then uses
  the issuer `https://auth.k6labs.cz` (discovery at `/.well-known/openid-configuration`), authorization code with
  PKCE, scopes `openid profile email groups`; the ID token and userinfo carry `groups`.
- **An API that checks tokens:** register it as an application with a secret and "Accepts tokens of" the apps whose
  tokens it receives; it calls `POST /introspect` (RFC 7662, HTTP Basic with its id and secret). Tokens of other apps
  are inactive to it.
- **A service that manages users:** Admin → API keys gives a SCIM 2.0 token (`/scim/v2`).
- Osiris's own apps (`osiris-web`, `osiris-cli`, `osiris-vscode`, `osiris-gateway`) were registered at the first start
  from `WEB_ORIGINS` and `GATEWAY_CLIENT_SECRET`; they are edited at /admin like any other.

- **Network:** `auth.k6labs.cz` goes through Cloudflare to busiris's Traefik (`192.168.0.50`); the certificate comes
  from cert-manager (`letsencrypt`, HTTP-01). Only Traefik reaches the pod. osiris.k6labs.cz's gateway introspects
  tokens and control calls SCIM over `https://auth.k6labs.cz`.
- **Keys** (secret `osiris-auth` in `osiris-auth`): `AUTH_SIGNING_KEY` (signs ID tokens; changing it signs everyone out),
  `AUTH_SECRET` (cookies and the TOTP sealing key: it is the one control had, so authenticator apps kept working when
  the users moved; changing it turns off everyone's authenticator app), `GATEWAY_CLIENT_SECRET` (`openssl rand -hex
  32`, also in the gateway's secret), `EMAILIT_API_KEY` and the social keys.
- **Email** (sign-in links): Emailit's HTTP API (`EMAILIT_API_KEY`, `k6labs.cz` verified there, sender `MAIL_FROM`).
- **Social sign-in** (each optional, on when its ID and secret are set). Redirect URIs are
  `https://auth.k6labs.cz/social/<google|facebook|microsoft|seznam>/callback`:
  - Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application); consent screen with
    scopes `openid email profile`. `.env`: `OSIRIS_GOOGLE_CLIENT_ID`, `OSIRIS_GOOGLE_CLIENT_SECRET`.
  - Meta for Developers → app with Facebook Login, permissions `email`, `public_profile`; Valid OAuth Redirect URIs as
    above. `.env`: `OSIRIS_FACEBOOK_CLIENT_ID` (App ID), `OSIRIS_FACEBOOK_CLIENT_SECRET` (App secret).
  - Microsoft Entra → App registrations → New (accounts in any organizational directory and personal Microsoft
    accounts), platform Web with the redirect URI, a client secret. `.env`: `OSIRIS_MICROSOFT_CLIENT_ID`,
    `OSIRIS_MICROSOFT_CLIENT_SECRET`; `MICROSOFT_TENANT` (default `common`) limits it to one directory.
  - Seznam (vyvojari.seznam.cz → OAuth → new service), scope `identity`, the redirect URI. `.env`:
    `OSIRIS_SEZNAM_CLIENT_ID`, `OSIRIS_SEZNAM_CLIENT_SECRET`.

  A Google or Facebook account whose verified email matches an Osiris user signs straight into that user (so invited
  people can use it at once), as does a Seznam account with a Seznam mailbox (@seznam.cz, @email.cz, @post.cz, …).
  Microsoft doesn't verify emails and a Seznam account can carry an outside address, so those must be linked on the
  account page first.
- **Passkeys** belong to `auth.k6labs.cz` (the provider's own host). Ones made on osiris.k6labs.cz before the move
  don't work there: people sign in another way (a link by email) and add a new one at /account.
- **SCIM tokens:** `kubectl --kubeconfig .kubeconfig.busiris -n osiris-auth exec deploy/auth -- node_modules/.bin/tsx
  src/cli.ts token control` prints control's token (`AUTH_SCIM_TOKEN` in `osiris-control`); running it again replaces it.
- **People:** the first system admin: `… exec deploy/auth -- node_modules/.bin/tsx src/cli.ts add-admin you@example.com
  First Last` prints a one-time sign-in link. System admins create projects and add people in the web app (System →
  Projects, Users); project admins add people to their own project (Project → Users). New people get a one-time
  sign-in link (3 days). Access is groups: `osiris-user`, `osiris-admin`, `project:<slug>`, `project-admin:<slug>`.
- **Lost second factor:** a system admin turns it off in the web app (Users → the person).

Users verify their phone number for WhatsApp themselves (My profile → Account → Phone for WhatsApp): they send `VERIFY
<code>` or `OVERENI <code>` from the phone to the business number; control writes it to osiris-auth.

### From control (one-off, 2026-10)

Before osiris-auth, control was the provider and kept users in rqlite. `cli.ts import-control <rqlite-url>` copies every
user with the same id, password, authenticator, recovery codes, passkeys and linked accounts, turning claims into
groups (sessions don't move: everyone signs in again). With a port-forward to rqlite on abydos:

```bash
kubectl -n osiris port-forward svc/rqlite 4001 &
kubectl --kubeconfig .kubeconfig.busiris -n osiris-auth exec -i deploy/auth -- env RQLITE_USERNAME=control RQLITE_PASSWORD=… \
  node_modules/.bin/tsx src/cli.ts import-control http://<reachable rqlite>:4001
```

(or run the CLI locally with `DATA_DIR` on a copy, then copy `auth.db` into the volume). Control's migration
`013_no_auth.sql` then drops its auth tables.

## WhatsApp

The webhook is `https://osiris.k6labs.cz/webhooks/whatsapp` (the gateway passes it to control, which checks Meta's
signature, stores the message and answers at once; a worker runs it in the sender's project).

1. Meta app → WhatsApp → Configuration → Webhook: callback URL above, verify token `OSIRIS_WHATSAPP_VERIFY_TOKEN`
   (`openssl rand -hex 16`), subscribe to `messages`.
2. `.env`: `OSIRIS_WHATSAPP_APP_SECRET` (App settings → Basic), `OSIRIS_WHATSAPP_ACCESS_TOKEN` (permanent System User
   token with `whatsapp_business_messaging`), `OSIRIS_WHATSAPP_DISPLAY_NUMBER` (the business number as users see it).
3. Set the secrets (below) and restart control **before** saving the webhook in Meta.

Scheduled results go to WhatsApp only within 24 hours of the user's last message (Meta's rule for free-form messages);
otherwise they stay in the web chat and the task shows a note.

## Observability (ClickHouse, OTLP)

`deploy/observability` (namespace `observability`, for the whole cluster) runs ClickHouse and the OpenTelemetry
Collector. `otel-collector` takes OTLP from applications (`otel-collector.observability.svc.cluster.local:4318`, gRPC
4317), cluster metrics and Kubernetes events; the `otel-agent` DaemonSet reads pod logs and kubelet metrics on every
node and sends them to the collector (port 4319, without a second pod lookup). The collector alone writes to ClickHouse
(database `otel`, tables `otel_logs`, `otel_traces`, `otel_metrics_*`, created by its exporter, 30 days TTL). Osiris
services and runtimes send traces, metrics and logs over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
(`@osiris/platform/telemetry.ts`; the manifests set it), so their pod logs are not collected a second time. Admins
read it all at **https://dashboard.k6labs.cz** (Logy, Metriky, Trasy; signed in through auth.k6labs.cz, group `admin`):
its telemetry API queries ClickHouse as the read-only user `osiris` — Osiris's Dashboards panels use the same user
through control (`/api/admin/telemetry/logs` and `/series`), and so does the digital twin (below); the NetworkPolicy
lets only the collector write and the three readers read.

## Osiris Digital Twin (twin.k6labs.cz)

`server/digital-twin` + `server/digital-twin/web` (Docker target `digital-twin`): the cluster's digital twin — a 3D
WebGL PWA (three.js, the OSIRIS theme) of namespaces → workloads → pods → containers as nested translucent cuboids,
edges coloured by status, with Logy/Metriky/Trasy pages that open filtered by the selected node. The structure comes
straight from the Kubernetes API (read-only ServiceAccount `digital-twin`, `deploy/k8s/rbac.yaml`); the telemetry
from ClickHouse; **Redis** (`deploy/k8s/redis.yaml`, cache only) caches both. The model is DTDL v2 (`/api/twin/model`).

1. In osiris-auth (`/admin`), add the app **digital-twin** (public, PKCE, redirect `https://twin.k6labs.cz/callback`)
   and the introspection client **osiris-digital-twin** (a secret, accepting `digital-twin`'s tokens), then:
   ```bash
   kubectl -n osiris create secret generic osiris-digital-twin --dry-run=client -o yaml \
     --from-literal=AUTH_CLIENT_SECRET="<osiris-auth secret>" --from-literal=CLICKHOUSE_PASSWORD="$OSIRIS_CLICKHOUSE_OSIRIS_PASSWORD" | kubectl apply -f -
   kubectl apply -k deploy/k8s
   ```
2. `AUTH_REQUIRED_GROUP` (default `admin`) says which group may see the twin; without membership the API answers 403.
3. DNS: twin.k6labs.cz to the cluster's ingress, the same as osiris.k6labs.cz; cert-manager issues the certificate.

Any cluster can be twinned, not just the one the app runs in: mount the cluster's kubeconfig (as a secret) and set
`KUBECONFIG` (and `KUBE_CONTEXT`, if not the current one) plus its ClickHouse (`CLICKHOUSE_URL`, `CLICKHOUSE_USER`,
`CLICKHOUSE_PASSWORD`) and `CLUSTER_NAME`. The kubeconfig's user must authenticate with a token — client certificates
and exec plugins are refused; `kubectl create token <service-account> --duration 0` prints one that doesn't expire
(the cluster's read-only rules are in `deploy/k8s/rbac.yaml`). The cluster's telemetry must reach ClickHouse through
the OpenTelemetry Collector's standard schema (`otel_logs`, `otel_traces`, `otel_metrics_*`, database `otel`).
One instance twins one cluster; a ClickHouse shared by several clusters would mix their telemetry (the twin doesn't
filter by `k8s.cluster.name`).

1. `.env`: `OSIRIS_CLICKHOUSE_OTEL_PASSWORD`, `OSIRIS_CLICKHOUSE_OSIRIS_PASSWORD` (`openssl rand -hex 24` each), then:
   ```bash
   kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n observability create secret generic clickhouse-users --dry-run=client -o yaml \
     --from-literal=OTEL_PASSWORD="$OSIRIS_CLICKHOUSE_OTEL_PASSWORD" --from-literal=OSIRIS_PASSWORD="$OSIRIS_CLICKHOUSE_OSIRIS_PASSWORD" | kubectl apply -f -
   kubectl -n osiris patch secret osiris-control --type merge -p "{\"stringData\":{\"CLICKHOUSE_PASSWORD\":\"$OSIRIS_CLICKHOUSE_OSIRIS_PASSWORD\"}}"
   kubectl apply -k deploy/observability
   ```
2. A changed collector or ClickHouse config needs a bump of the `config/version` annotation to restart it.
3. Ad-hoc SQL: `kubectl -n observability exec -it clickhouse-0 -- clickhouse-client --user otel --password "$OSIRIS_CLICKHOUSE_OTEL_PASSWORD"`.

## Web analytics

Cookieless analytics for the cluster's websites (web-events → collector → ClickHouse `web`, shown in System >
Traffic): deployment, the snippet, a new site and the move from GoatCounter are in
[observability/web/README.md](observability/web/README.md).

## Users' Google and Microsoft accounts

Users connect their own Google or Microsoft account in My profile → Connected accounts; the assistant then reads and sends
their mail, manages their contacts (those on their phone, when synced with the account) and their calendar. Osiris
needs one OAuth client per provider, whose redirect URI is `https://osiris.k6labs.cz/integration-callback`; runtimes
get them from the operator's secret (`RUNTIME_SECRET_*`, see Secrets). A provider without a client is not offered.

- **Google Cloud Console:** enable the Gmail API, People API and Google Calendar API; OAuth consent screen with the
  scopes `openid`, `email`, `…/auth/gmail.modify`, `…/auth/contacts`, `…/auth/calendar.events`; an OAuth client
  of type *Web application* with the redirect URI above. `.env`: `OSIRIS_GOOGLE_INTEGRATION_CLIENT_ID`,
  `OSIRIS_GOOGLE_INTEGRATION_CLIENT_SECRET`. Gmail and contacts are *restricted* scopes: while the app is in testing,
  only the test users listed on the consent screen (up to 100) can connect; publishing it for everyone needs Google's
  verification including a security assessment (CASA). An internal app of one Workspace organization needs neither.
- **Microsoft Entra:** App registrations → New, *accounts in any organizational directory and personal Microsoft
  accounts*, platform Web with the redirect URI above, a client secret, delegated permissions `User.Read`,
  `Mail.ReadWrite`, `Mail.Send`, `Contacts.ReadWrite`, `Calendars.ReadWrite`, `offline_access`, `openid`, `email`.
  `.env`: `OSIRIS_MICROSOFT_INTEGRATION_CLIENT_ID`, `OSIRIS_MICROSOFT_INTEGRATION_CLIENT_SECRET`.

Then recreate the `osiris-operator` secret and restart the operator; runtimes pick the clients up on their next start.

## Visits (GoatCounter)

The web app counts visits with GoatCounter (cookieless, in namespace `goatcounter`): set `GOATCOUNTER_URL` in
`gateway.yaml` to the Osiris site's URL (created in GoatCounter, e.g. `https://osiris.stats.k6labs.cz`). The gateway
then adds its `count.js` to the page and the site to the CSP; the app counts each view as a path (`/chat`,
`/skills`, …), never with ids or names.

## Object storage (Ceph RGW)

The RGW of the cluster's Ceph (namespace `rook-ceph-external`, service `ceph-rgw`; outside the cluster at
https://s3.k6labs.cz) with the user of the secret `rook-ceph-object-user-s3-richard` and a bucket (`osiris`).
Pods use `http://ceph-rgw.rook-ceph-external.svc` (path style). Prefixes: `backups/` (project snapshots and
control's database copies, `backups/control/`).

## Secrets

Generate the internal keys once and keep them in `.env` (losing `SECRETS_MASTER_KEY` makes projects' stored secrets
unreadable; changing the JWT keys only needs a restart of all services):

```bash
pnpm --filter @osiris/platform gen-keys   # → OSIRIS_INTERNAL_JWT_PRIVATE_KEY, OSIRIS_INTERNAL_JWT_PUBLIC_KEY, OSIRIS_SECRETS_MASTER_KEY,
                                          #   OSIRIS_AUTH_SIGNING_KEY, OSIRIS_AUTH_SECRET (osiris-auth's)
                                          #   (put the PEM values in single quotes in .env: they contain spaces)
```

```bash
set -a; . ./.env; set +a
K="kubectl -n osiris"
apply() { $K create secret generic "$@" --dry-run=client -o yaml | $K apply -f -; }
key() { printf '%s' "$1" | sed 's/\\n/\n/g'; }   # .env keeps PEM keys on one line

apply osiris-gateway --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")" \
  --from-literal=GATEWAY_CLIENT_SECRET="$OSIRIS_GATEWAY_CLIENT_SECRET"

apply osiris-control \
  --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")" \
  --from-literal=INTERNAL_JWT_PUBLIC_KEY="$(key "$OSIRIS_INTERNAL_JWT_PUBLIC_KEY")" \
  --from-literal=AUTH_SCIM_TOKEN="$OSIRIS_AUTH_SCIM_TOKEN" --from-literal=EMAILIT_API_KEY="$EMAILIT_API_KEY" \
  --from-literal=S3_ENDPOINT="$OSIRIS_S3_ENDPOINT" --from-literal=S3_REGION="$OSIRIS_S3_REGION" --from-literal=S3_BUCKET="$OSIRIS_S3_BUCKET" \
  --from-literal=S3_ACCESS_KEY_ID="$OSIRIS_S3_ACCESS_KEY_ID" --from-literal=S3_SECRET_ACCESS_KEY="$OSIRIS_S3_SECRET_ACCESS_KEY" \
  --from-literal=WHATSAPP_VERIFY_TOKEN="$OSIRIS_WHATSAPP_VERIFY_TOKEN" --from-literal=WHATSAPP_APP_SECRET="$OSIRIS_WHATSAPP_APP_SECRET" \
  --from-literal=WHATSAPP_ACCESS_TOKEN="$OSIRIS_WHATSAPP_ACCESS_TOKEN" --from-literal=WHATSAPP_DISPLAY_NUMBER="$OSIRIS_WHATSAPP_DISPLAY_NUMBER" \

apply osiris-operator \
  --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")" \
  --from-literal=INTERNAL_JWT_PUBLIC_KEY="$(key "$OSIRIS_INTERNAL_JWT_PUBLIC_KEY")" \
  --from-literal=SECRETS_MASTER_KEY="$OSIRIS_SECRETS_MASTER_KEY" \
  --from-literal=RUNTIME_SECRET_MISTRAL_API_KEY="$MISTRAL_API_KEY" \
  --from-literal=RUNTIME_SECRET_GOOGLE_INTEGRATION_CLIENT_ID="$OSIRIS_GOOGLE_INTEGRATION_CLIENT_ID" \
  --from-literal=RUNTIME_SECRET_GOOGLE_INTEGRATION_CLIENT_SECRET="$OSIRIS_GOOGLE_INTEGRATION_CLIENT_SECRET" \
  --from-literal=RUNTIME_SECRET_MICROSOFT_INTEGRATION_CLIENT_ID="$OSIRIS_MICROSOFT_INTEGRATION_CLIENT_ID" \
  --from-literal=RUNTIME_SECRET_MICROSOFT_INTEGRATION_CLIENT_SECRET="$OSIRIS_MICROSOFT_INTEGRATION_CLIENT_SECRET"


# Pull access to the private images (read:packages only); the operator copies it into project namespaces.
$K create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=richardblaha \
  --docker-password="$GITHUB_API_KEY" --dry-run=client -o yaml | $K apply -f -

# osiris-auth on busiris (its own cluster and namespace).
B="kubectl --kubeconfig .kubeconfig.busiris -n osiris-auth"
bapply() { $B create secret generic "$@" --dry-run=client -o yaml | $B apply -f -; }
bapply osiris-auth \
  --from-literal=AUTH_SIGNING_KEY="$(key "$OSIRIS_AUTH_SIGNING_KEY")" --from-literal=AUTH_SECRET="$OSIRIS_AUTH_SECRET" \
  --from-literal=GATEWAY_CLIENT_SECRET="$OSIRIS_GATEWAY_CLIENT_SECRET" --from-literal=EMAILIT_API_KEY="$EMAILIT_API_KEY" \
  --from-literal=GOOGLE_CLIENT_ID="$OSIRIS_GOOGLE_CLIENT_ID" --from-literal=GOOGLE_CLIENT_SECRET="$OSIRIS_GOOGLE_CLIENT_SECRET" \
  --from-literal=FACEBOOK_CLIENT_ID="$OSIRIS_FACEBOOK_CLIENT_ID" --from-literal=FACEBOOK_CLIENT_SECRET="$OSIRIS_FACEBOOK_CLIENT_SECRET" \
  --from-literal=MICROSOFT_CLIENT_ID="$OSIRIS_MICROSOFT_CLIENT_ID" --from-literal=MICROSOFT_CLIENT_SECRET="$OSIRIS_MICROSOFT_CLIENT_SECRET" \
  --from-literal=SEZNAM_CLIENT_ID="$OSIRIS_SEZNAM_CLIENT_ID" --from-literal=SEZNAM_CLIENT_SECRET="$OSIRIS_SEZNAM_CLIENT_SECRET"
$B create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=richardblaha \
  --docker-password="$GITHUB_API_KEY" --dry-run=client -o yaml | $B apply -f -
```

After changing a secret, restart what uses it: `kubectl -n osiris rollout restart deploy/<service>` (runtimes get new
keys from the operator, which restarts them by itself).

## Rollout

```bash
kubectl apply -k deploy/k8s
kubectl -n osiris rollout status deploy/control deploy/gateway deploy/operator
kubectl -n osiris get projects
```

### From tenants to projects (one-off)

Tenants became projects without moving their data. Before rolling out, delete the old objects by hand (their volumes go with them):

```bash
kubectl delete tenants.osiris.k6labs.cz --all -A
kubectl get ns -o name | grep '^namespace/osiris-t-' | xargs -r kubectl delete
kubectl delete crd tenants.osiris.k6labs.cz
```

Control's migration `011_projects.sql` renames the tables and rewrites users' claims (`tenant` → `project`, `tenant-admin` → `project-admin`), so accounts and sign-in stay. Recreate the projects in System > Projects.

## Checks after a rollout

- Network policies are enforced (the cluster runs Cilium). From a project runtime,
  everything inside the cluster must fail:
  ```bash
  kubectl -n osiris-p-<slug> exec statefulset/runtime -- node -e "fetch('http://gateway.osiris.svc:3001/health').then(r=>console.log('REACHABLE',r.status),e=>console.log('blocked',e.cause?.code))"
  ```
- A sleeping project wakes on a request; `kubectl -n osiris get projects` shows the phase and last activity.
- Backups: `kubectl -n osiris logs deploy/control | grep -i backup`, and the project detail in the web app lists them.

## Operations

- **Restore a project from a backup:** scale its runtime down (`kubectl -n osiris-p-<slug> scale statefulset/runtime --replicas=0`),
  delete its volume (`kubectl -n osiris-p-<slug> delete pvc data-runtime-0`) and wake it: it restores the newest snapshot.
- **Remove a project for good:** archive it in the web app first (claims removed, runtime suspended), then
  `kubectl -n osiris delete project <slug>`: the operator takes a last snapshot and deletes the namespace and volume.
  Backups stay in S3 for `BACKUP_RETENTION_DAYS` (30).
- **Control's database lost entirely:** restore the newest `backups/control/control-<date>.db.gz` from S3 as
  `/data/control.db` on the `control-data` volume (scale control to 0 first, then wake it).
- **Updating:** CI pushes `:main`; `kubectl -n osiris rollout restart deploy/<service>`. To pin a release, set the
  image to `:sha-<commit>` (runtimes: `RUNTIME_IMAGE` of the operator).

### Model assignments and standard accounts

Chat model assignments are system environment settings. Unset role overrides inherit `LLM_MODEL`
(default `mistralai:mistral-small-2603`):

| Variable | Used for |
| --- | --- |
| `LLM_AGENT_MODEL` | First agent step for a user message, including tool selection |
| `LLM_TOOLS_MODEL` | Agent steps after tool results, including further tool selection |
| `LLM_GUARD_MODEL` | Input and final answer rule checks |
| `LLM_PERSONA_MODEL` | Writing assistant personas |
| `EMBEDDING_MODEL` | Knowledge vectors; default `mistralai:mistral-embed` |

Chat specs accept `mistralai:…`, `openai:…`, `anthropic:…`; configure their respective
`MISTRAL_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` in the system environment.
The two agent models must support tool calling. Embeddings support Mistral and OpenAI.
Locally control passes its environment to runtimes. In Kubernetes configure operator
`RUNTIME_ENV_LLM_*` / `RUNTIME_ENV_EMBEDDING_MODEL` and `RUNTIME_SECRET_*_API_KEY`,
then restart runtimes to apply changes. No project or user can override these assignments.

Users connect their own named SMTP/IMAP/POP3, CalDAV and CardDAV accounts in
My profile → Connected accounts. The existing `integrations` feature gates their routes and tools.
Secrets are encrypted with the project key and are never returned by the API. SMTP uses
implicit TLS or mandatory STARTTLS; IMAP and POP3 require implicit TLS. DAV requires
HTTPS and a canonical URL on one origin (redirects and cross-origin discovery are refused).
Use an application password where the provider requires it. POP3 reading uses UIDL ids
and does not delete mail; IMAP reading does not mark messages read. DAV updates require
the ETag returned by reading, so concurrent changes return HTTP 412 instead of being overwritten.
Mail attachments and deletion are not currently exposed. Outgoing SMTP also requires
that the hosting provider permits the selected port (see the Civo SMTP restriction above).


### Account activity, session revocation and GeoIP

Control migration `009_auth_activity.sql` creates user-scoped login events, session metadata and revocation
tombstones. Profile > Aktivita a relace shows up to 100 events from the last 90 days and active OIDC sessions.
Successful sign-ins and failed password/second-factor attempts of known accounts are recorded; unknown
accounts and unidentifiable passkey/social failures are not attached to a user. Metadata is IP, approximate
country/region/city, ASN/provider and parsed browser/OS/device, never passwords, codes or raw User-Agent.
This security history is independent of anonymous website analytics. The cleanup loop physically deletes
records after 90 days; expired events disappear from the API immediately at the retention boundary.

Revocation checks ownership, tombstones the session UID and removes its tokens and grants. Adapter reads and
writes refuse revoked session UIDs, including in-flight token issuance. Gateway token identity caching means
revocation can take up to 60 seconds to affect normal API requests. Session activity writes are throttled to
one per five minutes. Existing sessions without metadata show an unknown location until observed again.

Gateway derives the client IP from its socket and only accepts forwarded headers from `TRUSTED_PROXIES`.
Set this to actual ingress CIDRs; the production default is the cluster's private 10/8 range plus loopback.
For Cloudflare, configure its CIDRs in `CDN_PROXIES`; `CF-Connecting-IP` is used only after verifying the
preceding CDN hop. Control trusts the canonical header supplied by the gateway and must remain private.
GeoIP uses local DB-IP City/ASN databases and monthly updates; see `deploy/observability/web/README.md`
for cache settings and the ClickHouse schema upgrade required before the analytics rollout.


### Interactive PWA and WhatsApp chat

See `deploy/whatsapp/README.md` for durable agent questions/forms, media processing, published Meta Flow
mappings and approved notification templates. Project migration 019 and control migration 010 run at startup.
No live Flow or template is created by deploying these images. Without configured Meta assets, simple choices
use native buttons/lists, questionnaires link to PWA and out-of-window scheduled replies remain in web chat.
Runtime OCR/transcription uses `MISTRAL_API_KEY`, `OCR_MODEL` and `AUDIO_MODEL`; configure them at system level.
