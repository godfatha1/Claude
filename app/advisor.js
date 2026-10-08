// Searching the sampled worlds and pooling them into one answer.
//
// Each world is searched on its own, then the rankings are combined. Pooling
// matters: a move that's excellent against one possible set and catastrophic
// against another should not come out ahead of one that's solid against both,
// and only pooling across worlds shows that difference.
//
// After pooling, a short list of hard rules vetoes known blunders. The engine is
// strong but it occasionally suggests something obviously wrong, and a single
// obviously wrong suggestion costs more trust than ten good ones earn.

import { sampleWorlds } from './infer.js';
import { toId } from './data.js';

/**
 * How much searching to do, by device.
 *
 * The budget is in positions, not milliseconds, so the same position gives the
 * same advice on a phone as on a desktop. We can afford that because the search
 * converges early: measured across a desktop at 300,000 positions and a slow
 * phone at 20,000, the top move and its confidence barely move. See
 * docs/browser-engine.md.
 */
export const BUDGETS = {
  quick: { worlds: 3, perWorld: 6000 },
  normal: { worlds: 4, perWorld: 12000 },
  deep: { worlds: 6, perWorld: 25000 },
};

export class Advisor {
  constructor(dex, engine) {
    this.dex = dex;
    this.engine = engine;
    this.lastResult = null;
  }

