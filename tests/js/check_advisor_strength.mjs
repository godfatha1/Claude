// Is the recommender any good? Let it play.
//
// One side clicks whatever the advisor recommends — the same code the panel
// runs, fed from that player's own feed — against an opponent that clicks at
// random, then one that always picks its hardest-hitting move. A working
// search should crush random and clearly beat greedy. If it doesn't, it's
// broken, whatever the panel looks like.
//
// It also records how sure it was each turn (the top option's share), since
// "low probability" on the panel is a separate question from "bad advice".
//
// Usage:  GAMES=10 BUDGET=normal node tests/js/check_advisor_strength.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const GAMES = parseInt(process.env.GAMES ?? '10', 10);
const BUDGET = process.env.BUDGET ?? 'normal';
const OPPONENTS = (process.env.OPPONENTS ?? 'random,greedy').split(',');
const PORT = 8748;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: process.cwd(), stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch { /* gone */ } });
await sleep(1200);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('   page:', m.text().slice(0, 200)); });
await page.goto(`http://localhost:${PORT}/tests/js/harness.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });

// ------------------------------------------------ positions with one answer
const sanity = await page.evaluate(async () => {
  const { Battle } = await import('/app/battle.js');
  const { Advisor, moveIdOf } = await import('/app/advisor.js');
  const { dex, engine } = window.__h;
  const advisor = new Advisor(dex, engine);
  const run = (theirSwitch, mine, expect) => {
    const b = new Battle(dex);
    for (const l of ['|player|p1|Us|1|', '|player|p2|Them|2|', '|teamsize|p1|6', '|teamsize|p2|6', '|gen|9', '|start',
      `|switch|p1a: ${mine.name}|${mine.details}|100/100`, theirSwitch, '|turn|1']) b.handle(l);
    b.applyRequest({
      side: { id: 'p1', name: 'Us', pokemon: [{ ident: `p1: ${mine.name}`, details: mine.details, condition: mine.hp,
        active: true, moves: mine.moves, item: mine.item, ability: mine.ability, teraType: mine.tera }] },
      active: [{ moves: mine.moves.map((m) => ({ move: m, id: m, pp: 16, maxpp: 16 })) }],
    });
    const r = advisor.advise(b, { budget: 'deep' });
    const top = r.actions.filter((a) => !a.vetoed)[0];
    return { expect, top: top?.choice, share: Math.round((top?.share ?? 0) * 100),
             ok: expect.includes(moveIdOf(top?.choice ?? '')) };
  };
  return [
    // A weakened Heatran: Ground is 4x, but half of Heatran's sets hold an Air
    // Balloon, so Close Combat (2x, no balloon problem) is just as right.
    run('|switch|p2a: Heatran|Heatran, L80, M|35/100',
      { name: 'Great Tusk', details: 'Great Tusk, L77', hp: '280/280', moves: ['headlongrush', 'closecombat', 'rapidspin', 'icespinner'],
        item: 'boosterenergy', ability: 'protosynthesis', tera: 'Ground' }, ['headlongrush', 'closecombat']),
    // Electric into a Gyarados at a third: Thunderbolt, not the resisted or immune options.
    run('|switch|p2a: Gyarados|Gyarados, L79, M|30/100',
      { name: 'Raikou', details: 'Raikou, L82', hp: '270/270', moves: ['thunderbolt', 'scald', 'shadowball', 'calmmind'],
        item: 'leftovers', ability: 'pressure', tera: 'Electric' }, ['thunderbolt']),
    // Ice into Garchomp (4x): Ice Beam.
    run('|switch|p2a: Garchomp|Garchomp, L77, F|60/100',
      { name: 'Vaporeon', details: 'Vaporeon, L86', hp: '420/420', moves: ['icebeam', 'scald', 'wish', 'protect'],
        item: 'leftovers', ability: 'waterabsorb', tera: 'Water' }, ['icebeam']),
  ];
});
console.log('positions with an obvious answer (deep):');
for (const s of sanity) console.log(`  ${s.ok ? 'ok   ' : 'FAIL '} expected ${s.expect.join('/')}, it said ${s.top} at ${s.share}%`);

// ------------------------------------------------ real games
const results = {};
for (const opponent of OPPONENTS) {
  results[opponent] = await page.evaluate(async ({ games, budget, opponent, debug }) => {
    const { Battle } = await import('/app/battle.js');
    const { Advisor, moveIdOf, isTeraChoice } = await import('/app/advisor.js');
    const { toId } = await import('/app/data.js');
    const { sampleWorlds } = await import('/app/infer.js');
    const { dex, engine } = window.__h;
    const advisor = new Advisor(dex, engine);
    const URL = 'ws://localhost:8111/showdown/websocket';
    const RUN = Date.now().toString(36).slice(-4);
    const out = { wins: 0, losses: 0, ties: 0, unfinished: 0, turns: 0, decisions: 0, failedSearches: 0,
                  topShares: [], ms: 0, fallbacks: 0 };

    const client = (name, onLine) => new Promise((resolve) => {
      const ws = new WebSocket(URL);
      ws.onmessage = (e) => {
        if (window.__raw !== undefined && window.__raw.length < 80 && name.startsWith('Adv')) window.__raw.push(String(e.data).slice(0, 90).replace(/\n/g, ' \\n '));
        const parts = String(e.data).split('\n');
        let room = '';
        if (parts[0].startsWith('>')) room = parts.shift().slice(1).trim();
        for (const line of parts) {
          if (line.startsWith('|challstr|')) ws.send(`|/trn ${name},0,`);
          if (line.startsWith('|updateuser|') && line.includes(name)) { ws.send('|/utm null'); resolve(ws); }
          onLine(room, line, ws);
        }
      };
    });

    // The opponent: random, or always its hardest-hitting move.
    const theirPick = (req, foeTypes) => {
      const moves = (req.active?.[0]?.moves ?? []).map((m, i) => ({ m, i })).filter(({ m }) => !m.disabled && (m.pp ?? 1) > 0);
      if (!moves.length) return 'default';
      if (opponent === 'random') return `move ${moves[Math.floor(Math.random() * moves.length)].i + 1}`;
      const score = ({ m }) => {
        const d = dex.move(m.id);
        if (!d || d.category === 'Status') return 0;
        const me = req.side.pokemon.find((p) => p.active);
        const myTypes = dex.get(me.details.split(',')[0])?.t ?? [];
        const stab = myTypes.includes(String(d.type).toUpperCase()) ? 1.5 : 1;
        return (d.basePower || 60) * stab * (foeTypes.length ? dex.effectiveness(d.type, foeTypes) : 1);
      };
      return `move ${moves.reduce((a, b) => (score(b) > score(a) ? b : a)).i + 1}`;
    };
    const forcedSwitch = (req) => {
      const bench = (req.side?.pokemon ?? []).map((p, i) => ({ p, i })).filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
      return bench.length ? `switch ${bench[Math.floor(Math.random() * bench.length)].i + 1}` : 'default';
    };

    // Turn the advisor's choice into the command Showdown takes.
    const command = (choice, req) => {
      const side = req.side.pokemon;
      if (choice === 'No Move') return (req.active?.[0]?.moves ?? []).length === 1 ? 'move 1' : null; // recharge
      if (choice.startsWith('switch')) {
        const id = toId(choice.slice(7));
        const i = side.findIndex((p) => !p.active && !p.condition.endsWith(' fnt')
          && (toId(p.details.split(',')[0]) === id || dex.get(p.details.split(',')[0])?.id === id));
        return i >= 0 ? `switch ${i + 1}` : null;
      }
      const id = moveIdOf(choice);
      const moves = req.active?.[0]?.moves ?? [];
      const i = moves.findIndex((m) => (m.id ?? toId(m.move)) === id && !m.disabled);
      if (i < 0) return null;
      return `move ${i + 1}${isTeraChoice(choice) && req.active[0].canTerastallize ? ' terastallize' : ''}`;
    };

    if (debug) { window.__debugLines = []; window.__raw = []; }
    for (let g = 0; g < games; g++) {
      const nameA = `Adv${RUN}a${g}`, nameB = `Opp${RUN}b${g}`;
      let battle = null, room = null, pending = null, timer = null, done = null, foeTypes = [];
      const finished = new Promise((r) => { done = r; });

      const decide = (wsA) => {
        clearTimeout(timer);
        const req = pending; pending = null;
        if (!req || !battle) return;
        let cmd = null, lastChoice = null;
        if (battle.us.active && battle.them.active) {
          const t0 = performance.now();
          const r = advisor.advise(battle, { budget });
          out.ms += performance.now() - t0;
          out.decisions += 1;
          if (!r || r.failed) { out.failedSearches += 1; if (advisor.lastFailure) (out.failures ??= []).push(advisor.lastFailure); }
          else {
            const best = r.actions.filter((a) => !a.vetoed)[0] ?? r.actions[0];
            if (best) { out.topShares.push(best.share); lastChoice = best.choice; cmd = command(best.choice, req); }
          }
        }
        if (!cmd) {
          out.fallbacks += 1;
          (out.fallbackWhy ??= []).push(`${lastChoice ?? 'no advice'} | force=${Boolean(req.forceSwitch)} | moves=${(req.active?.[0]?.moves ?? []).map((m) => `${m.id}${m.disabled ? '(x)' : ''}`).join(',')} | us=${battle.us.active?.speciesName} fainted=${battle.us.active?.fainted} | them=${battle.them.active?.speciesName} | ourTeam=${battle.us.team.map((m) => `${m.speciesName}:${m.fainted ? 'fnt' : Math.round(m.hpPercent)}`).join(',')} activeIdx=${battle.us.activeIndex} | reqTeam=${req.side.pokemon.map((p) => `${p.details.split(',')[0]}:${p.condition}${p.active ? '*' : ''}`).join(',')} | log=${battle.log.slice(-8).join(' ')} | world=${(() => { try { const w = sampleWorlds(dex, battle, { count: 1, seed: 1 })[0]; return `ours ${w.ours.pokemon.map((p) => `${p.id}:${p.hp}`).join(',')} act=${w.ours.active} fs=${w.ours.forceSwitch} theirs act ${w.theirs.pokemon[w.theirs.active]?.id}:${w.theirs.pokemon[w.theirs.active]?.hp} opts=${engine.options(w).join(',')}`; } catch (e) { return String(e); } })()}`);
          cmd = req.forceSwitch ? forcedSwitch(req) : 'default';
        }
        wsA.send(`${room}|/choose ${cmd}|${req.rqid}`);
      };

      const wsA = await client(nameA, (r, line, ws) => {
        if (window.__debugLines !== undefined && window.__debugLines.length < 60 && (r.startsWith('battle-') || /^\|(pm|popup|error)/.test(line))) window.__debugLines.push(`${r} ${line.slice(0, 120)}`);
        if (r.startsWith('battle-') && line.startsWith('|init|battle')) { room = r; battle = new Battle(dex); return; }
        if (!battle || r !== room) return;
        if (line.startsWith('|request|')) {
          let req; try { req = JSON.parse(line.slice(9)); } catch { return; }
          battle.applyRequest(req);
          if (req.wait) return;
          pending = req;
          clearTimeout(timer);
          timer = setTimeout(() => decide(ws), 300); // forced switches come without a |turn|
          return;
        }
        battle.handle(line);
        if (line.startsWith('|player|')) battle.setOurName(nameA);
        if (line.startsWith('|turn|') && pending) decide(ws);
        if (line.startsWith('|win|')) done(line.slice(5) === nameA ? 'win' : 'loss');
        if (line === '|tie' || line.startsWith('|tie|')) done('tie'); // not |tier|
      });
      const wsB = await client(nameB, (r, line, ws) => {
        if (line.startsWith('|pm|') && line.includes('/challenge')) ws.send(`|/accept ${nameA}`);
        if (!r.startsWith('battle-')) return;
        if (line.startsWith('|switch|p1a:') || line.startsWith('|switch|p2a:')) {
          // Track the foe's types from B's point of view (B is p2 when A challenged).
          const [, , who, details] = line.split('|');
          if (!who.includes(nameB.slice(0, 3)) && who.startsWith('p1')) foeTypes = dex.get(details.split(',')[0])?.t ?? [];
        }
        if (!line.startsWith('|request|')) return;
        let req; try { req = JSON.parse(line.slice(9)); } catch { return; }
        if (req.wait) return;
        setTimeout(() => ws.send(`${r}|/choose ${req.forceSwitch ? forcedSwitch(req) : theirPick(req, foeTypes)}|${req.rqid}`), 5);
      });
      wsA.send(`|/challenge ${nameB}, gen9randombattle`);
      const outcome = await Promise.race([finished, new Promise((r) => setTimeout(() => r('unfinished'), 240000))]);
      out[outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : outcome === 'tie' ? 'ties' : 'unfinished'] += 1;
      out.turns += battle?.turn ?? 0;
      wsA.close(); wsB.close();
      console.log(`[strength] ${opponent} game ${g + 1}: ${outcome} in ${battle?.turn ?? 0} turns`);
    }
    return out;
  }, { games: GAMES, budget: BUDGET, opponent, debug: Boolean(process.env.DEBUG) });
  if (process.env.DEBUG) console.log((await page.evaluate(() => window.__raw)).join('\n'));
}

await browser.close();
server.kill();

// Keep any position the engine failed on, to reproduce it outside the browser.
const { mkdirSync, writeFileSync } = await import('node:fs');
for (const [opponent, r] of Object.entries(results)) {
  for (const [i, f] of (r.failures ?? []).entries()) {
    mkdirSync('tests/js/engine-failures', { recursive: true });
    const name = `tests/js/engine-failures/${Date.now()}-${opponent}-${i}.json`;
    writeFileSync(name, JSON.stringify(f, null, 1));
    console.log(`  the engine failed on a position (${f.error}): saved to ${name}`);
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;
let bad = sanity.some((s) => !s.ok) ? 1 : 0;
for (const [opponent, r] of Object.entries(results)) {
  const played = r.wins + r.losses + r.ties;
  const shares = r.topShares.slice().sort((a, b) => a - b);
  const median = shares.length ? shares[Math.floor(shares.length / 2)] : 0;
  console.log(`\nvs ${opponent} (${BUDGET}): won ${r.wins} of ${played}${r.unfinished ? `, ${r.unfinished} unfinished` : ''}`
    + ` · ${Math.round(r.turns / Math.max(1, played))} turns a game`);
  console.log(`  ${r.decisions} decisions, ${Math.round(r.ms / Math.max(1, r.decisions))} ms each, `
    + `${r.failedSearches} failed searches, ${r.fallbacks} it couldn't turn into a click`);
  for (const w of (r.fallbackWhy ?? []).slice(0, 12)) console.log(`    couldn't click: ${w}`);
  console.log(`  how sure it was (top option's share): median ${pct(median)}, `
    + `under 25% on ${pct(shares.filter((s) => s < 0.25).length / Math.max(1, shares.length))} of turns`);
  const need = opponent === 'random' ? 0.85 : 0.6;
  if (played && r.wins / played < need) { console.log(`  FAIL  expected to win at least ${pct(need)} against ${opponent}`); bad = 1; }
}
console.log(bad ? '\nFAILED' : '\nall green');
process.exit(bad);
