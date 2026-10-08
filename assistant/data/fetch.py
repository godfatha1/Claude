"""Fetching and caching the published random battle sets.

The sets for every random battle format are public, kept in step with the live
simulator by the pkmn project. We pull the one file we care about and keep it on
disk so a battle never waits on the network.

Note on hosts: `pkmn.github.io` and `data.pkmn.cc` are both unreachable from some
networks (including this build box, where an egress proxy refuses them). The raw
GitHub host serves the same files and is used instead.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

CACHE_DIR = Path(__file__).parent / "cache"

SOURCES = (
    "https://raw.githubusercontent.com/pkmn/randbats/main/data/{fmt}.json",
    "https://pkmn.github.io/randbats/data/{fmt}.json",
)

# How old a cached copy may get before we try the network again. The sets only
# change when the format is rebalanced, so this is deliberately slack.
MAX_AGE_SECONDS = 24 * 60 * 60


class SetDataUnavailable(RuntimeError):
    """Raised when there's no cached copy and the network won't give us one."""


def cache_path(fmt: str) -> Path:
    return CACHE_DIR / f"{fmt}.json"


def load(fmt: str = "gen9randombattle", *, refresh: bool = False) -> dict:
    """Return the set data for a format, fetching it if we need to.

    Falls back to a stale cached copy if the network is down — out-of-date sets
    beat no sets at all, and we say so on stderr rather than failing a battle.
    """
    path = cache_path(fmt)
    fresh_enough = (
        path.exists()
        and not refresh
        and (time.time() - path.stat().st_mtime) < MAX_AGE_SECONDS
    )
    if fresh_enough:
        return json.loads(path.read_text())

    try:
        data = _download(fmt)
    except Exception as exc:
        if path.exists():
            print(f"couldn't refresh {fmt} sets ({exc}); using the cached copy")
            return json.loads(path.read_text())
        raise SetDataUnavailable(f"no cached {fmt} sets and no way to fetch them: {exc}") from exc

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    return data


def _download(fmt: str) -> dict:
    last: Exception | None = None
    for template in SOURCES:
        url = template.format(fmt=fmt)
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                data = json.loads(response.read())
            if not isinstance(data, dict) or not data:
                raise ValueError(f"{url} gave back something that isn't set data")
            return data
        except Exception as exc:
            last = exc
    raise last if last else RuntimeError("no sources configured")


if __name__ == "__main__":
    import sys

    fmt = sys.argv[1] if len(sys.argv) > 1 else "gen9randombattle"
    data = load(fmt, refresh="--refresh" in sys.argv)
    print(f"{fmt}: {len(data)} species cached at {cache_path(fmt)}")
