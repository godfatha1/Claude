#!/usr/bin/env python3
"""Run the assistant on the phone, with Showdown inside it.

What this is
------------
A small server that sits between your browser and Showdown. It passes their
site through untouched except for one thing: it adds our panel to the page. So
you open one address, see the normal Showdown client, log in as usual, and the
advice appears alongside the battle.

Why it's built this way
-----------------------
Three problems disappear at once by serving their client through us rather than
pointing at it:

  * Their client refuses to run inside another page and sends the whole tab to
    their site. Nothing is in a frame here, so there's nothing to refuse.
  * Logging in from another website is blocked by the browser. Through here
    every request is same-origin, exactly as it is on their own site, so login
    works normally and we never see your password.
  * Watching from outside only shows what a spectator sees — your own hidden
    moves and bench stay hidden. From inside the page the panel reads the same
    feed the client does, so it knows your side exactly.

Runs on the phone in Termux, bound to 127.0.0.1 only, Python standard library
only. Same shape as PhotoFrame.

    python3 serve.py
    # then open http://127.0.0.1:8137 on the phone

Options: --port (default 8137), --host (default 127.0.0.1).
"""

from __future__ import annotations

import argparse
import gzip
import io
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPSTREAM = "https://play.pokemonshowdown.com"
ROOT = Path(__file__).resolve().parent

# Our own files live under this prefix. Showdown doesn't use it, so nothing of
# theirs can collide with it.
OURS = "/_assist/"

DEFAULT_PORT = 8137

# Headers that are ours to decide, not theirs to pass on.
DROP_FROM_UPSTREAM = {
    "content-encoding",      # we decompress to inject, so the old value lies
    "content-length",        # likewise
    "transfer-encoding",
    "connection",
    "content-security-policy",  # would block the panel we add
    "content-security-policy-report-only",
    "x-frame-options",
    "strict-transport-security",  # would pin https on a plain-http localhost
    "alt-svc",
    "public-key-pins",
}

DROP_FROM_BROWSER = {
    "host", "connection", "accept-encoding", "content-length",
    "origin", "referer",  # rewritten below
}

# Goes in as early as the page allows, before any of their scripts run.
#
# This has to be an ordinary inline script, not a module. A module is deferred
# until the document has been parsed, by which point the client has already
# opened its connection and the first exchange — including the feed naming your
# team — has been and gone. So the wrapper goes in first and keeps everything it
# hears; the panel picks the backlog up when it loads.
#
# It only listens. Messages pass through untouched and nothing is ever sent.
HOOK = """<script>
(function () {
  if (window.__assistFeed) return;
  var feed = window.__assistFeed = { lines: [], listener: null };
  var Original = window.WebSocket;
  if (!Original) return;
  function Wrapped(url, protocols) {
    var socket = protocols === undefined
      ? new Original(url) : new Original(url, protocols);
    if (/psim\\.us|showdown/i.test(String(url))) {
      socket.addEventListener('message', function (event) {
        var data = String(event.data);
        if (feed.listener) { try { feed.listener(data); } catch (e) { console.warn(e); } }
        else { feed.lines.push(data); }
      });
    }
    return socket;
  }
  Wrapped.prototype = Original.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Wrapped[k] = Original[k]; });
  window.WebSocket = Wrapped;
})();
</script>"""

# The panel itself, which can wait until the page is built.
INJECT = (
    '<link rel="stylesheet" href="' + OURS + 'app/panel.css">'
    '<script type="module" src="' + OURS + 'app/panel.js"></script>'
)

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".map": "application/json",
}


# ---------------------------------------------------------- self-update
#
# The phone can't be reached from where the code is written, so it keeps
# itself current: it checks the branch every few minutes, and again whenever
# the page is opened. The panel, engine and data are read from disk on every
# request, so the next page load has them. If this file itself changed, the
# server restarts itself in place (same pid, same port) to pick it up.
#
# On by default in Termux, which is the only place this runs for real. Off
# elsewhere unless asked for: a `git reset --hard` is the wrong thing to do to
# a checkout someone is working in.

DEFAULT_BRANCH = "claude/pokemon-showdown-assistant-3xna06"
CHECK_EVERY = 5 * 60          # background check
CHECK_ON_OPEN_AFTER = 60      # opening the page checks if the last one is older
_update = {"last": 0.0, "lock": threading.Lock(), "running": False}
# Requests being served right now, so a restart can wait for them to finish
# rather than cut off the page load that noticed the update.
_busy = {"n": 0, "lock": threading.Lock()}


