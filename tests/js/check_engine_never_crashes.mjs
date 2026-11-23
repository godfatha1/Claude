// Does the engine survive every position real games produce?
//
// A crash in the engine is the worst failure the panel has: the search stops,
// and before 0.7.2 the old advice stayed up looking current. Waiting for one
// to turn up in a single watched game is hopeless, so this plays many real
// games on a local Showdown server, records them from one player's own feed
// (exactly what the panel sees, private team and all), then replays each in a
// browser and puts every position through the engine: search, damage and the
// list of options. Any crash is saved with the position that caused it.
//
// Usage:  node tests/js/check_engine_never_crashes.mjs [games]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { chromium } from 'playwright';

const GAMES = parseInt(process.argv[2] ?? process.env.GAMES ?? '20', 10);
// Positions per search. Deep search reaches lines a shallow one never does.
const DEPTH = parseInt(process.env.DEPTH ?? '25000', 10);
const SERVER = process.env.SHOWDOWN_WS ?? 'ws://localhost:8111/showdown/websocket';
const RUN = Date.now().toString(36).slice(-5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(SERVER);
  const lines = []; // { room, line }
  const listeners = [];
  ws.on('message', (data) => {
    const parts = String(data).split('\n');
    let room = '';
    if (parts[0].startsWith('>')) room = parts.shift().slice(1).trim();
    for (const line of parts) {
      lines.push({ room, line });
      for (const fn of listeners) fn(room, line);
    }
  });
  const wait = (test, ms = 20000) => new Promise((resolve, reject) => {
    const hit = lines.find((x) => test(x.room, x.line));
    if (hit) return resolve(hit);
    const fn = (room, line) => { if (test(room, line)) resolve({ room, line }); };
    listeners.push(fn);
    setTimeout(() => reject(new Error('timed out')), ms);
  });
  return { ws, lines, listeners, wait, ready: new Promise((r) => ws.on('open', r)), send: (m) => ws.send(m) };
}

/** Play one game with random legal choices; return player A's own view of it. */
async function playOne(index) {
  const nameA = `Crash${RUN}a${index}`, nameB = `Crash${RUN}b${index}`;
  const a = connect(), b = connect();
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.wait((r, l) => l.startsWith('|challstr|')), b.wait((r, l) => l.startsWith('|challstr|'))]);
  a.send(`|/trn ${nameA},0,`); b.send(`|/trn ${nameB},0,`);
  await Promise.all([a.wait((r, l) => l.startsWith('|updateuser|') && l.includes(nameA)),
                     b.wait((r, l) => l.startsWith('|updateuser|') && l.includes(nameB))]);
  a.send('|/utm null'); b.send('|/utm null');
  a.send(`|/challenge ${nameB}, gen9randombattle`);
  await b.wait((r, l) => l.startsWith('|pm|') && l.includes('/challenge'));
  b.send(`|/accept ${nameA}`);
  const { room } = await a.wait((r, l) => r.startsWith('battle-') && l.startsWith('|init|battle'));

  const play = (client) => (r, line) => {
    if (r !== room || !line.startsWith('|request|')) return;
    let req; try { req = JSON.parse(line.slice(9)); } catch { return; }
    if (req.wait) return;
    setTimeout(() => {
      if (req.forceSwitch) {
        const opts = (req.side?.pokemon ?? []).map((p, i) => ({ p, i }))
          .filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
        if (opts.length) client.send(`${room}|/choose switch ${opts[Math.floor(Math.random() * opts.length)].i + 1}|${req.rqid}`);
        return;
      }
      const moves = (req.active?.[0]?.moves ?? []).map((m, i) => ({ m, i })).filter(({ m }) => !m.disabled && (m.pp ?? 1) > 0);
      // Sometimes Tera, sometimes switch, so those positions get covered too.
      const canTera = req.active?.[0]?.canTerastallize && Math.random() < 0.25;
      const bench = (req.side?.pokemon ?? []).map((p, i) => ({ p, i })).filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
      if (bench.length && !req.active?.[0]?.trapped && Math.random() < 0.15) {
        client.send(`${room}|/choose switch ${bench[Math.floor(Math.random() * bench.length)].i + 1}|${req.rqid}`);
      } else if (moves.length) {
        const pick = moves[Math.floor(Math.random() * moves.length)];
        client.send(`${room}|/choose move ${pick.i + 1}${canTera ? ' terastallize' : ''}|${req.rqid}`);
      } else client.send(`${room}|/choose default|${req.rqid}`);
    }, 5);
  };
  // Answer any requests that arrived before these listeners existed.
  for (const x of a.lines) play(a)(x.room, x.line);
  for (const x of b.lines) play(b)(x.room, x.line);
  a.listeners.push(play(a)); b.listeners.push(play(b));

  for (let i = 0; i < 600; i++) {
    if (a.lines.some((x) => x.room === room && /^\|(win|tie)\|?/.test(x.line))) break;
    await sleep(100);
  }
  a.ws.close(); b.ws.close();
  return { room, name: nameA, lines: a.lines.filter((x) => x.room === room).map((x) => x.line) };
}

