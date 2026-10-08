#!/usr/bin/env bash
# Build the search engine for the browser.
#
# The whole point: the engine runs on the phone, so a battle never leaves the
# device and there's no server to deploy or keep running. The site can then be
# plain static files.
#
# Two things in the upstream engine don't work in a browser and get patched here
# rather than forked, so updating the pinned version stays a one-line change:
#
#   1. `rand` pulls in getrandom, which refuses to build for the browser unless
#      you pick its browser backend explicitly — both a feature and a cfg flag.
#   2. The search loop calls `std::time::Instant::now()`, which compiles for the
#      browser but panics the moment it runs. `web-time` is a drop-in
#      replacement that reads the page's clock instead.
set -euo pipefail

VERSION="0.0.48"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/site/engine"
WORK="${WASM_BUILD_DIR:-$(mktemp -d)}"

echo "building poke-engine $VERSION for the browser"
rustup target add wasm32-unknown-unknown >/dev/null

cd "$WORK"
if [ ! -d poke-engine ]; then
  git clone --depth 1 --branch "v$VERSION" https://github.com/pmariglia/poke-engine.git 2>/dev/null \
    || git clone --depth 1 https://github.com/pmariglia/poke-engine.git
fi
cd poke-engine

# --- patch 1: a random source that works in a browser, and a clock that does too
python3 - <<'PY'
import pathlib
p = pathlib.Path("Cargo.toml")
s = p.read_text()
if "wasm_js" not in s:
    s = s.replace(
        '[features]',
        '[target.\'cfg(target_arch = "wasm32")\'.dependencies]\n'
        'getrandom = { version = "0.3", features = ["wasm_js"] }\n'
        'web-time = "1.1.0"\n\n'
        '[features]',
        1,
    )
# Debug info makes the artifact ten times larger for no benefit in a browser.
s = s.replace("[profile.release]\ndebug = 1", "[profile.release]\ndebug = 0\nstrip = true")
p.write_text(s)

m = pathlib.Path("src/mcts.rs")
t = m.read_text()
needle = "    let start_time = std::time::Instant::now();"
if needle in t:
    t = t.replace(needle,
        '    #[cfg(target_arch = "wasm32")]\n'
        '    let start_time = web_time::Instant::now();\n'
        '    #[cfg(not(target_arch = "wasm32"))]\n'
        '    let start_time = std::time::Instant::now();')
    m.write_text(t)
print("patched for the browser")
PY

# --- our wrapper, built against the patched engine
rm -rf engine-wasm && cp -r "$ROOT/engine-wasm" engine-wasm
python3 - <<'PY'
import pathlib, re
p = pathlib.Path("engine-wasm/Cargo.toml")
s = p.read_text()
s = re.sub(r'poke-engine = \{ version = "=[^"]+"', 'poke-engine = { path = ".."', s)
p.write_text(s)

w = pathlib.Path("Cargo.toml")
s = w.read_text()
if "engine-wasm" not in s:
    s = s.replace('members = [\n    "poke-engine-py"\n]', 'members = [\n    "poke-engine-py",\n    "engine-wasm"\n]')
    w.write_text(s)
PY

RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  cargo build --release -p poke-engine-wasm --target wasm32-unknown-unknown

# --- bindings. The CLI version must match the crate's exactly, so read it off
#     the lockfile rather than pinning a guess that drifts.
BG_VERSION="$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep '^version' | head -1 | cut -d'"' -f2)"
echo "wasm-bindgen $BG_VERSION"
BG_DIR="$WORK/wasm-bindgen-$BG_VERSION-x86_64-unknown-linux-musl"
if [ ! -x "$BG_DIR/wasm-bindgen" ]; then
  curl -sSL -o "$WORK/wb.tgz" \
    "https://github.com/rustwasm/wasm-bindgen/releases/download/$BG_VERSION/wasm-bindgen-$BG_VERSION-x86_64-unknown-linux-musl.tar.gz"
  tar xzf "$WORK/wb.tgz" -C "$WORK"
fi

mkdir -p "$OUT"
"$BG_DIR/wasm-bindgen" --target web --out-dir "$OUT" --no-typescript \
  target/wasm32-unknown-unknown/release/poke_engine_wasm.wasm

echo
echo "wrote $OUT:"
ls -la "$OUT"
gzip -c "$OUT"/*.wasm | wc -c | awk '{printf "  gzipped: %.0f KB\n", $1/1024}'
