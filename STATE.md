# Session state

Kept current so work can resume after a context reset without re-deriving
anything. If you're picking this up cold, read this file then `docs/research.md`.

**Version:** 0.3.0
**Branch:** `claude/pokemon-showdown-assistant-3xna06`
**Last updated:** 2026-10-08
**Dashboard:** https://claude.ai/artifact/8pWEDEB4TewZaaZkbYvaAz
  (published private by default — needs sharing turned on from the page's Share menu
   to be reachable without a sign-in)

## House rules

Plain words, short answers, no jargon. See CLAUDE.md.

## What we're building

A helper that watches a live Gen 9 random battle in the Showdown client and tells
the player what to click, with reasons. It advises — it does not play. Target is
the random battle ladder specifically, because that format hands us deterministic
stats and a public set database, and both are big advantages.

## Decisions already made (don't relitigate)

- **Search, not learning.** Foul Play won the Gen 9 OU bracket at the PokéAgent
  Challenge (NeurIPS 2025) 50–14 against RL entries. Search is state of the art
  here and it needs no training run.
- **Engine is `poke-engine`** (Rust, Gen 9). Builds from source in ~37s. Verified
  268,000 MCTS visits/sec single-threaded on this box. Exposes
  `monte_carlo_tree_search`, `calculate_damage`, `State.from_string`.
- **Set data is `pkmn/randbats`** `gen9randombattle.json`, 509 species, role-based.
  Fetch via `raw.githubusercontent.com` (`pkmn.github.io` and `data.pkmn.cc` are
  both blocked by the egress proxy — use the raw GitHub host).
- **No language model in the decision path.** Challenge results showed it trails
  search and degrades under time pressure.
- **Delivery is a static site on GitHub Pages, engine compiled to WebAssembly.**
  Forced by phone + Pages hosting, and better anyway: nothing to deploy, nothing
  leaves the device. Measured ~43k positions/sec on mid-range phone hardware,
  210 KB gzipped. Crucially the ranking doesn't change with the budget, so a
  phone gets the same answer as a desktop. See `docs/browser-engine.md`.
- **The assistant watches your battle as a guest spectator.** A static site can't
  log in to Showdown — the official client posts to a same-origin
  `/~~showdown/action.php` that Pages has no way to proxy. Spectating needs no
  account at all, and `/cmd userdetails <name>` finds your live battle from your
  username, so there's nothing to paste on a phone. All verified against a real
  server. Trade-off: a spectator doesn't get the `request` feed, so our own
  hidden set is inferred rather than known, with an optional one-tap confirm for
  the lead. See `docs/connecting.md`.
- **Never plays for you.** A spectator connection physically cannot choose a move.
- **Choice-lock tracking ships with item inference, not after it.** Laplace
  measured a 39% game loss from adding item stats without it.
- **Set data is a strong prior, never a hard constraint.** The per-role item
  pools we rely on are derived — pkmn ran the generator many times and recorded
  what came out — so they're only as complete as that sampling. If what we
  observe contradicts every candidate role, fall back to the species' full pool
  rather than concluding "impossible". Ruling out the truth is worse than
  knowing nothing.

## Environment facts worth not rediscovering

- Python 3.13.16, Node 22.22, Rust/cargo 1.97 all present.
- `poke-engine` has **no prebuilt wheel** — must build from source:
  `pip install poke-engine==0.0.48 --no-binary poke-engine`
- Egress proxy blocks `pkmn.github.io` and `data.pkmn.cc`; `raw.githubusercontent.com` works.
- Engine state string format confirmed, comma-separated, `=` separates the two sides.
- The npm `pokemon-showdown` package is a frozen snapshot while our live set data
  tracks the current ladder, so levels drift between them (11 species differ
  against 0.11.11). That's expected, not a bug — tests report it instead of
  failing on it.

## Set data: things that cost time to work out

- **Spreads are nearly fixed but not quite.** 85 EVs / 31 IVs and a neutral
  nature, except: HP walks down in fours from 85 (to 73 in practice) so Stealth
  Rock chip divides evenly; Attack is zeroed when nothing in the set reads it;
  Speed is zeroed for Trick Room and Gyro Ball. All three rules are ported from
  the simulator and checked against 2,400 of its own generated sets, so every
  spread and every stat matches exactly.