def _restart_when_idle(limit: float = 30.0) -> None:
    deadline = time.monotonic() + limit
    while _busy["n"] > 0 and time.monotonic() < deadline:
        time.sleep(0.2)
    sys.stdout.flush()
    sys.stderr.flush()
    os.execv(sys.executable, [sys.executable, str(ROOT / "serve.py"), *sys.argv[1:]])


def in_termux() -> bool:
    return "com.termux" in os.environ.get("PREFIX", "") or bool(os.environ.get("TERMUX_VERSION"))


def _git(*args: str, timeout: int = 60) -> str:
    done = subprocess.run(["git", "-C", str(ROOT), *args], check=True, timeout=timeout,
                          capture_output=True, text=True)
    return done.stdout.strip()


def update_now(branch: str) -> None:
    """Pull the branch if it moved. Restarts this process if serve.py changed."""
    with _update["lock"]:
        if _update["running"]:
            return
        _update["running"] = True
        _update["last"] = time.monotonic()
    try:
        _git("fetch", "--depth", "1", "origin", branch)
        head, fetched = _git("rev-parse", "HEAD"), _git("rev-parse", "FETCH_HEAD")
        if head == fetched:
            return
        changed = _git("diff", "--name-only", head, fetched).splitlines()
        _git("reset", "--hard", "-q", fetched, timeout=30)
        version = (ROOT / "VERSION").read_text().strip() if (ROOT / "VERSION").is_file() else "?"
        sys.stderr.write(f"updated to {fetched[:7]} (v{version}): {len(changed)} files\n")
        if "serve.py" in changed:
            sys.stderr.write("serve.py changed, restarting in place once idle\n")
            _restart_when_idle()
    except (subprocess.SubprocessError, OSError) as err:
        # Offline, or no git: keep serving what's here and try again later.
        sys.stderr.write(f"update skipped: {err}\n")
    finally:
        _update["running"] = False


def maybe_update(branch: str, older_than: float) -> None:
    """Check in the background if the last check is older than this."""
    if time.monotonic() - _update["last"] < older_than or _update["running"]:
        return
    threading.Thread(target=update_now, args=(branch,), daemon=True).start()


