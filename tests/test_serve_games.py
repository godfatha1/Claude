"""The phone server keeps every game the panel records, on the phone only."""

from __future__ import annotations

import importlib.util
import json
import threading
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


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setenv("RANDBATS_GAMES", str(tmp_path / "games"))
    serve = load_serve()
    serve.Handler.quiet = True
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}", tmp_path / "games"
    httpd.shutdown()


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


def test_a_game_is_kept_on_the_phone(server):
    base, games = server
    assert post(base, GAME) == 204
    saved = games / "2026-11-25" / "battle-gen9randombattle-42.json"
    assert json.loads(saved.read_text())["advice"][0]["actions"][0]["c"] == "earthquake"


def test_the_finished_game_replaces_the_partial_one(server):
    base, games = server
    post(base, GAME)
    assert post(base, {**GAME, "final": True, "winner": "Me", "lines": ["|turn|1", "|win|Me"]}) == 204
    files = list(games.glob("*/*"))
    assert [f.name for f in files] == ["battle-gen9randombattle-42.json"]
    assert json.loads(files[0].read_text())["final"] is True


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
