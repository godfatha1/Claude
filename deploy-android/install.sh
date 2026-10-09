#!/data/data/com.termux/files/usr/bin/bash
# Put the assistant on the phone and keep it running.
#
# Same shape as PhotoFrame: Termux, bound to 127.0.0.1, restarted by
# Termux:Boot. Python standard library only — nothing to install.
set -euo pipefail

REPO="${REPO:-$HOME/randbats}"
BRANCH="${BRANCH:-claude/pokemon-showdown-assistant-3xna06}"
PORT="${PORT:-8137}"
URL="https://github.com/godfatha1/Claude"

echo "==> code"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch --depth 1 origin "$BRANCH"
  git -C "$REPO" checkout -qB "$BRANCH" FETCH_HEAD
  git -C "$REPO" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$URL" "$REPO"
fi

echo "==> checking what it needs"
command -v python3 >/dev/null || { echo "install python first:  pkg install python"; exit 1; }
for f in serve.py app/panel.js engine/poke_engine_wasm_bg.wasm data/gen9randombattle.json; do
  [ -f "$REPO/$f" ] || { echo "missing: $f"; exit 1; }
done
echo "    ok"

echo "==> start on boot"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/randbats" <<BOOT
#!/data/data/com.termux/files/usr/bin/sh
# Keeps the assistant up across reboots. Needs the Termux:Boot app installed
# and opened once.
termux-wake-lock
exec python3 "$REPO/serve.py" --port $PORT >> "\$HOME/.randbats.log" 2>&1
BOOT
chmod +x "$HOME/.termux/boot/randbats"
echo "    wrote $HOME/.termux/boot/randbats"

echo "==> restarting"
pkill -f "serve\.py" 2>/dev/null || true
sleep 1
termux-wake-lock 2>/dev/null || true
nohup python3 "$REPO/serve.py" --port "$PORT" >> "$HOME/.randbats.log" 2>&1 &
sleep 2

if curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/_assist/app/panel.js"; then
  echo
  echo "    running.  open  http://127.0.0.1:$PORT  on this phone"
  echo "    log in to Showdown there as normal; the panel appears at the bottom"
else
  echo "    didn't come up — see $HOME/.randbats.log"
  exit 1
fi
