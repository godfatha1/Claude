# Running it on the phone

Same shape as PhotoFrame: Termux, bound to `127.0.0.1`, restarted by
Termux:Boot.

## Install

One command, over ssh into Termux or in a Termux shell. It installs what it
needs, fetches itself, sets up the boot hook and starts:

```sh
curl -sSL https://raw.githubusercontent.com/godfatha1/Claude/claude/pokemon-showdown-assistant-3xna06/deploy-android/install.sh | bash
```

Running it again updates and restarts. The server is started with `setsid` and
tracked by pid, so it survives the ssh session closing.

### Or by hand

```sh
pkg install -y python git
git clone --depth 1 -b claude/pokemon-showdown-assistant-3xna06 \
  https://github.com/godfatha1/Claude ~/randbats
bash ~/randbats/deploy-android/install.sh
```

Then open **http://127.0.0.1:8137** on the phone. That's Showdown — log in and
play as normal. The panel sits at the bottom; tap it for the full read.

## What it's actually doing

`serve.py` passes Showdown's site through and adds our panel to the page. Three
problems go away at once by doing it this way rather than pointing at their
site:

- **Their client refuses to run inside another page** and sends the whole tab
  to their site. Nothing is in a frame here, so there is nothing to refuse.
- **Logging in from another website is blocked by the browser.** Through here
  every request is same-origin, exactly as on their own site, so login works
  normally and we never see your password.
- **Watching from outside only shows what a spectator sees.** From inside the
  page the panel reads the same feed the client does, so it knows your own team
  exactly — including your bench, by name, from turn one.

## Updating

```sh
bash ~/randbats/deploy-android/install.sh
```

Pulls the latest and restarts.

## Checking on it

```sh
tail -20 ~/.randbats.log          # what it is doing
kill -0 $(cat ~/.randbats.pid)    # is it up
kill $(cat ~/.randbats.pid)       # stop it
```

Stopping goes by pid rather than `pkill -f serve.py`, because that pattern also
matches any shell whose command line contains the text — including the ssh
invocation that started it.

## Notes

Bound to `127.0.0.1` only, so it is not on your network — same reasoning as the
go2rtc bind in PhotoFrame, since Android has no host firewall.

It only reads. The panel wraps the client's connection to watch the traffic and
never sends anything, so it cannot make a move for you.

Boot start needs the **Termux:Boot** app installed and opened once, the same as
PhotoFrame's supervisor.

## If something looks wrong

**Panel never appears.** Check the page came through the mirror — the address
has to be `127.0.0.1:8137`, not `play.pokemonshowdown.com`. The panel says so
in the console if the early listener is missing.

**Panel says "failed to load".** The engine or set data is missing from the
checkout. Re-run the install script.

**Login doesn't work.** That means the mirror isn't passing requests through;
check `~/.randbats.log` for errors reaching Showdown.