console.log(`playing ${GAMES} real games on ${SERVER}`);
const games = [];
for (let i = 0; i < GAMES; i++) {
  try { games.push(await playOne(i)); process.stdout.write(`  ${i + 1}`); }
  catch (err) { process.stdout.write(`  ${i + 1}(${err.message})`); }
}
console.log();

// --- replay them in a browser, through the engine ------------------------
const PORT = 8747;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: process.cwd(), stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch { /* gone */ } });
await sleep(1200);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/tests/js/harness.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });

const out = await page.evaluate(async ({ games, depth }) => {
  const { Battle } = await import('/app/battle.js');
  const { sampleWorlds } = await import('/app/infer.js');
  const { dex, engine } = window.__h;
  const failures = [];
  let positions = 0, calls = 0;

  const probe = async (b, g, where) => {
    if (!b.us.active || !b.them.active) return;
    const worlds = sampleWorlds(dex, b, { count: 3, seed: positions + 1 });
    positions += 1;
    for (const w of worlds) {
      for (const [what, run] of [['search', () => engine.search(w, depth)], ['damage', () => engine.damage(w)],
                                 ['options', () => engine.options(w)]]) {
        calls += 1;
        try { run(); } catch (err) {
          failures.push({ game: g.room, where, what, error: String(err.message ?? err), turn: b.turn, world: w,
                          recent: b.log.slice(-25) });
          await engine.recover(); // a crash leaves its memory unusable
          return;
        }
      }
    }
  };

  for (const g of games) {
    const b = new Battle(dex);
    for (const line of g.lines) {
      if (line.startsWith('|request|')) {
        let req; try { req = JSON.parse(line.slice(9)); } catch { continue; }
        if (req.wait || !b.applyRequest(req)) continue;
        await probe(b, g, 'request');
        continue;
      }
      b.handle(line);
      if (line.startsWith('|player|')) b.setOurName(g.name);
      if (line.startsWith('|turn|')) await probe(b, g, 'turn');
    }
  }
  return { failures, positions, calls };
}, { games, depth: DEPTH });

await browser.close();
server.kill();

console.log(`  ${games.length} games, ${out.positions} positions, ${out.calls} engine calls, ${DEPTH} deep`);
if (out.failures.length) {
  mkdirSync('tests/js/engine-failures', { recursive: true });
  for (const [i, f] of out.failures.entries()) {
    const name = `tests/js/engine-failures/${Date.now()}-${i}-${f.what}.json`;
    writeFileSync(name, JSON.stringify(f, null, 1));
    console.log(`  FAIL  ${f.what} crashed at turn ${f.turn} (${f.where}) in ${f.game}: ${f.error} — saved to ${name}`);
  }
  console.log(`\n${out.failures.length} FAILED`);
  process.exit(1);
}
console.log('  ok    the engine survived every position\n\nall green');
