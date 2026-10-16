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

  // ---- 8. Truant: Slaking attacks, then loafs, then attacks again.
  {
    const b = fresh();
    b.handle('|switch|p2a: Slaking|Slaking, L84, M|100/100');
    const before = worlds(b)[0].theirs.volatiles;
    b.handle('|move|p2a: Slaking|Double-Edge|p1a: Great Tusk');
    b.handle('|turn|2');
    const loafing = worlds(b)[0].theirs.volatiles;
    b.handle('|cant|p2a: Slaking|ability: Truant');
    b.handle('|turn|3');
    const after = worlds(b)[0].theirs.volatiles;
    res.truant = { before, loafing, after, ability: b.them.active.ability };
    // and that a sleeping Slaking keeps its clock
    b.handle('|move|p2a: Slaking|Double-Edge|p1a: Great Tusk');
    b.handle('|cant|p2a: Slaking|slp');
    res.truantKept = worlds(b)[0].theirs.volatiles.includes('TRUANT');
  }

  // ---- 9. The rating line after the game.
  {
    const b = fresh();
    b.handle('|win|Us');
    b.handle("|raw|Us's rating: 1312 &rarr; <strong>1330</strong><br />(+18 for winning)");
    b.handle("|raw|Them's rating: 1402 &rarr; <strong>1388</strong><br />(-14 for losing)");
    res.rating = { ended: b.ended, winner: b.winner, us: b.ratings.us, them: b.ratings.them };
  }

  // ---- 10. The Tera box: our active is Tera'd in every world, nothing else is.
  {
    const b = fresh();
    b.us.active.teraType = 'Ground';
    b.handle('|switch|p1a: Great Tusk|Great Tusk, L77, M|100/100'); // re-switch keeps it
    b.us.active.teraType = 'Ground';
    const plain = worlds(b)[0];
    const tera = sampleWorlds(dex, b, { count: 1, seed: 7, teraNow: true })[0];
    res.tera = {
      plainTypes: plain.ours.pokemon[0].types, plainTera: plain.ours.pokemon[0].terastallized,
      teraTypes: tera.ours.pokemon[0].types, teraTera: tera.ours.pokemon[0].terastallized,
      theirsUntouched: !tera.theirs.pokemon[0].terastallized,
      plainOptions: engine.options(plain), teraOptions: engine.options(tera),
    };
    // Damage moves with it: Headlong Rush on a Tera Ground Great Tusk gets the
    // bigger STAB, so it has to go up and nothing of theirs should change type.
    for (const m of ['headlongrush', 'closecombat', 'rapidspin']) {
      if (!b.us.active.revealedMoves.has(m)) b.us.active.revealedMoves.set(m, 0);
    }
    const p2 = sampleWorlds(dex, b, { count: 1, seed: 7 })[0];
    const t2 = sampleWorlds(dex, b, { count: 1, seed: 7, teraNow: true })[0];
    const dp = engine.damage(p2), dt = engine.damage(t2);
    const find = (d, id) => d.ours.find((m) => m.id === id);
    res.damage = {
      plain: find(dp, 'headlongrush'), tera: find(dt, 'headlongrush'),
      theirMaxhp: dp.theirMaxhp, ourMaxhp: dp.ourMaxhp,
      status: dp.theirs.map((m) => `${m.id}:${m.min}-${m.max}`),
    };
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
// Under Encore you can still Tera, so the engine rightly offers both the move
// and the move-with-Tera — one move, two ways to click it.
const encoredMoves = new Set(e.options.filter((c) => !isSwitch(c)).map((c) => c.replace(/-tera$/, '')));
check('only the Encored move (and switches) remain legal',
  encoredMoves.size === 1 && encoredMoves.has('bulkup'), e.options.join(', '));

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

const t = out.truant;
check('a fresh Slaking is not loafing', !t.before.includes('TRUANT'), JSON.stringify(t.before));
check('after it attacks, the engine is told it loafs', t.loafing.includes('TRUANT'), JSON.stringify(t.loafing));
check('after the loaf, it can move again', !t.after.includes('TRUANT'), JSON.stringify(t.after));
check('the loaf line reveals the ability', t.ability === 'Truant', String(t.ability));
check('sleeping through a loaf keeps the clock', out.truantKept === true);

const r = out.rating;
check('the rating line is read for both players',
  r.us?.before === 1312 && r.us?.after === 1330 && r.us?.reason === '+18 for winning'
  && r.them?.after === 1388, JSON.stringify(r));

const te = out.tera;
check('without the box, we are not Tera\'d', te.plainTera === false && te.plainTypes.length === 2, JSON.stringify(te.plainTypes));
check('with the box, our active is Tera Ground', te.teraTera === true && te.teraTypes.join() === 'GROUND', JSON.stringify(te.teraTypes));
check('their side is untouched by our Tera', te.theirsUntouched === true);
check('the engine offers Tera moves before, not after',
  te.plainOptions.some((c) => /-tera$/.test(c)) && !te.teraOptions.some((c) => /-tera$/.test(c)),
  `${te.plainOptions.join(', ')} | ${te.teraOptions.join(', ')}`);

const d = out.damage;
check('damage numbers come back in HP', d.plain && d.plain.max > 0 && d.theirMaxhp > 0,
  JSON.stringify(d.plain));
check('Tera Ground makes Headlong Rush hit harder', d.tera && d.tera.max > d.plain.max,
  `${d.plain?.max} -> ${d.tera?.max}`);
check('the roll is 85–100%', d.plain && d.plain.min === Math.floor(d.plain.max * 0.85),
  `${d.plain?.min}/${d.plain?.max}`);
console.log(`         Headlong Rush vs Grimmsnarl: ${d.plain?.min}–${d.plain?.max} of ${d.theirMaxhp}, Tera Ground ${d.tera?.min}–${d.tera?.max}`);
console.log(`         theirs: ${d.status.join(' ')}`);
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' / '));

await browser.close();
server.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
