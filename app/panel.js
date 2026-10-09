// The panel, running inside the Showdown page.
//
// Injected by serve.py into their client. Being in the page rather than beside
// it changes one important thing: we can watch the client's own connection, so
// we see the private feed that carries your team. Watching from outside only
// ever showed what your opponent could see.
//
// It reads and never writes. The socket wrapper below passes everything
// straight through and only looks at what comes back — it cannot send a move.

import { Dex } from './data.js';
import { Battle, TrackedMon } from './battle.js';
import { Engine } from './engine.js';
import { Advisor } from './advisor.js';
import { readOpponent } from './infer.js';

const BASE = new URL('.', import.meta.url).href;

// ------------------------------------------------------- watching the feed

/**
 * Pick up the feed the early listener has been collecting.
 *
 * The wrapping itself happens in a small script the server puts at the top of
 * the page, because by the time a module runs the client has already connected
 * and the first exchange is gone. Anything heard before now is replayed, so
 * nothing is missed.
 */
function watchTheConnection(onLine) {
  const feed = window.__assistFeed;
  if (!feed) {
    console.warn('[assist] the early listener is missing — is this page coming through serve.py?');
    return false;
  }
  for (const line of feed.lines.splice(0)) onLine(line);
  feed.listener = onLine;
  return true;
}

// ------------------------------------------------------------- the panel

const PANEL = `
<div class="assist" id="assist" data-open="false">
  <button class="assist-bar" id="assist-bar" type="button" aria-expanded="false">
    <span class="assist-dot" id="assist-dot"></span>
    <span class="assist-call" id="assist-call">starting up</span>
    <span class="assist-conf" id="assist-conf"></span>
    <svg class="assist-chev" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>
  <div class="assist-body" id="assist-body">
    <p class="assist-why" id="assist-why"></p>
    <ol class="assist-opts" id="assist-opts"></ol>
    <div class="assist-read" id="assist-read"></div>
    <ul class="assist-notes" id="assist-notes"></ul>
    <div class="assist-foot">
      <div class="assist-seg" id="assist-seg">
        <button type="button" data-budget="quick">quick</button>
        <button type="button" data-budget="normal" aria-pressed="true">normal</button>
        <button type="button" data-budget="deep">deep</button>
      </div>
      <span class="assist-cost" id="assist-cost"></span>
    </div>
  </div>
</div>`;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let dex = null, engine = null, advisor = null;
let battle = null, ourName = null;
let budget = 'normal', thinking = false, dirty = false;

function setCall(text, tone = '') {
  $('assist-call').textContent = text;
  $('assist-dot').className = `assist-dot ${tone}`;
}

/** Which player are we? The client tells us on login. */
function findOurName() {
  // The old client and the new one keep it in different places; try both, then
  // fall back to the page's own header.
  const candidates = [
    window.app?.user?.get?.('name'),
    window.app?.user?.attributes?.name,
    window.PS?.user?.name,
  ];
  for (const name of candidates) {
    if (name && !/^Guest /.test(name)) return String(name);
  }
  const header = document.querySelector('.username');
  const text = header?.textContent?.trim();
  return text && !/^Guest /.test(text) ? text : null;
}

// --------------------------------------------------------- reading battles

/**
 * Feed one chunk of the client's traffic in.
 *
 * Showdown sends several lines at a time, prefixed with the room they belong
 * to. We follow one random battle at a time.
 */
let room = null;

function handleChunk(chunk) {
  if (!dex) return;
  let currentRoom = room;

  for (const raw of chunk.split('\n')) {
    if (raw.startsWith('>')) { currentRoom = raw.slice(1).trim(); continue; }
    if (!raw) continue;

    // Start following a battle when one begins.
    if (currentRoom?.startsWith('battle-') && raw.startsWith('|init|battle')) {
      room = currentRoom;
      battle = new Battle(dex);
      ourName = ourName ?? findOurName();
      setCall('reading the battle', 'warn');
      continue;
    }
    if (!battle || currentRoom !== room) continue;

    let changed = false;
    try { changed = battle.handle(raw); }
    catch (err) { console.warn('[assist] line:', raw, err); }

    // The private feed names our side, which is the whole reason for being in
    // the page rather than watching from outside.
    if (raw.startsWith('|player|')) {
      ourName = ourName ?? findOurName();
      if (ourName) battle.setOurName(ourName);
    }
    if (raw.startsWith('|request|')) applyOwnTeam(raw);

    if (changed) { render(); if (raw.startsWith('|turn|')) queueThink(); }
  }
  room = currentRoom?.startsWith('battle-') ? currentRoom : room;
}

/**
 * Fill in our own side from the client's private feed.
 *
 * This is exact: our species, moves, items and HP, not an inference. It's the
 * one thing watching from outside could never get.
 */
