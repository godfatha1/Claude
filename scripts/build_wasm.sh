#!/usr/bin/env bash
# Build the search engine for the browser.
#
# The whole point: the engine runs on the phone, so a battle never leaves the
# device and there's no server to deploy or keep running. The site is then just
# static files.
#
# Two things in the upstream engine don't work in a browser. Both are patched
# here against a pinned version rather than kept as a fork, so updating stays a
# one-line change:
#
#   1. `rand` pulls in getrandom, which refuses to build for the browser unless
#      you pick its browser backend explicitly — and it wants both a feature and
#      a cfg flag, which is easy to half-do.
#   2. The search loop calls `std::time::Instant::now()` unconditionally, even
#      when the search is capped by iteration count. That *compiles* for the
#      browser and then panics the moment it runs, which is the worst way for it
#      to fail. `web-time` is a drop-in replacement that reads the page's clock.
set -euo pipefail

VERSION="0.0.48"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/site/engine"
WORK="${WASM_BUILD_DIR:-$(mktemp -d)}"

echo "building poke-engine $VERSION for the browser"
rustup target add wasm32-unknown-unknown >/dev/null

mkdir -p "$WORK"
cd "$WORK"
if [ ! -d poke-engine ]; then
  git clone --depth 1 --branch "v$VERSION" https://github.com/pmariglia/poke-engine.git 2>/dev/null \
    || git clone --depth 1 https://github.com/pmariglia/poke-engine.git
fi
cd poke-engine

# Clear any previous copy of our wrapper first. A leftover directory declaring
# the same package name gets picked instead and the build silently uses stale
# source, which looks like your edits did nothing.
rm -rf engine-wasm poke-engine-wasm
cp -r "$ROOT/engine-wasm" engine-wasm

python3 "$ROOT/scripts/patch_engine_for_browser.py"

RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  cargo build --release -p poke-engine-wasm --target wasm32-unknown-unknown

# Bindings. The CLI version has to match the crate's exactly, so read it off the
# lockfile rather than pinning a guess that drifts.
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
