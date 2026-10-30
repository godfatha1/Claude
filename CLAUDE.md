# How to work on this

## Talking to me

- Plain words. No jargon, no buzzwords, no padding.
- Short answers. A few lines, not an essay.
- Say what changed and what it means. Skip the play-by-play.
- Don't dress things up. If something's broken or half-done, say so in a sentence.

## The project

A helper for Gen 9 random battles on Showdown. You type your Showdown name,
it finds your battle, watches it, and tells you what to click.

Runs entirely in the browser so it works on a phone. Hosted on GitHub Pages
from the repo root.

Read `STATE.md` before doing anything — it has every decision already made.

## Shipping

- Every change goes to the phone by default. Pushing to the branch is
  shipping: the phone server pulls it by itself (every 5 minutes and whenever
  the page is opened) and restarts itself if `serve.py` changed.
- Bump `VERSION` on every push. The panel shows it bottom right, which is how
  to tell the phone has the latest.
- After pushing, say it'll be on the phone within about 5 minutes. If a change
  can't reach the phone on its own, say exactly what's needed.
- **Right now it can't.** The phone runs the desktop session's own patches
  merged on top of 0.7.1, started with `--no-update` so the pull doesn't wipe
  them. Until those patches are folded into this branch, every push needs the
  desktop session to `git fetch` and `git merge` it on the phone. Say so.
