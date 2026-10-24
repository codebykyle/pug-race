#!/usr/bin/env bash
# Expose the running watch server to the public internet, on demand.
#
# Run ./run-race.sh first (or node server.js), then run this in a second
# terminal when you actually want a public link. Nothing is exposed until
# you run this, and everything closes the moment you press Ctrl-C.
#
#   ./share-public.sh [port]
#
set -euo pipefail

PORT="${1:-8731}"
BIN_DIR="$HOME/.local/bin"
CF="$(command -v cloudflared || echo "$BIN_DIR/cloudflared")"

if [ ! -x "$CF" ]; then
  echo "cloudflared is not installed."
  echo
  echo "It creates a temporary public HTTPS URL that forwards to your local"
  echo "server. No account and no signup for the quick-tunnel mode used here."
  echo
  read -r -p "Download it to $BIN_DIR now? [y/N] " ok
  case "$ok" in
    [yY]*) ;;
    *) echo "Aborted. Your server is still reachable on your local network."; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p "$BIN_DIR"
  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
  echo "Downloading $URL"
  curl -fL --progress-bar "$URL" -o "$BIN_DIR/cloudflared"
  chmod +x "$BIN_DIR/cloudflared"
  CF="$BIN_DIR/cloudflared"
  echo "Installed to $CF"
  echo
fi

if ! curl -sf -m 3 "http://localhost:$PORT/api/time" >/dev/null; then
  echo "Nothing is listening on port $PORT." >&2
  echo "Start the race server first:  ./run-race.sh" >&2
  exit 1
fi

cat <<BANNER

  Opening a PUBLIC tunnel to localhost:$PORT
  ------------------------------------------------------
  While this runs, anyone with the URL can reach the page.
  The watch link is read-only: starting a race needs the
  operator key, which stays on your machine and is never
  sent to viewers.

  Give participants the URL below with /watch on the end:
      https://<name>.trycloudflare.com/watch

  Press Ctrl-C to close the tunnel.
  ------------------------------------------------------

BANNER

exec "$CF" tunnel --url "http://localhost:$PORT"
