# What's already been built, and what's worth copying

Survey done 2026-10-08. Everything here was checked against the actual repo or
store listing, not just a description of it. Where a number is self-reported I
say so.

## The landscape in one paragraph

There are three kinds of thing out there. **Overlays** that sit on top of the
Showdown client and show you information (damage numbers, likely sets) but never
tell you what to do. **Full bots** that connect as a player and pick their own
moves — strong, but they play instead of you. And a thin middle layer of
**advisors** that try to tell a human what to click, which is what we want, and
which is the least developed of the three. The one advisor extension I found is
Gen 1 only and labelled experimental. So the gap we're filling is real: take the
engine quality of the strong bots and point it at a human instead of the ladder.

## The projects that matter

### Overlays (information, no recommendation)

**Showdex** — the big one, a browser extension, ~tens of thousands of users.
Injects itself into the Showdown client page by waiting for `window.app` to
exist, then renders a panel inside the battle room. Embeds a patched fork of
`@smogon/calc` and syncs field state automatically as the battle plays out.
Handles both the old Backbone client and the new Preact one. This is the
reference implementation for *how to get a panel into the client*, and it proves
the approach is accepted by the community rather than treated as cheating.

**Randbats Tooltip** — Firefox/Chrome extension, last updated Sept 2026. Adds
the likely abilities, items, moves and stats of a random battle Pokémon to its
hover tooltip, sourced from the `pkmn/randbats` dataset. Small, focused, and the
dataset behind it is the single most valuable free asset in this whole space
(more below).

**BattleHelper** — Tampermonkey userscript, self-described as beta. Pulls replays
and runs damage calcs on each new matchup. Interesting mainly because it shows a
userscript can do the job without shipping an extension.

### Full bots (they play; useful as engine references and as sparring partners)

**Foul Play** — the one to take seriously. Python, drives `poke-engine` (Rust,
Gen 9) for search. **It won the Gen 9 OU tournament at the PokéAgent Challenge
(NeurIPS 2025), 50–14 in the final, beating the reinforcement-learning entries.**
That result is the strongest evidence available that search beats learned
policies in this game right now. Supports singles in every generation. No
Dynamax or Z-moves.

**Laplace** — claims a 2231 peak on the Gen 9 random battle ladder (~83 GXE, top
1%), self-reported. Its README is unusually honest and is effectively a free
design document for exactly our problem. Architecture: read state with
`poke-env`, sample 8 complete opponent teams per turn from randbats usage data,
filter each against what's been revealed, search each world with `poke-engine`
MCTS at 150ms, pool the rankings, then veto known blunders with hard-coded
guards. A 368-feature value network re-ranks only the turns where the engine's
own evaluation is known to be weak. Near-tied moves get sampled rather than
always taking the top one.

**showdown-brain** — Gen 9 randbats, learned a win-probability function from
public ladder replays, one-ply expectimax on top. Ships pretrained models.
Benchmarks are 10-game batches, so the ~50% vs poke-env's heuristic bot means
very little.

**Percymon** — the 2015 Stanford CS221 project. Depth-2 minimax, ~5.5s per
decision. Historically important, now superseded, but its feature weights file is
a readable list of what humans thought mattered.

**Metamon / PokéChamp** — the academic baselines for the PokéAgent Challenge.
Metamon trained on ~5M reconstructed human battles plus 20M+ self-play games, up
to a 200M-parameter transformer, and released 30 checkpoints. Reaches strong-human
level. Enormous training cost; not something we reproduce, but the checkpoints are
public if we ever want a sparring partner.

**PsyMew** — gathers state, scores options, hands the final choice to a language
model. Notable because the Challenge results found language-model entries
generally trailed search and RL agents, with "panic behaviour" under time
pressure. Worth knowing so we don't repeat it.

### The one actual advisor

**Pokémon Showdown Battle Advisor** (Chrome Web Store) — shows the top 2 moves or
switches with confidence scores, live, during a battle. Exactly our product
shape. But: Gen 1 random battles only, and the listing calls it experimental.
Nobody has done this properly for Gen 9.

