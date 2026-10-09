// Check the panel works inside a Showdown page.
//
// This is the mode that matters now: serve.py passes Showdown's client through
// and adds our panel to it. Being in the page means the panel watches the
// client's own connection, so it sees the private feed carrying your team —
// the thing watching from outside could never get.
//
// A stand-in client is used rather than the real site, because this container
// can't reach Showdown. It connects to a local Showdown server and plays a real
// game, which is what the panel actually reads.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const WS = process.env.SHOWDOWN_WS ?? 'ws://localhost:8111/showdown/websocket';
const FAKE_PORT = 8898;
const MIRROR_PORT = 8142;

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

// --- a stand-in for play.pokemonshowdown.com -----------------------------
// It is a real client in the one way that matters: it opens a websocket to a
// Showdown server and plays, so the panel has genuine traffic to read.
mkdirSync('/tmp/fakeclient', { recursive: true });
writeFileSync('/tmp/fakeclient/server.py', `
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
PAGE = open('/tmp/fakeclient/index.html','rb').read()
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(PAGE)))
        self.end_headers(); self.wfile.write(PAGE)
ThreadingHTTPServer(('127.0.0.1', ${FAKE_PORT}), H).serve_forever()
`);

const RUN = Date.now().toString(36).slice(-5);
writeFileSync('/tmp/fakeclient/index.html', `<!doctype html><html><head>
<meta charset="utf-8"><title>Showdown</title></head><body>
<div class="username">Player${RUN}</div><div id="client">stand-in client</div>
<script>
// The bit that matters: a real connection to a real Showdown server, playing a
// real game. The panel wraps WebSocket, so this is what it reads.
window.__lines = [];
const sock = new WebSocket('${WS}');
let room = null;
sock.onmessage = (e) => {
  window.__lines.push(String(e.data));
  for (const raw of String(e.data).split('\\n')) {
    if (raw.startsWith('>')) { room = raw.slice(1).trim(); continue; }
    if (raw.startsWith('|challstr|')) { sock.send('|/trn Player${RUN},0,'); }
    if (raw.startsWith('|updateuser|') && raw.includes('Player${RUN}')) {
      sock.send('|/utm null');
      setTimeout(() => sock.send('|/search gen9randombattle'), 300);
    }
    if (raw.startsWith('|request|') && raw.length > 40 && room) {
      let req; try { req = JSON.parse(raw.slice(9)); } catch { continue; }
      if (req.wait) continue;
      const r = room;
      setTimeout(() => {
        if (req.forceSwitch) {
          const opts = (req.side?.pokemon||[]).map((p,i)=>({p,i}))
            .filter(({p}) => !p.active && !p.condition.endsWith(' fnt'));
          if (opts.length) sock.send(r+'|/choose switch '+(opts[0].i+1)+'|'+req.rqid);
          return;
        }
        const mv = (req.active?.[0]?.moves||[]).map((m,i)=>({m,i}))
          .filter(({m}) => !m.disabled && (m.pp ?? 1) > 0);
        if (mv.length) sock.send(r+'|/choose move '+(mv[0].i+1)+'|'+req.rqid);
        else sock.send(r+'|/choose default|'+req.rqid);
      }, 1200);
    }
  }
};
</script>
</body></html>`);

const fake = spawn('python3', ['/tmp/fakeclient/server.py'], { stdio: 'ignore' });

// --- the mirror, pointed at the stand-in ---------------------------------
writeFileSync('/tmp/fakeclient/run_mirror.py', `
import pathlib, sys
src = pathlib.Path('${process.cwd()}/serve.py').read_text()
src = src.replace('UPSTREAM = "https://play.pokemonshowdown.com"',
                  'UPSTREAM = "http://127.0.0.1:${FAKE_PORT}"')
sys.argv = ['serve.py', '--port', '${MIRROR_PORT}', '--quiet']
exec(compile(src, 'serve.py', 'exec'),
     {'__name__': '__main__', '__file__': '${process.cwd()}/serve.py'})
`);
const mirror = spawn('python3', ['/tmp/fakeclient/run_mirror.py'], { stdio: 'ignore' });

const stop = () => { try { fake.kill(); mirror.kill(); } catch { /* gone */ } };
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 2500));

