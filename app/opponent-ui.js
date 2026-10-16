// The "their side" block, with things you can tap to confirm.
//
// Shared by the phone panel and the standalone page so they behave the same.
//
// Three kinds of chip, and the difference matters:
//   seen   — witnessed in the battle. Locked; a tap does nothing.
//   sure   — you confirmed it by tapping. Tap again to undo.
//   maybe  — still possible according to the set data. Tap to confirm.
//
// Confirming writes straight into the tracker, so the next search uses it the
// same way it would use something seen: the set narrows, a confirmed Choice
// Scarf moves the speed numbers, a confirmed Encore means every sampled world
// has it.

import { toId } from './data.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function chip(kind, id, label, state) {
  const title = state === 'seen' ? 'seen in the battle'
    : state === 'sure' ? 'you confirmed this — tap to undo'
    : 'tap to confirm';
  return `<button type="button" class="chip ${state}" data-kind="${kind}" `
       + `data-id="${esc(id)}" title="${title}">${esc(label)}</button>`;
}

/** The HTML for the block. `read` is what readOpponent() returns. */
export function renderOpponent(read, dex) {
  if (!read) return '';
  const moveName = (id) => dex.move(id)?.name ?? id;
  const pretty = (id) => id.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Moves: seen, then confirmed, then the rest of the pool.
  const moves = [
    ...read.revealed.map((id) => chip('move', id, moveName(id), 'seen')),
    ...read.confirmedMoves.filter((id) => !read.revealed.includes(id))
      .map((id) => chip('move', id, moveName(id), 'sure')),
    ...read.unseenMoves.map((id) => chip('move', id, moveName(id), 'maybe')),
  ];

  // Item: one known, or the pool.
  const items = read.item
    ? [chip('item', toId(read.item),
        read.scarfProven ? 'Choice Scarf (proven)' : prettyItem(dex, read.item),
        read.itemConfirmed ? 'sure' : 'seen')]
    : read.possibleItems.map((id) => chip('item', id, prettyItem(dex, id), 'maybe'));

  const abilities = read.ability
    ? [chip('ability', toId(read.ability), pretty(read.ability), read.abilityConfirmed ? 'sure' : 'seen')]
    : read.possibleAbilities.map((id) => chip('ability', id, prettyAbility(id), 'maybe'));

  const status = [
    read.status !== 'none' ? read.status : null,
    ...read.volatiles.filter((v) => ['substitute', 'encore', 'taunt', 'confusion', 'leechseed'].includes(v)),
  ].filter(Boolean);

  return `
    <div class="hd">${esc(read.species)} · L${read.level} · ${read.hpPercent}%
      ${status.length ? `<span class="st">${esc(status.join(' · '))}</span>` : ''}</div>
    <div class="r"><span>Could be</span><b class="${read.pinned ? 'pinned' : ''}">${esc(read.roles.join(', ') || 'unknown')}</b></div>
    <div class="r"><span>Speed</span><b class="${read.scarfProven ? 'proven' : ''}">${esc(read.speed ?? 'unknown')}</b></div>
    <div class="chips"><span class="lbl">Item</span>${items.join('')}</div>
    <div class="chips"><span class="lbl">Ability</span>${abilities.join('')}</div>
    <div class="chips"><span class="lbl">Moves</span>${moves.join('')}</div>
    <div class="hint">tap anything to confirm it · tap again to undo</div>`;
}

/**
 * Handle a tap inside the block. Returns true if something changed.
 *
 * `mon` is the opponent's active TrackedMon.
 */
export function applyTap(target, mon) {
  const button = target.closest?.('button.chip');
  if (!button || !mon) return false;
  const { kind, id } = button.dataset;
  if (button.classList.contains('seen')) return false; // witnessed, not yours to undo
  switch (kind) {
    case 'move': mon.confirmMove(id); return true;
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
  return ITEM_NAMES[key] ?? id;
}
function prettyAbility(id) {
  // Best effort: the bundle stores ability ids only.
  return id.replace(/^(.)/, (c) => c.toUpperCase());
}
