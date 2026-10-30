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
  const { Advisor } = await import('/app/advisor.js');
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

  // ---- 11. Abilities and items named in passing land on the right Pokémon.
  {
    const b = fresh();
    b.handle('|-heal|p2a: Grimmsnarl|100/100|[from] item: Leftovers');
    const leftovers = { item: b.them.active.item, worlds: sampleWorlds(dex, b, { count: 4, seed: 1 }).map((w) => w.theirs.pokemon[0].item) };

    const c = fresh();
    c.handle('|-damage|p1a: Great Tusk|88/100|[from] item: Rocky Helmet|[of] p2a: Grimmsnarl');
    const helmet = { theirs: c.them.active.item, ours: c.us.active.item };

    // Rough Skin hits the attacker and names the holder in [of].
    const d = fresh();
    d.handle('|switch|p2a: Garchomp|Garchomp, L74, M|100/100');
    d.handle('|-damage|p1a: Great Tusk|88/100|[from] ability: Rough Skin|[of] p2a: Garchomp');
    // Volt Absorb heals the holder and names the attacker in [of].
    const e = fresh();
    e.handle('|switch|p2a: Lanturn|Lanturn, L89, F|100/100');
    e.handle('|-heal|p2a: Lanturn|100/100|[from] ability: Volt Absorb|[of] p1a: Great Tusk');
    // Weather from an ability names the holder in [of] only.
    const f = fresh();
    f.handle('|switch|p2a: Torkoal|Torkoal, L88, M|100/100');
    f.handle('|-weather|SunnyDay|[from] ability: Drought|[of] p2a: Torkoal');
    // A tapped ability gives way to the real one.
    const g = fresh();
    g.them.active.confirmAbility('frisk');
    g.handle('|-ability|p2a: Grimmsnarl|Prankster');
    // A consumed item still says what it was.
    const h = fresh();
    h.handle('|-enditem|p2a: Grimmsnarl|Sitrus Berry|[eat]');

    res.effects = {
      leftovers, helmet,
      roughSkin: { garchomp: d.them.active.ability, tusk: d.us.active.ability ?? null,
                   engine: sampleWorlds(dex, d, { count: 3, seed: 2 }).map((w) => w.theirs.pokemon[w.theirs.active].ability) },
      voltAbsorb: { lanturn: e.them.active.ability, tusk: e.us.active.ability ?? null },
      drought: f.them.active.ability,
      tapThenSeen: { ability: g.them.active.ability, confirmed: g.them.active.confirmed.ability },
      sitrus: { item: h.them.active.item, gone: h.them.active.itemKnownGone, read: readOpponent(h).itemGone,
                engine: worlds(h)[0].theirs.pokemon[0].item },
    };
  }

  // ---- 12. The only option is assumed, in the readout and in every world.
  {
    const b = fresh();
    b.handle('|switch|p2a: Abomasnow|Abomasnow, L84, M|100/100');
    const read = readOpponent(b);
    res.assumed = {
      item: read.assumedItem, ability: read.assumedAbility,
      worldItems: [...new Set(sampleWorlds(dex, b, { count: 6, seed: 4 }).map((w) => w.theirs.pokemon[w.theirs.active].item))],
      worldAbilities: [...new Set(sampleWorlds(dex, b, { count: 6, seed: 4 }).map((w) => w.theirs.pokemon[w.theirs.active].ability))],
    };
    // Proven otherwise: a different item seen replaces the assumption.
    b.handle('|-heal|p2a: Abomasnow|100/100|[from] item: Leftovers');
    res.assumedThenSeen = { item: readOpponent(b).item, assumed: readOpponent(b).assumedItem };
  }

  // ---- 13. Odds of each move: seen ones are certain, the rest add up to the open slots.
  {
    const b = fresh();
    const fresh0 = b.them.active.moveOdds();
    b.handle('|move|p2a: Grimmsnarl|Spirit Break|p1a: Great Tusk');
    const after = b.them.active.moveOdds();
    const sum = (m) => [...m.values()].reduce((a, x) => a + x, 0);
    res.odds = {
      freshSum: sum(fresh0), afterSum: sum(after), spiritbreak: after.get('spiritbreak'),
      inRange: [...after.values()].every((p) => p >= 0 && p <= 1),
      read: readOpponent(b).moveOdds,
    };
  }

  // ---- 14. Calling their next move pins it in the search.
  {
    const b = fresh();
    const mon = b.them.active;
    const steps = [mon.cycleMove('thunderwave'), mon.cycleMove('thunderwave')];
    const w = worlds(b)[0];
    const r = engine.search(w, 3000);
    const free = engine.search({ ...w, theirs: { ...w.theirs, rootMove: '' } }, 3000);
    steps.push(mon.cycleMove('thunderwave'));
    res.called = {
      steps, root: w.theirs.rootMove, pinned: r.theirMovePinned,
      theirChoices: r.theirs.map((o) => o.choice), freeChoices: free.theirs.map((o) => o.choice),
      cleared: mon.nextMove === null && !mon.revealedMoves.has('thunderwave'),
      inEveryWorld: sampleWorlds(dex, b, { count: 1, seed: 1 }).length === 1,
    };
    // A seen move goes straight to "next", and the turn ending clears it.
    b.handle('|move|p2a: Grimmsnarl|Spirit Break|p1a: Great Tusk');
    const seenStep = mon.cycleMove('spiritbreak');
    b.handle('|turn|2');
    res.called.seenStep = seenStep;
    res.called.clearedByTurn = mon.nextMove === null;
    // Calling a move they can't use (Choice-locked into another) isn't pinned.
    const c = fresh();
    c.handle('|move|p2a: Grimmsnarl|Spirit Break|p1a: Great Tusk');
    c.them.active.confirmItem('choiceband');
    c.them.active.choiceLockedTo = 'spiritbreak';
    c.them.active.cycleMove('thunderwave'); c.them.active.cycleMove('thunderwave');
    res.called.lockedPinned = engine.search(worlds(c)[0], 1500).theirMovePinned;
  }

  // ---- 15. Illusion: Zoroark-Hisui comes in looking like Muk, then breaks.
  {
    const b = fresh();
    b.handle('|switch|p2a: Muk|Muk-Alola, L85, M|100/100');
    b.handle('|-damage|p2a: Muk|80/100');
    b.handle('|switch|p2a: Grimmsnarl|Grimmsnarl, L82, F|100/100');
    b.handle('|switch|p2a: Muk|Muk-Alola, L85, M|71/100'); // "Muk" again: this is the disguise
    const muk = b.them.active;
    b.handle('|move|p2a: Muk|Focus Blast|p1a: Great Tusk');
    b.handle('|-damage|p2a: Muk|61/100|[from] item: Life Orb');
    b.handle('|move|p1a: Great Tusk|Headlong Rush|p2a: Muk');
    b.handle('|-damage|p2a: Muk|20/100');
    b.handle('|replace|p2a: Zoroark|Zoroark-Hisui, L79, M|20/100');
    b.handle('|-end|p2a: Zoroark|Illusion');
    const zor = b.them.active;
    res.illusion = {
      active: zor.speciesName, mukMoves: [...muk.revealedMoves.keys()], zorMoves: [...zor.revealedMoves.keys()],
      mukHp: muk.hpPercent, zorHp: zor.hpPercent, mukItem: muk.item, zorItem: zor.item,
    };
  }
  // ---- 19. Forme changes: new stats, new Speed, sometimes a new ability.
  {
    const b = fresh();
    b.handle('|switch|p2a: Eiscue|Eiscue, L86, F|100/100');
    const before = b.them.active.normalSpeed;
    b.handle('|-activate|p2a: Eiscue|ability: Ice Face');
    b.handle('|detailschange|p2a: Eiscue|Eiscue-Noice, L86, F');
    const after = b.them.active.normalSpeed;
    // The Noice face outspeeding the turn it changed must not read as a Scarf.
    b.handle('|move|p2a: Eiscue|Icicle Crash|p1a: Great Tusk');
    b.handle('|move|p1a: Great Tusk|Headlong Rush|p2a: Eiscue');
    b.handle('|turn|2');
    const t = fresh();
    t.handle('|switch|p2a: Terapagos|Terapagos, L76|100/100');
    t.handle('|detailschange|p2a: Terapagos|Terapagos-Terastal, L76');
    t.handle('|-activate|p2a: Terapagos|ability: Tera Shift');
    res.formes = {
      before, after, scarf: b.them.active.scarfProven, engineId: worlds(b)[0].theirs.pokemon[1].id,
      teraAbility: t.them.active.ability, teraSpeed: t.them.active.normalSpeed,
      search: (() => { try { return engine.search(worlds(t)[0], 800).ours.length > 0; } catch (e) { return String(e); } })(),
    };
  }

  // ---- 16. Statuses, in Showdown's own spelling, on both sides and the bench.
  {
    const b = fresh();
    b.handle('|-status|p1a: Great Tusk|tox');
    b.handle('|-status|p2a: Grimmsnarl|par');
    b.handle('|switch|p2a: Muk|Muk-Alola, L85, M|100/100');
    b.handle('|-status|p2a: Muk|slp');
    b.handle('|switch|p2a: Grimmsnarl|Grimmsnarl, L82, F|100/100');
    const run = (label, fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, label, error: String(e.message ?? e) }; } };
    const w = worlds(b)[0];
    res.status = {
      sent: [w.ours.pokemon[0].status, w.theirs.pokemon[0].status, w.theirs.pokemon[1].status],
      search: run('search', () => engine.search(w, 1500).ours.length),
      damage: run('damage', () => engine.damage(w).ours.length),
      options: run('options', () => engine.options(w).length),
    };
    // Burn has to actually reach it: a burned Great Tusk's Headlong Rush hits about half as hard.
    const plain = fresh(), burned = fresh();
    burned.handle('|-status|p1a: Great Tusk|brn');
    for (const x of [plain, burned]) x.us.active.revealedMoves.set('headlongrush', 0);
    const hit = (x) => engine.damage(worlds(x)[0]).ours.find((m) => m.id === 'headlongrush')?.max ?? 0;
    res.status.burn = { plain: hit(plain), burned: hit(burned) };
    // Weather and terrain the engine has no name for read as none, not a crash.
    const odd = fresh();
    odd.weather = 'deltastream'; odd.terrain = 'somethingnew';
    res.status.oddField = run('odd field', () => engine.search(worlds(odd)[0], 800).ours.length);
    // And every status Showdown sends, one at a time, through a full advise().
    const advisor = new Advisor(dex, engine);
    res.status.advise = ['brn', 'par', 'slp', 'frz', 'psn', 'tox'].map((st) => {
      const x = fresh(); x.handle(`|-status|p2a: Grimmsnarl|${st}`);
      const r = advisor.advise(x, { budget: 'quick' });
      return `${st}:${r && !r.failed ? 'ok' : `failed ${r?.error}`}`;
    });
  }

  // ---- 17. Every world failing is reported, and a fresh engine can be swapped in.
  {
    const broken = { search: () => { throw new Error('unreachable'); } };
    const r = new Advisor(dex, broken).advise(fresh(), { budget: 'quick' });
    await engine.recover();
    res.failure = { failed: r?.failed === true, error: r?.error, afterRecover: engine.search(worlds(fresh())[0], 800).ours.length };
  }

  // ---- 18. Tera Blast with Tera into a Ghost isn't a Normal move into an immunity.
  {
    const b = fresh();
    b.handle('|switch|p2a: Gengar|Gengar, L80, M|100/100');
    b.us.active.teraType = 'Fire';
    const advisor = new Advisor(dex, engine);
    const acts = advisor.applyGuards([
      { choice: 'terablast', share: 0.5, vetoed: null },
      { choice: 'terablast-tera', share: 0.5, vetoed: null },
    ], b);
    res.teraBlast = Object.fromEntries(acts.map((a) => [a.choice, a.vetoed]));
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

const fx = out.effects;
check('Leftovers healing reveals Leftovers', fx.leftovers.item === 'Leftovers' && fx.leftovers.worlds.every((i) => i === 'leftovers'),
  JSON.stringify(fx.leftovers));
check('Rocky Helmet recoil credits the holder, not the one hit', fx.helmet.theirs === 'Rocky Helmet' && fx.helmet.ours !== 'Rocky Helmet',
  JSON.stringify(fx.helmet));
check('Rough Skin chip credits the holder ([of])', fx.roughSkin.garchomp === 'Rough Skin' && fx.roughSkin.tusk == null,
  JSON.stringify(fx.roughSkin));
check('…and the engine is given it', fx.roughSkin.engine.every((a) => a === 'roughskin'), fx.roughSkin.engine.join());
check('Volt Absorb heal credits the healed one, not [of]', fx.voltAbsorb.lanturn === 'Volt Absorb' && fx.voltAbsorb.tusk == null,
  JSON.stringify(fx.voltAbsorb));
check('Drought on the weather line credits [of]', fx.drought === 'Drought', String(fx.drought));
check('a seen ability replaces a tapped one', fx.tapThenSeen.ability === 'Prankster' && fx.tapThenSeen.confirmed === false,
  JSON.stringify(fx.tapThenSeen));
check('a used-up item is remembered but not given to the engine',
  fx.sitrus.item === 'Sitrus Berry' && fx.sitrus.gone && fx.sitrus.read && fx.sitrus.engine === '', JSON.stringify(fx.sitrus));

const as = out.assumed;
check('an only-option item is assumed', as.item === 'lightclay', String(as.item));
check('an only-option ability is assumed', as.ability === 'snowwarning', String(as.ability));
check('…and every sampled set has them', as.worldItems.join() === 'lightclay' && as.worldAbilities.join() === 'snowwarning',
  `${as.worldItems} / ${as.worldAbilities}`);
check('seeing a different item drops the assumption', out.assumedThenSeen.item === 'Leftovers' && out.assumedThenSeen.assumed === null,
  JSON.stringify(out.assumedThenSeen));

const od = out.odds;
check('move odds add up to about four before anything is seen', Math.abs(od.freshSum - 4) < 0.35, od.freshSum.toFixed(2));
check('a seen move is certain and the total stays about four', od.spiritbreak === 1 && Math.abs(od.afterSum - 4) < 0.35,
  `${od.spiritbreak} ${od.afterSum.toFixed(2)}`);
check('every chance is between 0 and 1', od.inRange);
console.log(`         Grimmsnarl after Spirit Break: ${Object.entries(od.read).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')}`);

const cl = out.called;
check('tapping a move twice: they have it, then they use it next', cl.steps.join() === 'sure,next,maybe', cl.steps.join());
check('the called move reaches the engine', cl.root === 'thunderwave', cl.root);
check('the search answers only that move for them',
  cl.pinned === true && cl.theirChoices.every((c) => c.replace(/-tera$/, '') === 'thunderwave'),
  `${cl.theirChoices.join(', ')} (free: ${cl.freeChoices.join(', ')})`);
check('a third tap clears it', cl.cleared === true);
check('a seen move can be called in one tap', cl.seenStep === 'next', cl.seenStep);
check('the call lasts one turn', cl.clearedByTurn === true);
check('a move they can\'t use isn\'t pinned', cl.lockedPinned === false);

const il = out.illusion;
const fm = out.formes;
check('Eiscue losing its Ice Face gets the Noice face\'s Speed', fm.before < fm.after, `${fm.before} -> ${fm.after}`);
check('…and outspeeding that turn isn\'t read as a Scarf', fm.scarf === false);
check('…and the engine is told which forme', fm.engineId === 'eiscuenoice', fm.engineId);
check('Terapagos-Terastal has Tera Shell, not Tera Shift', fm.teraAbility === 'Tera Shell' && fm.search === true,
  JSON.stringify(fm));

const st = out.status;
check('statuses are passed as Showdown spells them', st.sent.join() === 'tox,par,slp', st.sent.join());
check('a statused position searches instead of crashing', st.search.ok && st.damage.ok && st.options.ok,
  JSON.stringify([st.search, st.damage, st.options].filter((x) => !x.ok)));
check('burn really reaches the engine (physical damage about halves)',
  st.burn.burned > 0 && st.burn.burned < st.burn.plain * 0.6, JSON.stringify(st.burn));
check('weather or terrain it has no name for reads as none', st.oddField.ok, JSON.stringify(st.oddField));
check('every status gets advice', st.advise.every((x) => x.endsWith(':ok')), st.advise.join(' '));
check('every world failing is reported, not silent', out.failure.failed && /unreachable/.test(out.failure.error),
  JSON.stringify(out.failure));
check('a fresh engine can be swapped in and works', out.failure.afterRecover > 0, String(out.failure.afterRecover));
check('Tera Blast + Tera into a Ghost is allowed; plain Tera Blast is still vetoed',
  out.teraBlast['terablast-tera'] === null && /immune to normal/.test(out.teraBlast.terablast ?? ''), JSON.stringify(out.teraBlast));

check('a broken Illusion hands the moves to Zoroark', il.zorMoves.includes('focusblast') && !il.mukMoves.includes('focusblast'),
  JSON.stringify(il));
check('…and the disguise gets its own HP and item back', il.mukHp === 80 && il.zorHp === 20 && il.mukItem == null && il.zorItem === 'Life Orb',
  JSON.stringify(il));
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' / '));

await browser.close();
server.kill();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
