// Check the state reader against real battles.
//
// Runs actual games on a local Showdown server, watches them the way the
// assistant will (as a spectator), and then checks what the reader concluded
// against the teams the server really generated. The players' own `request`
// feeds give us ground truth that a spectator never sees, which is exactly what
// makes this worth running.
//
// What it verifies:
//   - the reader survives real protocol without throwing
//   - species, levels and faint counts track correctly
//   - every Choice Scarf it claims is actually a Choice Scarf
//   - revealed moves are really in the set that used them
//   - every ability and item it credits is one that Pokémon really had
//
// Usage:  node tests/js/check_state_reader.mjs [games] [ws://host:port]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import WebSocket from 'ws';
import { Dex, toId } from '../../app/data.js';
import { Battle } from '../../app/battle.js';

const GAMES = parseInt(process.argv[2] ?? '12', 10);
const SERVER = process.argv[3] ?? 'ws://localhost:8111/showdown/websocket';

const dex = new Dex(JSON.parse(readFileSync('data/gen9randombattle.json', 'utf8')));

function connect(tag) {
  const ws = new WebSocket(SERVER);
  const lines = [];
  const waiters = [];
  const onLine = [];
  ws.on('message', (data) => {
    for (const raw of String(data).split('\n')) {
      lines.push(raw);
      for (const fn of onLine) fn(raw);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].test(raw)) { waiters[i].resolve(raw); waiters.splice(i, 1); }
      }
    }
  });
  return {
    tag, lines, onLine,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(m),
    wait: (test, ms = 20000) => new Promise((resolve, reject) => {
      for (const l of lines) if (test(l)) return resolve(l);
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error(`${tag}: timed out`)), ms);
    }),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Abilities that change Speed or priority. Kept here on purpose rather than
// imported from the reader, so the count of missed chances is independent.
const SPEED_OR_PRIORITY_ABILITIES = new Set([
  'swiftswim', 'chlorophyll', 'sandrush', 'slushrush', 'surgesurfer', 'unburden', 'quickfeet',
  'speedboost', 'slowstart', 'protosynthesis', 'quarkdrive', 'steamengine', 'motordrive',
  'weakarmor', 'rattled', 'prankster', 'galewings', 'triage', 'quickdraw', 'stall', 'myceliummight',
]);

/** Play one real game and return the spectator's view plus the true teams. */
// Names unique to this run. The server remembers battles by player name, so
// reusing names across runs rejoins old battles, and the test then watches a
// stale game with no ground truth while reporting green.
const RUN = Date.now().toString(36).slice(-5);

