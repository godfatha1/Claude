// Turning "what we know" into "several things it could be".
//
// The opponent's position is the hard half of the problem, and the published set
// data makes it tractable: a species has a handful of named roles, and each role
// pins down its own item, ability, tera type and move pool. One revealed move
// often collapses the options to one.
//
// What we can't collapse, we sample. Rather than searching a single best guess
// and trusting it, the search runs over several complete, self-consistent
// versions of their team and the rankings get pooled. That turns a guess into a
// distribution, and it's the single biggest gain after getting damage numbers
// right.
//
// One rule throughout: the published pools are derived from sampling, so they
// can be incomplete. Where what we've seen contradicts every candidate, fall
// back to the wider pool rather than concluding the set is impossible. Ruling
// out the truth is worse than knowing nothing.

import { statsFor, toId } from './data.js';

/** Deterministic generator, so the same position gives the same advice. */
function makeRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

const pick = (list, random) => list[Math.floor(random() * list.length)];

/** Pick from a list by weight. Falls back to an even pick without weights. */
function pickWeighted(list, weights, random) {
  if (!list.length) return undefined;
  if (!weights || weights.length !== list.length) return pick(list, random);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return pick(list, random);
  let r = random() * total;
  for (let i = 0; i < list.length; i++) { r -= weights[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}

/**
 * Fill the open move slots the way the generator would: moves the role always
 * has go in first, the rest are drawn by how often they actually turn up.
 */
function fillMoves(role, known, random) {
  const moves = [...known];
  if (!role) return moves;
  // Without counts, four picked evenly from the pool.
  const f = (m) => (role.mf ? role.mf[role.m.indexOf(m)] : Math.min(1, 4 / role.m.length));
  const open = role.m.filter((m) => !moves.includes(m));
  for (const m of open.filter((m) => f(m) >= 0.999)) { if (moves.length < 4) moves.push(m); }
  let rest = open.filter((m) => f(m) < 0.999);
  while (moves.length < 4 && rest.length) {
    const m = pickWeighted(rest, rest.map(f), random);
    moves.push(m);
    rest = rest.filter((x) => x !== m);
  }
  return moves;
}

/**
 * One self-consistent guess at a Pokémon's set.
 *
 * Everything revealed is kept as-is; the rest is drawn from whichever roles are
 * still possible.
 */
function sampleSet(dex, mon, random, { teraNow = false } = {}) {
  if (!mon.data) return mon.bestGuessSet();

  // Which set it's running, weighted by how often each one comes up and how
  // well it fits what's been seen — the same odds the panel shows.
  const odds = mon.roleOdds();
  const role = odds.length ? pickWeighted(odds.map((o) => o.role), odds.map((o) => o.p), random) : null;

  // Seen and confirmed moves are facts. A move you've called for this turn
  // goes first so it can never be the one cut when there are more than four.
  const known = [...mon.revealedMoves.keys()];
  if (mon.nextMove) known.sort((a, b) => (b === mon.nextMove) - (a === mon.nextMove));
  const moves = fillMoves(role, known, random);

  // Seen or confirmed beats the pool; so does a proven Scarf, and so does an
  // item that's the only one any of its sets carry.
  let item;
  if (mon.itemKnownGone) item = '';
  else if (mon.item) item = toId(mon.item);
  else if (mon.hasScarf) item = 'choicescarf';
  else if (role?.i?.length) item = toId(pickWeighted(role.i, role.if, random));
  else item = toId(pick(mon.data.I?.length ? mon.data.I : [''], random) ?? '');

  const ability = mon.ability
    ? toId(mon.ability)
    : role?.a?.length
      ? toId(pickWeighted(role.a, role.af, random))
      : toId(pick(mon.data.A?.length ? mon.data.A : [''], random) ?? '');

  const teraType = mon.teraType
    ? toId(mon.teraType)
    : toId((role?.t?.length ? pickWeighted(role.t, role.tf, random) : '') ?? '');

  const stats = statsFor(dex, mon.data, mon.id, mon.level, ability, item, moves);
  const maxhp = stats[0];
  const hp = mon.fainted ? 0
    : mon.hpIsExact && mon.hpExact != null ? mon.hpExact
    : Math.max(1, Math.round(maxhp * mon.hpPercent / 100));

  // "What if I Tera right now?" — the position as it would be after clicking
  // it, so the search and the damage numbers both answer that question.
  const terastallized = mon.terastallized || (teraNow && Boolean(teraType));

  return {
    id: mon.id,
    level: mon.level,
    types: terastallized && teraType ? [teraType.toUpperCase()] : mon.types,
    hp,
    maxhp,
    ability,
    item,
    stats,
    status: mon.status,
    teraType,
    terastallized,
    weight: mon.data.w ?? 0,
    moves: moves.slice(0, 4),
    // Showdown's own word on our side, a worked-out Choice lock on theirs.
    disabled: mon.disabledMoves(moves.slice(0, 4)),
    pp: moves.slice(0, 4).map((m) => mon.pp.get(m) ?? 16),
    restTurns: mon.restTurns,
    sleepTurns: mon.sleepTurns,
  };
}

/**
 * Invent a bench slot we've never seen.
 *
 * This is the weakest part of reading any random battle and every bot that plays
 * the format says so: you never see the opposing roster, so the slots have to be
 * made up, and a made-up Pokémon is as likely to mislead as to help. Sampled
 * uniformly from species not yet on the field, which is at least unbiased.
 *
 * The alternative — leaving the slot empty — is worse: the engine would think
 * they have fewer switches than they do and quietly overrate our position.
 */
function sampleUnseen(dex, excludeIds, random) {
  const candidates = Object.keys(dex.species).filter((id) => !excludeIds.has(id));
  if (!candidates.length) return null;
  const id = pick(candidates, random);
  const entry = dex.species[id];
  const role = Object.values(entry.r ?? {})[0];
  if (!role) return null;

  const moves = (role.m ?? []).slice(0, 4);
  const ability = role.a?.[0] ?? entry.A?.[0] ?? '';
  const item = role.i?.[0] ?? entry.I?.[0] ?? '';
  const stats = statsFor(dex, entry, id, entry.l, ability, item, moves);

  return {
    id,
    level: entry.l,
    types: entry.t,
    hp: stats[0],
    maxhp: stats[0],
    ability: toId(ability),
    item: toId(item),
    stats,
    status: 'none',
    teraType: toId(role.t?.[0] ?? ''),
    terastallized: false,
    weight: entry.w ?? 0,
    moves,
    disabled: [],
    restTurns: 0,
    sleepTurns: 0,
  };
}

/** Field and hazards, which are the same in every sampled world. */
function fieldFrom(battle) {
  const conditionsOf = (side) => ({
    stealthRock: side.conditions.stealthRock,
    spikes: side.conditions.spikes,
    toxicSpikes: side.conditions.toxicSpikes,
    stickyWeb: side.conditions.stickyWeb,
    reflect: side.conditions.reflect,
    lightScreen: side.conditions.lightScreen,
    auroraVeil: side.conditions.auroraVeil,
    tailwind: side.conditions.tailwind,
    safeguard: side.conditions.safeguard,
    toxicCount: side.conditions.toxicCount,
  });
  const boostsOf = (side) => {
    const a = side.active;
    return a
      ? [a.boosts.atk, a.boosts.def, a.boosts.spa, a.boosts.spd, a.boosts.spe,
         a.boosts.accuracy, a.boosts.evasion]
      : [0, 0, 0, 0, 0, 0, 0];
  };
  return {
    weather: battle.weather,
    weatherTurns: battle.weatherTurns,
    terrain: battle.terrain,
    terrainTurns: battle.terrainTurns,
    trickRoom: battle.trickRoom,
    trickRoomTurns: battle.trickRoomTurns,
    ourConditions: conditionsOf(battle.us),
    theirConditions: conditionsOf(battle.them),
    ourBoosts: boostsOf(battle.us),
    theirBoosts: boostsOf(battle.them),
  };
}

/**
 * Build several complete, consistent versions of the position.
 *
 * Our own side gets sampled too. A spectator sees our team the way the opponent
 * does, so our unrevealed moves are as uncertain as theirs — sampling both keeps
 * the search honest about that instead of pretending we know.
 */
export function sampleWorlds(dex, battle, { count = 4, seed = null, teraNow = false } = {}) {
  const random = makeRandom(seed ?? (battle.turn * 7919 + battle.log.length));
  const field = fieldFrom(battle);

  const worlds = [];
  for (let w = 0; w < count; w++) {
    const buildSide = (side) => {
      const seen = new Set(side.team.map((m) => m.id));
      // Only our active can be the one we're about to Tera.
      const team = side.team.map((mon) =>
        sampleSet(dex, mon, random, { teraNow: teraNow && side === battle.us && mon === side.active }));
      const seenCount = team.length;

      // Fill the slots we haven't seen. This has to happen for *both* sides,
      // including ours: a spectator sees our bench no sooner than the opponent
      // does, and leaving those slots empty would tell the engine we have fewer
      // Pokémon left than we really do, which quietly makes every position look
      // worse than it is.
      //
      // The cost is that the engine can recommend switching to a teammate we
      // invented. That's handled where the options are presented, not here —
      // the search needs the resources to be right, and the panel needs to not
      // name a Pokémon it cannot see.
      const missing = Math.max(0, Math.min(6, side.teamSize) - team.length);
      for (let i = 0; i < missing; i++) {
        const invented = sampleUnseen(dex, seen, random);
        if (invented) { team.push(invented); seen.add(invented.id); }
      }

      return {
        active: Math.max(0, side.team.indexOf(side.active)),
        pokemon: team.slice(0, 6),
        // Slots at or past this index are guesses, not sightings.
        seenCount,
      };
    };

    const ours = buildSide(battle.us);
    const theirs = buildSide(battle.them);

    // What's happening to each active right now — an Encore, a Substitute,
    // being trapped — is the same in every world, and the engine models all of
    // it. It just has to be told.
    const ourSlot = battle.slotFactsFor(battle.us);
    const theirSlot = battle.slotFactsFor(battle.them);

    worlds.push({
      ours: { ...ours, boosts: field.ourBoosts, ...field.ourConditions, ...ourSlot },
      theirs: {
        ...theirs, boosts: field.theirBoosts, ...field.theirConditions, ...theirSlot,
        // The move you've called for them: the search answers it directly.
        rootMove: battle.them.active?.nextMove ?? '',
      },
      // Carried alongside so the panel knows which switches it may name.
      seenOurs: new Set(battle.us.team.map((m) => m.id)),
      weather: field.weather,
      weatherTurns: field.weatherTurns,
      terrain: field.terrain,
      terrainTurns: field.terrainTurns,
      trickRoom: field.trickRoom,
      trickRoomTurns: field.trickRoomTurns,
    });
  }
  return worlds;
}

/** What we think the opponent's active is, in a form the panel can show. */
export function readOpponent(battle) {
  const mon = battle.them.active;
  if (!mon) return null;
  const roles = mon.candidateRoles();
  const range = mon.speedRange();

  // Items still possible, narrowed by the surviving roles.
  const itemPool = new Set();
  for (const role of roles) for (const item of role.i ?? []) itemPool.add(item);

  const abilityPool = new Set();
  for (const role of roles) for (const a of role.a ?? []) abilityPool.add(a);

  // Seen in the battle, as opposed to confirmed by tapping.
  const seenMoves = [...mon.revealedMoves.entries()]
    .filter(([id, count]) => count > 0 || !mon.confirmed.moves.has(id))
    .map(([id]) => id);

  const moveOdds = mon.moveOdds();
  const itemOdds = mon.itemOdds();
  const abilityOdds = mon.abilityOdds();
  const toObject = (map) => Object.fromEntries([...map].map(([k, v]) => [k, Math.round(v * 100) / 100]));

  return {
    species: mon.speciesName,
    level: mon.level,
    hpPercent: Math.round(mon.hpPercent),
    status: mon.status,
    revealed: seenMoves,
    confirmedMoves: [...mon.confirmed.moves],
    roles: roles.map((r) => r.name),
    pinned: roles.length === 1,
    item: mon.item,
    itemGone: mon.itemKnownGone,
    // The only item / ability any of its possible sets has: taken as known
    // until something says otherwise.
    assumedItem: mon.assumedItem,
    assumedAbility: mon.assumedAbility,
    // Chance of each, 0–1.
    moveOdds: toObject(moveOdds),
    itemOdds: toObject(itemOdds),
    abilityOdds: toObject(abilityOdds),
    // The move you've called for this turn.
    nextMove: mon.nextMove,
    itemConfirmed: mon.confirmed.item,
    itemSeen: Boolean(mon.item) && !mon.confirmed.item,
    scarfProven: mon.scarfProven,
    possibleItems: mon.item ? [toId(mon.item)]
      : [...itemPool].sort((a, b) => (itemOdds.get(b) ?? 0) - (itemOdds.get(a) ?? 0)),
    ability: mon.ability,
    abilityConfirmed: mon.confirmed.ability,
    abilitySeen: Boolean(mon.ability) && !mon.confirmed.ability,
    possibleAbilities: mon.ability ? [toId(mon.ability)]
      : [...abilityPool].sort((a, b) => (abilityOdds.get(b) ?? 0) - (abilityOdds.get(a) ?? 0)),
    speed: range ? (range.min === range.max ? `${range.max}` : `${range.min}–${range.max}`) : null,
    volatiles: [...mon.volatiles],
    // Moves it could still be holding that we haven't seen or confirmed.
    // Likeliest first.
    unseenMoves: [...new Set(roles.flatMap((r) => r.m))]
      .filter((m) => !mon.revealedMoves.has(m))
      .sort((a, b) => (moveOdds.get(b) ?? 0) - (moveOdds.get(a) ?? 0)),
  };
}
