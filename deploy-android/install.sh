#!/data/data/com.termux/files/usr/bin/bash
# Put the assistant on the phone and keep it running.
#
# Same shape as PhotoFrame: Termux, bound to 127.0.0.1, restarted by
# Termux:Boot. Python standard library only — nothing from pip.
#
# Self-contained, so it works straight off the network:
#
#   curl -sSL https://raw.githubusercontent.com/godfatha1/Claude/claude/pokemon-showdown-assistant-3xna06/deploy-android/install.sh | bash
#
# Running it again updates to the latest and restarts.
set -euo pipefail

REPO="${REPO:-$HOME/randbats}"
BRANCH="${BRANCH:-claude/pokemon-showdown-assistant-3xna06}"
PORT="${PORT:-8137}"
URL="https://github.com/godfatha1/Claude"

say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# --- what it needs -------------------------------------------------------
say "checking what's here"
need_install=""
command -v git     >/dev/null || need_install="$need_install git"
command -v python3 >/dev/null || need_install="$need_install python"
if [ -n "$need_install" ]; then
  note "installing:$need_install"
  if command -v pkg >/dev/null; then
    pkg install -y $need_install
  else
    echo "    not Termux, and these are missing:$need_install" >&2
    exit 1
  fi
fi
note "git and python ready"

# --- the code ------------------------------------------------------------
say "fetching the code"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch --depth 1 origin "$BRANCH"
  git -C "$REPO" checkout -qB "$BRANCH" FETCH_HEAD
  git -C "$REPO" reset --hard -q FETCH_HEAD
  note "updated $REPO"
else
  git clone --depth 1 --branch "$BRANCH" "$URL" "$REPO"
  note "cloned to $REPO"
fi

for f in serve.py app/panel.js app/panel.css \
         engine/poke_engine_wasm.js engine/poke_engine_wasm_bg.wasm \
         data/gen9randombattle.json; do
  [ -f "$REPO/$f" ] || { echo "    missing from the checkout: $f" >&2; exit 1; }
done
note "all the pieces are there"

# --- start on boot -------------------------------------------------------
say "setting it to start on boot"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/randbats" <<BOOT
#!/data/data/com.termux/files/usr/bin/sh
# Keeps the assistant up across reboots.
termux-wake-lock
echo \$\$ > "\$HOME/.randbats.pid"
exec python3 "$REPO/serve.py" --port $PORT >> "\$HOME/.randbats.log" 2>&1
BOOT
chmod +x "$HOME/.termux/boot/randbats"
note "wrote $HOME/.termux/boot/randbats"
if [ ! -d /data/data/com.termux.boot ]; then
  note "(for that to fire you need the Termux:Boot app installed and opened once —"
  note " the same thing PhotoFrame's supervisor relies on)"
fi

# --- run it --------------------------------------------------------------
say "starting it"

# Stop the old one by pid, not by pattern. `pkill -f serve.py` also matches any
# shell whose command line happens to contain that text — including the ssh
# invocation running this script, which it will cheerfully kill.
PIDFILE="$HOME/.randbats.pid"
if [ -f "$PIDFILE" ]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    # Make sure it is ours before signalling it.
    if tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null | grep -q "serve.py"; then
      kill "$old" 2>/dev/null || true
      sleep 1
      kill -9 "$old" 2>/dev/null || true
      note "stopped the previous one (pid $old)"
    fi
  fi
  rm -f "$PIDFILE"
fi

termux-wake-lock 2>/dev/null || true

# setsid, not just nohup. Run over ssh, the whole process group goes when the
# connection closes, and nohup alone only covers the hangup signal — the server
# would look like it started and be gone by the time you opened the page.
if command -v setsid >/dev/null; then
  setsid python3 "$REPO/serve.py" --port "$PORT" >> "$HOME/.randbats.log" 2>&1 < /dev/null &
else
  nohup python3 "$REPO/serve.py" --port "$PORT" >> "$HOME/.randbats.log" 2>&1 < /dev/null &
fi
echo $! > "$PIDFILE"
disown 2>/dev/null || true

for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  code="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
          "http://127.0.0.1:$PORT/_assist/app/panel.js" 2>/dev/null || true)"
  [ "$code" = "200" ] && break
done

echo
if [ "${code:-}" = "200" ]; then
  note "running."
  echo
  echo "    Open this on the phone:   http://127.0.0.1:$PORT"
  echo
  note "That's Showdown. Log in and play as normal — the advice panel"
  note "sits at the bottom of the page. Tap it for the full read."
  echo
  note "log:   tail -f ~/.randbats.log"
  note "stop:  kill \$(cat ~/.randbats.pid)"
else
  note "it didn't come up. Last few lines of the log:"
  tail -n 15 "$HOME/.randbats.log" 2>/dev/null | sed 's/^/      /'
  exit 1
fi