async function playOneGame(index) {
  const nameA = `Alpha${RUN}${index}`;
  const nameB = `Bravo${RUN}${index}`;
  const a = connect('A');
  const b = connect('B');
  const spy = connect('SPY');
  await Promise.all([a.ready, b.ready, spy.ready]);
  await Promise.all([
    a.wait((l) => l.startsWith('|challstr|')),
    b.wait((l) => l.startsWith('|challstr|')),
    spy.wait((l) => l.startsWith('|challstr|')),
  ]);

  a.send(`|/trn ${nameA},0,`);
  b.send(`|/trn ${nameB},0,`);
  await Promise.all([
    a.wait((l) => l.startsWith('|updateuser|') && l.includes(nameA)),
    b.wait((l) => l.startsWith('|updateuser|') && l.includes(nameB)),
  ]);

  a.send('|/utm null');
  b.send('|/utm null');
  a.send(`|/challenge ${nameB}, gen9randombattle`);
  await b.wait((l) => l.startsWith('|pm|') && l.includes('/challenge gen9randombattle'));
  b.send(`|/accept ${nameA}`);

  const roomLine = await a.wait((l) => l.startsWith('>battle-'));
  const room = roomLine.slice(1).trim();

  // The spectator's stream is what the assistant will actually get.
  const spectated = [];
  spy.onLine.push((l) => { if (l && !l.startsWith('>')) spectated.push(l); });
  spy.send(`|/join ${room}`);
  await spy.wait((l) => l.startsWith('|init|battle'));

  // Ground truth: each player's own request carries their real team. Items
  // can change hands mid-game (Trick, Knock Off), so keep every one each
  // Pokémon was ever seen holding.
  const trueTeams = {};
  const itemsEver = {};
  const captureTeam = (who, side) => (line) => {
    if (!line.startsWith('|request|') || line.length < 40) return;
    try {
      const parsed = JSON.parse(line.slice('|request|'.length));
      if (!parsed.side?.pokemon) return;
      // Keyed by ident ("p1: Eiscue"), which survives a forme change.
      for (const p of parsed.side.pokemon) {
        (itemsEver[`${side}|${p.ident}`] ??= new Set()).add(toId(p.item ?? ''));
      }
      trueTeams[side] = parsed.side.pokemon.map((p) => ({
        ident: p.ident,
        details: p.details,
        item: p.item,
        ability: p.ability,
        moves: p.moves,
        baseAbility: p.baseAbility,
      }));
      void who;
    } catch { /* partial request, ignore */ }
  };
  a.onLine.push(captureTeam(nameA, 'p1'));
  b.onLine.push(captureTeam(nameB, 'p2'));

  // Play it out with whatever the server will accept.
  let guard = 0;
  const playRandom = (client) => (line) => {
    if (!line.startsWith('|request|') || line.length < 40) return;
    let parsed;
    try { parsed = JSON.parse(line.slice('|request|'.length)); } catch { return; }
    if (parsed.wait) return;
    setTimeout(() => {
      if (parsed.forceSwitch) {
        const options = (parsed.side?.pokemon ?? [])
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
        if (options.length) {
          const pick = options[Math.floor(Math.random() * options.length)];
          client.send(`${room}|/choose switch ${pick.i + 1}|${parsed.rqid}`);
        }
        return;
      }
      const moves = (parsed.active?.[0]?.moves ?? [])
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => !m.disabled && (m.pp ?? 1) > 0);
      if (moves.length) {
        const pick = moves[Math.floor(Math.random() * moves.length)];
        client.send(`${room}|/choose move ${pick.i + 1}|${parsed.rqid}`);
      } else {
        client.send(`${room}|/choose default|${parsed.rqid}`);
      }
    }, 5);
  };
  a.onLine.push(playRandom(a));
  b.onLine.push(playRandom(b));

  // Wait for the game to finish, or give up.
  while (guard++ < 400) {
    if (spectated.some((l) => l.startsWith('|win|') || l.startsWith('|tie'))) break;
    await sleep(150);
  }

  a.close(); b.close(); spy.close();
  return { room, spectated, trueTeams, itemsEver, players: { p1: nameA, p2: nameB } };
}

// --------------------------------------------------------------- checking

const problems = {
  threw: [],
  species: [],
  faints: [],
  falseScarf: [],
  missedScarf: [],
  phantomMove: [],
  wrongAbility: [],
  wrongItem: [],
  engineState: [],
  noTruth: [],
};
const stats = {
  games: 0, lines: 0, turns: 0,
  scarfsFound: 0, scarfsReal: 0,
  realScarfHoldersSeen: 0,
  abilitiesCredited: 0,
  illusionUnbroken: 0,
  itemsCredited: 0,
  // A guard that only ever says "no" is worthless, so measure the other side:
  // how often was the order actually there to be read?
  detectableOpportunities: 0,
  opportunitiesCaught: 0,
};

