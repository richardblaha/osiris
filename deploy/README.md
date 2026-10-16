# Deployment

Osiris runs in the `abydos` k3s cluster (Civo) at https://osiris.k6labs.cz, in the `osiris` namespace.

- **Image:** GitHub Actions (`.github/workflows/ci.yml`) runs the tests and, on `main`, pushes `ghcr.io/richardblaha/osiris` with the tags `main` and `sha-<commit>`. The image runs the API, which also serves the built web client.
- **Storage:** tenant databases are SQLite files on the `osiris-data` PVC (`/data/tenants`). The volume is ReadWriteOnce, so the deployment runs one replica with the `Recreate` strategy.
- **TLS:** cert-manager (`letsencrypt` ClusterIssuer). Traefik redirects HTTP to HTTPS.

Commands below use `KUBECONFIG=.kubeconfig` and read keys from the gitignored root `.env`.

## PocketID (auth.k6labs.cz)

1. Create an OIDC client named `Osiris`:
   - type **public client** (PKCE)
   - callback URL `https://osiris.k6labs.cz/callback`
   - logout callback URL `https://osiris.k6labs.cz`

   Put its client ID in `.env` as `OSIRIS_OIDC_CLIENT_ID`.
2. Create the group `osiris-admin` and add yourself. Its members manage tenants in the web app (Správa → Tenanti): creating a tenant creates the groups `osiris-tenant-<slug>` (members) and `osiris-tenant-<slug>-admin` (admins), and members are added there too. Users without a tenant group get "not assigned to any tenant".
3. Optional: give each user the custom claim `phone_number` in `+420…` format.

4. Create an API key (Settings → API keys) and put it in `.env` as `POCKETID_API_KEY`. The API needs it in production: tenants are PocketID groups.

`OSIRIS_SECRETS_KEY` (`openssl rand -base64 32`) encrypts the MCP server headers in the tenant databases. If it is lost or changed, stored headers can no longer be read and have to be re-entered.

## WhatsApp

One webhook serves all tenants: `https://osiris.k6labs.cz/webhooks/whatsapp`. The sender's number is matched to the PocketID custom claim `phone_number` (digits are compared, so `+420 777 123 456` works). Users in several tenants pick one with `/tenant <slug>` in the chat, and `/nova` starts a new conversation.

1. In the Meta app (WhatsApp → Configuration → Webhook):
   - callback URL `https://osiris.k6labs.cz/webhooks/whatsapp`
   - verify token: a random string (`openssl rand -hex 16`), in `.env` as `OSIRIS_WHATSAPP_VERIFY_TOKEN`
   - subscribe to the `messages` field
2. Put the app secret (App settings → Basic) in `.env` as `OSIRIS_WHATSAPP_APP_SECRET`, and a permanent System User token with `whatsapp_business_messaging` as `OSIRIS_WHATSAPP_ACCESS_TOKEN`.
3. Add the three values to the `osiris-env` secret (see below) and restart the deployment **before** saving the webhook in Meta. Until they are set, the URL answers 404 and Meta's verification fails.

## First deploy

```bash
set -a; . ./.env; set +a
kubectl apply -f deploy/k8s/namespace.yaml

# Pull access to the private GHCR image. Use a token with read:packages only.
kubectl -n osiris create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=richardblaha --docker-password="$GITHUB_API_KEY"

kubectl -n osiris create secret generic osiris-env \
  --from-literal=MISTRAL_API_KEY="$MISTRAL_API_KEY" \
  --from-literal=OIDC_AUDIENCE="$OSIRIS_OIDC_CLIENT_ID" \
  --from-literal=SECRETS_KEY="$OSIRIS_SECRETS_KEY" \
  --from-literal=POCKETID_API_KEY="$POCKETID_API_KEY" \
  --from-literal=WHATSAPP_VERIFY_TOKEN="$OSIRIS_WHATSAPP_VERIFY_TOKEN" \
  --from-literal=WHATSAPP_APP_SECRET="$OSIRIS_WHATSAPP_APP_SECRET" \
  --from-literal=WHATSAPP_ACCESS_TOKEN="$OSIRIS_WHATSAPP_ACCESS_TOKEN"

kubectl apply -k deploy/k8s
```

To change a secret, add `--dry-run=client -o yaml | kubectl apply -f -` to the `create secret` command, then run `kubectl -n osiris rollout restart deploy/osiris`.

## Updating

The deployment follows the `main` tag with `imagePullPolicy: Always`. After CI has pushed a new image:

```bash
kubectl -n osiris rollout restart deploy/osiris
kubectl -n osiris rollout status deploy/osiris
```

To pin a release, run `kubectl -n osiris set image deploy/osiris osiris=ghcr.io/richardblaha/osiris:sha-<commit>`.

## Backups

The tenant databases live only on the PVC (Civo volume). Snapshot the volume or copy `/data/tenants` out (`kubectl cp`) before risky changes.
