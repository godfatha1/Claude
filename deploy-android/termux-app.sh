#!/usr/bin/env bash
# Put any web app on the phone and keep it running and current.
#
# The same mechanics as the Showdown helper and PhotoFrame: Termux, bound to
# 127.0.0.1, started on boot by Termux:Boot, tracked by pid file, and pulling
# its own updates every few minutes. Run it again to update and restart.
#
# Settings come from the environment, so it can be run straight off the
# network:
#
#   APP=financedeals REPO=https://github.com/you/finance-deals PORT=8140 \
#   START='python3 app.py --host 127.0.0.1 --port 8140' \
#   SETUP='pip install -r requirements.txt' PKGS='git python' \
#     bash <(curl -sSL https://raw.githubusercontent.com/godfatha1/Claude/claude/pokemon-showdown-assistant-3xna06/deploy-android/termux-app.sh)
#
# Secrets (API keys) go in ~/.config/$APP/env as KEY=value lines, chmod 600.
# They're loaded before START and never live in the repo or in this script.
#
# To stop it pulling updates (say, while you patch something on the phone):
#   touch ~/apps/$APP/.no-update
set -euo pipefail

: "${APP:?set APP, a short name with no spaces}"
: "${REPO:?set REPO, the git URL}"
: "${PORT:?set PORT, a free port (8137 is taken by the Showdown helper)}"
: "${START:?set START, the command that runs the app on 127.0.0.1:\$PORT}"
BRANCH="${BRANCH:-main}"
SETUP="${SETUP:-}"
PKGS="${PKGS:-git}"
CHECK_EVERY="${CHECK_EVERY:-300}"
DIR="${DIR:-$HOME/apps/$APP}"
SH="${PREFIX:-/usr}/bin/sh"

LOG="$HOME/.$APP.log"
PIDF="$HOME/.$APP.pid"
UPIDF="$HOME/.$APP-update.pid"
ENVF="$HOME/.config/$APP/env"

say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# --- packages ------------------------------------------------------------
say "packages: $PKGS"
if command -v pkg >/dev/null; then
  # shellcheck disable=SC2086
  pkg install -y $PKGS >/dev/null
else
  note "no pkg (not Termux) - skipping"
fi

# --- code ----------------------------------------------------------------
say "code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH"
  git -C "$DIR" reset -q --hard FETCH_HEAD
  note "updated $DIR to $(git -C "$DIR" rev-parse --short HEAD)"
else
  mkdir -p "$(dirname "$DIR")"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
  note "cloned to $DIR"
fi
if [ -n "$SETUP" ]; then
  say "setup: $SETUP"
  (cd "$DIR" && eval "$SETUP")
fi
mkdir -p "$(dirname "$ENVF")"
[ -f "$ENVF" ] && chmod 600 "$ENVF"

# --- the run script ------------------------------------------------------
# Loads secrets, then replaces itself with the app, so the pid it writes is
# the app's own.
cat > "$DIR/.run.sh" <<RUN
#!$SH
cd "$DIR"
if [ -f "$ENVF" ]; then set -a; . "$ENVF"; set +a; fi
echo \$\$ > "$PIDF"
exec $START >> "$LOG" 2>&1
RUN
chmod +x "$DIR/.run.sh"

# --- the update loop -----------------------------------------------------
# Every few minutes: fetch, and if the branch moved, pull, re-run setup and
# restart. A hard reset wipes local edits to tracked files, so patch in the
# repo, or touch .no-update while you work on the phone.
SETUP_LINE=""
[ -n "$SETUP" ] && SETUP_LINE="  (cd \"$DIR\" && $SETUP) >> \"$LOG\" 2>&1"
cat > "$DIR/.update.sh" <<UPD
#!$SH
echo \$\$ > "$UPIDF"
while true; do
  sleep $CHECK_EVERY
  [ -f "$DIR/.no-update" ] && continue
  git -C "$DIR" fetch -q --depth 1 origin "$BRANCH" 2>/dev/null || continue
  [ "\$(git -C "$DIR" rev-parse HEAD)" = "\$(git -C "$DIR" rev-parse FETCH_HEAD)" ] && continue
  git -C "$DIR" reset -q --hard FETCH_HEAD
  echo "\$(date) updated to \$(git -C "$DIR" rev-parse --short HEAD)" >> "$LOG"
$SETUP_LINE
  old=\$(cat "$PIDF" 2>/dev/null || true)
  if [ -n "\$old" ] && [ "\$(readlink /proc/\$old/cwd 2>/dev/null)" = "$DIR" ]; then kill "\$old"; sleep 2; fi
  setsid "$DIR/.run.sh" < /dev/null > /dev/null 2>&1 &
done
UPD
chmod +x "$DIR/.update.sh"

# --- start on boot -------------------------------------------------------
# Termux:Boot runs every executable file in ~/.termux/boot at boot - stray
# backups included, so don't leave any executable copies lying around there.
say "boot hook"
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/$APP" <<BOOT
#!$SH
termux-wake-lock
setsid "$DIR/.update.sh" < /dev/null > /dev/null 2>&1 &
exec "$DIR/.run.sh"
BOOT
chmod +x "$HOME/.termux/boot/$APP"
note "wrote $HOME/.termux/boot/$APP"

# --- (re)start now -------------------------------------------------------
# Stop by pid, checked against its working directory. `pkill -f` matches the
# ssh command running this script and kills your own session.
say "starting"
for f in "$PIDF" "$UPIDF"; do
  old=$(cat "$f" 2>/dev/null || true)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    cwd=$(readlink "/proc/$old/cwd" 2>/dev/null || true)
    if [ "$cwd" = "$DIR" ] || tr '\0' ' ' < "/proc/$old/cmdline" 2>/dev/null | grep -q "$DIR/.update.sh"; then
      kill "$old" 2>/dev/null || true
    fi
  fi
done
sleep 1
termux-wake-lock 2>/dev/null || true
# setsid, not nohup: over ssh the whole process group goes when the
# connection closes.
setsid "$DIR/.run.sh" < /dev/null > /dev/null 2>&1 &
setsid "$DIR/.update.sh" < /dev/null > /dev/null 2>&1 &

code=000
for _ in $(seq 1 20); do
  sleep 1
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || true)
  [ "$code" != "000" ] && break
done
echo
if [ "$code" != "000" ]; then
  note "running: http://127.0.0.1:$PORT (HTTP $code)"
else
  note "not answering on $PORT yet - check the log"
fi
note "log:     tail -f $LOG"
note "stop:    kill \$(cat $PIDF) \$(cat $UPIDF)"
note "updates: checks $BRANCH every ${CHECK_EVERY}s (touch $DIR/.no-update to pause)"