// --- drive it ------------------------------------------------------------
// A second player, so the ladder search finds a game.
const foe = new WebSocket(WS);
let foeRoom = null;
foe.on('message', (data) => {
  for (const raw of String(data).split('\n')) {
    if (raw.startsWith('>')) { foeRoom = raw.slice(1).trim(); continue; }
    if (raw.startsWith('|challstr|')) foe.send(`|/trn Foe${RUN},0,`);
    if (raw.startsWith('|updateuser|') && raw.includes(`Foe${RUN}`)) {
      foe.send('|/utm null');
      setTimeout(() => foe.send('|/search gen9randombattle'), 600);
    }
    if (raw.startsWith('|request|') && raw.length > 40 && foeRoom) {
      let req; try { req = JSON.parse(raw.slice(9)); } catch { continue; }
      if (req.wait) continue;
      const r = foeRoom;
      setTimeout(() => {
        if (req.forceSwitch) {
          const opts = (req.side?.pokemon ?? []).map((p, i) => ({ p, i }))
            .filter(({ p }) => !p.active && !p.condition.endsWith(' fnt'));
          if (opts.length) foe.send(`${r}|/choose switch ${opts[0].i + 1}|${req.rqid}`);
          return;
        }
        const mv = (req.active?.[0]?.moves ?? []).map((m, i) => ({ m, i }))
          .filter(({ m }) => !m.disabled && (m.pp ?? 1) > 0);
        if (mv.length) foe.send(`${r}|/choose move ${mv[0].i + 1}|${req.rqid}`);
        else foe.send(`${r}|/choose default|${req.rqid}`);
      }, 1200);
    }
  }
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${MIRROR_PORT}/`);

// 1. Did the panel get added to their page and start up?
try {
  await page.waitForSelector('#assist', { timeout: 30000 });
  check('the panel is added to their page', true);
} catch {
  check('the panel is added to their page', false, 'no #assist element');
}
try {
  await page.waitForFunction(
    () => !/starting up|failed/.test(document.getElementById('assist-call')?.textContent ?? ''),
    null, { timeout: 60000 });
  check('it loads its data and engine', true);
} catch {
  check('it loads its data and engine', false,
    await page.textContent('#assist-call').catch(() => '?'));
}
console.log(`         status: ${(await page.textContent('#assist-call')).trim()}`);

// 2. Did it see the client's traffic?
try {
  await page.waitForFunction(() => window.__lines?.length > 3, null, { timeout: 30000 });
  check('the client connected and is talking', true);
} catch {
  check('the client connected and is talking', false, 'no traffic');
}

// 3. Did it give advice from inside the page?
let call = '';
try {
  await page.waitForFunction(() => {
    const t = document.getElementById('assist-call')?.textContent ?? '';
    return t && !/starting up|ready|reading|connected|failed/i.test(t);
  }, null, { timeout: 90000 });
  call = (await page.textContent('#assist-call')).trim();
  const conf = (await page.textContent('#assist-conf')).trim();
  check('it recommends a move', true);
  console.log(`         "${call}" ${conf}`);
} catch {
  check('it recommends a move', false,
    `stuck at "${(await page.textContent('#assist-call')).trim()}"`);
}

// 4. The point of being in the page: does it know our own team exactly?
await page.click('#assist-bar').catch(() => {});
const ownKnowledge = await page.evaluate(() => {
  const opts = [...document.querySelectorAll('#assist-opts li .n')]
    .map((e) => e.textContent.trim());
  return { opts, hasNamedSwitch: opts.some((o) => /^Switch to /.test(o)) };
});
check('it lists real options', ownKnowledge.opts.length >= 2,
  ownKnowledge.opts.join(', '));
console.log(`         ${ownKnowledge.opts.slice(0, 5).join(', ')}`);
// From inside the page the private feed names our bench, so a switch can be
// named rather than collapsed into a vague "Switch out".
// The point of being in the page: the private feed names our bench, so a
// switch is a named Pokémon rather than a vague "switch out".
check('it names the teammate to switch to (private feed working)',
  ownKnowledge.hasNamedSwitch,
  ownKnowledge.opts.join(', '));

// 5. Clean?
const real = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check('no page errors', real.length === 0, real.slice(0, 3).join(' / '));

await page.screenshot({ path: 'tests/js/panel-in-page.png', fullPage: false });
console.log('\n  screenshot: tests/js/panel-in-page.png');

await browser.close();
foe.close();
stop();

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
