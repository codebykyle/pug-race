#!/usr/bin/env bash
# Start the pug race watch server and print both links.
#
#   ./run-race.sh [port]
#
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8731}"

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

if curl -sf -m 2 "http://localhost:$PORT/api/time" >/dev/null 2>&1; then
  echo "Port $PORT is already serving. Stop it first, or pass another port." >&2
  exit 1
fi

exec node "$HERE/server.js" "$PORT"