## Assets we get for free

These are the three things that change what's feasible, and I've verified all
three work from this machine:

1. **`pkmn/randbats` set data.** One 240KB JSON file for `gen9randombattle`, 509
   species. Reachable via `raw.githubusercontent.com`. Per species it gives the
   fixed level, the full ability/item pool, and then a set of **roles** — and each
   role carries its own tighter ability/item/tera/move pools. Example: Dragapult
   is level 77 and has three roles; "Fast Attacker" means Choice Specs and
   Infiltrator, "Fast Support" means Heavy-Duty Boots, "Tera Blast user" means
   Life Orb and Dragon Dance. So the moment you see one move you often collapse
   the item and ability to a single possibility. This is the backbone of opponent
   inference and it is a gift.

2. **`poke-engine`.** On PyPI, no prebuilt wheel, but it builds from source in
   **37 seconds** with the Rust toolchain already on this box. I built it and
   smoke-tested it: a Great Tusk vs Choice Specs Dragapult position ran
   **268,000 MCTS visits in one second on a single thread** and returned every
   legal action ranked with a visit share and an expected value. Gen 9 features
   are present (terastallization, tera types, Stellar). It also has
   `State.from_string` / string serialization, `calculate_damage`, and an
   iterative-deepening expectiminimax as an alternative to MCTS.

3. **Deterministic stats.** Random battle Pokémon use fixed levels and a fixed
   85/85/85/85/85/85 EV spread with neutral nature. That means the opponent's
   exact stats are computable from species alone — no spread guessing. Which in
   turn means **turn order is hard evidence**: if something outsped us when its
   base speed says it shouldn't have, it is holding a Choice Scarf. Laplace does
   exactly this. It's free information that doesn't exist in OU.

## The feature list, ranked

Scored two ways. **Lift** is how much I think it actually moves win rate.
**Cost** is build effort. Sorted so the top of each tier is where to start.

### Tier 1 — do these first, they're cheap and they're most of the value

| Feature | Lift | Cost | Notes |
|---|---|---|---|
| Read live battle state off the client | Essential | Low | Showdex proved the hook. Without this nothing else ships. |
| Exact damage numbers both ways | **Very high** | Low | `calculate_damage` is in the engine already. Humans misjudge rolls constantly; this alone fixes a lot of bad clicks. |
| Opponent role/set narrowing from randbats data | **Very high** | Low | The role structure does the hard work for us. One revealed move often pins the item. |
| Deterministic speed check → Scarf detection | High | Very low | Pure arithmetic on known levels. Catches the single most common blowout in the format. |
| MCTS search on a single best-guess opponent set | **Very high** | Low | Engine does it. 268k visits/sec measured. This is the core recommendation. |
| Ranked output with visit share as confidence | High | Very low | Already in `MctsResult`. Free. |
| Blunder guards (immunities, no-op moves, status on last mon) | High | Very low | ~30 lines of hard rules. Stops the embarrassing suggestions that destroy trust. |

### Tier 2 — the real strength gains, moderate effort

| Feature | Lift | Cost | Notes |
|---|---|---|---|
| Sample N opponent worlds, pool the rankings | **Very high** | Medium | This is the single biggest jump after Tier 1. Laplace uses 8. Turns one guess into a distribution. |
| Choice-lock tracking | High | Low-Med | Laplace found adding item statistics *without* this **lost 39% of games**. Do them together or not at all. |
| Revealed-info consistency filter on sampled worlds | High | Medium | Throw away any sampled team that contradicts what we've seen. |
| Unseen bench generation | Medium | Medium | Required for randbats (you never see their full roster). Laplace calls this its largest noise source — so expect it to be imperfect. |
| Threat list / "what kills me next turn" | Medium-High | Low | Cheap to compute from the same calcs, and it's the thing a human most wants to see on screen. |
| Explain *why* a move is recommended | Medium | Low | No win-rate effect, large trust effect. Makes it usable rather than a black box. |
| Tera timing logic (once per game, not on a coin flip) | Medium | Low | Copy Laplace's rule directly. |

