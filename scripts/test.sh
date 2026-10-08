#!/usr/bin/env bash
# Run everything. The JS tests that play real games need a local Showdown
# server; they're skipped with a note if one isn't up.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0

echo "=== python: set data vs the simulator ==="
./.venv/bin/python -m pytest tests/ -q || fail=1

echo
echo "=== browser data layer vs the same fixture ==="
node tests/js/check_data_layer.mjs || fail=1

echo
echo "=== Choice Scarf detection ==="
node tests/js/check_scarf_detection.mjs || fail=1

echo
echo "=== state reader against real games ==="
if curl -sS --max-time 4 -o /dev/null "http://localhost:8111/" 2>/dev/null; then
  node tests/js/check_state_reader.mjs "${GAMES:-16}" || fail=1
else
  echo "  skipped — no Showdown server on :8111"
  echo "  start one with: scripts/local_server.sh"
fi

echo
[ "$fail" = 0 ] && echo "ALL GREEN" || echo "FAILURES ABOVE"
exit "$fail"
