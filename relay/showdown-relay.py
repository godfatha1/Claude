#!/usr/bin/env python3
"""A tiny relay so the assistant page can log in to Showdown.

Why this exists
---------------
Showdown's login server doesn't allow other websites to call it from a browser.
That rule is the browser's and applies to pages, not to programs. So this sits on
your phone, makes that one request on the page's behalf, and hands back the
answer.

Runs on the phone itself, in Termux, bound to 127.0.0.1 only — same as the rest
of your setup. Nothing is exposed to your network, and nothing goes to anyone
else's server. An https page is allowed to talk to localhost: browsers treat it
as trustworthy, so the usual mixed-content block doesn't apply.

What it will and won't do
-------------------------
It is not a general proxy. It forwards to exactly one address — Showdown's login
endpoint — and only from the page origins listed below. Anything else gets a
flat refusal. Your password passes through it, which is why it stays on your
phone and talks to nobody else.

Run it
------
    python3 showdown-relay.py

    # keep it alive across reboots, the way PhotoFrame does:
    #   put it in ~/.termux/boot/ or under your supervisor

Options: --port (default 8137), --allow (extra page origin, repeatable).
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The one address this will talk to. Not configurable on purpose: a relay that
# forwards anywhere is an open proxy sitting on your phone.
LOGIN_URL = "https://play.pokemonshowdown.com/action.php"

DEFAULT_PORT = 8137

# Pages allowed to use it. Anything else is refused, so a random site you happen
# to visit can't quietly use your phone to talk to Showdown.
DEFAULT_ORIGINS = {
    "https://godfatha1.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
}

MAX_BODY = 64 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "showdown-relay/1.0"
    allowed_origins: set[str] = set()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.log_date_time_string()}  {fmt % args}\n")

    # ------------------------------------------------------------ helpers

    def _origin_ok(self) -> str | None:
        origin = self.headers.get("Origin")
        if origin and origin in self.allowed_origins:
            return origin
        return None

    def _cors(self, origin: str | None) -> None:
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome asks permission before letting a public page reach a local
        # address. Without this the request is refused before it's even sent.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, payload: dict, origin: str | None = None) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors(origin)
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------ routes

    def do_OPTIONS(self):  # noqa: N802
        origin = self._origin_ok()
        self.send_response(204 if origin else 403)
        self._cors(origin)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        """A heartbeat, so the page can tell whether the relay is running."""
        origin = self._origin_ok()
        path = urllib.parse.urlparse(self.path).path
        if path not in ("/", "/health"):
            self._json(404, {"error": "no such path"}, origin)
            return
        self._json(200, {
            "ok": True,
            "name": "showdown-relay",
            "forwardsTo": LOGIN_URL,
            "originAllowed": bool(origin),
        }, origin)

    def do_POST(self):  # noqa: N802
        origin = self._origin_ok()
        if not origin:
            self._json(403, {
                "error": "this page isn't on the allowed list",
                "hint": "start the relay with --allow <your page's address>",
            })
            return

        path = urllib.parse.urlparse(self.path).path
        if path != "/login":
            self._json(404, {"error": "no such path"}, origin)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"error": "body missing or too big"}, origin)
            return

        body = self.rfile.read(length)

        try:
            request = urllib.request.Request(
                LOGIN_URL,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    # Showdown's login server rejects requests with no user
                    # agent, so say plainly what this is.
                    "User-Agent": "showdown-relay (personal assistant, localhost)",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=20) as response:
                text = response.read().decode("utf-8", "replace")
                status = response.status
        except urllib.error.HTTPError as err:
            text = err.read().decode("utf-8", "replace")
            status = err.code
        except Exception as err:  # network down, DNS, timeout
            self._json(502, {"error": f"couldn't reach Showdown: {err}"}, origin)
            return

        # Hand the reply back untouched. Showdown prefixes its JSON with a
        # character the client strips itself, so don't parse or reshape it.
        payload = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors(origin)
        self.end_headers()
        self.wfile.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--allow", action="append", default=[],
                        help="an extra page address allowed to use this")
    args = parser.parse_args()

    Handler.allowed_origins = DEFAULT_ORIGINS | {o.rstrip("/") for o in args.allow}

    # 127.0.0.1 only. Android has no host firewall, so binding to all interfaces
    # would put this on every network the phone joins.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"relay listening on http://127.0.0.1:{args.port}")
    print(f"  forwards to : {LOGIN_URL}")
    print(f"  pages allowed: {', '.join(sorted(Handler.allowed_origins))}")
    print("  ctrl-c to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
