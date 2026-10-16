#!/usr/bin/env bash
# Install or update the assistant on the phone from anywhere, the way
# PhotoFrame does it: ask the worker where the phone is today, open a
# Cloudflare Access tunnel to its Termux sshd, and run the installer over ssh.
#
#   ./deploy-android/phone.sh            # install / update and restart
#   ./deploy-android/phone.sh tail -f ~/.randbats.log   # any other command
#
# Needs: curl, cloudflared (downloaded if missing), ssh, and the key that
# Termux's sshd trusts (PHONE_SSH_KEY, default ~/.ssh/id_ed25519). The machine
# running this must be allowed to reach the worker and Cloudflare Access.
set -euo pipefail

WORKER="${PHONE_WORKER:-https://photoframe.randall216.workers.dev/ssh.txt?key=rayan}"
USER_ON_PHONE="${PHONE_USER:-u0_a568}"
LOCAL_PORT="${PHONE_LOCAL_PORT:-2222}"
KEY="${PHONE_SSH_KEY:-$HOME/.ssh/id_ed25519}"
BRANCH="${BRANCH:-claude/pokemon-showdown-assistant-3xna06}"
INSTALL="curl -sSL https://raw.githubusercontent.com/godfatha1/Claude/$BRANCH/deploy-android/install.sh | bash"

say() { printf '==> %s\n' "$*"; }

# --- where is the phone today? -------------------------------------------
say "asking the worker for the ssh host"
HOST="$(curl -sS --max-time 15 "$WORKER" | tr -d '[:space:]')"
[ -n "$HOST" ] || { echo "the worker gave no host (is $WORKER reachable from here?)" >&2; exit 1; }
echo "    $HOST"

# --- cloudflared ----------------------------------------------------------
CFD="$(command -v cloudflared || true)"
if [ -z "$CFD" ]; then
  CFD="${TMPDIR:-/tmp}/cloudflared"
  if [ ! -x "$CFD" ]; then
    say "fetching cloudflared"
    curl -sSL -o "$CFD" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x "$CFD"
  fi
fi

say "opening the tunnel on 127.0.0.1:$LOCAL_PORT"
"$CFD" access tcp --hostname "$HOST" --url "127.0.0.1:$LOCAL_PORT" >/dev/null 2>&1 &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null || true' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break
done

# --- over ssh, into Termux ------------------------------------------------
SSH=(ssh -p "$LOCAL_PORT" -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20
     "$USER_ON_PHONE@127.0.0.1")
if [ $# -gt 0 ]; then
  say "running on the phone: $*"
  "${SSH[@]}" "$@"
else
  say "installing / updating on the phone"
  "${SSH[@]}" "$INSTALL"
fi