### Tier 3 — worth it later

| Feature | Lift | Cost | Notes |
|---|---|---|---|
| Value network re-ranking on weak-eval turns | Medium | High | Laplace's 368 features, trained on self-play. Only pays off once the base is strong, and it's tuned to its own level. |
| Loss mining from saved replays | Medium | Medium | Cluster losses into signatures, use wins as control. This is a process, not a feature, and it's how you find real bugs. |
| Head-to-head change validation | Medium | Medium | 60+ game self-play with a Wilson interval before accepting any change. Cheap insurance against fooling ourselves. |
| Mixed-strategy root sampling | Low-Med | Low | Matters against opponents who read you. Mostly irrelevant on ladder. |

### Explicitly not doing

- **Language-model move choice.** The Challenge results are clear: it trails
  search, and it panics on the clock. The engine is better and faster.
- **Training our own policy from scratch.** Metamon spent 25M battles to reach
  strong-human. Foul Play beat RL agents with search alone.
- **Autoplaying the ladder.** You asked for help deciding, and a tool that
  advises a human is on much firmer ground than one that plays for you.
- **Deeper search for its own sake.** Laplace found extra search time gave no
  gain — the engine had already converged. Spend the time on better opponent
  modelling instead.

## What this says about our build

The ordering writes itself. Tier 1 is a working, genuinely useful tool and almost
all of it is wiring up things that already exist. Tier 2 is where we go from
"useful" to "strong", and the ordering inside it matters — world sampling first,
and choice-lock tracking must land with item inference rather than after it.

The architecture that falls out:

```
Showdown client (browser)
   │  battle protocol lines, read in-page
   ▼
thin overlay  ──websocket──►  local server
                                 │
                                 ├─ state tracker      (what we know)
                                 ├─ set inference      (what they probably have)
                                 ├─ world sampler      (N consistent possibilities)
                                 ├─ poke-engine MCTS   (search each world)
                                 └─ pool + guards      (one ranked answer)
                                 │
   ◄──────────ranked moves───────┘
```

Two things to settle as we go: the overlay has to survive both Showdown client
versions, and the whole loop needs to finish inside a turn timer, which at 268k
visits a second is not going to be the hard part.

## Sources

- [Showdex](https://github.com/doshidak/showdex) · [store listing](https://chromewebstore.google.com/detail/showdex/dabpnahpcemkfbgfbmegmncjllieilai)
- [Randbats Tooltip](https://addons.mozilla.org/en-US/firefox/addon/pkmn-randbats-tooltip/) · [pkmn/randbats data](https://github.com/pkmn/randbats)
- [BattleHelper](https://github.com/FullLifeGames/BattleHelper)
- [Foul Play](https://github.com/pmariglia/foul-play) · [poke-engine](https://github.com/pmariglia/poke-engine)
- [Laplace](https://github.com/influxtion/Laplace-Pokemon-Showdown-AI) · [site](https://www.trylaplaceai.com/)
- [showdown-brain](https://github.com/Blueshadow0107/showdown-brain)
- [Percymon report](https://varunramesh.com/content/documents/cs221-final-report.pdf) · [repo](https://github.com/rameshvarun/showdownbot)
- [Metamon](https://github.com/UT-Austin-RPL/metamon) · [PokéAgent Challenge](https://pokeagent.github.io/track1.html) · [paper](https://arxiv.org/abs/2603.15563)
- [PsyMew](https://www.smogon.com/forums/threads/psymew-open-source-ai-battle-bot-project.3781351/)
- [Battle Advisor extension](https://chromewebstore.google.com/detail/pok%C3%A9mon-showdown-battle-a/jplpafeoapffclcclpoaekblbjaobheb)
- [poke-env](https://poke-env.readthedocs.io/) · [Showdown rules](https://pokemonshowdown.com/rules)