  /**
   * Work out what to click.
   *
   * Returns the ranked actions with a reason for each, or null if the position
   * isn't ready to search yet.
   */
  advise(battle, { budget = 'normal' } = {}) {
    const plan = BUDGETS[budget] ?? BUDGETS.normal;
    if (!battle.us.active || !battle.them.active) return null;

    const worlds = sampleWorlds(this.dex, battle, { count: plan.worlds });
    const searched = [];
    const started = performance.now();

    for (const world of worlds) {
      try {
        searched.push(this.engine.search(world, plan.perWorld));
      } catch (err) {
        // One bad world shouldn't lose the turn's advice.
        console.warn('[advisor] a world failed to search:', err.message);
      }
    }
    if (!searched.length) return null;

    const pooled = this.pool(searched);
    const named = this.collapseUnseenSwitches(pooled, battle);
    const guarded = this.applyGuards(named, battle);
    const result = {
      actions: guarded,
      worlds: searched.length,
      positions: searched.reduce((sum, r) => sum + (r.totalVisits ?? 0), 0),
      elapsedMs: Math.round(performance.now() - started),
      budget,
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Combine per-world rankings into one.
   *
   * Averaging the share each action got is the straightforward part. The number
   * that matters more is the *worst* world: an action that wins big in three
   * worlds and loses the game in the fourth is a gamble, and the panel should
   * say so rather than hide it behind a good average.
   */
  pool(results) {
    const byChoice = new Map();

    for (const result of results) {
      for (const option of result.ours ?? []) {
        let entry = byChoice.get(option.choice);
        if (!entry) {
          entry = { choice: option.choice, shares: [], values: [], visits: 0 };
          byChoice.set(option.choice, entry);
        }
        entry.shares.push(option.share ?? 0);
        entry.values.push(option.value ?? 0);
        entry.visits += option.visits ?? 0;
      }
    }

    const worldCount = results.length;
    const pooled = [...byChoice.values()].map((entry) => {
      // An action missing from a world got no search there, which is itself
      // information — count it as zero rather than skipping it.
      while (entry.shares.length < worldCount) entry.shares.push(0);
      while (entry.values.length < worldCount) entry.values.push(0);

      const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
      return {
        choice: entry.choice,
        share: mean(entry.shares),
        value: mean(entry.values),
        worstValue: Math.min(...entry.values),
        bestValue: Math.max(...entry.values),
        visits: entry.visits,
        vetoed: null,
      };
    });

    pooled.sort((a, b) => b.share - a.share);
    return pooled;
  }

  /**
   * Fold switches to teammates we haven't seen into one honest row.
   *
   * The search needs our full team to evaluate the position properly, so unseen
   * bench slots get filled with plausible guesses. But the panel must never tell
   * you to switch to a Pokémon it invented — you'd go looking for it and it
   * wouldn't be there.
   *
   * So every switch to a slot we've actually watched come in keeps its name, and
   * the rest collapse into a single "switch to your bench" row carrying the best
   * score among them. You know your own team; it doesn't. Saying "switching is
   * right, you pick who" is the truthful version of this advice.
   */
  collapseUnseenSwitches(actions, battle) {
    const seen = new Set(battle.us.team.filter((m) => !m.fainted).map((m) => m.id));
    const named = [];
    const unseen = [];

    for (const action of actions) {
      if (!action.choice.startsWith('switch ')) { named.push(action); continue; }
      const target = toId(action.choice.slice(7));
      // An empty engine slot serializes as "none"; those are never real.
      if (target && target !== 'none' && seen.has(target)) named.push(action);
      else unseen.push(action);
    }

    if (unseen.length) {
      const best = unseen.reduce((a, b) => (b.share > a.share ? b : a));
      named.push({
        ...best,
        // Sum the share: the engine split its attention across several guessed
        // teammates, but they stand for one decision — whether to switch at all.
        share: unseen.reduce((sum, a) => sum + a.share, 0),
        choice: 'switch *',
        unnamedSwitch: true,
        alternatives: unseen.length,
      });
    }

    return named.sort((a, b) => b.share - a.share);
  }

  /**
   * Veto the suggestions that are simply wrong.
   *
   * Short and hard-coded on purpose. These are the mistakes that destroy
   * confidence in a tool instantly, and none of them needs a search to spot.
   */
  applyGuards(actions, battle) {
    const ourActive = battle.us.active;
    const theirActive = battle.them.active;
    const aliveBench = battle.us.team.filter((m) => m !== ourActive && !m.fainted).length;

    for (const action of actions) {
      if (action.choice.startsWith('switch')) {
        // Count what we know is left, plus the slots we have not seen yet —
        // those are teammates too, even though we cannot name them.
        const unseenAlive = Math.max(0, Math.min(6, battle.us.teamSize) - battle.us.team.length);
        if (aliveBench + unseenAlive === 0) action.vetoed = 'nothing left to switch to';
        continue;
      }

      const move = this.dex.move(action.choice);
      if (!move) continue;

      // Clicking into an immunity.
      if (move.category !== 'Status' && theirActive?.types?.length) {
        const defending = theirActive.terastallized && theirActive.teraType
          ? [toId(theirActive.teraType).toUpperCase()]
          : theirActive.types;
        if (this.dex.effectiveness(move.type, defending) === 0) {
          action.vetoed = `${theirActive.speciesName} is immune to ${move.type.toLowerCase()}`;
          continue;
        }
      }

      // A status move on our last Pokémon, when it can't afford the turn.
      if (move.category === 'Status' && aliveBench === 0 && ourActive?.hpPercent <= 25) {
        action.vetoed = 'last Pokémon and low — this spends the turn for nothing';
        continue;
      }
    }

    // Vetoed actions drop below everything playable, but stay visible so the
    // panel can say why rather than silently hiding an option.
    return actions.sort((a, b) => {
      if (Boolean(a.vetoed) !== Boolean(b.vetoed)) return a.vetoed ? 1 : -1;
      return b.share - a.share;
    });
  }

  /**
   * Put the recommendation into words.
   *
   * No effect on win rate, large effect on whether the thing is usable. A number
   * with no reason attached is a black box, and a black box is hard to trust and
   * impossible to argue with.
   */
  explain(action, result, battle) {
    if (action.vetoed) return action.vetoed;

    const reasons = [];
    const isSwitch = action.choice.startsWith('switch ');
    const confidence = Math.round(action.share * 100);

    if (confidence >= 60) reasons.push('clearly ahead of the alternatives');
    else if (confidence >= 35) reasons.push('the best of several close options');
    else reasons.push('a narrow call');

    // The spread across worlds is the honest part: it says how much of this
    // rests on guessing their set right.
    const spread = action.bestValue - action.worstValue;
    if (spread > 0.25) {
      reasons.push(`but it swings a lot depending on their set (${Math.round(action.worstValue * 100)}–${Math.round(action.bestValue * 100)}%)`);
    }

    if (action.unnamedSwitch) {
      reasons.push('switching out beats staying in — but it can only see the '
                 + 'Pokémon you have already shown, so pick the best fit yourself');
    } else if (isSwitch) {
      const name = action.choice.replace(/^switch /, '');
      reasons.push(`going to ${name} keeps more options open than staying in`);
    } else {
      const move = this.dex.move(action.choice);
      const them = battle.them.active;
      if (move && them?.types?.length && move.category !== 'Status') {
        const multiplier = this.dex.effectiveness(move.type, them.types);
        if (multiplier >= 2) reasons.push(`${move.name} is super effective`);
        else if (multiplier < 1) reasons.push(`${move.name} is resisted, but still the best line`);
      }
    }

    if (battle.them.active?.scarfProven) {
      reasons.push('their Choice Scarf is accounted for');
    }

    void result;
    return reasons.join(', ');
  }
}
