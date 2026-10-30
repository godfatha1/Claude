// The "their side" block, with things you can tap to confirm.
//
// Shared by the phone panel and the standalone page so they behave the same.
//
// Four kinds of chip, and the difference matters:
//   seen     — witnessed in the battle. Locked.
//   sure     — you confirmed it by tapping. Tap again to undo.
//   assumed  — the only option any of its sets has, so taken as known until
//              something shows otherwise.
//   maybe    — still possible according to the set data, with the chance.
//
// Moves go one step further: tap a confirmed or seen move to say "they'll use
// this next turn", and the search answers that move directly.
//
// Confirming writes straight into the tracker, so the next search uses it the
// same way it would use something seen: the set narrows, a confirmed Choice
// Scarf moves the speed numbers, a confirmed Encore means every sampled world
// has it.

import { toId } from './data.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;

function chip(kind, id, label, state, { next = false, odds = null } = {}) {
  const title = next ? 'you think they use this next turn — tap to clear'
    : state === 'seen' ? (kind === 'move' ? 'seen in the battle — tap if they use it next turn' : 'seen in the battle')
    : state === 'sure' ? (kind === 'move' ? 'you confirmed this — tap if they use it next turn' : 'you confirmed this — tap to undo')
    : state === 'assumed' ? 'the only one its sets carry, so assumed — tap to confirm'
    : 'tap to confirm';
  return `<button type="button" class="chip ${state}${next ? ' next' : ''}" data-kind="${kind}" `
       + `data-id="${esc(id)}" title="${title}">${esc(label)}`
       + `${odds != null ? ` <span class="odds">${pct(odds)}</span>` : ''}</button>`;
}

/** The HTML for the block. `read` is what readOpponent() returns. */
export function renderOpponent(read, dex) {
  if (!read) return '';
  const moveName = (id) => dex.move(id)?.name ?? id;
  const pretty = (name) => dex.names?.abilities?.[toId(name)] ?? name;
  const prettyAbility = (id) => dex.names?.abilities?.[toId(id)] ?? capitalise(id);

  // Moves: seen, then confirmed, then the rest of the pool, likeliest first.
  const next = (id) => ({ next: read.nextMove === id });
  const moves = [
    ...read.revealed.map((id) => chip('move', id, moveName(id), 'seen', next(id))),
    ...read.confirmedMoves.filter((id) => !read.revealed.includes(id))
      .map((id) => chip('move', id, moveName(id), 'sure', next(id))),
    ...read.unseenMoves.map((id) => chip('move', id, moveName(id), 'maybe', { odds: read.moveOdds?.[id] })),
  ];

  // Item: one known, its only option, or the pool with the odds.
  const items = read.item
    ? [chip('item', toId(read.item),
        (read.scarfProven ? 'Choice Scarf (proven)' : prettyItem(dex, read.item)) + (read.itemGone ? ' (gone)' : ''),
        read.itemConfirmed ? 'sure' : 'seen')]
    : read.assumedItem
      ? [chip('item', read.assumedItem, prettyItem(dex, read.assumedItem), 'assumed')]
      : read.possibleItems.map((id) => chip('item', id, prettyItem(dex, id), 'maybe', { odds: read.itemOdds?.[id] }));

  const abilities = read.ability
    ? [chip('ability', toId(read.ability), pretty(read.ability), read.abilityConfirmed ? 'sure' : 'seen')]
    : read.assumedAbility
      ? [chip('ability', read.assumedAbility, prettyAbility(read.assumedAbility), 'assumed')]
      : read.possibleAbilities.map((id) => chip('ability', id, prettyAbility(id), 'maybe', { odds: read.abilityOdds?.[id] }));

  const status = [
    read.status !== 'none' ? read.status : null,
    ...read.volatiles.filter((v) => ['substitute', 'encore', 'taunt', 'confusion', 'leechseed'].includes(v)),
    read.volatiles.includes('truant') ? 'loafs this turn' : null,
  ].filter(Boolean);

  return `
    <div class="hd">${esc(read.species)} · L${read.level} · ${read.hpPercent}%
      ${status.length ? `<span class="st">${esc(status.join(' · '))}</span>` : ''}</div>
    <div class="r"><span>Could be</span><b class="${read.pinned ? 'pinned' : ''}">${esc(read.roles.join(', ') || 'unknown')}</b></div>
    <div class="r"><span>Speed</span><b class="${read.scarfProven ? 'proven' : ''}">${esc(read.speed ?? 'unknown')}</b></div>
    <div class="chips"><span class="lbl">Item</span>${items.join('')}</div>
    <div class="chips"><span class="lbl">Ability</span>${abilities.join('')}</div>
    <div class="chips"><span class="lbl">Moves</span>${moves.join('')}</div>
    <div class="hint">tap to confirm · tap a move again: they use it next turn · again: undo</div>`;
}

/**
 * Handle a tap inside the block. Returns true if something changed.
 *
 * `mon` is the opponent's active TrackedMon.
 */
export function applyTap(target, mon) {
  const button = target.closest?.('[data-kind][data-id]');
  if (!button || !mon) return false;
  const { kind, id } = button.dataset;
  // A seen move can still be called as their next one; anything else seen is
  // witnessed, and not yours to undo.
  if (kind === 'move') { mon.cycleMove(id); return true; }
  if (button.classList.contains('seen')) return false;
  switch (kind) {
    case 'item': mon.confirmItem(id); return true;
    case 'ability': mon.confirmAbility(id); return true;
    default: return false;
  }
}

// Item and ability ids have no display names in the bundle, so space them out.
const ITEM_NAMES = {
  choicescarf: 'Choice Scarf', choiceband: 'Choice Band', choicespecs: 'Choice Specs',
  leftovers: 'Leftovers', lifeorb: 'Life Orb', heavydutyboots: 'Heavy-Duty Boots',
  assaultvest: 'Assault Vest', focussash: 'Focus Sash', boosterenergy: 'Booster Energy',
  eviolite: 'Eviolite', blacksludge: 'Black Sludge', rockyhelmet: 'Rocky Helmet',
  sitrusberry: 'Sitrus Berry', airballoon: 'Air Balloon', whiteherb: 'White Herb',
  weaknesspolicy: 'Weakness Policy', loadeddice: 'Loaded Dice', lightclay: 'Light Clay',
  expertbelt: 'Expert Belt', throatspray: 'Throat Spray', covertcloak: 'Covert Cloak',
};
function prettyItem(dex, id) {
  const key = toId(id);
  return dex.names?.items?.[key] ?? ITEM_NAMES[key] ?? id;
}
const capitalise = (id) => String(id).replace(/^(.)/, (c) => c.toUpperCase());
