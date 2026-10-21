# Deployment

Osiris runs in the `abydos` k3s cluster (Civo) at https://osiris.k6labs.cz. Shared services live in the `osiris`
namespace; each tenant gets its own namespace `osiris-t-<slug>`, created by the operator.

```
Internet ─ Traefik ─┬─ osiris.k6labs.cz ──▶ gateway ──┬─▶ control ──▶ rqlite (3 nodes) ─▶ S3 (rqlite backups)
                    │                                 │      │  └──▶ WhatsApp, S3, Emailit, Google/Facebook/Microsoft/Seznam (sign-in)
                    │                                 │      └──▶ Tenant objects ◀── operator ──▶ tenant namespaces
                    │                                 └─▶ runtime (osiris-t-<slug>, 0–1 pod, own volume) ─▶ gotenberg
                    └─ tenant domains ──▶ sites ──▶ rqlite (read-only user), S3
```

- **Images:** GitHub Actions (`.github/workflows/ci.yml`) runs the tests and, on `main`, pushes one image per service:
  `ghcr.io/richardblaha/osiris-{gateway,control,runtime,operator,sites}` with the tags `main` and `sha-<commit>`.
  Runtimes pull `:main` whenever they wake, so a new runtime version reaches a tenant on its next wake-up.
- **Tenants sleep:** a runtime idle for `idleMinutes` (30 by default, 0 = always on) is snapshotted to S3 and scaled to
  zero; the next request, WhatsApp message or scheduled task wakes it (the gateway waits for it, usually 10–30 s).
- **Data:** tenant database and files on the tenant's volume (`civo-volume`), snapshots in S3 (before every sleep and
  daily); the central database in rqlite with automatic backups to S3.
- **TLS:** cert-manager (`letsencrypt` ClusterIssuer); tenant domains get their certificates through HTTP-01.
- **Sign-in:** control is the OpenID Connect provider at `https://osiris.k6labs.cz/auth` (the gateway passes `/auth` to
  it). PocketID at auth.k6labs.cz stays for other services; Osiris no longer uses it.

Commands below use `KUBECONFIG=.kubeconfig` and read keys from the gitignored root `.env`.

## Sign-in

Users sign in on `https://osiris.k6labs.cz/login` with a passkey, email and password, Google, Facebook, Microsoft or Seznam,
or a one-time link; an authenticator app (TOTP) is an optional second factor after a password or social sign-in.
Users, credentials and the provider's sessions and tokens live in rqlite (tables `users`, `passkeys`,
`user_identities`, `recovery_codes`, `login_links`, `auth_challenges`, `oidc_store`).