function verify(game) {
  const battle = new Battle(dex);
  for (const line of game.spectated) {
    try {
      battle.handle(line);
    } catch (err) {
      problems.threw.push(`${game.room}: ${line} -> ${err.message}`);
      return;
    }
  }
  battle.setOurName(game.players.p1);

  stats.games += 1;
  stats.lines += game.spectated.length;
  stats.turns += battle.turn;

  for (const slot of ['p1', 'p2']) {
    const tracked = battle.sides[slot];
    const truth = game.trueTeams[slot];
    // No ground truth means nothing below was checked. That has to fail,
    // not quietly pass.
    if (!truth) { problems.noTruth.push(`${game.room} ${slot}: never saw the real team`); continue; }

    const trueBySpecies = new Map();
    for (const t of truth) {
      trueBySpecies.set(toId(t.details.split(',')[0]), t);
    }

    for (const mon of tracked.team) {
      // Every species the reader saw must be one the player really had.
      const match = trueBySpecies.get(toId(mon.speciesName))
        ?? [...trueBySpecies.values()].find((t) => toId(t.details.split(',')[0]) === mon.id);
      if (!match) {
        problems.species.push(`${game.room} ${slot}: tracked ${mon.speciesName}, not in the real team`);
        continue;
      }

      // Judged by anything it held during the game: a Scarf that gets Knocked
      // Off or Tricked away later was still a Scarf when the order showed it.
      const heldEver = game.itemsEver?.[`${slot}|${match.ident}`] ?? new Set([toId(match.item ?? '')]);
      const everScarf = heldEver.has('choicescarf');
      if (everScarf) stats.realScarfHoldersSeen += 1;

      // A Scarf we claim must actually be one.
      if (mon.scarfProven) {
        stats.scarfsFound += 1;
        if (everScarf) stats.scarfsReal += 1;
        else {
          problems.falseScarf.push(`${game.room} ${slot}: claimed Scarf on ${mon.speciesName}, really ${match.item || 'nothing'}`);
          // A false claim is rare and misleads when it happens, so keep the
          // whole game. Guessing at the cause from a one-line summary is how
          // the first four wrong guards got written.
          try {
            mkdirSync('tests/js/false-scarfs', { recursive: true });
            const name = `tests/js/false-scarfs/${Date.now()}-${toId(mon.speciesName)}.json`;
            writeFileSync(name, JSON.stringify({
              claimedOn: mon.speciesName,
              reallyHeld: match.item,
              realAbility: match.ability ?? match.baseAbility,
              realMoves: match.moves,
              trackedSpeedRange: mon.speedRange?.(),
              trackedBoosts: mon.boosts,
              trackedStatus: mon.status,
              note: battle.notes.find((n) => n.kind === 'scarf')?.text,
              trueTeams: game.trueTeams,
              protocol: game.spectated,
            }, null, 1));
            console.log(`\n  saved a false claim to ${name}`);
          } catch (err) { console.warn('could not save it:', err.message); }
        }
      }

      // Abilities and items it credited — from their own lines or from a
      // "[from]" tag on someone else's — must be the real ones.
      if (mon.ability) {
        stats.abilitiesCredited += 1;
        const real = [match.baseAbility, match.ability].filter(Boolean).map(toId);
        if (!real.includes(toId(mon.ability))) {
          problems.wrongAbility.push(`${game.room} ${slot}: ${mon.speciesName} credited with ${mon.ability}, really ${real.join('/')}`);
        }
      }
      if (mon.item && !mon.scarfProven) {
        stats.itemsCredited += 1;
        const ever = game.itemsEver?.[`${slot}|${match.ident}`] ?? new Set();
        if (!ever.has(toId(mon.item))) {
          problems.wrongItem.push(`${game.room} ${slot}: ${mon.speciesName} credited with ${mon.item}, held ${[...ever].join('/') || 'nothing'}`);
        }
      }

      // Revealed moves must really be in its set.
      const realMoves = new Set((match.moves ?? []).map(toId));
      for (const moveId of mon.revealedMoves.keys()) {
        if (realMoves.size && !realMoves.has(moveId)) {
          // A Zoroark that left without its Illusion breaking: the log never
          // says it was there, so nobody watching can know. Counted, not failed.
          const zoroark = truth.find((t) => /^Zoroark/i.test(t.details) && (t.moves ?? []).map(toId).includes(moveId));
          if (zoroark) { stats.illusionUnbroken += 1; continue; }
          // Show where it came from: the line, and a few before it.
          const at = game.spectated.findIndex((l) => l.startsWith('|move|') && toId(l.split('|')[3] ?? '') === moveId);
          const context = at >= 0 ? game.spectated.slice(Math.max(0, at - 4), at + 2).join('\n            ') : '';
          problems.phantomMove.push(`${game.room} ${slot}: ${mon.speciesName} credited with ${moveId}, set has ${[...realMoves].join(',')}`
            + (context ? `\n            ${context}` : ''));
        }
      }
    }

    // Faint tracking: the reader's count must not exceed the real team size.
    const fainted = tracked.team.filter((m) => m.fainted).length;
    if (fainted > truth.length) {
      problems.faints.push(`${game.room} ${slot}: ${fainted} fainted of ${truth.length}`);
    }
  }

  // How many chances did the reader actually get? Replay the stream and count
  // turns where a real Scarf holder moved first against something its unscarfed
  // speed could not have outsped. Those are the ones it ought to catch.
  countOpportunities(game);

  // The engine state must be well formed at the end of every game.
  try {
    const state = battle.toEngineState();
    if (!state.ours.pokemon.length || !state.theirs.pokemon.length) {
      problems.engineState.push(`${game.room}: empty side`);
    }
    for (const side of ['ours', 'theirs']) {
      for (const mon of state[side].pokemon) {
        if (!mon.id) problems.engineState.push(`${game.room} ${side}: a Pokémon with no id`);
        if (!(mon.maxhp > 0)) problems.engineState.push(`${game.room} ${side}: ${mon.id} has maxhp ${mon.maxhp}`);
        if (mon.hp > mon.maxhp) problems.engineState.push(`${game.room} ${side}: ${mon.id} hp ${mon.hp} > max ${mon.maxhp}`);
        if (mon.level == null) problems.engineState.push(`${game.room} ${side}: ${mon.id} has no level`);
      }
    }
  } catch (err) {
    problems.engineState.push(`${game.room}: ${err.message}`);
  }
}

