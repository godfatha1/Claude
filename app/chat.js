// Chat from the battle room, turned into plain lines for the strip above the bar.
//
// On a phone the client's chat sits under the panel, so what people say there
// is easy to miss. This reads the same lines the client does and sorts them:
// what your opponent says goes on its own line, everything else (you,
// spectators, the timer, the ladder's rating message) goes on the line below.

import { toId } from './data.js';

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'",
                   '&rarr;': '→', '&nbsp;': ' ' };

/** Strip HTML down to its text, for the server's own announcements. */
function textOf(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&[#\w]+;/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Showdown's chat markup (**bold**, __italic__ and friends), dropped. */
const plain = (s) => s.replace(/\*\*|__|~~|``|\^\^/g, '').trim();

/** "☆Name@!" -> "Name": the rank symbol in front, the away marker behind. */
const nameOf = (user) => user.slice(1).split('@')[0].trim();

/**
 * Read one protocol line. Returns { kind, who, text } or null if it isn't
 * chat. `kind` is 'them' (your opponent), 'us', 'chat' (anyone else) or
 * 'notice' (the server: timer, rating, forfeits).
 */
export function readChat(line, { them = null, us = null } = {}) {
  if (!line?.startsWith('|')) return null;
  const parts = line.slice(1).split('|');
  const cmd = parts[0];

  if (cmd === 'raw' || cmd === 'html') {
    const text = textOf(parts.slice(1).join('|'));
    return text ? { kind: 'notice', who: null, text } : null;
  }
  if (cmd === 'inactive' || cmd === '-message') {
    const text = plain(parts.slice(1).join('|'));
    return text ? { kind: 'notice', who: null, text } : null;
  }

  let user, message;
  if (cmd === 'c' || cmd === 'chat') { user = parts[1]; message = parts.slice(2).join('|'); }
  else if (cmd === 'c:') { user = parts[2]; message = parts.slice(3).join('|'); }
  else return null;
  if (!user || message == null) return null;

  const who = nameOf(user);
  if (!who) return message.startsWith('/') ? null : { kind: 'notice', who: null, text: plain(message) };
  const kind = them && toId(who) === toId(them) ? 'them'
    : us && toId(who) === toId(us) ? 'us'
    : 'chat';

  // Commands the client renders specially. Most are noise here.
  if (message.startsWith('//')) message = message.slice(1);
  else if (message.startsWith('/')) {
    const [command, ...rest] = message.slice(1).split(' ');
    const body = rest.join(' ');
    switch (command) {
      case 'me': return { kind, who, text: `* ${who} ${plain(body)}` };
      case 'mee': return { kind, who, text: `${who}${plain(body)}` };
      case 'raw': case 'html': case 'log': case 'text': case 'announce': case 'nonotify': {
        const text = textOf(body);
        return text ? { kind: 'notice', who: null, text } : null;
      }
      case 'uhtml': case 'uhtmlchange': {
        const text = textOf(body.slice(body.indexOf(',') + 1));
        return text ? { kind: 'notice', who: null, text } : null;
      }
      default: return null; // challenges, data blobs and the like
    }
  }
  const text = plain(message);
  return text ? { kind, who, text } : null;
}
