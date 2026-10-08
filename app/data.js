// The set data, and exact stats for any set.
//
// This is a port of the Python layer in `assistant/data/`, which is the one
// that's been checked move-for-move against 2,400 teams the real simulator
// generated. The rules here are the same rules; `tests/` keeps both honest.
//
// Why it matters: random battle spreads are nearly fixed, so an opponent's stats
// are computable rather than estimated. Get the arithmetic exactly right and
// something outspeeding you when it shouldn't is *proof* of a Choice Scarf. Get
// it slightly wrong and it's a hunch.

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

// Flags packed by scripts/build_data.py.
const FLAG_FIXED_DAMAGE = 1; // Seismic Toss, Night Shade, Dragon Rage
const FLAG_DAMAGE_CALLBACK = 2; // Counter, Super Fang, Endeavor, Ruination

const CATEGORY = ['Physical', 'Special', 'Status'];

// Exceptions the generator carves out by name.
const CRASH_MOVES = new Set(['axekick', 'highjumpkick', 'jumpkick', 'supercellslam']);
const SITRUS_HALVERS = new Set(['bellydrum', 'filletaway', 'shedtail']);
const SR_IGNORING_ITEMS = new Set(['leftovers', 'lifeorb']);
const PHYSICAL_TERA_ABILITIES = new Set(['contrary', 'defiant']);
const ATTACK_FREE_PHYSICAL = new Set(['bodypress', 'foulplay']);

/** Normalise any spelling to Showdown's id form. Same rule Showdown uses. */
export function toId(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export class Dex {
  constructor(bundle) {
    this.format = bundle.format;
    this.species = bundle.species;
    this.moves = bundle.moves;
    this.types = bundle.types;
    this.aliases = bundle.aliases;
    this.itemFormes = bundle.itemFormes;
  }

  static async load(url = 'data/gen9randombattle.json') {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`couldn't load set data (${response.status})`);
    return new Dex(await response.json());
  }

  /**
   * Find a species' data, by any spelling.
   *
   * Three steps, in order: resolve an item-led forme, try the exact name, then
   * fall back to the base species. Gastrodon-East and Minior-Blue arrive under a
   * forme name and are filed under the base; Zamazenta-Crowned has stats of its
   * own and keeps its own entry.
   */
  get(name, item = null) {
    const id = toId(name);
    if (item) {
      const forme = this.itemFormes[`${id}|${toId(item)}`];
      if (forme && this.species[forme]) return { id: forme, ...this.species[forme] };
    }
    if (this.species[id]) return { id, ...this.species[id] };
    const base = this.aliases[id];
    if (base && this.species[base]) return { id: base, ...this.species[base] };
    return null;
  }

  move(name) {
    const id = toId(name);
    const entry = this.moves[id];
    if (!entry) {
      // The bundle carries every move in the generation, so this should be
      // unreachable. If it ever fires, the spread rules below will quietly
      // compute the wrong Attack investment, so say so rather than limp on.
      if (!this._warned) this._warned = new Set();
      if (!this._warned.has(id)) {
        this._warned.add(id);
        console.warn(`[data] no move called "${name}" — stats for sets using it will be wrong`);
      }
      return null;
    }
    return {
      id,
      name: entry.n,
      category: CATEGORY[entry.c],
      basePower: entry.p,
      type: entry.t,
      priority: entry.pr ?? 0,
      fixedDamage: Boolean((entry.f ?? 0) & FLAG_FIXED_DAMAGE),
      damageCallback: Boolean((entry.f ?? 0) & FLAG_DAMAGE_CALLBACK),
    };
  }

  /** Plain damage multiplier for one attacking type against a defending pair. */
  effectiveness(attackingType, defendingTypes) {
    const attacker = String(attackingType).toUpperCase();
    let multiplier = 1;
    for (const defender of defendingTypes) {
      const row = this.types[String(defender).toUpperCase()];
      if (!row) continue;
      const value = row[attacker];
      multiplier *= value === undefined ? 1 : value;
    }
    return multiplier;
  }

  /** The same thing in the generator's step form: 2x is 1, 4x is 2, half is -1. */
  effectivenessSteps(attackingType, defendingTypes) {
    let multiplier = this.effectiveness(attackingType, defendingTypes);
    if (multiplier === 0) return 0;
    let steps = 0;
    while (multiplier > 1) { multiplier /= 2; steps += 1; }
    while (multiplier < 1) { multiplier *= 2; steps -= 1; }
    return steps;
  }

  /** Every role a species could be running that allows this move. */
  rolesWithMove(speciesData, moveName) {
    const id = toId(moveName);
    return Object.entries(speciesData.r)
      .filter(([, role]) => role.m.includes(id))
      .map(([name, role]) => ({ name, ...role }));
  }

  rolesWithItem(speciesData, itemName) {
    const id = toId(itemName);
    return Object.entries(speciesData.r)
      .filter(([, role]) => role.i.includes(id))
      .map(([name, role]) => ({ name, ...role }));
  }
}

// ------------------------------------------------------------------- stats

const trunc = (x) => Math.trunc(x);

