// Do the facts the tracker knows actually reach the engine, and change what it
// considers legal?
//
// Every one of these is a thing the engine already models. The failure this
// guards against is quieter than a crash: the tracker sees an Encore, the
// panel even shows it, and the search carries on as if we had four free moves.
//
// Runs the real wasm in a browser (it panics under Node — a runtime difference,
// not a bug in the engine) against hand-built protocol, so each case is exact.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8745;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: process.cwd(), stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch { /* gone */ } });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/tests/js/harness.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

const out = await page.evaluate(async () => {
  const { Battle } = await import('/app/battle.js');
  const { sampleWorlds, readOpponent } = await import('/app/infer.js');
  const { dex, engine } = window.__h;

  const lines = (...ls) => ls;
  const start = lines(
    '|player|p1|Us|1|', '|player|p2|Them|2|',
    '|teamsize|p1|6', '|teamsize|p2|6', '|gametype|singles', '|gen|9',
    '|tier|[Gen 9] Random Battle', '|start',
    '|switch|p1a: Great Tusk|Great Tusk, L77, M|100/100',
    '|switch|p2a: Grimmsnarl|Grimmsnarl, L82, F|100/100',
    '|turn|1',
  );
  const fresh = () => { const b = new Battle(dex); for (const l of start) b.handle(l); b.setOurName('Us'); return b; };
  const worlds = (b) => sampleWorlds(dex, b, { count: 1, seed: 7 });
  // Engine.options/search take the object; they do their own encoding.
  const opts = (b) => engine.options(worlds(b)[0]);
  const res = {};

  // ---- baseline: four moves + five switches offered
  { const b = fresh(); res.baseline = opts(b); }

  // ---- 1. Encore on us: we used Bulk Up, Grimmsnarl Encored it.
  {
    const b = fresh();
    for (const l of lines(
      '|move|p1a: Great Tusk|Bulk Up|p1a: Great Tusk', '|-boost|p1a: Great Tusk|atk|1',
      '|move|p2a: Grimmsnarl|Encore|p1a: Great Tusk', '|-start|p1a: Great Tusk|Encore',
      '|turn|2')) b.handle(l);
    // Showdown's request under Encore lists only the locked move as usable.
    const us = b.us.active;
    us.requestDisabled = new Set([...us.revealedMoves.keys()].filter((m) => m !== 'bulkup'));
    // Give it a full moveset so there is something to disable.
    for (const m of ['closecombat', 'headlongrush', 'rapidspin']) if (!us.revealedMoves.has(m)) us.revealedMoves.set(m, 0);
    us.requestDisabled = new Set(['closecombat', 'headlongrush', 'rapidspin']);
    const w = worlds(b)[0];
    res.encore = {
      ours: w.ours.volatiles, encoreTurns: w.ours.encoreTurns, last: w.ours.lastUsedMove,
      disabled: w.ours.pokemon[0].disabled, options: opts(b),
    };
  }

  // ---- 2. Trapped: Showdown says we can't switch.
  {
    const b = fresh();
    b.us.trapped = true;
    res.trapped = { forceTrapped: worlds(b)[0].ours.forceTrapped, options: opts(b) };
  }

  // ---- 3. Substitute on them.
  {
    const b = fresh();
    for (const l of lines('|move|p2a: Grimmsnarl|Substitute|p2a: Grimmsnarl',
                          '|-start|p2a: Grimmsnarl|Substitute', '|-damage|p2a: Grimmsnarl|75/100', '|turn|2')) b.handle(l);
    const w = worlds(b)[0];
    res.sub = { theirs: w.theirs.volatiles, subHp: w.theirs.substituteHealth };
  }

  // ---- 4. You confirm a Choice Scarf by tapping: speed and item follow.
  {
    const b = fresh();
    const them = b.them.active;
    const before = readOpponent(b).speed;
    them.confirmItem('choicescarf');
    const after = readOpponent(b);
    const w = worlds(b)[0];
    res.scarf = { before, after: after.speed, item: w.theirs.pokemon[0].item, confirmed: after.itemConfirmed };
    // and undo
    them.confirmItem('choicescarf');
    res.scarfUndone = readOpponent(b).item === null;
  }

  // ---- 5. You confirm a move: every sampled world carries it.
  {
    const b = fresh();
    b.them.active.confirmMove('encore');
    const ws = sampleWorlds(dex, b, { count: 6, seed: 3 });
    res.confirmedMove = ws.every((w) => w.theirs.pokemon[0].moves.includes('encore'));
    res.roleNarrowed = readOpponent(b).roles;
  }

  // ---- 6. Taunt counts down and expires.
  {
    const b = fresh();
    b.handle('|-start|p1a: Great Tusk|move: Taunt');
    const t0 = worlds(b)[0].ours.tauntTurns;
    b.handle('|turn|2'); b.handle('|turn|3'); b.handle('|turn|4');
    res.taunt = { t0, gone: !worlds(b)[0].ours.volatiles.includes('TAUNT') };
  }

  // ---- 7. The enriched state still searches cleanly.
  {
    const b = fresh();
    b.handle('|-start|p2a: Grimmsnarl|Substitute');
    b.us.trapped = true;
    const r = engine.search(worlds(b)[0], 2000);
    res.search = { ok: r.ours.length > 0, choices: r.ours.map((o) => o.choice) };
  }
  return res;
});

const isSwitch = (c) => /^switch/.test(c);
const base = out.baseline;
check('baseline offers moves and switches', base.some(isSwitch) && base.some((c) => !isSwitch(c)), base.join(', '));

const e = out.encore;
check('Encore on us reaches the engine', e.ours.includes('ENCORE') && e.encoreTurns > 0, JSON.stringify(e.ours));
check('the engine knows which move was last used', e.last === 'bulkup', e.last);
check('Showdown-disabled moves are passed as disabled', e.disabled.length === 3, e.disabled.join(','));
check('only the Encored move (and switches) remain legal',
  e.options.filter((c) => !isSwitch(c)).length === 1 && e.options.includes('bulkup'), e.options.join(', '));

check('trapped reaches the engine', out.trapped.forceTrapped === true);
check('no switches offered when trapped', !out.trapped.options.some(isSwitch), out.trapped.options.join(', '));

check('their Substitute reaches the engine', out.sub.theirs.includes('SUBSTITUTE') && out.sub.subHp > 0,
  `${out.sub.theirs} hp=${out.sub.subHp}`);

check('confirming a Scarf raises their speed', out.scarf.before !== out.scarf.after, `${out.scarf.before} -> ${out.scarf.after}`);
check('a confirmed Scarf is what the engine is given', out.scarf.item === 'choicescarf', out.scarf.item);
check('it reads as confirmed, not seen', out.scarf.confirmed === true);
check('tapping again undoes it', out.scarfUndone === true);

check('a confirmed move is in every sampled set', out.confirmedMove === true);
check('confirming narrows the role', out.roleNarrowed.length >= 1, out.roleNarrowed.join(', '));
console.log(`         Grimmsnarl with Encore confirmed -> ${out.roleNarrowed.join(', ')}`);

check('Taunt is passed with turns left, then expires', out.taunt.t0 > 0 && out.taunt.gone, JSON.stringify(out.taunt));
check('search still runs on the enriched state', out.search.ok, out.search.choices.join(', '));
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' / '));

await browser.close();
server.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