def keep_updated(branch: str) -> None:
    """Check now, then every few minutes, for as long as the server runs."""
    def loop() -> None:
        while True:
            update_now(branch)
            time.sleep(CHECK_EVERY)
    threading.Thread(target=loop, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    server_version = "randbats-assistant/1.0"
    protocol_version = "HTTP/1.1"
    quiet = False
    self_update_branch: str | None = None

    def log_message(self, fmt, *args):
        if not self.quiet:
            sys.stderr.write(f"{self.log_date_time_string()}  {fmt % args}\n")

    # ----------------------------------------------------------- our files

    def serve_ours(self, path: str) -> None:
        """Serve the panel and everything it needs, from this repo."""
        # Decode first: a browser will happily send %2e%2e%2f, and comparing
        # before decoding would let it walk straight out of the repo.
        relative = urllib.parse.unquote(path[len(OURS):]).lstrip("/")
        try:
            target = (ROOT / relative).resolve()
            target.relative_to(ROOT)  # raises if it escaped
        except (ValueError, OSError):
            self.send_error(404, "not found")
            return
        if not target.is_file():
            self.send_error(404, "not found")
            return

        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type",
                         CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        # The panel and the data change as we work on it; don't let a stale copy
        # stick around and look like a bug.
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # -------------------------------------------------------------- mirror

    def mirror(self, method: str) -> None:
        upstream_url = UPSTREAM + self.path

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in DROP_FROM_BROWSER}
        # Their server checks these, and ours would read as a different site.
        headers["Origin"] = UPSTREAM
        referer = self.headers.get("Referer")
        if referer:
            headers["Referer"] = re.sub(r"^https?://[^/]+", UPSTREAM, referer)
        # Ask for it uncompressed so we can inject without unpacking every time.
        headers["Accept-Encoding"] = "identity"

        request = urllib.request.Request(upstream_url, data=body,
                                         headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
            status, raw, out_headers = response.status, response.read(), response.headers
        except urllib.error.HTTPError as err:
            status, raw, out_headers = err.code, err.read(), err.headers
        except Exception as err:
            self.send_error(502, f"couldn't reach Showdown: {err}")
            return

        # Some responses arrive compressed anyway.
        if (out_headers.get("Content-Encoding") or "").lower() == "gzip":
            try:
                raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
            except OSError:
                pass

        content_type = (out_headers.get("Content-Type") or "").lower()
        if "text/html" in content_type:
            raw = self.inject(raw)

        self.send_response(status)
        for key, value in out_headers.items():
            if key.lower() in DROP_FROM_UPSTREAM:
                continue
            if key.lower() == "set-cookie":
                # Their cookies are marked Secure and scoped to their domain;
                # neither survives the trip to a plain-http localhost.
                value = re.sub(r";\s*Secure", "", value, flags=re.I)
                value = re.sub(r";\s*Domain=[^;]*", "", value, flags=re.I)
                value = re.sub(r";\s*SameSite=None", "; SameSite=Lax", value, flags=re.I)
            if key.lower() == "location":
                value = re.sub(r"^https?://play\.pokemonshowdown\.com", "", value)
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(raw)

    # A page can carry its own content policy in a meta tag, which the header
    # stripping above never sees. Left in place it blocks the panel's script.
    META_CSP = re.compile(
        r"""<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>""",
        re.IGNORECASE)

    def inject(self, raw: bytes) -> bytes:
        """Add the panel to one of their pages."""
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw
        if OURS + "app/panel.js" in text:
            return raw  # already there
        text = self.META_CSP.sub("", text)

        # The listener goes in before anything of theirs can run.
        if "<head>" in text:
            text = text.replace("<head>", "<head>" + HOOK, 1)
        elif "<html" in text:
            text = re.sub(r"(<html[^>]*>)", r"\1" + HOOK, text, count=1)
        else:
            text = HOOK + text

        if "</body>" in text:
            return text.replace("</body>", INJECT + "</body>", 1).encode()
        return (text + INJECT).encode()

    # -------------------------------------------------------------- routes

    def route(self, method: str) -> None:
        with _busy["lock"]:
            _busy["n"] += 1
        try:
            self._route(method)
        finally:
            with _busy["lock"]:
                _busy["n"] -= 1

    def _route(self, method: str) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/" and method == "GET" and self.self_update_branch:
            maybe_update(self.self_update_branch, CHECK_ON_OPEN_AFTER)
        if path.startswith(OURS):
            if method in ("GET", "HEAD"):
                self.serve_ours(path)
            else:
                self.send_error(405, "not allowed here")
            return
        self.mirror(method)

    def do_GET(self):  # noqa: N802
        self.route("GET")

    def do_HEAD(self):  # noqa: N802
        self.route("HEAD")

    def do_POST(self):  # noqa: N802
        self.route("POST")

    def do_OPTIONS(self):  # noqa: N802
        self.route("OPTIONS")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)))
    parser.add_argument("--host", default="127.0.0.1",
                        help="127.0.0.1 by default. Android has no host firewall, "
                             "so anything else puts this on every network you join.")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--self-update", metavar="BRANCH", default=None,
                        help="keep the checkout on this branch: checks every five minutes "
                             "and when the page is opened. On by default in Termux.")
    parser.add_argument("--no-update", action="store_true",
                        help="never pull, even in Termux")
    args = parser.parse_args()

    Handler.quiet = args.quiet
    branch = None if args.no_update else (args.self_update or (DEFAULT_BRANCH if in_termux() else None))
    Handler.self_update_branch = branch

    missing = [p for p in ("app/panel.js", "engine/poke_engine_wasm_bg.wasm",
                           "data/gen9randombattle.json") if not (ROOT / p).is_file()]
    if missing:
        print("these are missing, so the panel won't load:", file=sys.stderr)
        for m in missing:
            print(f"  {m}", file=sys.stderr)
        print("\nrebuild with scripts/build_wasm.sh and scripts/build_data.py",
              file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"open http://{args.host}:{args.port} on this phone")
    print(f"  Showdown passes through from {UPSTREAM}")
    print("  log in there as you normally would — the panel appears in the battle")
    print("  ctrl-c to stop")
    if branch:
        print(f"  keeping itself current with {branch} (every {CHECK_EVERY // 60} min and on open)")
        keep_updated(branch)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