- **Keys:** `gen-keys` (below) prints `AUTH_SIGNING_KEY` (signs ID tokens; changing it signs everyone out) and
  `AUTH_SECRET` (signs the provider's cookies and seals TOTP secrets; changing it signs everyone out and turns off
  everyone's authenticator app). Keep both in `.env` as `OSIRIS_AUTH_SIGNING_KEY` and `OSIRIS_AUTH_SECRET`.
- **Email** (sign-in links, "forgot password"; without it the login screen doesn't offer them): Civo blocks outgoing
  SMTP (ports 25, 465 and 587 time out from the cluster), so production sends through Emailit's HTTP API: `.env`
  `EMAILIT_API_KEY` (a sending key), with `k6labs.cz` verified at Emailit (SPF, DKIM, DMARC) and the sender `MAIL_FROM`
  in `control.yaml`. `SMTP_URL` (`smtps://user:password@host:465`) still works where SMTP isn't blocked.
- **Social sign-in** (each optional, on when its ID and secret are set). Redirect URIs are
  `https://osiris.k6labs.cz/auth/social/<google|facebook|microsoft|seznam>/callback`:
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
  Microsoft doesn't verify emails and a Seznam account can carry an outside address, so those must be linked in
  Můj profil → Přihlášení a zabezpečení first.
- **People:** the first system admin comes from the command line:
  `kubectl -n osiris exec deploy/control -- node_modules/.bin/tsx src/auth/users-cli.ts add-admin you@example.cz Jméno Příjmení`
  prints a one-time sign-in link. System admins create tenants and add people in the web app (Tenanti); tenant admins
  add people to their own tenant (tenant info → Lidé v tenantovi). New people get a one-time sign-in link (3 days) and
  set up a passkey or password in their profile. Membership is stored in the user's claims: `tenant` / `tenant-admin`
  = `<slug>` (comma-separated for several) plus `role` = `osiris-user`.
- **Lost second factor:** a system admin turns it off in the tenant detail (Vypnout 2FA next to the person).

Users verify their phone number for WhatsApp themselves (Můj profil → Telefon): they send `OVERENI <code>` from the phone
to the business number, which sets the claim `phone_number`.

### From PocketID (one-off)

1. Roll out the new images with the secrets below (`AUTH_*`, `EMAILIT_API_KEY`, social keys).
2. Copy the users, keeping their ids (tenant data is keyed by them), names, emails and claims:
   ```bash
   kubectl -n osiris exec deploy/control -- env POCKETID_URL=http://pocket-id.pocket-id.svc.cluster.local:1411 POCKETID_API_KEY="$POCKETID_API_KEY" \
     node_modules/.bin/tsx src/auth/users-cli.ts import-pocketid --links
   ```
   Passkeys can't move (they belong to auth.k6labs.cz), so people sign in once with Google/Facebook, a link by email
   ("Zapomněl(a) jsem heslo") or the printed 72-hour link, and add a new passkey in their profile. Running it again
   skips users already imported.
3. Remove the Osiris client and API key in PocketID.

## WhatsApp

The webhook is `https://osiris.k6labs.cz/webhooks/whatsapp` (the gateway passes it to control, which checks Meta's
signature, stores the message and answers at once; a worker runs it in the sender's tenant).

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
(`@osiris/platform/telemetry.ts`; the manifests set it), so their pod logs are not collected a second time. System
admins read it all in Osiris: System > Logy, Metriky, Trasy (control queries ClickHouse as the read-only user `osiris`;
the NetworkPolicy lets only the collector write and control read).

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

## Users' Google and Microsoft accounts

Users connect their own Google or Microsoft account in Můj profil → Propojené účty; the assistant then reads and sends
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

## Object storage (Civo)

Create an object store and a bucket (`osiris`), and credentials for it. Put into `.env`: `OSIRIS_S3_ENDPOINT`
(e.g. `https://objectstore.fra1.civo.com`), `OSIRIS_S3_REGION`, `OSIRIS_S3_BUCKET`, `OSIRIS_S3_ACCESS_KEY_ID`,
`OSIRIS_S3_SECRET_ACCESS_KEY`. Prefixes: `sites/` (published sites), `backups/` (tenant snapshots), `rqlite/` (central DB).

## Secrets

Generate the internal keys once and keep them in `.env` (losing `SECRETS_MASTER_KEY` makes tenants' stored secrets
unreadable; changing the JWT keys only needs a restart of all services):

```bash
pnpm --filter @osiris/platform gen-keys   # → OSIRIS_INTERNAL_JWT_PRIVATE_KEY, OSIRIS_INTERNAL_JWT_PUBLIC_KEY, OSIRIS_SECRETS_MASTER_KEY,
                                          #   OSIRIS_AUTH_SIGNING_KEY, OSIRIS_AUTH_SECRET
                                          #   (put the PEM values in single quotes in .env: they contain spaces)
openssl rand -hex 24                      # → OSIRIS_RQLITE_CONTROL_PASSWORD, OSIRIS_RQLITE_SITES_PASSWORD, OSIRIS_RQLITE_NODE_PASSWORD
```

```bash
set -a; . ./.env; set +a
K="kubectl -n osiris"
apply() { $K create secret generic "$@" --dry-run=client -o yaml | $K apply -f -; }
key() { printf '%s' "$1" | sed 's/\\n/\n/g'; }   # .env keeps PEM keys on one line

apply osiris-gateway --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")"

apply osiris-control \
  --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")" \
  --from-literal=INTERNAL_JWT_PUBLIC_KEY="$(key "$OSIRIS_INTERNAL_JWT_PUBLIC_KEY")" \
  --from-literal=AUTH_SIGNING_KEY="$(key "$OSIRIS_AUTH_SIGNING_KEY")" --from-literal=AUTH_SECRET="$OSIRIS_AUTH_SECRET" \
  --from-literal=EMAILIT_API_KEY="$EMAILIT_API_KEY" \
  --from-literal=GOOGLE_CLIENT_ID="$OSIRIS_GOOGLE_CLIENT_ID" --from-literal=GOOGLE_CLIENT_SECRET="$OSIRIS_GOOGLE_CLIENT_SECRET" \
  --from-literal=FACEBOOK_CLIENT_ID="$OSIRIS_FACEBOOK_CLIENT_ID" --from-literal=FACEBOOK_CLIENT_SECRET="$OSIRIS_FACEBOOK_CLIENT_SECRET" \
  --from-literal=MICROSOFT_CLIENT_ID="$OSIRIS_MICROSOFT_CLIENT_ID" --from-literal=MICROSOFT_CLIENT_SECRET="$OSIRIS_MICROSOFT_CLIENT_SECRET" \
  --from-literal=SEZNAM_CLIENT_ID="$OSIRIS_SEZNAM_CLIENT_ID" --from-literal=SEZNAM_CLIENT_SECRET="$OSIRIS_SEZNAM_CLIENT_SECRET" \
  --from-literal=RQLITE_USERNAME=control --from-literal=RQLITE_PASSWORD="$OSIRIS_RQLITE_CONTROL_PASSWORD" \
  --from-literal=S3_ENDPOINT="$OSIRIS_S3_ENDPOINT" --from-literal=S3_REGION="$OSIRIS_S3_REGION" --from-literal=S3_BUCKET="$OSIRIS_S3_BUCKET" \
  --from-literal=S3_ACCESS_KEY_ID="$OSIRIS_S3_ACCESS_KEY_ID" --from-literal=S3_SECRET_ACCESS_KEY="$OSIRIS_S3_SECRET_ACCESS_KEY" \
  --from-literal=WHATSAPP_VERIFY_TOKEN="$OSIRIS_WHATSAPP_VERIFY_TOKEN" --from-literal=WHATSAPP_APP_SECRET="$OSIRIS_WHATSAPP_APP_SECRET" \
  --from-literal=WHATSAPP_ACCESS_TOKEN="$OSIRIS_WHATSAPP_ACCESS_TOKEN" --from-literal=WHATSAPP_DISPLAY_NUMBER="$OSIRIS_WHATSAPP_DISPLAY_NUMBER" \
  --from-literal=SITES_INGRESS_IPS="$(kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[*].ip}')"

apply osiris-operator \
  --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")" \
  --from-literal=INTERNAL_JWT_PUBLIC_KEY="$(key "$OSIRIS_INTERNAL_JWT_PUBLIC_KEY")" \
  --from-literal=SECRETS_MASTER_KEY="$OSIRIS_SECRETS_MASTER_KEY" \
  --from-literal=RUNTIME_SECRET_MISTRAL_API_KEY="$MISTRAL_API_KEY" \
  --from-literal=RUNTIME_SECRET_GOOGLE_INTEGRATION_CLIENT_ID="$OSIRIS_GOOGLE_INTEGRATION_CLIENT_ID" \
  --from-literal=RUNTIME_SECRET_GOOGLE_INTEGRATION_CLIENT_SECRET="$OSIRIS_GOOGLE_INTEGRATION_CLIENT_SECRET" \
  --from-literal=RUNTIME_SECRET_MICROSOFT_INTEGRATION_CLIENT_ID="$OSIRIS_MICROSOFT_INTEGRATION_CLIENT_ID" \
  --from-literal=RUNTIME_SECRET_MICROSOFT_INTEGRATION_CLIENT_SECRET="$OSIRIS_MICROSOFT_INTEGRATION_CLIENT_SECRET"

apply osiris-sites --from-literal=RQLITE_USERNAME=sites --from-literal=RQLITE_PASSWORD="$OSIRIS_RQLITE_SITES_PASSWORD" \
  --from-literal=S3_ENDPOINT="$OSIRIS_S3_ENDPOINT" --from-literal=S3_REGION="$OSIRIS_S3_REGION" --from-literal=S3_BUCKET="$OSIRIS_S3_BUCKET" \
  --from-literal=S3_ACCESS_KEY_ID="$OSIRIS_S3_ACCESS_KEY_ID" --from-literal=S3_SECRET_ACCESS_KEY="$OSIRIS_S3_SECRET_ACCESS_KEY"

# rqlite: users and permissions (control all, sites read-only, nodes join), automatic backup to S3 every 5 minutes.
apply rqlite-config \
  --from-literal=users.json="[{\"username\":\"control\",\"password\":\"$OSIRIS_RQLITE_CONTROL_PASSWORD\",\"perms\":[\"all\"]},{\"username\":\"sites\",\"password\":\"$OSIRIS_RQLITE_SITES_PASSWORD\",\"perms\":[\"query\"]},{\"username\":\"node\",\"password\":\"$OSIRIS_RQLITE_NODE_PASSWORD\",\"perms\":[\"join\",\"remove\"]},{\"username\":\"*\",\"perms\":[\"status\",\"ready\"]}]" \
  --from-literal=backup.json="{\"version\":1,\"type\":\"s3\",\"interval\":\"5m\",\"vacuum\":false,\"sub\":{\"access_key_id\":\"\$S3_ACCESS_KEY_ID\",\"secret_access_key\":\"\$S3_SECRET_ACCESS_KEY\",\"endpoint\":\"$OSIRIS_S3_ENDPOINT\",\"region\":\"$OSIRIS_S3_REGION\",\"bucket\":\"$OSIRIS_S3_BUCKET\",\"path\":\"rqlite/osiris.sqlite3.gz\",\"force_path_style\":true}}" \
  --from-literal=S3_ACCESS_KEY_ID="$OSIRIS_S3_ACCESS_KEY_ID" --from-literal=S3_SECRET_ACCESS_KEY="$OSIRIS_S3_SECRET_ACCESS_KEY"
# (Nodes join as `node`; rqlite takes its password from users.json.)

# Pull access to the private images (read:packages only); the operator copies it into tenant namespaces.
$K create secret docker-registry ghcr-pull --docker-server=ghcr.io --docker-username=richardblaha \
  --docker-password="$GITHUB_API_KEY" --dry-run=client -o yaml | $K apply -f -
```

After changing a secret, restart what uses it: `kubectl -n osiris rollout restart deploy/<service>` (runtimes get new
keys from the operator, which restarts them by itself).

## Rollout

```bash
kubectl apply -k deploy/k8s
kubectl -n osiris rollout status statefulset/rqlite
kubectl -n osiris rollout status deploy/control deploy/gateway deploy/operator deploy/sites
kubectl -n osiris get tenants
```

### From the monolith (one-off)

1. Push to `main` and wait for CI to publish the five images.
2. Create the secrets above, plus the import's own:
   `apply osiris-legacy-import --from-literal=LEGACY_SECRETS_KEY="$OSIRIS_SECRETS_KEY" --from-literal=SECRETS_MASTER_KEY="$OSIRIS_SECRETS_MASTER_KEY"`.
3. `kubectl apply -k deploy/k8s` (rqlite, control, gateway, operator, sites; the ingress now points at the gateway).
4. Stop the monolith and import its data:
   ```bash
   kubectl -n osiris scale deploy/osiris --replicas=0
   kubectl -n osiris apply -f deploy/k8s/legacy-import-job.yaml
   kubectl -n osiris logs -f job/legacy-import
   ```
   Every tenant gets its row in rqlite, a `Tenant` object, and an `import` backup that its runtime restores on first
   wake.
5. Check a tenant end to end (login, chat, files), then remove the monolith: `kubectl -n osiris delete deploy/osiris svc/osiris`.

   Done on 2026-10-17; the monolith's volume (`osiris-data`) and its manifests were removed on 2026-10-20, so this
   section only documents how tenants got here (`legacy-import-job.yaml` is in git history).

Volumes of sleeping tenants show as detached in the Civo dashboard (named `pvc-…`): they hold the tenants' data.
Before deleting a volume there, check that no PV points to it
(`kubectl get pv -o custom-columns=PV:.metadata.name,CIVO_ID:.spec.csi.volumeHandle,NS:.spec.claimRef.namespace`).
A tenant whose volume is gone comes back from its newest snapshot: delete its PVC `data-runtime-0` (and the PV, once
the volume no longer exists) and the next start restores it.

## Checks after a rollout

- Network policies are enforced (the cluster runs Cilium). From a tenant runtime,
  everything inside the cluster must fail:
  ```bash
  kubectl -n osiris-t-<slug> exec statefulset/runtime -- node -e "fetch('http://rqlite.osiris.svc:4001/status').then(r=>console.log('REACHABLE',r.status),e=>console.log('blocked',e.cause?.code))"
  ```
- A sleeping tenant wakes on a request; `kubectl -n osiris get tenants` shows the phase and last activity.
- Backups: `kubectl -n osiris logs deploy/control | grep -i backup`, and the tenant detail in the web app lists them.

## Operations

- **Restore a tenant from a backup:** scale its runtime down (`kubectl -n osiris-t-<slug> scale statefulset/runtime --replicas=0`),
  delete its volume (`kubectl -n osiris-t-<slug> delete pvc data-runtime-0`) and wake it: it restores the newest snapshot.
- **Remove a tenant for good:** archive it in the web app first (claims removed, runtime suspended), then
  `kubectl -n osiris delete tenant <slug>`: the operator takes a last snapshot and deletes the namespace and volume.
  Backups stay in S3 for `BACKUP_RETENTION_DAYS` (30).
- **rqlite lost entirely:** restore the newest `rqlite/osiris.sqlite3.gz` from S3 (`rqlite` CLI `.restore`, see rqlite docs).
- **Updating:** CI pushes `:main`; `kubectl -n osiris rollout restart deploy/<service>`. To pin a release, set the
  image to `:sha-<commit>` (runtimes: `RUNTIME_IMAGE` of the operator).
