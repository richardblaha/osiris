#!/usr/bin/env bash
# Builds osiris-cli_<version>_amd64.deb: the agent (`osiris`) and the terminal client (`osiris-cli`), with the Node.js that
# runs this script bundled (Debian and Ubuntu ship older ones) and the PWA the agent serves.
#
# Usage:  packaging/deb/build-osiris-deb.sh <version> <out-dir>
#   <version>  a tag's version: 1.2.0, or 1.2.0-rc.1 (becomes 1.2.0~rc.1, sorting before 1.2.0)
# Needs: Node 24 and pnpm (installed workspace), dpkg-deb; builds the PWA itself.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
VERSION="${1:?usage: build-osiris-deb.sh <version> <out-dir>}"
OUT="${2:?usage: build-osiris-deb.sh <version> <out-dir>}"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "needs Node 24 (it is bundled)" >&2; exit 1; }

root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT
lib="$root/usr/lib/osiris"
mkdir -p "$lib" "$root/usr/bin" "$root/DEBIAN" "$OUT"

# The PWA, built without development settings (an .env's VITE_DEV_USER would bypass sign-in).
VITE_DEV_USER= VITE_API_URL= pnpm --filter @osiris/pwa build
cp -r apps/osiris-pwa/dist "$lib/pwa"
# The terminal client with everything it runs, the agent included (production dependencies only).
pnpm --filter @osiris/cli deploy --prod "$lib/app"
rm -f "$lib/app/pnpm-lock.yaml" "$lib/app/pnpm-workspace.yaml"
install -m 0755 "$(command -v node)" "$lib/node"

for cmd in osiris osiris-cli; do
  target=$([ "$cmd" = osiris ] && echo app/node_modules/@osiris/agent/bin/osiris.mjs || echo app/bin/osiris-cli.mjs)
  cat > "$root/usr/bin/$cmd" <<SH
#!/bin/sh
# The agent serves this PWA, also when osiris-cli starts it.
export STATIC_DIR="\${STATIC_DIR:-/usr/lib/osiris/pwa}"
# The agent runs in this release's container image (osiris --no-container runs it as a process).
export OSIRIS_IMAGE="\${OSIRIS_IMAGE:-ghcr.io/richardblaha/osiris-local:${VERSION}}"
exec /usr/lib/osiris/node /usr/lib/osiris/$target "\$@"
SH
  chmod 0755 "$root/usr/bin/$cmd"
done

cat > "$root/DEBIAN/control" <<CTL
Package: osiris-cli
Version: ${VERSION//-/\~}
Architecture: amd64
Maintainer: Richard Bláha <richardblaha@gmail.com>
Depends: libc6 (>= 2.28), libstdc++6, git, ca-certificates
Recommends: docker.io | podman-docker | docker-ce
Section: utils
Priority: optional
Homepage: https://github.com/richardblaha/osiris
Installed-Size: $(du -sk "$root/usr" | cut -f1)
Description: Osiris, the assistant for a project folder
 osiris runs the agent over a project folder (its knowledge, memory, files and
 website in .osiris/) and serves the web app; osiris-cli is the terminal client,
 for a local folder or an Osiris server. Node.js 24 is bundled.
 Model keys: ~/.config/osiris/agent.env (e.g. MISTRAL_API_KEY=...).
CTL

dpkg-deb --root-owner-group -Zxz --build "$root" "$OUT/osiris-cli_${VERSION//-/\~}_amd64.deb"
