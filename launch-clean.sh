#!/usr/bin/env bash
# Launch the pug race in a Chrome window with browser extensions disabled.
#
# A web page cannot switch extensions off — that is a browser security
# boundary. The browser launcher can, so that is where this happens.
#
#   ./launch-clean.sh                     # offline single file, no extensions
#   ./launch-clean.sh --live              # connect to the watch server (operator)
#   ./launch-clean.sh --live --watch      # open as a participant would see it
#   ./launch-clean.sh --with-claude       # allow only the Claude extension
#   ./launch-clean.sh --live --port 9000  # non-default port
#
# Flags compose, e.g.  ./launch-clean.sh --live --with-claude
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8731
LIVE=0
WATCH=0
WITH_CLAUDE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --live)        LIVE=1 ;;
    --watch)       WATCH=1; LIVE=1 ;;
    --with-claude) WITH_CLAUDE=1 ;;
    --port)        PORT="${2:?--port needs a value}"; shift ;;
    -h|--help)     sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1  (try --help)" >&2; exit 1 ;;
  esac
  shift
done

# The Claude for Chrome extension (only used with --with-claude). Set
# CLAUDE_EXT to its unpacked directory, or let this find the newest installed
# version in any local Chrome profile.
CLAUDE_EXT_ID="fcoeoabgfenejglbffodgkkbkcdhcgfn"
if [ -z "${CLAUDE_EXT:-}" ]; then
  CLAUDE_EXT="$(ls -d "$HOME"/.config/google-chrome/*/Extensions/"$CLAUDE_EXT_ID"/*/ 2>/dev/null | sort -V | tail -1)"
  CLAUDE_EXT="${CLAUDE_EXT%/}"
fi

CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  command -v "$c" >/dev/null 2>&1 && { CHROME="$c"; break; }
done
[ -z "$CHROME" ] && { echo "No Chrome/Chromium found on PATH." >&2; exit 1; }

# ---- work out which URL to open ----
if [ "$LIVE" -eq 1 ]; then
  if ! curl -sf -m 3 "http://localhost:$PORT/api/time" >/dev/null; then
    echo "No watch server on port $PORT." >&2
    echo "Start it first, in another terminal:  ./run-race.sh" >&2
    exit 1
  fi
  if [ "$WATCH" -eq 1 ]; then
    PAGE="http://localhost:$PORT/watch"
    echo "Opening the PARTICIPANT view (read-only)."
  else
    PAGE="http://localhost:$PORT/"
    echo "Opening the HOST page. Enter the host password to run races"
    echo "(nothing secret in the address bar — safe to screen-share)."
  fi
else
  PAGE="file://$HERE/index.html"
  echo "Opening the offline single-file version (no server)."
fi

# A throwaway profile guarantees the flags apply. Chrome ignores command-line
# flags when it reuses an already-running instance of the same profile, which
# silently defeats the whole point.
PROFILE="$(mktemp -d /tmp/pug-race-profile.XXXXXX)"
trap 'rm -rf "$PROFILE"' EXIT

COMMON=(
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
  --disable-background-networking
  --disable-sync
  --new-window
)

if [ "$WITH_CLAUDE" -eq 1 ]; then
  if [ ! -d "$CLAUDE_EXT" ]; then
    echo "Claude extension not found at:" >&2
    echo "  $CLAUDE_EXT" >&2
    echo "Set CLAUDE_EXT to the extension's directory, or drop --with-claude." >&2
    exit 1
  fi
  echo "Extensions: ONLY Claude enabled (one extension can still touch the page)."
  "$CHROME" "${COMMON[@]}" \
    --disable-extensions-except="$CLAUDE_EXT" \
    --load-extension="$CLAUDE_EXT" \
    "$PAGE" &
else
  echo "Extensions: ALL disabled."
  "$CHROME" "${COMMON[@]}" --disable-extensions "$PAGE" &
fi

echo
echo "Page: $PAGE"
echo "Throwaway profile: $PROFILE  (deleted when this script exits)"
echo
echo "Check the badge in the top-right reads 'self-check passed' before"
echo "starting a race. (It's a tripwire, not proof: viewers should still"
echo "verify the receipt themselves.)"
echo
echo "Press Ctrl-C when the race session is over."
wait
