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
import { Advisor, moveIdOf, isTeraChoice } from './advisor.js';
import { readOpponent, sampleWorlds } from './infer.js';
import { renderOpponent, applyTap } from './opponent-ui.js';
import { toId } from './data.js';

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
    <label class="assist-tera" id="assist-tera-row" hidden>
      <input type="checkbox" id="assist-tera">
      <span id="assist-tera-text">Tera now</span>
      <span class="hint">recomputes the damage and the advice as if you click it</span>
    </label>
    <div class="assist-dmg" id="assist-dmg"></div>
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
/** The Tera box: advice and damage as if we Tera this turn. */
let teraNow = false;

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

  // Which side are we? The request says so, and so does our name.
  const slot = request.side.id; // 'p1' or 'p2'
  if (slot && battle.sides[slot]) battle.ourSlot = slot;
  if (request.side.name) ourName = request.side.name;

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
    // Our real Tera type, rather than the one the set data guesses.
    if (entry.teraType) mon.teraType = entry.teraType;
    const condition = String(entry.condition ?? '');
    const hp = /^(\d+)\/(\d+)/.exec(condition);
    if (hp) {
      mon.hpExact = parseInt(hp[1], 10);
      mon.hpIsExact = true;
      mon.hpPercent = (mon.hpExact / parseInt(hp[2], 10)) * 100;
    }
    if (/fnt/.test(condition)) mon.fainted = true;
  }

  // The request also says, for our active, exactly which moves can be used
  // right now and how much PP is left. Under Encore, Taunt, Disable or a Choice
  // lock this is the authoritative list — it's what the client greys out — so
  // it goes to the engine as-is rather than being inferred.
  const active = request.active?.[0];
  const mon = ours.active;
  if (active && mon) {
    const listed = active.moves ?? [];
    const usable = new Set(listed.filter((m) => !m.disabled).map((m) => m.id ?? toId(m.move)));
    mon.requestDisabled = new Set(
      [...mon.revealedMoves.keys()].filter((id) => !usable.has(id)));
    for (const m of listed) {
      const id = m.id ?? toId(m.move);
      if (id && typeof m.pp === 'number') mon.pp.set(id, m.pp);
    }
    ours.trapped = Boolean(active.trapped);
    // Whether we can Tera right now, and into what. Gone once it's been used.
    ours.canTera = active.canTerastallize || null;
    if (!ours.canTera) teraNow = false;
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
  if (battle.ended) { showEnd(); return; }
  if (!battle.us.active || !battle.them.active) return;
  // Their Pokémon went down and ours didn't: nothing to decide until they
  // bring the next one in. The engine's only answer here would be "no move".
  if (battle.them.active.fainted && !battle.us.active.fainted) {
    setCall('waiting for their switch', 'warn');
    $('assist-conf').textContent = '';
    $('assist-why').textContent = '';
    $('assist-dmg').innerHTML = '';
    return;
  }

  thinking = true;
  $('assist-cost').dataset.thinking = 'true';

  setTimeout(() => {
    try {
      showDamage();
      const result = advisor.advise(battle, { budget, teraNow });
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

const cap = (s) => String(s).replace(/^(.)/, (c) => c.toUpperCase());

function label(choice, action = null) {
  if (action?.unnamedSwitch) return 'Switch out';
  if (choice.startsWith('switch ')) {
    const name = choice.slice(7);
    return `Switch to ${dex.get(name)?.n ?? name}`;
  }
  const id = moveIdOf(choice);
  const name = dex.move(id)?.name ?? id;
  if (!isTeraChoice(choice)) return name;
  // The engine's "use this move and Tera" option.
  const type = battle?.us?.active?.teraType;
  return `${name} + Tera${type ? ` ${cap(type)}` : ''}`;
}

/**
 * The end of the game: who won, and what it did to your rating once the
 * ladder posts it. The rating arrives a moment after the result, so this is
 * drawn again when it does.
 */
function showEnd() {
  let text = battle.winner ? `${battle.winner} won` : 'battle over';
  const mine = ourName ? battle.ratings[toId(ourName)] : null;
  if (mine) {
    const delta = mine.after - mine.before;
    text += ` · ${mine.before} → ${mine.after} (${delta >= 0 ? '+' : ''}${delta})`;
  }
  setCall(text);
  $('assist-conf').textContent = '';
  $('assist-why').textContent = mine?.reason ?? '';
  $('assist-tera-row').hidden = true;
}

/**
 * The damage block: what each of our moves does to them, and what each of
 * theirs does to us, as a share of max HP. From the engine's own calculator,
 * over the same sampled sets the search uses, so the spread of their possible
 * items and abilities is in the range.
 */
function showDamage() {
  const us = battle.us.active, them = battle.them.active;
  const box = $('assist-dmg');
  if (!us || !them || !engine || us.fainted || them.fainted) { box.innerHTML = ''; return; }

  const worlds = sampleWorlds(dex, battle, { count: 4, teraNow });
  const ours = new Map(), theirs = new Map();
  const fold = (map, m, maxhp) => {
    if (!m.id) return;
    const lo = Math.floor(m.min / maxhp * 100), hi = Math.ceil(m.max / maxhp * 100);
    const e = map.get(m.id) ?? { id: m.id, lo: Infinity, hi: 0 };
    e.lo = Math.min(e.lo, lo); e.hi = Math.max(e.hi, hi);
    map.set(m.id, e);
  };
  for (const w of worlds) {
    let d;
    try { d = engine.damage(w); } catch (err) { console.warn('[assist] damage:', err.message); continue; }
    for (const m of d.ours) fold(ours, m, d.theirMaxhp);
    for (const m of d.theirs) fold(theirs, m, d.ourMaxhp);
  }
  if (!ours.size && !theirs.size) { box.innerHTML = ''; return; }

  const row = (e, targetHp, guess) => {
    const name = dex.move(e.id)?.name ?? e.id;
    const pct = e.hi === 0 ? '—' : e.lo === e.hi ? `${e.hi}%` : `${e.lo}–${e.hi}%`;
    const ko = e.hi === 0 ? '' : e.lo >= targetHp ? 'KO' : e.hi >= targetHp ? 'can KO' : '';
    return `<div class="dr ${guess ? 'guess' : ''}">
      <span class="n">${esc(name)}</span>
      <span class="p">${pct}${ko ? ` <em>${ko}</em>` : ''}</span>
      <span class="b"><i style="width:${Math.min(100, e.hi)}%"></i></span>
    </div>`;
  };
  const sure = new Set([...them.revealedMoves.keys()]);
  const theirRows = [...theirs.values()]
    .sort((a, b) => Number(sure.has(b.id)) - Number(sure.has(a.id)) || b.hi - a.hi);
  const ourTag = teraNow && us.teraType ? ` (Tera ${cap(us.teraType)})` : '';

  box.innerHTML = `
    <div class="hd">Your moves${esc(ourTag)} → ${esc(them.speciesName)} at ${Math.round(them.hpPercent)}%</div>
    ${[...ours.values()].map((e) => row(e, Math.round(them.hpPercent), false)).join('')}
    <div class="hd">Their likely moves → ${esc(us.speciesName)} at ${Math.round(us.hpPercent)}%</div>
    ${theirRows.map((e) => row(e, Math.round(us.hpPercent), !sure.has(e.id))).join('')}
    <div class="hint">of max HP · faded rows are guesses from their set data</div>`;
}

function renderTera() {
  const row = $('assist-tera-row');
  const type = battle?.us?.canTera;
  if (!type || battle.ended) { row.hidden = true; return; }
  row.hidden = false;
  $('assist-tera-text').textContent = `Tera ${cap(type)} now`;
  $('assist-tera').checked = teraNow;
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
  renderTera();
  if (battle.ended) showEnd();
  const read = readOpponent(battle);
  if (read) $('assist-read').innerHTML = renderOpponent(read, dex);
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
  // Tapping a chip confirms (or un-confirms) a fact and re-runs the search.
  $('assist-read').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!battle?.them?.active) return;
    if (applyTap(e.target, battle.them.active)) { render(); queueThink(); }
  });

  // The Tera box: everything below it is recomputed as if you click Tera.
  $('assist-tera').addEventListener('change', (e) => {
    teraNow = e.target.checked;
    queueThink();
  });
  $('assist-tera-row').addEventListener('click', (e) => e.stopPropagation());

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
    window.__assist = { get battle() { return battle; }, dex, engine, advisor,
                        get teraNow() { return teraNow; } };
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
