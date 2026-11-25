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
import { Battle } from './battle.js';
import { Engine } from './engine.js';
import { Advisor, moveIdOf, isTeraChoice } from './advisor.js';
import { readOpponent, sampleWorlds } from './infer.js';
import { renderOpponent, applyTap } from './opponent-ui.js';
import { readChat, RivalMoves } from './chat.js';
import { GameRecorder } from './recorder.js';
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
  <div class="assist-chat" id="assist-chat" aria-live="polite">
    <div class="them" id="assist-chat-them"></div>
    <div class="all" id="assist-chat-all"></div>
    <div class="move" id="assist-chat-move"></div>
  </div>
  <div class="assist-moves" id="assist-moves" aria-label="their possible moves"></div>
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
        <button type="button" data-budget="normal">normal</button>
        <button type="button" data-budget="deep" aria-pressed="true">deep</button>
      </div>
      <span class="assist-cost" id="assist-cost"></span>
      <span class="assist-ver" id="assist-ver" title="the version this phone is running"></span>
    </div>
  </div>
</div>`;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let dex = null, engine = null, advisor = null;
let battle = null, ourName = null;
// Deep from the start: it's what you'd pick anyway, and a turn has the time.
let budget = 'deep', thinking = false, dirty = false;
/** Damage both ways for the active pair, worked out each think, for the moves row. */
let threat = null;
/** We're a player in this battle (we've had a request), so gg can be said. */
let weArePlaying = false, ggSent = false;
/** The game being recorded, and the version that recorded it. */
let recorder = null, appVersion = null;
const GAMES_ENDPOINT = new URL('../games/save', BASE).href;
/** The Tera box: advice and damage as if we Tera this turn. */
let teraNow = false;
/** Chat for the strip above the bar: the opponent's lines, and everyone else's. */
const CHAT_KEEP = 2;
let chatThem = [], chatAll = [];
/** Their last move and what it did to you, one line right above the bar. */
let rivalMoves = new RivalMoves(), lastRivalMove = '';

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
      if (recorder && !recorder.record.final) recorder.save(); // a game left unfinished
      room = currentRoom;
      battle = new Battle(dex);
      recorder = new GameRecorder({ room, version: appVersion, endpoint: GAMES_ENDPOINT });
      ourName = ourName ?? findOurName();
      chatThem = []; chatAll = [];
      rivalMoves = new RivalMoves(); lastRivalMove = '';
      threat = null; weArePlaying = false; ggSent = false;
      renderChat();
      setCall('reading the battle', 'warn');
      continue;
    }
    if (!battle || currentRoom !== room) continue;
    recorder?.line(raw);

    // Read before the battle applies the line, so our HP before the hit is known.
    const moved = rivalMoves.read(raw, battle);
    if (moved) { lastRivalMove = moved; renderChat(); }

    const said = readChat(raw, { them: battle.them.name, us: ourName });
    if (said) {
      const list = said.kind === 'them' ? chatThem : chatAll;
      list.push(said);
      if (list.length > CHAT_KEEP) list.shift();
      renderChat();
    }

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

    if (recorder) {
      // Save as it goes, so a closed tab still leaves most of the game.
      if (raw.startsWith('|turn|') && battle.turn - recorder.sentTurn >= 5) {
        recorder.sentTurn = battle.turn;
        recorder.sync(battle, ourName);
        recorder.save();
      }
      // The final save waits a moment for the ladder's rating line.
      if ((raw.startsWith('|win|') || raw === '|tie' || raw.startsWith('|tie|')) && !recorder.finishing) {
        recorder.finishing = true;
        const r = recorder;
        setTimeout(() => { r.sync(battle, ourName); r.save({ final: true }); }, 4000);
      }
    }
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
  if (!battle.applyRequest(request)) return;
  weArePlaying = true;
  if (request.side.name) ourName = request.side.name;
  if (!battle.us.canTera) teraNow = false;
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
    renderMoves();
    return;
  }

  thinking = true;
  $('assist-cost').dataset.thinking = 'true';

  setTimeout(() => {
    try {
      // The game can end between queueing this and running it; a search
      // finishing after that must not draw over the result.
      if (battle.ended) { showEnd(); return; }
      showDamage();
      const result = advisor.advise(battle, { budget, teraNow });
      recorder?.advice(battle, result, { budget, teraNow });
      if (result?.failed) searchFailed(result.error);
      else if (result) show(result);
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
  // The engine's word for "there's only one thing you can do".
  if (choice === 'No Move') {
    return battle?.us?.active?.volatiles.has('mustrecharge') ? 'Recharge (no choice this turn)' : 'No choice this turn';
  }
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
  // Nothing left to choose: don't leave the last turn's options up.
  $('assist-opts').innerHTML = '';
  $('assist-dmg').innerHTML = '';
  renderMoves();
}

/**
 * Say "gg" in the battle room. Goes through the page's own connection, via a
 * hook that only passes plain chat lines (never a command), or the client's
 * own send if the hook isn't there.
 */
function sendGG() {
  if (!room) return false;
  if (window.__assistFeed?.say) return window.__assistFeed.say(room, 'gg');
  if (typeof window.app?.send === 'function') { window.app.send('gg', room); return true; }
  return false;
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
  if (!us || !them || !engine || us.fainted || them.fainted) { box.innerHTML = ''; renderMoves(); return; }

  const worlds = sampleWorlds(dex, battle, { count: 4, teraNow });
  // Every move they could have, not only the four each sampled set happened
  // to draw — that was why some of theirs only showed up once tapped.
  const odds = them.moveOdds();
  const pool = [...odds.keys()];
  const groups = [];
  for (let i = 0; i < pool.length; i += 4) groups.push(pool.slice(i, i + 4));
  const ours = new Map(), theirs = new Map();
  const fold = (map, m, maxhp) => {
    if (!m.id) return;
    const lo = Math.floor(m.min / maxhp * 100), hi = Math.ceil(m.max / maxhp * 100);
    const e = map.get(m.id) ?? { id: m.id, lo: Infinity, hi: 0 };
    e.lo = Math.min(e.lo, lo); e.hi = Math.max(e.hi, hi);
    map.set(m.id, e);
  };
  // Their moves in fours, swapped into each sampled set in turn, so each one
  // is worked out against the items and abilities they might really have.
  const withTheirMoves = (w, group) => ({
    ...w,
    theirs: {
      ...w.theirs,
      pokemon: w.theirs.pokemon.map((p, i) => (i === w.theirs.active
        ? { ...p, moves: group, disabled: [], pp: group.map(() => 16) } : p)),
    },
  });
  for (const w of worlds) {
    for (const group of groups.length ? groups : [null]) {
      let d;
      try { d = engine.damage(group ? withTheirMoves(w, group) : w); }
      catch (err) { console.warn('[assist] damage:', err.message); continue; }
      for (const m of d.ours) fold(ours, m, d.theirMaxhp);
      for (const m of d.theirs) fold(theirs, m, d.ourMaxhp);
    }
  }
  threat = { them, us, theirs, odds };
  renderMoves();
  if (!ours.size && !theirs.size) { box.innerHTML = ''; return; }

  const dmgText = (e) => (e.hi === 0 ? '—' : e.lo === e.hi ? `${e.hi}%` : `${e.lo}–${e.hi}%`);
  const koText = (e, targetHp) => (e.hi === 0 ? '' : e.lo >= targetHp ? 'KO' : e.hi >= targetHp ? 'can KO' : '');
  const ourRow = (e, targetHp) => {
    const ko = koText(e, targetHp);
    return `<div class="dr">
      <span class="n">${esc(dex.move(e.id)?.name ?? e.id)}</span>
      <span class="p">${dmgText(e)}${ko ? ` <em>${ko}</em>` : ''}</span>
      <span class="b"><i style="width:${Math.min(100, e.hi)}%"></i></span>
    </div>`;
  };
  const ourTag = teraNow && us.teraType ? ` (Tera ${cap(us.teraType)})` : '';

  box.innerHTML = `
    <div class="hd">Your moves${esc(ourTag)} → ${esc(them.speciesName)} at ${Math.round(them.hpPercent)}%</div>
    ${[...ours.values()].map((e) => ourRow(e, Math.round(them.hpPercent))).join('')}
    <div class="hint">of max HP · their moves are in the row above the bar</div>`;
}

/** Type colours for the moves row, the games' own, softened by the CSS. */
const TYPE_COLOR = {
  NORMAL: '#a8a77a', FIRE: '#ee8130', WATER: '#6390f0', ELECTRIC: '#f7d02c', GRASS: '#7ac74c',
  ICE: '#96d9d6', FIGHTING: '#c22e28', POISON: '#a33ea1', GROUND: '#e2bf65', FLYING: '#a98ff3',
  PSYCHIC: '#f95587', BUG: '#a6b91a', ROCK: '#b6a136', GHOST: '#735797', DRAGON: '#6f35fc',
  DARK: '#705746', STEEL: '#b7b7ce', FAIRY: '#d685ad',
};

/**
 * Their moves, in a thin row right above the bar: what each does to you, and
 * for anything not seen or confirmed, how likely they are to have it. Tap a
 * chip: they have it; again: they'll use it next turn; again: undo.
 *
 * Drawn from the last think's damage when it was for this same pair, and with
 * the odds alone when the pair just changed and the numbers haven't caught up.
 * When the game's over, the row is the gg button instead.
 */
function renderMoves() {
  const row = $('assist-moves');
  if (!row) return;
  if (battle?.ended) {
    row.innerHTML = weArePlaying
      ? `<button type="button" class="gg" id="assist-gg" ${ggSent ? 'disabled' : ''}>${ggSent ? 'gg sent' : 'gg'}</button>`
      : '';
    fitBody();
    return;
  }
  const them = battle?.them?.active;
  if (!them || them.fainted) { row.innerHTML = ''; fitBody(); return; }

  const fresh = threat && threat.them === them && threat.us === battle.us.active;
  const odds = fresh ? threat.odds : them.moveOdds();
  const known = new Set(them.revealedMoves.keys());
  const ourHp = Math.round(battle.us.active?.hpPercent ?? 100);
  const ids = [...odds.keys()].sort((a, b) =>
    Number(b === them.nextMove) - Number(a === them.nextMove)
    || Number(known.has(b)) - Number(known.has(a))
    || (odds.get(b) ?? 0) - (odds.get(a) ?? 0));

  row.innerHTML = `<span class="lb">${esc(them.speciesName)}</span>` + ids.map((id) => {
    const move = dex.move(id);
    const e = fresh ? threat.theirs.get(id) : null;
    const dmg = !e ? '' : e.hi === 0 ? '—' : e.lo === e.hi ? `${e.hi}%` : `${e.lo}–${e.hi}%`;
    const ko = e && e.hi > 0 ? (e.lo >= ourHp ? 'KO' : e.hi >= ourHp ? 'KO?' : '') : '';
    const sure = known.has(id);
    const state = them.nextMove === id ? 'next' : sure ? 'sure' : 'maybe';
    const color = TYPE_COLOR[String(move?.type ?? '').toUpperCase()] ?? '#98a3b3';
    return `<button type="button" class="mv ${state}" style="--t:${color}" data-kind="move" data-id="${esc(id)}"
        title="${esc(`${move?.name ?? id} · ${move?.type?.toLowerCase() ?? ''}${sure ? '' : ` · ${Math.round((odds.get(id) ?? 0) * 100)}% likely`}`)}">`
      + `<span class="mn">${esc(move?.name ?? id)}</span>`
      + (dmg ? `<span class="md">${dmg}</span>` : '')
      + (ko ? `<span class="ko">${ko}</span>` : '')
      + (sure ? '' : `<span class="ml">${Math.round((odds.get(id) ?? 0) * 100)}%</span>`)
      + `</button>`;
  }).join('');
  fitBody();
}

/**
 * Every sampled set failed to search. Never leave the old advice up looking
 * current: say so, start a fresh copy of the engine (a crash can leave the
 * old one's memory unusable), and try again — once per turn, so a position
 * that genuinely breaks it can't loop.
 */
let recoveredOnTurn = null;
function searchFailed(error) {
  console.error('[assist] search failed:', error);
  $('assist-opts').innerHTML = '';
  $('assist-conf').textContent = '';
  $('assist-why').textContent = `the engine failed on this position (${error})`;
  if (recoveredOnTurn === battle.turn) { setCall('search failed', 'bad'); return; }
  recoveredOnTurn = battle.turn;
  setCall('search failed — restarting the engine', 'bad');
  engine.recover()
    .then(() => queueThink())
    .catch((err) => { console.error('[assist] restart failed:', err); setCall('search failed', 'bad'); });
}

/** Above the bar: their chat, then everyone else's (and them leaving), then their last move. */
function renderChat() {
  const line = (m) => (m.who
    ? `<p class="${m.kind}"><b>${esc(m.who)}:</b> ${esc(m.text)}</p>`
    : `<p class="${m.kind}">${esc(m.text)}</p>`);
  $('assist-chat-them').innerHTML = chatThem.map(line).join('');
  $('assist-chat-all').innerHTML = chatAll.map(line).join('');
  $('assist-chat-move').innerHTML = lastRivalMove ? `<p>${esc(lastRivalMove)}</p>` : '';
  fitBody();
}

/**
 * Keep the client's own buttons clear of the collapsed panel. Its height
 * changes as chat comes and goes, so the page's bottom padding follows it.
 */
function fitBody() {
  const h = ($('assist-chat')?.offsetHeight ?? 0) + ($('assist-moves')?.offsetHeight ?? 0)
    + ($('assist-bar')?.offsetHeight ?? 0);
  if (h > 0) document.body.style.setProperty('padding-bottom', `${h + 4}px`, 'important');
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
  // Their moves live in the row above the bar now, not in here.
  if (read) $('assist-read').innerHTML = renderOpponent(read, dex, { moves: false });
  renderMoves();
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
  for (const id of ['assist-read', 'assist-dmg', 'assist-moves']) {
    $(id).addEventListener('click', (e) => {
      e.stopPropagation();
      if (!battle?.them?.active) return;
      const tapped = e.target.closest?.('[data-kind][data-id]');
      if (applyTap(e.target, battle.them.active)) {
        const mon = battle.them.active;
        const { kind, id } = tapped.dataset;
        recorder?.tap(battle, kind, id, kind === 'move'
          ? (mon.nextMove === id ? 'next' : mon.confirmed.moves.has(id) ? 'sure' : 'cleared')
          : (kind === 'item' ? (mon.confirmed.item ? 'sure' : 'cleared') : (mon.confirmed.ability ? 'sure' : 'cleared')));
        render(); queueThink();
      }
    });
  }
  // The gg button, once the game's over.
  $('assist-moves').addEventListener('click', (e) => {
    if (!e.target.closest('#assist-gg') || ggSent) return;
    ggSent = sendGG();
    if (!ggSent) $('assist-gg').textContent = "couldn't send";
    else renderMoves();
  });
  fitBody();
  window.addEventListener('resize', fitBody);
  // Closing the tab mid-game: send what there is.
  window.addEventListener('pagehide', () => { if (recorder && !recorder.record.final) { recorder.sync(battle, ourName); recorder.beacon(); } });

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
    // Which version this phone is running, so you can tell an update landed.
    fetch(new URL('../VERSION', BASE).href, { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((v) => { if (v.trim()) { appVersion = v.trim(); $('assist-ver').textContent = `v${appVersion}`; } })
      .catch(() => {});
    window.__assist = { get battle() { return battle; }, dex, engine, advisor,
                        get teraNow() { return teraNow; },
                        get chat() { return { them: chatThem, all: chatAll }; } };
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
