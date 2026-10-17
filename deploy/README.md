# Deployment

Osiris runs in the `abydos` k3s cluster (Civo) at https://osiris.k6labs.cz. Shared services live in the `osiris`
namespace; each tenant gets its own namespace `osiris-t-<slug>`, created by the operator.

```
Internet ─ Traefik ─┬─ osiris.k6labs.cz ──▶ gateway ──┬─▶ control ──▶ rqlite (3 nodes) ─▶ S3 (rqlite backups)
                    │                                 │      │  └──▶ PocketID admin API, WhatsApp, S3 (sites, backups)
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

Commands below use `KUBECONFIG=.kubeconfig` and read keys from the gitignored root `.env`.

## PocketID (auth.k6labs.cz)

1. Create an OIDC client named `Osiris`: **public client** (PKCE), callback URL `https://osiris.k6labs.cz/callback`,
   logout callback URL `https://osiris.k6labs.cz`. Put its client ID in `.env` as `OSIRIS_OIDC_CLIENT_ID`.
2. Give yourself the custom claim `role` = `osiris-admin`. System admins create tenants and add people in the web app
   (Tenanti); tenant admins add people to their own tenant (tenant info → Lidé v tenantovi). New people are created in
   PocketID and get a one-time sign-in link. Membership is stored as custom claims: `tenant` / `tenant-admin` = `<slug>`
   (comma-separated for several) plus `role` = `osiris-user`.
3. Create an API key (Settings → API keys) and put it in `.env` as `POCKETID_API_KEY`. Only control holds it.

Users verify their phone number for WhatsApp themselves (Můj profil → Telefon): they send `OVERENI <code>` from the phone
to the business number, which sets the claim `phone_number`.

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

## Object storage (Civo)

Create an object store and a bucket (`osiris`), and credentials for it. Put into `.env`: `OSIRIS_S3_ENDPOINT`
(e.g. `https://objectstore.fra1.civo.com`), `OSIRIS_S3_REGION`, `OSIRIS_S3_BUCKET`, `OSIRIS_S3_ACCESS_KEY_ID`,
`OSIRIS_S3_SECRET_ACCESS_KEY`. Prefixes: `sites/` (published sites), `backups/` (tenant snapshots), `rqlite/` (central DB).

## Secrets

Generate the internal keys once and keep them in `.env` (losing `SECRETS_MASTER_KEY` makes tenants' stored secrets
unreadable; changing the JWT keys only needs a restart of all services):

```bash
pnpm --filter @osiris/platform gen-keys   # → OSIRIS_INTERNAL_JWT_PRIVATE_KEY, OSIRIS_INTERNAL_JWT_PUBLIC_KEY, OSIRIS_SECRETS_MASTER_KEY
                                          #   (put the two PEM values in single quotes in .env: they contain spaces)
openssl rand -hex 24                      # → OSIRIS_RQLITE_CONTROL_PASSWORD, OSIRIS_RQLITE_SITES_PASSWORD, OSIRIS_RQLITE_NODE_PASSWORD
```

```bash
set -a; . ./.env; set +a
K="kubectl -n osiris"
apply() { $K create secret generic "$@" --dry-run=client -o yaml | $K apply -f -; }
key() { printf '%s' "$1" | sed 's/\\n/\n/g'; }   # .env keeps PEM keys on one line

apply osiris-gateway --from-literal=OIDC_AUDIENCE="$OSIRIS_OIDC_CLIENT_ID" \
  --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")"

apply osiris-control \
  --from-literal=INTERNAL_JWT_PRIVATE_KEY="$(key "$OSIRIS_INTERNAL_JWT_PRIVATE_KEY")" \
  --from-literal=INTERNAL_JWT_PUBLIC_KEY="$(key "$OSIRIS_INTERNAL_JWT_PUBLIC_KEY")" \
  --from-literal=POCKETID_API_KEY="$POCKETID_API_KEY" \
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
  --from-literal=RUNTIME_SECRET_MISTRAL_API_KEY="$MISTRAL_API_KEY"

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
   Keep the `osiris-data` volume until you're sure; it is the fallback (`kubectl -n osiris scale deploy/osiris --replicas=1`
   with the previous manifests restores the old setup).

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
