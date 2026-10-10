# Installing it from the desktop over the adb bridge

Paste this into a Claude Code session on the desktop — the one that has the
wireless adb bridge to the S22. It does the whole thing.

---

Install the Pokémon Showdown assistant onto the S22 over the adb bridge, the
same way PhotoFrame and GameBible are deployed from here.

It's a small Python server (standard library only, nothing from pip). The one
command that does everything, run inside Termux on the phone:

    curl -sSL https://raw.githubusercontent.com/godfatha1/Claude/claude/pokemon-showdown-assistant-3xna06/deploy-android/install.sh | bash

Use whatever mechanism PhotoFrame already uses on this desktop to run a command
in Termux on the phone.

Then check it took:

    curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8137/_assist/app/panel.js   # want 200
    pgrep -af serve.py                                                                      # want it running
    ls -l ~/.termux/boot/randbats                                                           # boot hook

Don't touch PhotoFrame, GameBible, or anything else on the phone, and don't
reboot it. `serve.py` binds 127.0.0.1 deliberately — leave that alone.

Report back: whether adb saw the device, the HTTP code, and anything that
failed.

---

## What it installs

A server on the phone at `http://127.0.0.1:8137`. Opening that gives you
Showdown with an advice panel added to the page. See `../deploy-android/README.md`.
