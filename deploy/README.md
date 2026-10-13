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
2. Assign tenants with groups. `tenant-<slug>` makes a user a member. `tenant-<slug>-admin` makes them an admin. Users without a tenant group get "not assigned to any tenant".
3. Optional: give each user the custom claim `phone_number` in `+420…` format.

## First deploy

```bash
set -a; . ./.env; set +a
kubectl apply -f deploy/k8s/namespace.yaml

# Pull access to the private GHCR image. Use a token with read:packages only.
kubectl -n osiris create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=richardblaha --docker-password="$GITHUB_API_KEY"

kubectl -n osiris create secret generic osiris-env \
  --from-literal=MISTRAL_API_KEY="$MISTRAL_API_KEY" \
  --from-literal=OIDC_AUDIENCE="$OSIRIS_OIDC_CLIENT_ID"

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
