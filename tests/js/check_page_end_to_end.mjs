// Drive the whole page in a real browser against a real battle.
//
// Everything else tests a layer. This tests the thing: load the page, connect,
// find a battle by username, watch it, and check that a recommendation actually
// appears and keeps up as the turns go by.
//
// Needs a local Showdown server (scripts/local_server.sh) and serves the repo
// over http, because the page loads its data and engine with fetch.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const WS = process.env.SHOWDOWN_WS ?? 'ws://localhost:8111/showdown/websocket';
const PORT = 8732;

// --- serve the repo ---
const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
  cwd: process.cwd(), stdio: 'ignore',
});
const stopServer = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stopServer);
await new Promise((r) => setTimeout(r, 1500));

// --- start a battle for the page to find ---
function client(name) {
  const ws = new WebSocket(WS);
  const lines = [];
  const waiters = [];
  const hooks = [];
  ws.on('message', (d) => {
    for (const raw of String(d).split('\n')) {
      lines.push(raw);
      for (const fn of hooks) fn(raw);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].test(raw)) { waiters[i].resolve(raw); waiters.splice(i, 1); }
      }
    }
  });
  return {
    name, lines, hooks,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(m),
    wait: (test, ms = 20000) => new Promise((resolve, reject) => {
      for (const l of lines) if (test(l)) return resolve(l);
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error(`${name}: timed out`)), ms);
    }),
    close: () => ws.close(),
  };
}

// A fresh name per run. Re-using one finds an abandoned battle from the last
// run still sitting in the user's room list, and the test then checks a
// position that ended hours ago.
const RUN = Date.now().toString(36).slice(-5);
const WATCHED = `PageTest${RUN}`;
const a = client(WATCHED);
const b = client(`Foe${RUN}`);
await Promise.all([a.ready, b.ready]);
await Promise.all([
  a.wait((l) => l.startsWith('|challstr|')),
  b.wait((l) => l.startsWith('|challstr|')),
]);
a.send(`|/trn ${WATCHED},0,`);
b.send(`|/trn Foe${RUN},0,`);
await Promise.all([
  a.wait((l) => l.startsWith('|updateuser|') && l.includes(WATCHED)),
  b.wait((l) => l.startsWith('|updateuser|') && l.includes(`Foe${RUN}`)),
]);
a.send('|/utm null');
b.send('|/utm null');
a.send(`|/challenge Foe${RUN}, gen9randombattle`);
await b.wait((l) => l.startsWith('|pm|') && l.includes('/challenge gen9randombattle'));
b.send(`|/accept ${WATCHED}`);
const room = (await a.wait((l) => l.startsWith('>battle-'))).slice(1).trim();
console.log(`battle running: ${room}`);

// Hold the players until the page is watching. Otherwise the battle races
// ahead while the page is still loading its engine, and the test ends up
// checking a position that is already over.
let released = false;
const pending = [];
const release = () => {
  released = true;
  // Replay anything that arrived while we were holding.
  const queued = pending.splice(0);
  for (const run of queued) run();
};

// Keep both sides playing so turns keep arriving while the page watches.
const playOn = (c) => (line) => {
  if (!released) { pending.push(() => playOn(c)(line)); return; }
  if (!line.startsWith('|request|') || line.length < 40) return;
  let parsed;
  try { parsed = JSON.parse(line.slice('|request|'.length)); } catch { return; }
  if (parsed.wait) return;
  setTimeout(() => {
    if (parsed.forceSwitch) {
      const options = (parsed.side?.pokemon ?? [])
        .map((p, i) => ({ p, i })).filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
      if (options.length) c.send(`${room}|/choose switch ${options[0].i + 1}|${parsed.rqid}`);
      return;
    }
    const moves = (parsed.active?.[0]?.moves ?? [])
      .map((m, i) => ({ m, i })).filter(({ m }) => !m.disabled && (m.pp ?? 1) > 0);
    if (moves.length) {
      const pickIndex = Math.floor(Math.random() * moves.length);
      c.send(`${room}|/choose move ${moves[pickIndex].i + 1}|${parsed.rqid}`);
    } else {
      c.send(`${room}|/choose default|${parsed.rqid}`);
    }
  }, 1800); // roughly a human pace, so the page is exercised the way it will be used
};
a.hooks.push(playOn(a));
b.hooks.push(playOn(b));

// --- drive the page ---
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

// A mid-range phone, so the timings mean something.
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const consoleErrors = [];
const badResponses = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));
// A bare "failed to load resource" console line doesn't say what failed, which
// makes it useless to debug, so record the URL alongside.
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

const url = `http://localhost:${PORT}/index.html?server=${encodeURIComponent(WS)}`;
await page.goto(url);

// 1. Does it start up at all?
try {
  await page.waitForFunction(
    () => document.getElementById('watchBtn') && !document.getElementById('watchBtn').disabled,
    null, { timeout: 60000 });
  check('page loads its data and engine', true);
} catch {
  check('page loads its data and engine', false, await page.textContent('#state'));
}
console.log(`         status: ${(await page.textContent('#state')).trim()}`);

