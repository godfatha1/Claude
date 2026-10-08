# Session state

Kept current so work can resume after a context reset without re-deriving
anything. If you're picking this up cold, read this file then `docs/research.md`.

**Version:** 0.1.0
**Branch:** `claude/pokemon-showdown-assistant-3xna06`
**Last updated:** 2026-10-08
**Dashboard:** https://claude.ai/artifact/8pWEDEB4TewZaaZkbYvaAz
  (published private by default — needs sharing turned on from the page's Share menu
   to be reachable without a sign-in)

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
- **Delivery is a thin in-page overlay + local server.** Overlay reads battle
  state in the browser and relays protocol lines; all thinking happens locally in
  Python where the engine lives. Showdex proves the in-page hook works.
- **Choice-lock tracking ships with item inference, not after it.** Laplace
  measured a 39% game loss from adding item stats without it.

## Environment facts worth not rediscovering

- Python 3.13.16, Node 22.22, Rust/cargo 1.97 all present.
- `poke-engine` has **no prebuilt wheel** — must build from source:
  `pip install poke-engine==0.0.48 --no-binary poke-engine`
- Egress proxy blocks `pkmn.github.io` and `data.pkmn.cc`; `raw.githubusercontent.com` works.
- Engine state string format confirmed, comma-separated, `=` separates the two sides.

## Build order

Tiers come from `docs/research.md`. Tier 1 is a useful tool on its own; Tier 2 is
where it gets strong.

- [x] 1. Research survey → `docs/research.md`
- [x] 2. Repo scaffold + this file
- [x] 3. Public dashboard → https://claude.ai/artifact/8pWEDEB4TewZaaZkbYvaAz
- [ ] 4. Set data layer (randbats fetch/cache, deterministic stat computation)  ← **current**
- [ ] 5. State reader (protocol lines → tracked battle state)
- [ ] 6. Set inference + world sampling (role narrowing, scarf detection, N worlds)
- [ ] 7. Search layer (MCTS per world, pool, blunder guards, ranked output)
- [ ] 8. Live overlay in the client
- [ ] 9. Strength measurement → perceived rating on the dashboard

## Perceived rating

Not measured yet. Deliberately blank rather than guessed. Reference points for
when we do measure: Laplace self-reports a 2231 peak on this exact ladder, and
the strongest public baselines sit around strong-human level.

## Open questions

- Which Showdown client build to target first — the overlay needs to handle both
  the Backbone and Preact clients eventually.
- How many sampled worlds before the clock becomes the constraint. Laplace uses 8
  at 150ms each; we have more headroom per world than that.
- Unseen bench generation is the known weak point in every randbats bot. No
  better idea than the standard one yet.
