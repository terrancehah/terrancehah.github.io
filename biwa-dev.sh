#!/usr/bin/env bash
# biwa-dev.sh — local development for the Lake Biwa Ride Companion only.
#
# Starts the static site + proxy on :3000 and the isolated Biwa API on
# :8000 (in-memory store — no Redis needed locally). Google keys come from
# the gitignored .env.local; nothing here touches Pacey's config or its
# default dev flow. Ctrl-C stops both servers.
set -euo pipefail
cd "$(dirname "$0")"

# Export every var in .env.local to the child processes.
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a

node proxy-server.js &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT

# Kebab-case module name → load by path; the 3.13 venv carries uvicorn.
BIWA_DEV_ALLOW_MEMORY=1 venv/bin/python -c "
import importlib.util, sys, uvicorn
spec = importlib.util.spec_from_file_location('biwa_dev', 'lib/biwa/biwa-dev.py')
m = importlib.util.module_from_spec(spec); sys.modules['biwa_dev'] = m
spec.loader.exec_module(m)
uvicorn.run(m.app, host='127.0.0.1', port=8000, log_level='warning')
"
