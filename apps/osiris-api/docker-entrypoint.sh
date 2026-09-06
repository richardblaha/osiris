#!/bin/sh
set -e

# The console API drives a workspace's Git-backed backlog, so /workspace must be
# a repo. If a bind-mounted project isn't one yet, initialise it (harmless — it
# only creates .git and an initial commit).
if [ -d /workspace ] && [ ! -d /workspace/.git ]; then
  echo "osiris-server: initialising /workspace as a git repository"
  git -C /workspace init -q -b main
  [ -f /workspace/README.md ] || echo "# Osiris workspace" > /workspace/README.md
  git -C /workspace add -A
  git -C /workspace commit -q -m "chore: osiris-server workspace init" || true
fi

exec node dist/index.js
