# Randbats Assistant

A live decision helper for Gen 9 random battles on Pokémon Showdown. It watches
the battle you're already playing, works out what the other side is likely
holding, searches the position, and tells you what to click — and why.

It advises. It does not play for you, and it never touches your account.

**Build status:** [dashboard](https://claude.ai/artifact/8pWEDEB4TewZaaZkbYvaAz)

## Why random battles specifically

The format hands you two things no other format does:

- **Published sets.** Every species' possible roles, items, abilities, tera types
  and moves are a matter of public record. Seeing one move usually narrows the
  rest sharply.
- **Fixed stats.** Levels and spreads are fixed, so the opponent's exact stats
  are computable from the species alone. That makes turn order hard evidence: if
  something outsped you when it shouldn't have, it's holding a Choice Scarf.

Together they turn the hardest part of the problem — guessing what you're up
against — from an estimate into something closer to arithmetic.

## How it works

```
Showdown client (your browser)
   │  battle protocol, read in-page
   ▼
thin overlay  ──websocket──►  local server
                                 │
                                 ├─ state tracker   what we know
                                 ├─ set inference   what they probably have
                                 ├─ world sampler   several consistent possibilities
                                 ├─ search          each world, in the engine
                                 └─ pool + guards   one ranked answer
                                 │
   ◄──────────ranked moves───────┘
```

Nothing leaves your machine. The search runs locally.

## Layout

```
assistant/     the thinking: data, state, inference, search, server
overlay/       the in-page panel
docs/          research notes and design decisions
dashboard/     the status page
scripts/       setup and maintenance
tests/
```

## Reading order

1. `docs/research.md` — what already exists out there, and what's worth copying
2. `STATE.md` — decisions already settled, and what's next
