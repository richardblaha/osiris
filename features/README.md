# Osiris DevContainer features

Source for the DevContainer [features](https://containers.dev/implementors/features/)
Osiris injects into project containers.

| Feature | Purpose |
| --- | --- |
| [`web-ide`](src/web-ide) | openvscode-server + an `osiris-web-ide` launcher. The Osiris fallback `devcontainer.json` references it and publishes its port to host loopback (`appPort`), so the `osiris-workspace` remote authority resolver has a server to connect to. |

## Publishing

`.github/workflows/publish-features.yml` runs
[`devcontainers/action`](https://github.com/devcontainers/action) on pushes to
`main` that touch `features/src/**`, publishing each to
`ghcr.io/osiris-ide/osiris/<id>`.

Until first publish, point `EnsureDevContainerInput.webIdeFeatureRef` (or the
`osiris.devcontainer.webIdeFeature` setting) at a local path:

```
--additional-features '{"./features/src/web-ide": {"port": 8000}}'
```

## Testing locally

```bash
devcontainer features test --features web-ide --base-image mcr.microsoft.com/devcontainers/base:ubuntu-24.04
```
