#!/usr/bin/env python3
"""Patch a checked-out poke-engine so it builds for the browser.

Run from inside the engine's own checkout; `scripts/build_wasm.sh` does that.
Everything here is idempotent, so running it twice is harmless.

See that script's header for why each patch is needed.
"""

from __future__ import annotations

import pathlib
import re
import sys

WASM_DEPS = """[target.'cfg(target_arch = "wasm32")'.dependencies]
getrandom = { version = "0.3", features = ["wasm_js"] }
web-time = "1.1.0"

[features]"""

CLOCK_BEFORE = "    let start_time = std::time::Instant::now();"
CLOCK_AFTER = """    #[cfg(target_arch = "wasm32")]
    let start_time = web_time::Instant::now();
    #[cfg(not(target_arch = "wasm32"))]
    let start_time = std::time::Instant::now();"""


def patch_engine_manifest() -> list[str]:
    path = pathlib.Path("Cargo.toml")
    text = path.read_text()
    done = []

    if "wasm_js" not in text:
        text = text.replace("[features]", WASM_DEPS, 1)
        done.append("browser random + clock dependencies")

    # Debug info makes the artifact ten times larger for no benefit in a browser.
    if "[profile.release]\ndebug = 1" in text:
        text = text.replace(
            "[profile.release]\ndebug = 1", "[profile.release]\ndebug = 0\nstrip = true"
        )
        done.append("stripped release profile")

    # Set the members outright rather than appending. Rewriting keeps this
    # idempotent and stops a leftover member from an earlier build shadowing our
    # crate, since both declare the same package name.
    new_members = '[workspace]\nmembers = [\n    "poke-engine-py",\n    "engine-wasm"\n]'
    text, count = re.subn(
        r"\[workspace\]\s*members\s*=\s*\[[^\]]*\]", new_members, text, count=1
    )
    if count:
        done.append("workspace members")

    path.write_text(text)
    return done


def patch_clock() -> list[str]:
    path = pathlib.Path("src/mcts.rs")
    text = path.read_text()
    if CLOCK_BEFORE not in text:
        return []
    path.write_text(text.replace(CLOCK_BEFORE, CLOCK_AFTER))
    return ["browser clock in the search loop"]


def point_wrapper_at_local_engine() -> list[str]:
    """Build our wrapper against this checkout instead of the published crate."""
    path = pathlib.Path("engine-wasm/Cargo.toml")
    if not path.exists():
        return []
    text = path.read_text()
    patched = re.sub(
        r'poke-engine = \{ version = "=[^"]+"', 'poke-engine = { path = ".."', text
    )
    if patched == text:
        return []
    path.write_text(patched)
    return ["wrapper pointed at the local engine"]


def main() -> int:
    if not pathlib.Path("src/mcts.rs").exists():
        print("run this from inside a poke-engine checkout", file=sys.stderr)
        return 1

    done = patch_engine_manifest() + patch_clock() + point_wrapper_at_local_engine()
    print("patched for the browser: " + (", ".join(done) if done else "already up to date"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
