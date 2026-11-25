// Go back over saved games, turn by turn.
//
// For each recommendation the panel made, this rebuilds the position exactly
// as the panel saw it (by replaying the saved log up to that point, with your
// taps), and shows: what it said then, what you actually clicked, and what the
// current version says now. That's how a bad call gets found and fixed, and
// how a change gets checked against games that really happened.
//
// Usage:  node scripts/review_game.mjs <game.json | folder> [...]
//         BUDGET=deep node scripts/review_game.mjs games/
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const files = process.argv.slice(2).flatMap((p) => (statSync(p).isDirectory()
  ? readdirSync(p, { recursive: true }).filter((f) => String(f).endsWith('.json')).map((f) => join(p, String(f)))
  : [p]));
if (!files.length) { console.log('usage: node scripts/review_game.mjs <game.json | folder> [...]'); process.exit(1); }
const games = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, 'utf8')) })).filter((g) => g.kind === 'randbats-game');

const PORT = 8751;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: process.cwd(), stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch { /* gone */ } });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/tests/js/harness.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });

const reviews = await page.evaluate(async ({ games, budget }) => {
  const { Battle } = await import('/app/battle.js');
  const { Advisor, moveIdOf } = await import('/app/advisor.js');
  const { dex, engine } = window.__h;
  const advisor = new Advisor(dex, engine);
  const pct = (s) => `${Math.round((s ?? 0) * 100)}%`;
  const name = (c) => (!c ? '?' : c.startsWith('switch ') ? `→ ${dex.get(c.slice(7))?.n ?? c.slice(7)}`
    : `${dex.move(moveIdOf(c))?.name ?? c}${/-tera$/.test(c) ? ' +Tera' : ''}`);

  return games.map((g) => {
    const b = new Battle(dex);
    const rows = [];
    let li = 0, ti = 0;
    const replayTo = (at) => {
      for (; li < Math.min(at, g.lines.length); li++) {
        const line = g.lines[li];
        if (line.startsWith('|request|')) {
          try { const req = JSON.parse(line.slice(9)); if (!req.wait) b.applyRequest(req); } catch { /* partial */ }
        } else {
          b.handle(line);
          if (line.startsWith('|player|') && g.us) b.setOurName(g.us);
        }
        // Taps happened at this point in the log.
        while (ti < g.taps.length && g.taps[ti].at <= li + 1) {
          const t = g.taps[ti++];
          const mon = b.them.active;
          if (!mon) continue;
          if (t.kind === 'move') mon.cycleMove(t.id);
          else if (t.kind === 'item') mon.confirmItem(t.id);
          else if (t.kind === 'ability') mon.confirmAbility(t.id);
        }
      }
    };
    // What we actually did next: our side's next move or switch after this point.
    const clicked = (at) => {
      const slot = b.ourSlot;
      for (let i = at; i < g.lines.length; i++) {
        const l = g.lines[i];
        if (l.startsWith(`|move|${slot}a:`)) return l.split('|')[3];
        if (l.startsWith(`|switch|${slot}a:`) || l.startsWith(`|drag|${slot}a:`)) return `→ ${l.split('|')[3].split(',')[0]}`;
        if (l.startsWith('|turn|') && i > at) return null;
      }
      return null;
    };
    for (const a of g.advice) {
      replayTo(a.at);
      const then = a.actions?.find((x) => !x.x) ?? a.actions?.[0];
      let now = null;
      try {
        const r = advisor.advise(b, { budget: budget || a.budget || 'normal', teraNow: a.teraNow });
        now = r && !r.failed ? r.actions.find((x) => !x.vetoed) ?? r.actions[0] : { choice: `failed: ${r?.error}` };
      } catch (err) { now = { choice: `error: ${err.message}` }; }
      rows.push({
        turn: a.turn,
        then: a.failed ? `failed: ${a.failed}` : `${name(then?.c)} ${pct(then?.s)}`,
        clicked: clicked(a.at) ?? '—',
        now: now?.share != null ? `${name(now.choice)} ${pct(now.share)}` : now?.choice,
        changed: Boolean(then && now?.choice && then.c !== now.choice),
      });
    }
    replayTo(g.lines.length);
    return { file: g.file, us: g.us, them: g.them, winner: g.winner, version: g.version, rating: g.rating, rows };
  });
}, { games, budget: process.env.BUDGET ?? '' });

await browser.close();
server.kill();

for (const r of reviews) {
  const result = r.winner ? (r.winner === r.us ? 'won' : 'lost') : 'unfinished';
  const rating = r.rating ? ` · ${r.rating.before} → ${r.rating.after}` : '';
  console.log(`\n${r.file}\n  ${r.us} vs ${r.them} · ${result}${rating} · recorded on v${r.version ?? '?'}`);
  console.log(`  ${'turn'.padEnd(5)}${'said then'.padEnd(30)}${'you clicked'.padEnd(24)}says now`);
  // The panel thinks again when the turn's log lands; show a call once.
  const rows = r.rows.filter((row, i) => i === 0 || row.turn !== r.rows[i - 1].turn
    || row.then.split(' ').slice(0, -1).join(' ') !== r.rows[i - 1].then.split(' ').slice(0, -1).join(' '));
  r.rows = rows;
  for (const row of rows) {
    console.log(`  ${String(row.turn).padEnd(5)}${row.then.padEnd(30)}${String(row.clicked).padEnd(24)}${row.now}${row.changed ? '   ← changed' : ''}`);
  }
  const changed = r.rows.filter((x) => x.changed).length;
  console.log(`  ${r.rows.length} calls, ${changed} would be different now`);
}
