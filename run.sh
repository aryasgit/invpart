#!/usr/bin/env bash
# INVPART — launch the local server.
#   ./run.sh             # uses ./vault for data, port 8766
#   ./run.sh /path       # custom vault root
#   PORT=9000 ./run.sh   # custom port

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PORT="${PORT:-8766}"
HOST="${HOST:-0.0.0.0}"
VAULT="${1:-$HERE/vault}"

if [ ! -d ".venv" ]; then
  echo "[invpart] creating virtualenv .venv"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [ ! -f ".venv/.installed" ] || [ "server/requirements.txt" -nt ".venv/.installed" ]; then
  echo "[invpart] installing dependencies"
  pip install --quiet --upgrade pip
  pip install --quiet -r server/requirements.txt
  touch .venv/.installed
fi

mkdir -p "$VAULT/parts" "$VAULT/events" "$VAULT/assets"
export INVPART_VAULT="$VAULT"

echo
echo "  ┌─────────────────────────────────────────"
echo "  │  INVPART"
echo "  │  vault:  $VAULT"
echo "  │  open:   http://localhost:$PORT"
echo "  │  LAN:    http://$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '<your-ip>'):$PORT"
echo "  └─────────────────────────────────────────"
echo

exec uvicorn server.main:app --host "$HOST" --port "$PORT" --reload
