// What goes in the strip above the bar.
//
// On a phone the client's chat sits under the panel, so it's easy to miss. The
// strip shows three things and nothing else: what people type (your
// opponent's lines on their own), your opponent leaving or disconnecting, and
// their last move with what it did to you.

import { toId } from './data.js';

/** Showdown's chat markup (**bold**, __italic__ and friends), dropped. */
const plain = (s) => s.replace(/\*\*|__|~~|``|\^\^/g, '').trim();

/** "☆Name@!" -> "Name": the rank symbol in front, the away marker behind. */
const nameOf = (user) => user.slice(1).split('@')[0].trim();

/**
 * Read one protocol line. Returns { kind, who, text } or null if it isn't
 * something to show. `kind` is:
 *   'them'  — your opponent typed it
 *   'us'    — you did
 *   'chat'  — a spectator did
 *   'leave' — your opponent left, disconnected, came back, or forfeited
 *
 * Everything else is dropped on purpose: timer countdowns, the rating line,
 * server notices, bot announcements.
 */
export function readChat(line, { them = null, us = null } = {}) {
  if (!line?.startsWith('|')) return null;
  const parts = line.slice(1).split('|');
  const cmd = parts[0];
  const isThem = (name) => Boolean(them) && toId(name) === toId(them);

  // The opponent going away, or coming back. The timer's own wording carries
  // how long they have; only the fact is shown.
  if (cmd === 'inactive') {
    const text = parts.slice(1).join('|');
    const m = /^(.+?) (disconnected|reconnected)\b/.exec(text);
    return m && isThem(m[1]) ? { kind: 'leave', who: null, text: `${m[1]} ${m[2]}` } : null;
  }
  if (cmd === '-message') {
    const text = plain(parts.slice(1).join('|'));
    return them && toId(text).startsWith(toId(them)) && /forfeit|lost by/.test(text)
      ? { kind: 'leave', who: null, text } : null;
  }
  if (cmd === 'l' || cmd === 'L') {
    const who = nameOf(parts[1] ?? '');
    return isThem(who) ? { kind: 'leave', who: null, text: `${who} left` } : null;
  }

  let user, message;
  if (cmd === 'c' || cmd === 'chat') { user = parts[1]; message = parts.slice(2).join('|'); }
  else if (cmd === 'c:') { user = parts[2]; message = parts.slice(3).join('|'); }
  else return null;
  if (!user || message == null) return null;

  const who = nameOf(user);
  if (!who) return null; // the server talking, not a person
  const kind = isThem(who) ? 'them' : us && toId(who) === toId(us) ? 'us' : 'chat';

  // Commands: only /me is something a person said.
  if (message.startsWith('//')) message = message.slice(1);
  else if (message.startsWith('/')) {
    const [command, ...rest] = message.slice(1).split(' ');
    const body = rest.join(' ');
    if (command === 'me') return { kind, who, text: `* ${who} ${plain(body)}` };
    if (command === 'mee') return { kind, who, text: `${who}${plain(body)}` };
    return null;
  }
  const text = plain(message);
  return text ? { kind, who, text } : null;
}

/**
 * Their last move and what it did to you, as one line:
 * "Garchomp used Earthquake · Great Tusk −42%".
 *
 * Fed every line *before* the battle applies it, so our HP before the hit is
 * still there to compare against. An action ends at the blank line Showdown
 * puts between actions, or at the next move, switch or turn.
 */
export class RivalMoves {
  constructor() { this.pending = null; }

  /** Returns the finished line when an action of theirs completes, else null. */
  read(line, battle) {
    if (!line?.startsWith('|') || !battle?.ourSlot) return null;
    const parts = line.slice(1).split('|');
    const cmd = parts[0];
    const ours = battle.ourSlot;
    const theirs = ours === 'p1' ? 'p2' : 'p1';
    const onSide = (ref, slot) => typeof ref === 'string' && ref.startsWith(slot);

    let done = null;
    const ends = ['', 'move', 'switch', 'drag', 'replace', 'turn', 'upkeep', 'win', 'tie', 'cant'];
    if (this.pending && ends.includes(cmd)) done = this.finish();

    if (cmd === 'move' && onSide(parts[1], theirs)) {
      const usActive = battle.us.active;
      this.pending = {
        who: battle.them.active?.speciesName ?? parts[1].replace(/^p[12][a-c]?:\s*/, ''),
        move: parts[2],
        target: usActive?.speciesName ?? null,
        hp: usActive?.hpPercent ?? null,
        lost: 0, outcome: null, fainted: false,
      };
      return done;
    }
    const p = this.pending;
    if (!p) return done;

    const hasFrom = parts.some((x) => /^\[from\]/.test(x));
    if (cmd === '-damage' && onSide(parts[1], ours) && !hasFrom) {
      const now = hpPercentOf(parts[2]);
      if (now != null && p.hp != null) { p.lost += Math.max(0, p.hp - now); p.hp = now; }
    } else if (cmd === 'faint' && onSide(parts[1], ours)) {
      p.fainted = true;
    } else if (cmd === '-miss' && onSide(parts[1], theirs)) {
      p.outcome = 'missed';
    } else if (cmd === '-immune' && onSide(parts[1], ours)) {
      p.outcome = 'no effect';
    } else if (cmd === '-activate' && onSide(parts[1], ours) && /substitute/i.test(parts[2] ?? '') && parts.includes('[damage]')) {
      p.outcome = 'hit your Substitute';
    } else if (cmd === '-fail' && onSide(parts[1], theirs)) {
      p.outcome = p.outcome ?? 'failed';
    }
    return done;
  }

  finish() {
    const p = this.pending;
    this.pending = null;
    if (!p) return null;
    let text = `${p.who} used ${p.move}`;
    if (p.lost >= 0.5) text += ` · ${p.target ?? 'you'} −${Math.round(p.lost)}%`;
    else if (p.outcome) text += ` · ${p.outcome}`;
    if (p.fainted) text += ' (fainted)';
    return text;
  }
}

/** "180/250", "72/100 par", "0 fnt" -> a percentage, or null. */
function hpPercentOf(hp) {
  if (!hp) return null;
  if (/fnt/.test(hp)) return 0;
  const m = /^(\d+)\/(\d+)/.exec(hp);
  return m ? (parseInt(m[1], 10) / parseInt(m[2], 10)) * 100 : null;
}
