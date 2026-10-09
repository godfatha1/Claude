# The relay

A small program that runs on your phone so the assistant page can log in to
Showdown.

## Why it's needed

Showdown's login server doesn't let other websites call it from a browser. That
rule applies to web pages, not to programs. The relay makes that one request on
the page's behalf and hands back the answer.

It stays on your phone and talks to nobody but Showdown. Your password passes
through it, which is exactly why it isn't on someone else's server.

## Running it

In Termux:

```sh
python3 ~/randbats/relay/showdown-relay.py
```

That's it — no packages to install, it only uses what Python ships with.

To keep it running across reboots, the same way PhotoFrame does, drop a line in
`~/.termux/boot/`:

```sh
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/showdown-relay <<'SH'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
python3 ~/randbats/relay/showdown-relay.py >> ~/.showdown-relay.log 2>&1 &
SH
chmod +x ~/.termux/boot/showdown-relay
```

## What it allows

Bound to `127.0.0.1` only, so it isn't on your network — same reasoning as the
go2rtc bind in PhotoFrame, since Android has no host firewall.

It forwards to exactly one address, Showdown's login endpoint, and only for the
pages listed in `DEFAULT_ORIGINS`. Everything else is refused, so a random site
you happen to open can't use your phone to talk to Showdown.

Add another page address with `--allow`:

```sh
python3 showdown-relay.py --allow https://some-other-page.example
```

## Checking it

Open the assistant's check page on the phone. The last row says whether the
relay is running and whether it will accept the page.
