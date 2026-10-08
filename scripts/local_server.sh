#!/usr/bin/env bash
# Run a Showdown server locally so the tests can play real games against it.
# No accounts, no security — it never touches the official server.
set -euo pipefail
PORT="${PORT:-8111}"
DIR="${SHOWDOWN_DIR:-/tmp/showdown-local}"

mkdir -p "$DIR"
cd "$DIR"
if [ ! -d node_modules/pokemon-showdown ]; then
  echo '{"name":"showdown-local","private":true}' > package.json
  npm install --silent --no-audit --no-fund pokemon-showdown ws
fi

SD=node_modules/pokemon-showdown
[ -f "$SD/config/config.js" ] || cp "$SD/config/config-example.js" "$SD/config/config.js"
python3 - "$SD/config/config.js" "$PORT" <<'PY'
import re, sys
path, port = sys.argv[1], sys.argv[2]
s = open(path).read()
s = re.sub(r"exports\.port\s*=\s*\d+", f"exports.port = {port}", s)
open(path, "w").write(s)
PY
# The server expects these to exist and crashes on startup without them.
mkdir -p "$SD/logs/repl" "$SD/config/chat-plugins"

echo "starting Showdown on :$PORT (logs: $DIR/server.log)"
node "$SD/pokemon-showdown" start --no-security > server.log 2>&1 &
sleep 10
curl -sS --max-time 5 -o /dev/null -w "  ready: HTTP %{http_code}\n" "http://localhost:$PORT/"