/**
 * Count the turns where a real Choice Scarf was visibly readable from the order.
 *
 * Deliberately simple and independent of the reader: parse the stream again,
 * find turns where exactly one move came from each side at equal priority, and
 * ask whether the first mover was a real Scarf holder that its base speed says
 * should have gone second.
 */
function countOpportunities(game) {
  const realItem = {};
  for (const slot of ['p1', 'p2']) {
    for (const t of game.trueTeams[slot] ?? []) {
      realItem[`${slot}|${toId(t.details.split(',')[0])}`] = toId(t.item ?? '');
    }
  }

  const active = { p1: null, p2: null };
  let turnMoves = [];
  const seenCaught = new Set();

  const judge = () => {
    if (turnMoves.length === 2 && turnMoves[0].slot !== turnMoves[1].slot) {
      const [first, second] = turnMoves;
      const fd = dex.get(first.species);
      const sd = dex.get(second.species);
      const fm = dex.move(first.moveId);
      const sm = dex.move(second.moveId);
      if (fd && sd && fm && sm && fm.priority === 0 && sm.priority === 0) {
        const fSpeed = fd.sp?.[1];
        const sSpeed = sd.sp?.[1];
        const item = realItem[`${first.slot}|${fd.id}`];
        // Either side having an ability that could explain the order means
        // the order proves nothing, so it isn't a missed chance.
        const explained = [fd, sd].some((d) => (d.A ?? []).some((a) => SPEED_OR_PRIORITY_ABILITIES.has(a)));
        if (fSpeed != null && sSpeed != null && item === 'choicescarf' && !explained
            && fSpeed < sSpeed && Math.trunc(fSpeed * 1.5) > sSpeed) {
          const key = `${game.room}|${first.slot}|${fd.id}`;
          if (!seenCaught.has(key)) {
            seenCaught.add(key);
            stats.detectableOpportunities += 1;
            (stats.opportunityList ??= []).push(`${game.room}: ${first.species} (${fSpeed}) ${first.moveId} before `
              + `${second.species} (${sSpeed}) ${second.moveId}`);
          }
        }
      }
    }
    turnMoves = [];
  };

  for (const line of game.spectated) {
    const parts = line.slice(1).split('|');
    if (parts[0] === 'switch' || parts[0] === 'drag' || parts[0] === 'replace') {
      const slot = /^(p[12])/.exec(parts[1])?.[1];
      if (slot) active[slot] = (parts[2] ?? '').split(',')[0].trim();
    } else if (parts[0] === 'move') {
      const slot = /^(p[12])/.exec(parts[1])?.[1];
      if (slot && !turnMoves.some((m) => m.slot === slot)) {
        turnMoves.push({ slot, species: active[slot], moveId: toId(parts[2]) });
      }
    } else if (parts[0] === 'turn') {
      judge();
    }
  }
  judge();

  // Of those, how many did the reader actually flag?
  const battle = new Battle(dex);
  for (const line of game.spectated) { try { battle.handle(line); } catch { /* already reported */ } }
  for (const slot of ['p1', 'p2']) {
    for (const mon of battle.sides[slot].team) {
      if (mon.scarfProven && realItem[`${slot}|${mon.id}`] === 'choicescarf') {
        stats.opportunitiesCaught += 1;
      }
    }
  }
}

