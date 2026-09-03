#!/usr/bin/env bash
# =========================================================================
#  RTL TeX Editor launcher  (Linux / macOS)
#
#    ./rtl-tex-editor.sh [folder] [port]
#
#      folder   workspace root to open (default: parent folder of this script)
#      port     HTTP port (default 5199; or set RWE_PORT)
#
#    env:  RWE_PORT   RWE_ENGINE  (xelatex | pdflatex | lualatex)
# =========================================================================
set -euo pipefail

case "${1:-}" in
  -h|--help|/?)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT_IN="${1:-$(dirname "$HERE")}"
PORT="${2:-${RWE_PORT:-5199}}"
ENGINE="${RWE_ENGINE:-xelatex}"

if [ ! -d "$ROOT_IN" ]; then
  echo "[rtl-tex-editor] folder not found: $ROOT_IN" >&2
  exit 1
fi
ROOT="$(cd "$ROOT_IN" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[rtl-tex-editor] Node.js 18+ was not found on PATH." >&2
  exit 1
fi

URL="http://127.0.0.1:${PORT}/"
echo "[rtl-tex-editor] root : $ROOT"
echo "[rtl-tex-editor] url  : $URL"
echo "[rtl-tex-editor] Ctrl+C to stop."

node "$HERE/server.js" --root "$ROOT" --port "$PORT" --engine "$ENGINE" &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT INT TERM

sleep 1.5
if command -v open >/dev/null 2>&1; then
  open "$URL"                 # macOS
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true   # Linux
else
  echo "[rtl-tex-editor] open $URL in your browser."
fi

wait "$SRV"
