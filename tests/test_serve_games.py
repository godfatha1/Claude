"""The phone server keeps every game the panel records, and can copy finished
ones to a GitHub repository. Checked here against a stand-in for GitHub."""

from __future__ import annotations

import base64
import importlib.util
import json
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load_serve():
    spec = importlib.util.spec_from_file_location("serve_under_test", ROOT / "serve.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeGitHub(BaseHTTPRequestHandler):
    puts: list = []
    existing: dict = {}

    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path in self.existing:
            body = json.dumps({"sha": self.existing[path]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def do_PUT(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeGitHub.puts.append({"path": self.path, "auth": self.headers.get("Authorization"), **body})
        self.send_response(201)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")


@pytest.fixture()
def server(tmp_path, monkeypatch):
    github = ThreadingHTTPServer(("127.0.0.1", 0), FakeGitHub)
    threading.Thread(target=github.serve_forever, daemon=True).start()
    conf = tmp_path / "upload.json"
    conf.write_text(json.dumps({"repo": "me/games", "token": "t0ken", "branch": "main"}))
    monkeypatch.setenv("RANDBATS_GAMES", str(tmp_path / "games"))
    monkeypatch.setenv("RANDBATS_UPLOAD_CONF", str(conf))
    monkeypatch.setenv("RANDBATS_GITHUB_API", f"http://127.0.0.1:{github.server_port}")
    FakeGitHub.puts = []
    FakeGitHub.existing = {}
    serve = load_serve()
    serve.Handler.quiet = True
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}", tmp_path / "games"
    httpd.shutdown()
    github.shutdown()


def post(base, record):
    data = json.dumps(record).encode()
    req = urllib.request.Request(f"{base}/_assist/games/save", data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as err:
        return err.code


GAME = {"kind": "randbats-game", "room": "battle-gen9randombattle-42", "started": "2026-11-25T10:00:00Z",
        "us": "Me", "them": "Foe", "winner": None, "final": False,
        "lines": ["|turn|1"], "advice": [{"turn": 1, "at": 1, "actions": [{"c": "earthquake", "s": 0.4}]}], "taps": []}


def wait_for(cond, seconds=5):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_a_partial_game_is_kept_and_not_uploaded(server):
    base, games = server
    assert post(base, GAME) == 204
    saved = games / "2026-11-25" / "battle-gen9randombattle-42.json"
    assert json.loads(saved.read_text())["advice"][0]["actions"][0]["c"] == "earthquake"
    time.sleep(0.3)
    assert FakeGitHub.puts == []


def test_the_finished_game_replaces_it_and_is_uploaded(server):
    base, games = server
    post(base, GAME)
    final = {**GAME, "final": True, "winner": "Me", "lines": ["|turn|1", "|win|Me"]}
    assert post(base, final) == 204
    assert wait_for(lambda: FakeGitHub.puts)
    put = FakeGitHub.puts[0]
    assert put["path"] == "/repos/me/games/contents/games/2026-11-25/battle-gen9randombattle-42.json"
    assert put["auth"] == "Bearer t0ken" and put["branch"] == "main"
    assert json.loads(base64.b64decode(put["content"]))["winner"] == "Me"
    saved = games / "2026-11-25" / "battle-gen9randombattle-42.json"
    assert json.loads(saved.read_text())["final"] is True
    assert wait_for(lambda: not saved.with_suffix(".pending").exists())


def test_an_existing_file_is_updated_not_duplicated(server):
    base, _ = server
    FakeGitHub.existing["/repos/me/games/contents/games/2026-11-25/battle-gen9randombattle-42.json"] = "abc123"
    post(base, {**GAME, "final": True})
    assert wait_for(lambda: FakeGitHub.puts)
    assert FakeGitHub.puts[0]["sha"] == "abc123"


def test_the_list_and_the_file_can_be_read_back(server):
    base, _ = server
    post(base, {**GAME, "winner": "Me", "final": True, "rating": {"before": 1200, "after": 1216}})
    with urllib.request.urlopen(f"{base}/_assist/games", timeout=10) as r:
        page = r.read().decode()
    assert "Foe" in page and "won (+16)" in page
    with urllib.request.urlopen(f"{base}/_assist/games/2026-11-25/battle-gen9randombattle-42.json", timeout=10) as r:
        assert json.loads(r.read())["us"] == "Me"


def test_bad_input_is_refused(server):
    base, games = server
    assert post(base, {**GAME, "room": "../../etc"}) == 400
    assert post(base, {**GAME, "room": "lobby"}) == 400
    req = urllib.request.Request(f"{base}/_assist/games/save", data=b"not json", method="POST")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(req, timeout=10)
    assert err.value.code == 400
    for bad in ["../serve.py", "2026-11-25/../../serve.py", "2026-11-25/x.json"]:
        with pytest.raises(urllib.error.HTTPError):
            urllib.request.urlopen(f"{base}/_assist/games/{bad}", timeout=10)
    assert not any(games.glob("*/*.json")) if games.exists() else True
