// Check the browser data layer against the simulator's own generated teams.
//
// The Python layer in assistant/data/ is already verified against this exact
// fixture. This runs the JavaScript port over the same 2,400 sets so a mistake
// in the port shows up here rather than in a battle.
import { readFileSync } from 'node:fs';
import { Dex, spreadFor, computeStats, toId } from '../../site/app/data.js';

const bundle = JSON.parse(readFileSync('data/gen9randombattle.json', 'utf8'));
const fixture = JSON.parse(readFileSync('tests/fixtures/simulator_teams.json', 'utf8'));
const dex = new Dex(bundle);
const sets = fixture.teams;

let checked = 0;
const fail = { spread: [], stats: [], lookup: [], speed: [] };

for (const entry of sets) {
  const sp = dex.get(entry.speciesId, entry.item);
  if (!sp) { fail.lookup.push(entry.species); continue; }
  checked++;

  const { evs, ivs } = spreadFor(dex, sp, sp.id, entry.level, entry.ability, entry.item, entry.moves);

  for (let i = 0; i < 6; i++) {
    const key = ['hp','atk','def','spa','spd','spe'][i];
    if (evs[i] !== entry.evs[key] || ivs[i] !== entry.ivs[key]) {
      fail.spread.push(`${entry.species} (${entry.role}) ${key}: ours ${evs[i]}/${ivs[i]} vs sim ${entry.evs[key]}/${entry.ivs[key]} [item ${entry.item}, ability ${entry.ability}, moves ${entry.moves.join(',')}]`);
    }
  }

  const ours = computeStats(sp.b, entry.level, evs, ivs);
  const simEvs = ['hp','atk','def','spa','spd','spe'].map(k => entry.evs[k]);
  const simIvs = ['hp','atk','def','spa','spd','spe'].map(k => entry.ivs[k]);
  const theirs = computeStats(sp.b, entry.level, simEvs, simIvs);
  if (ours.join(',') !== theirs.join(',')) {
    fail.stats.push(`${entry.species}: ${ours} vs ${theirs}`);
  }

  // Speed is the number scarf detection rests on.
  const zeroed = entry.evs.spe === 0;
  const expected = zeroed ? sp.sp[0] : sp.sp[1];
  if (!zeroed || entry.evs.spe === 0) {
    // sp[] was precomputed at the level in OUR data, which can differ from the
    // snapshot's level, so only compare when the levels agree.
    if (sp.l === entry.level && theirs[5] !== expected) {
      fail.speed.push(`${entry.species} L${entry.level}: sim ${theirs[5]} vs precomputed ${expected}`);
    }
  }
}

const report = (name, list) => {
  if (!list.length) { console.log(`  ok  ${name}`); return 0; }
  console.log(`  FAIL ${name}: ${list.length}`);
  for (const line of [...new Set(list)].slice(0, 12)) console.log(`        ${line}`);
  return 1;
};

console.log(`browser data layer vs simulator (${checked} of ${sets.length} sets)`);
let bad = 0;
bad += report('every species resolves', fail.lookup);
bad += report('spreads match', fail.spread);
bad += report('final stats match', fail.stats);
bad += report('precomputed speeds match', fail.speed);

// Cross-check a few lookups that exercise the awkward cases.
const cases = [
  ['Gastrodon-East', null, 'gastrodon'],
  ['Minior-Blue', null, 'minior'],
  ['Maushold-Four', null, 'maushold'],
  ['Zacian', 'Rusted Sword', 'zaciancrowned'],
  ['Zamazenta', 'Rusted Shield', 'zamazentacrowned'],
  ['Zacian', 'Life Orb', 'zacian'],
  ['Great Tusk', 'Leftovers', 'greattusk'],
];
const lookupBad = cases.filter(([n, i, want]) => (dex.get(n, i)?.id) !== want)
  .map(([n, i, want]) => `${n} + ${i} -> ${dex.get(n, i)?.id} (wanted ${want})`);
bad += report('awkward lookups', lookupBad);

console.log(bad ? '\nFAILED' : '\nall green');
process.exit(bad ? 1 : 0);