- **Speed is therefore exact**, which is what makes turn order evidence rather
  than a hint.
- **Cosmetic formes arrive under a forme name.** Gastrodon-East, Minior-Blue,
  Maushold-Four, Polteageist-Antique, Pikachu-Alola and others are filed under
  the base species. Look up the exact name first, then the base.
- **Two formes are decided by the item.** Zacian plus Rusted Sword is
  Zacian-Crowned: Fairy/Steel instead of Fairy, 148 base Speed instead of 138.
  Same for Zamazenta. The generator reports the *base* name, so resolving
  through the item is required or both the type chart and the speed check go
  wrong. Handled by `dex.battle_forme`.
- **Six of 509 species reuse a role name** across sets with different movepools.
  The pkmn data unions them, which makes our pools slightly looser than the
  simulator's actual sets — the safe direction.
- **The two data sources have different shapes.** The simulator keys by id with a
  `sets` list and publishes no items (it picks those at runtime). pkmn keys by
  display name with a `roles` map and *does* give per-role item pools, derived by
  sampling. Those item pools are the single most useful thing we have for
  narrowing a set, which is why we use pkmn's copy.

## Build order

Tiers come from `docs/research.md`. Tier 1 is a useful tool on its own; Tier 2 is
where it gets strong.

- [x] 1. Research survey → `docs/research.md`
- [x] 2. Repo scaffold + this file
- [x] 3. Public dashboard → https://claude.ai/artifact/8pWEDEB4TewZaaZkbYvaAz
- [x] 4. Set data layer — exact spreads, stats, formes, role pools (34 tests green)
- [x] 5a. Delivery architecture settled and verified (browser engine, guest spectator)
- [x] 5. State reader — protocol → tracked position, Choice Scarf proof
- [x] 6. Set inference and world sampling
- [x] 7. Search layer — MCTS per world, pooled, blunder guards
- [x] 8. The page itself — watches your battle, ranked advice with reasons
- [ ] 9. Strength measurement → perceived rating  ← **current**

## Perceived rating

Not measured yet. Deliberately blank rather than guessed. Reference points for
when we do measure: Laplace self-reports a 2231 peak on this exact ladder, and
the strongest public baselines sit around strong-human level.

## How it's laid out

Everything the browser runs is at the repo root, because Pages serves static
files from there with no build step:

```
index.html          the page
app/                data.js, battle.js, infer.js, advisor.js, engine.js, showdown.js
engine/             the compiled search engine (committed; rebuild with scripts/build_wasm.sh)
data/               the set bundle (committed; rebuild with scripts/build_data.py)
assistant/          the Python layer — now a build-time generator and test oracle
tests/              python + js, including a full browser run against a live battle
```

The Python layer is no longer the runtime. Since everything moved into the
browser it generates `data/` and acts as the reference the JS port is checked
against — both are verified against the same 2,400 simulator sets.

## Measured

- Engine: ~43k positions/sec on mid-range phone hardware, 243 KB gzipped.
- Data bundle: 519 species, 954 moves, 56 KB gzipped.
- A full turn's advice on throttled phone hardware: **4 sampled sets, 48k
  positions, 600–900 ms.** Comfortably inside a turn.
- Choice Scarf check: no false claims across 40 real games and 521 turns.

## Open questions

- **Our own bench is invisible.** A spectator sees our side the way the opponent
  does. The search fills unseen slots with plausible guesses so the evaluation is
  sound, and the panel collapses any switch to a guessed teammate into one
  "Switch out" row rather than naming a Pokémon it can't see. Honest, but a
  one-tap "this is my lead's set" would make turn-1 advice much sharper.
- **Unseen bench generation** is the known weak point in every randbats bot, ours
  included. Sampled uniformly from the roster, which is at least unbiased.
- **Scarf recall is only lightly measured.** Precision is solid (no false claims
  in 521 turns) but random-move play rarely creates provable situations. Needs
  real ladder games.
- **No damage numbers in the panel yet.** The engine exposes them and it's one of
  the highest-value Tier 1 items; it just isn't wired to the UI.