// ------------------------------------------------------------------- run

console.log(`playing ${GAMES} real games on ${SERVER}\n`);
for (let i = 0; i < GAMES; i++) {
  const game = await playOneGame(i);
  verify(game);
  process.stdout.write(`  game ${i + 1}/${GAMES}: ${game.spectated.length} lines\r`);
}
console.log(' '.repeat(50));

console.log(`watched ${stats.games} games, ${stats.lines} protocol lines, ${stats.turns} turns\n`);

let bad = 0;
const report = (label, list) => {
  if (!list.length) { console.log(`  ok    ${label}`); return; }
  bad += 1;
  console.log(`  FAIL  ${label}: ${list.length}`);
  for (const line of [...new Set(list)].slice(0, 8)) console.log(`          ${line}`);
};

report('the real teams were captured (otherwise nothing below is checked)', problems.noTruth);
report('reader never threw', problems.threw);
report('every tracked species was really on that team', problems.species);
report('faint counts stay within the team', problems.faints);
report('no revealed move the set does not have', problems.phantomMove);
report('every claimed Choice Scarf is real', problems.falseScarf);
report('every ability it credits is the real one', problems.wrongAbility);
report('every item it credits is one it really held', problems.wrongItem);
report('engine state is well formed', problems.engineState);

console.log(`\n  real Choice Scarf holders seen active : ${stats.realScarfHoldersSeen}`);
console.log(`  turns where the order gave it away   : ${stats.detectableOpportunities}`);
console.log(`  of those, the reader caught          : ${stats.opportunitiesCaught}`);
console.log(`  Scarfs claimed: ${stats.scarfsFound}, of which real: ${stats.scarfsReal}`);
console.log(`  abilities credited: ${stats.abilitiesCredited}, items credited: ${stats.itemsCredited}`);
if (stats.illusionUnbroken) console.log(`  moves from a Zoroark whose Illusion never broke: ${stats.illusionUnbroken} (unknowable)`);
// One missed chance can still have a reason this counter doesn't see (Tailwind,
// Trick Room, an item); missing every one of several means the reader is broken.
if (stats.detectableOpportunities >= 3 && stats.opportunitiesCaught === 0) {
  console.log('\n  WARNING: the order gave away a Scarf and the reader said nothing.');
  for (const o of stats.opportunityList ?? []) console.log(`    ${o}`);
  console.log('           The guards are too strict to be useful.');
  bad += 1;
}
console.log(bad ? '\nFAILED' : '\nall green');
process.exit(bad ? 1 : 0);
