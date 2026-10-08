// Does the Choice Scarf check actually fire, and does it stay quiet when it should?
//
// The precision side is covered by check_state_reader.mjs, which plays real
// games and verifies every claim against the server's own teams. But a check
// that never fires would also pass that, so this one builds the exact situations
// by hand: cases where the order is genuine proof, and cases that look like
// proof but have another explanation.
//
// Each guard here exists because an earlier version got that case wrong.
import { readFileSync } from 'node:fs';
import { Dex, toId } from '../../app/data.js';
import { Battle } from '../../app/battle.js';

const dex = new Dex(JSON.parse(readFileSync('data/gen9randombattle.json', 'utf8')));

const SPEED_ABILITIES = new Set([
  'swiftswim', 'chlorophyll', 'sandrush', 'slushrush', 'surgesurfer',
  'unburden', 'quickfeet', 'speedboost', 'slowstart',
  'protosynthesis', 'quarkdrive', 'steamengine', 'motordrive',
  'weakarmor', 'rattled',
]);
const PRIORITY_ABILITIES = new Set([
  'prankster', 'galewings', 'triage', 'quickdraw', 'stall', 'myceliummight',
]);
const AWKWARD_ITEMS = new Set([
  'quickclaw', 'custapberry', 'laggingtail', 'fullincense',
  'ironball', 'machobrace', 'quickpowder', 'boosterenergy',
]);

/** A species whose speed is unambiguous: no odd abilities, items or slow sets. */
function isClean(entry) {
  const abilities = entry.A ?? [];
  if (abilities.some((a) => SPEED_ABILITIES.has(a) || PRIORITY_ABILITIES.has(a))) return false;
  if ((entry.I ?? []).some((i) => AWKWARD_ITEMS.has(i))) return false;
  for (const role of Object.values(entry.r ?? {})) {
    if (role.m.includes('trickroom') || role.m.includes('gyroball')) return false;
  }
  return Object.keys(entry.r ?? {}).length > 0;
}

/** Find a pair where a Scarf on the slower one would explain it moving first. */
function findProvablePair() {
  const clean = Object.entries(dex.species)
    .filter(([, e]) => isClean(e) && e.sp?.[1])
    .map(([id, e]) => ({ id, name: e.n, speed: e.sp[1], entry: e }));

  for (const slow of clean) {
    for (const fast of clean) {
      if (slow.id === fast.id) continue;
      // Slower normally, but fast enough with a Scarf to have gone first.
      if (slow.speed < fast.speed && Math.trunc(slow.speed * 1.5) >= fast.speed) {
        // Both need an ordinary attacking move with no priority.
        const slowMove = firstPlainMove(slow.entry);
        const fastMove = firstPlainMove(fast.entry);
        if (slowMove && fastMove) return { slow, fast, slowMove, fastMove };
      }
    }
  }
  return null;
}

function firstPlainMove(entry) {
  for (const role of Object.values(entry.r ?? {})) {
    for (const id of role.m) {
      const move = dex.move(id);
      if (move && move.priority === 0 && move.category !== 'Status'
          && !['grassyglide', 'pursuit', 'upperhand'].includes(id)) {
        return move;
      }
    }
  }
  return null;
}

/**
 * Build a protocol stream for one turn where `theirs` moves before `ours`.
 *
 * `extra` lets a case add field conditions that should make the order
 * unprovable.
 */
function stream({ ours, theirs, ourMove, theirMove, extra = [], ourLevel, theirLevel }) {
  return [
    '|player|p1|You|1|',
    '|player|p2|Them|2|',
    '|teamsize|p1|6',
    '|teamsize|p2|6',
    '|gametype|singles',
    '|gen|9',
    '|tier|[Gen 9] Random Battle',
    '|start',
    `|switch|p1a: ${ours}|${ours}, L${ourLevel}, M|100/100`,
    `|switch|p2a: ${theirs}|${theirs}, L${theirLevel}, F|100/100`,
    ...extra,
    '|turn|1',
    // Theirs goes first despite being slower.
    `|move|p2a: ${theirs}|${theirMove}|p1a: ${ours}`,
    `|-damage|p1a: ${ours}|70/100`,
    `|move|p1a: ${ours}|${ourMove}|p2a: ${theirs}`,
    `|-damage|p2a: ${theirs}|60/100`,
    '|upkeep',
    '|turn|2',
  ];
}