// 2. Does it find and watch the battle from the name alone?
await page.fill('#nameInput', WATCHED);
await page.click('#watchBtn');
try {
  await page.waitForFunction(
    () => /watching/.test(document.getElementById('state').textContent),
    null, { timeout: 45000 });
  check('finds the battle from the username and watches it', true);
  release(); // now let the battle actually play out
} catch {
  const err = await page.textContent('#setupErr');
  check('finds the battle from the username and watches it', false,
    `${(await page.textContent('#state')).trim()} / ${err?.trim()}`);
  release();
}

// 3. Does a recommendation appear?
let firstCall = null;
try {
  await page.waitForFunction(() => {
    const el = document.getElementById('callMove');
    return el && el.textContent.trim() && el.textContent.trim() !== '—';
  }, null, { timeout: 60000 });
  firstCall = (await page.textContent('#callMove')).trim();
  const confidence = (await page.textContent('#callConf')).trim();
  const why = (await page.textContent('#callWhy')).trim();
  check('shows a recommendation', true);
  console.log(`         "${firstCall}" ${confidence} — ${why}`);
  check('the recommendation has a reason attached', why.length > 10, why);
} catch {
  check('shows a recommendation', false, 'nothing appeared in the ribbon');
}

// 4. Is the ranked list populated? Read it now, while the battle is certainly
// still going — later on it may legitimately be over with nothing to choose.
const ranked = await page.$$eval('#opts li', (items) => items.map((li) => ({
  name: li.querySelector('.oname')?.textContent?.trim(),
  share: li.querySelector('.oshare')?.textContent?.trim(),
  vetoed: li.classList.contains('vetoed'),
})));
const onlySwitches = ranked.every((r) => /^Switch/.test(r.name ?? ''));
if (onlySwitches) {
  // A forced switch really does have one kind of option, so this is not a
  // failure — note it and move on.
  console.log(`         (forced switch: ${ranked.length} option${ranked.length === 1 ? '' : 's'})`);
  check('lists the options available', ranked.length >= 1, 'none at all');
} else {
  check('lists every option with a share', ranked.length >= 2,
    `only ${ranked.length}: ${ranked.map((r) => r.name).join(', ')}`);
}
check('never names a Pokémon it cannot see',
  !ranked.some((r) => /\bnone\b/i.test(r.name ?? '')),
  ranked.map((r) => r.name).join(', '));
if (ranked.length) {
  console.log(`         ${ranked.length} options: ` +
    ranked.slice(0, 4).map((r) => `${r.name} ${r.share}`).join(', '));
}

// 5. Does the opponent read show something real?
const oppName = (await page.textContent('#oppName')).trim();
check('reads their active Pokémon', Boolean(oppName) && oppName !== '—', oppName);
const roles = await page.$$eval('#oppRead dd', (els) => els.map((e) => e.textContent.trim()));
check('narrows their possible sets', roles.some((r) => r && r !== 'unknown'), roles.join(' | '));
console.log(`         ${oppName}: ${roles[0] ?? '?'}`);

// 6. Does it keep up as turns go by?
const turnAt = async () => (await page.textContent('#turnLabel')).trim();
const beforeTurn = await turnAt();
await page.waitForTimeout(12000);
const afterTurn = await turnAt();
const advanced = beforeTurn !== afterTurn;
const over = /won|over/i.test(await page.textContent('#callMove'));
check('follows the battle as turns pass', advanced || over,
  `stuck at ${afterTurn || 'no turn'} and not finished`);
console.log(`         ${beforeTurn || 'turn ?'} -> ${afterTurn || 'turn ?'}`);

// 7. How long does a search take on throttled hardware?
// Wait for a search to land rather than catching one mid-flight.
await page.waitForFunction(
  () => /ms/.test(document.getElementById('cost').textContent),
  null, { timeout: 40000 }).catch(() => {});
const cost = (await page.textContent('#cost')).trim();
check('reports what the search cost', /ms/.test(cost), cost);
console.log(`         ${cost}`);

// 8. Does it survive at phone width without horizontal scroll?
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no sideways scrolling at 390px', overflow <= 1, `${overflow}px wider than the screen`);

// 9. Clean console?
check('nothing 404s', badResponses.length === 0, badResponses.slice(0, 3).join(' / '));
// Drop the generic resource-load line: `badResponses` above covers it with the
// URL attached, and keeping both just reports the same failure twice.
const realErrors = consoleErrors.filter((e) => !/Failed to load resource/i.test(e));
check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' / '));

await page.screenshot({ path: 'tests/js/page-phone.png', fullPage: true });
console.log('\n  screenshot: tests/js/page-phone.png');

await browser.close();
a.close(); b.close();
stopServer();

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