function applyOwnTeam(line) {
  let request;
  try { request = JSON.parse(line.slice('|request|'.length)); }
  catch { return; }
  if (!request?.side?.pokemon) return;

  // Which side are we? The request says so.
  const slot = request.side.id; // 'p1' or 'p2'
  if (slot && battle.sides[slot]) battle.ourSlot = slot;

  const ours = battle.us;
  for (const entry of request.side.pokemon) {
    const details = entry.details || '';
    const species = details.split(',')[0].trim();
    let mon = ours.find(species);

    // Add the ones we haven't seen on the field yet. This is the real gain
    // from being in the page: your whole bench, by name, from turn one. From
    // outside we could only ever say "switch out" and let you pick.
    if (!mon) {
      const level = /L(\d+)/.exec(details)?.[1];
      mon = new TrackedMon(dex, species, level ? parseInt(level, 10) : null,
                           /\bF\b/.test(details) ? 'F' : /\bM\b/.test(details) ? 'M' : null);
      if (!mon.isKnown) continue;
      ours.team.push(mon);
    }
    for (const move of entry.moves ?? []) {
      if (!mon.revealedMoves.has(move)) mon.revealedMoves.set(move, 0);
    }
    if (entry.item) mon.item = entry.item;
    if (entry.ability || entry.baseAbility) mon.ability = entry.ability || entry.baseAbility;
    const condition = String(entry.condition ?? '');
    const hp = /^(\d+)\/(\d+)/.exec(condition);
    if (hp) {
      mon.hpExact = parseInt(hp[1], 10);
      mon.hpIsExact = true;
      mon.hpPercent = (mon.hpExact / parseInt(hp[2], 10)) * 100;
    }
    if (/fnt/.test(condition)) mon.fainted = true;
  }
  queueThink();
}

// ------------------------------------------------------------- the advice

function queueThink() {
  if (thinking) { dirty = true; return; }
  think();
}

function think() {
  if (!battle || !advisor) return;
  if (battle.ended) {
    setCall(battle.winner ? `${battle.winner} won` : 'battle over');
    $('assist-conf').textContent = '';
    return;
  }
  if (!battle.us.active || !battle.them.active) return;

  thinking = true;
  $('assist-cost').dataset.thinking = 'true';

  setTimeout(() => {
    try {
      const result = advisor.advise(battle, { budget });
      if (result) show(result);
    } catch (err) {
      console.error('[assist]', err);
      setCall('search failed', 'bad');
    } finally {
      thinking = false;
      $('assist-cost').dataset.thinking = 'false';
      if (dirty) { dirty = false; think(); }
    }
  }, 0);
}

function label(choice, action = null) {
  if (action?.unnamedSwitch) return 'Switch out';
  if (choice.startsWith('switch ')) {
    const name = choice.slice(7);
    return `Switch to ${dex.get(name)?.n ?? name}`;
  }
  return dex.move(choice)?.name ?? choice;
}

function show(result) {
  const playable = result.actions.filter((a) => !a.vetoed);
  const best = playable[0] ?? result.actions[0];
  if (best) {
    setCall(label(best.choice, best), 'live');
    $('assist-conf').textContent = `${Math.round(best.share * 100)}%`;
    $('assist-why').textContent = advisor.explain(best, result, battle);
  }
  $('assist-cost').textContent =
    `${result.worlds} sets · ${(result.positions / 1000).toFixed(0)}k · ${result.elapsedMs}ms`;

  $('assist-opts').innerHTML = result.actions.map((action, i) => {
    const share = Math.round(action.share * 100);
    const swing = action.bestValue - action.worstValue;
    return `<li class="${!action.vetoed && i === 0 ? 'top' : ''} ${action.vetoed ? 'out' : ''}">
      <span class="n">${esc(label(action.choice, action))}</span>
      <span class="s">${share}%</span>
      <span class="b"><i style="width:${Math.max(1, share)}%"></i></span>
      ${action.vetoed ? `<span class="v">${esc(action.vetoed)}</span>`
        : swing > 0.2 ? `<span class="m">${Math.round(action.worstValue * 100)}–${Math.round(action.bestValue * 100)}% depending on their set</span>`
        : ''}
    </li>`;
  }).join('');
}

function render() {
  if (!battle) return;
  const read = readOpponent(battle);
  if (read) {
    const rows = [
      ['Could be', read.roles.join(', ') || 'unknown'],
      ['Speed', read.speed ?? 'unknown'],
      ['Item', read.scarfProven ? 'Choice Scarf (proven)'
        : read.item || read.possibleItems.join(', ') || 'unknown'],
      ['Might have', read.unseenMoves.slice(0, 6)
        .map((m) => dex.move(m)?.name ?? m).join(', ') || '—'],
    ];
    $('assist-read').innerHTML =
      `<div class="hd">${esc(read.species)} · L${read.level} · ${read.hpPercent}%</div>`
      + rows.map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  }
  const notes = battle.notes.slice(-3).reverse();
  $('assist-notes').innerHTML = notes
    .map((n) => `<li>${esc(n.text)}</li>`).join('');
}

// ---------------------------------------------------------------- startup

async function start() {
  document.body.insertAdjacentHTML('beforeend', PANEL);

  $('assist-bar').addEventListener('click', () => {
    const el = $('assist');
    const open = el.dataset.open !== 'true';
    el.dataset.open = String(open);
    $('assist-bar').setAttribute('aria-expanded', String(open));
  });
  $('assist-seg').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    budget = button.dataset.budget;
    for (const other of $('assist-seg').querySelectorAll('button')) {
      other.setAttribute('aria-pressed', String(other === button));
    }
    think();
  });

  try {
    const [loadedDex, loadedEngine] = await Promise.all([
      Dex.load(new URL('../data/gen9randombattle.json', BASE).href),
      Engine.load(new URL('../engine/poke_engine_wasm.js', BASE).href),
    ]);
    dex = loadedDex;
    engine = loadedEngine;
    advisor = new Advisor(dex, engine);
    setCall('ready — start a random battle');
    // Only now start reading: the backlog replays into a panel that can show it.
    watchTheConnection(handleChunk);
  } catch (err) {
    setCall('failed to load', 'bad');
    console.error('[assist]', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