/** Showdown's own stat arithmetic, truncation points included. */
export function computeStat(base, iv, ev, level, isHp) {
  if (isHp) return trunc(trunc(2 * base + iv + trunc(ev / 4) + 100) * level / 100 + 10);
  return trunc(trunc(2 * base + iv + trunc(ev / 4)) * level / 100 + 5);
}

/** Random battles always use a neutral nature, so there's no nature step. */
export function computeStats(baseStats, level, evs, ivs) {
  return STAT_KEYS.map((key, i) =>
    computeStat(baseStats[i], ivs[i] ?? 31, evs[i] ?? 85, level, key === 'hp'));
}

/**
 * Whether the generator zeroes this set's Attack to blunt confusion damage.
 *
 * True when nothing in the set reads the user's Attack stat at all.
 */
function wantsNoAttack(dex, speciesData, speciesId, ability, moves) {
  const moveIds = new Set(moves.map(toId));
  if (moveIds.has('transform')) return false;

  const abilityId = toId(ability);
  const baseId = speciesData.base ?? speciesId;

  for (const moveId of moveIds) {
    const move = dex.move(moveId);
    // An unknown move can't be ruled out, so assume it wants Attack.
    if (!move) return false;
    // Seismic Toss and friends don't read the stat.
    if (move.fixedDamage || move.damageCallback) continue;
    // Can land as physical, so it wants the stat.
    if (moveId === 'shellsidearm') return false;

    if (moveId === 'terablast') {
      const physicalTera = baseId === 'porygon2'
        || PHYSICAL_TERA_ABILITIES.has(abilityId)
        || moveIds.has('shiftgear')
        || speciesData.b[1] > speciesData.b[3]; // base atk > base spa
      if (physicalTera) return false;
      continue;
    }

    if (move.category === 'Physical' && !ATTACK_FREE_PHYSICAL.has(moveId)) return false;
  }
  return true;
}

/**
 * Walk HP EVs down the way the generator does.
 *
 * Most Pokémon weak to Stealth Rock give up a little HP so the chip damage
 * divides evenly, which buys an extra switch-in. A few sets instead want HP that
 * makes Sitrus Berry fire at the right moment. Ported step for step, because
 * getting HP wrong puts every damage number out.
 */
function tunedHpEvs(dex, speciesData, level, ability, item, moves) {
  const abilityId = toId(ability);
  const itemId = toId(item);
  const moveIds = new Set(moves.map(toId));

  const rockImmune = abilityId === 'magicguard' || itemId === 'heavydutyboots';
  let srWeakness = rockImmune ? 0 : dex.effectivenessSteps('ROCK', speciesData.t);
  for (const m of moveIds) if (CRASH_MOVES.has(m)) { srWeakness = 2; break; }

  let evsHp = 85;
  const baseHp = speciesData.b[0];
  const isMinior = (speciesData.base ?? '') === 'minior';

  while (evsHp > 1) {
    const hp = computeStat(baseHp, 31, evsHp, level, true);

    if ((moveIds.has('substitute') && itemId === 'sitrusberry') || isMinior) {
      // Two Substitutes should trigger Sitrus Berry; Minior wants Shields Down
      // to survive two sets of hazards.
      if (hp % 4 === 0) break;
    } else if ([...SITRUS_HALVERS].some((m) => moveIds.has(m))
               && (itemId === 'sitrusberry' || abilityId === 'gluttony')) {
      if (hp % 2 === 0) break;
    } else if (moveIds.has('substitute') && moveIds.has('endeavor')) {
      if (hp % 4 > 0) break;
    } else {
      if (srWeakness <= 0 || abilityId === 'regenerator' || SR_IGNORING_ITEMS.has(itemId)) break;
      const divisor = Math.trunc(4 / srWeakness);
      if (itemId !== 'sitrusberry' && hp % divisor > 0) break;
      if (itemId === 'sitrusberry' && hp % divisor === 0) break;
    }
    evsHp -= 4;
  }
  return evsHp;
}

/** The exact EVs and IVs a set like this gets. */
export function spreadFor(dex, speciesData, speciesId, level, ability, item, moves) {
  const evs = [85, 85, 85, 85, 85, 85];
  const ivs = [31, 31, 31, 31, 31, 31];

  evs[0] = tunedHpEvs(dex, speciesData, level, ability, item, moves);

  if (wantsNoAttack(dex, speciesData, speciesId, ability, moves)) {
    evs[1] = 0;
    ivs[1] = 0;
  }

  const moveIds = new Set(moves.map(toId));
  if (moveIds.has('gyroball') || moveIds.has('trickroom')) {
    evs[5] = 0;
    ivs[5] = 0;
  }
  return { evs, ivs };
}

/** Exact stats for a concrete set. Returns [hp, atk, def, spa, spd, spe]. */
export function statsFor(dex, speciesData, speciesId, level, ability, item, moves) {
  const { evs, ivs } = spreadFor(dex, speciesData, speciesId, level, ability, item, moves);
  return computeStats(speciesData.b, level, evs, ivs);
}

export { STAT_KEYS };