function run(lines) {
  const battle = new Battle(dex);
  for (const line of lines) battle.handle(line);
  return battle;
}

// ------------------------------------------------------------------ cases

const pair = findProvablePair();
if (!pair) {
  console.log('could not build a provable pair from the set data — check the bundle');
  process.exit(1);
}

const { slow, fast, slowMove, fastMove } = pair;
const base = {
  ours: fast.name,
  theirs: slow.name,
  ourMove: fastMove.name,
  theirMove: slowMove.name,
  ourLevel: fast.entry.l,
  theirLevel: slow.entry.l,
};

console.log(`using ${slow.name} (speed ${slow.speed}) moving before `
          + `${fast.name} (speed ${fast.speed})`);
console.log(`moves: ${slowMove.name} vs ${fastMove.name}\n`);

const results = [];
const expect = (label, got, want) => {
  const ok = got === want;
  results.push(ok);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label}${ok ? '' : ` (got ${got}, wanted ${want})`}`);
};

// 1. The plain case: this is real proof and must be caught.
{
  const battle = run(stream(base));
  const them = battle.sides.p2.active;
  expect('catches a Scarf the order proves', them.scarfProven, true);
  expect('says so in a note', battle.notes.some((n) => n.kind === 'scarf'), true);
}

// 2. Trick Room reverses the order, so it proves nothing.
{
  const battle = run(stream({
    ...base,
    extra: ['|-fieldstart|move: Trick Room'],
  }));
  expect('stays quiet under Trick Room', battle.sides.p2.active.scarfProven, false);
}

// 3. Tailwind doubles a side's speed, so it proves nothing.
{
  const battle = run(stream({
    ...base,
    extra: [`|-sidestart|p2: Them|move: Tailwind`],
  }));
  expect('stays quiet with Tailwind up', battle.sides.p2.active.scarfProven, false);
}

// 4. A priority move explains the order on its own.
{
  const battle = run({ ...base } && stream({ ...base, theirMove: 'Aqua Jet' }));
  expect('stays quiet on a priority move', battle.sides.p2.active.scarfProven, false);
}

// 5. Only one side moved, so there is no order to read.
{
  const lines = stream(base).filter((l) => !l.startsWith(`|move|p1a:`));
  const battle = run(lines);
  expect('stays quiet when only one side moved', battle.sides.p2.active.scarfProven, false);
}

// 6. A known item that is not a Scarf rules it out.
{
  const lines = stream(base);
  lines.splice(lines.indexOf('|turn|1'), 0, `|-item|p2a: ${slow.name}|Leftovers`);
  const battle = run(lines);
  expect('stays quiet when the item is already known', battle.sides.p2.active.scarfProven, false);
}

// 7. Grassy Glide gets its priority from the terrain, not the move.
{
  const battle = run(stream({ ...base, theirMove: 'Grassy Glide' }));
  expect('stays quiet on Grassy Glide', battle.sides.p2.active.scarfProven, false);
}

// 8. A species that could have a speed-altering ability is never provable.
{
  const paradox = Object.entries(dex.species)
    .find(([, e]) => (e.A ?? []).includes('protosynthesis') && e.sp?.[1] < fast.speed
                  && Math.trunc(e.sp[1] * 1.5) >= fast.speed);
  if (paradox) {
    const [, entry] = paradox;
    const move = firstPlainMove(entry);
    const battle = run(stream({
      ...base,
      theirs: entry.n,
      theirLevel: entry.l,
      theirMove: move?.name ?? slowMove.name,
    }));
    expect(`stays quiet on a Paradox ability (${entry.n})`,
      battle.sides.p2.active.scarfProven, false);
  } else {
    console.log('  skip  no suitable Paradox species for this pair');
  }
}

// 9. Once proven, the speed used afterwards reflects it.
{
  const battle = run(stream(base));
  const them = battle.sides.p2.active;
  const expected = Math.trunc(slow.speed * 1.5);
  expect('uses the scarfed speed afterwards', them.effectiveSpeed(), expected);
  expect('passes the Scarf to the engine',
    toId(them.bestGuessSet().item), 'choicescarf');
}

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
