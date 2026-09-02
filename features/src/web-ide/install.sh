#!/usr/bin/env bash
# Osiris "web-ide" DevContainer feature — installs openvscode-server + a launcher.
set -euo pipefail

PORT="${PORT:-8000}"
VERSION="${VERSION:-latest}"
INSTALL_DIR=/usr/local/lib/osiris-web-ide

echo "[osiris/web-ide] installing openvscode-server (port ${PORT}, version ${VERSION})"

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y --no-install-recommends curl ca-certificates tar
fi

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) rel_arch="x64" ;;
  aarch64 | arm64) rel_arch="arm64" ;;
  *) echo "[osiris/web-ide] unsupported arch: $arch" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL https://api.github.com/repos/gitpod-io/openvscode-server/releases/latest \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\(openvscode-server-v[^"]*\)"/\1/')"
fi
num="${VERSION#openvscode-server-v}"
url="https://github.com/gitpod-io/openvscode-server/releases/download/${VERSION}/openvscode-server-v${num}-linux-${rel_arch}.tar.gz"

mkdir -p "$INSTALL_DIR"
echo "[osiris/web-ide] downloading $url"
curl -fsSL "$url" | tar -xz --strip-components=1 -C "$INSTALL_DIR"

cat > /usr/local/bin/osiris-web-ide <<EOF
#!/usr/bin/env bash
set -eu
DIR="$INSTALL_DIR"
PORT="\${OSIRIS_WEB_IDE_PORT:-${PORT}}"
case "\${1:-}" in
  start)
    if pgrep -f "openvscode-server .*--port \${PORT}" >/dev/null 2>&1; then
      echo "osiris-web-ide already running on \${PORT}"; exit 0
    fi
    mkdir -p "\${HOME}/.osiris-server"
    nohup "\${DIR}/bin/openvscode-server" \\
      --host 0.0.0.0 --port "\${PORT}" --without-connection-token \\
      --server-data-dir "\${HOME}/.osiris-server" \\
      >/tmp/osiris-web-ide.log 2>&1 &
    echo "osiris-web-ide started on \${PORT}"
    ;;
  stop)
    pkill -f "openvscode-server .*--port \${PORT}" || true
    ;;
  *)
    echo "usage: osiris-web-ide {start|stop}" >&2; exit 1 ;;
esac
EOF
chmod +x /usr/local/bin/osiris-web-ide

echo "[osiris/web-ide] done — 'osiris-web-ide start' launches the server on ${PORT}"
