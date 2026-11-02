// The strip above the bar: what it shows, and what it leaves out.
import { readFileSync } from 'node:fs';
import { readChat, RivalMoves } from '../../app/chat.js';
import { Dex } from '../../app/data.js';
import { Battle } from '../../app/battle.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};
const who = { them: 'Foe Guy', us: 'Rayan' };
const r = (line) => readChat(line, who);

// Shown: what people type.
check("the opponent's line is theirs", r('|c|☆Foe Guy|gg')?.kind === 'them');
check('ours is ours, away marker and all', r('|c:|1700000000|☆Rayan@!|lol')?.kind === 'us');
check('a spectator is just chat', r('|c| spectator|nice')?.kind === 'chat');
check('chat markup is dropped', r('|c|☆Foe Guy|**gg** __ez__')?.text === 'gg ez');
check('a pipe inside a message survives', r('|c|☆Foe Guy|a|b')?.text === 'a|b');
check('/me reads as an action', r('|c|☆Foe Guy|/me sighs')?.text === '* Foe Guy sighs');

// Shown: the opponent going away, without the countdown.
check('their disconnect, minus the time left',
  r('|inactive|Foe Guy disconnected and has a minute to reconnect!')?.text === 'Foe Guy disconnected');
check('their reconnect, minus the time left',
  r('|inactive|Foe Guy reconnected and has 120 seconds left.')?.text === 'Foe Guy reconnected');
check('their forfeit', r('|-message|Foe Guy forfeited.')?.kind === 'leave');
check('them leaving the room', r('|l|☆Foe Guy')?.text === 'Foe Guy left');

// Not shown.
check('no timer countdowns', r('|inactive|Foe Guy has 60 seconds left.') === null
  && r('|inactive|Rayan has 30 seconds left.') === null
  && r('|inactive|Battle timer is ON: inactive players will automatically lose when time\'s up.') === null);
check('no disconnect countdown', r('|inactive|Foe Guy has 45 seconds to reconnect!') === null);
check("someone else leaving isn't news", r('|l| spectator') === null && r('|inactive|Rayan disconnected!') === null);
check('no rating line', r("|raw|Rayan's rating: 1234 &rarr; <strong>1250</strong><br />(+16 for winning)") === null);
check('no server notices', r('|html|<div class="message-error">You must be registered to chat.</div>') === null
  && r('|c|~|Server restart in 5 minutes') === null && r('|c| bot|/log something') === null);
check('commands and battle lines are not chat', r('|c|☆Foe Guy|/challenge gen9randombattle') === null
  && r('|move|p1a: X|Tackle|p2a: Y') === null && r('|j| someone') === null);

// Their last move and what it did, from a real-looking exchange.
const dex = new Dex(JSON.parse(readFileSync('data/gen9randombattle.json', 'utf8')));
const b = new Battle(dex);
const feed = new RivalMoves();
const seen = [];
const play = (...lines) => { for (const l of lines) { const done = feed.read(l, b); if (done) seen.push(done); b.handle(l); } };
play('|player|p1|Rayan|1|', '|player|p2|Foe Guy|2|');
b.setOurName('Rayan');
play('|switch|p1a: Great Tusk|Great Tusk, L77|250/250', '|switch|p2a: Garchomp|Garchomp, L74, M|100/100', '|turn|1',
  '|move|p2a: Garchomp|Earthquake|p1a: Great Tusk', '|-damage|p1a: Great Tusk|145/250', '|',
  '|move|p1a: Great Tusk|Headlong Rush|p2a: Garchomp', '|-damage|p2a: Garchomp|40/100', '|',
  '|-damage|p1a: Great Tusk|130/250|[from] Stealth Rock', '|upkeep', '|turn|2',
  '|move|p2a: Garchomp|Stone Edge|p1a: Great Tusk|[miss]', '|-miss|p2a: Garchomp|p1a: Great Tusk', '|',
  '|turn|3',
  '|move|p2a: Garchomp|Scale Shot|p1a: Great Tusk', '|-damage|p1a: Great Tusk|90/250', '|-damage|p1a: Great Tusk|40/250',
  '|-damage|p1a: Great Tusk|0 fnt', '|-hitcount|p1a: Great Tusk|3', '|faint|p1a: Great Tusk', '|');
check('their move and the damage you took', seen[0] === 'Garchomp used Earthquake · Great Tusk −42%', seen[0]);
check('a miss says so', seen[1] === 'Garchomp used Stone Edge · missed', seen[1]);
check('multi-hit adds up, and a KO says so', seen[2] === 'Garchomp used Scale Shot · Great Tusk −52% (fainted)', seen[2]);
check('our own moves and hazard chip are not on it', seen.length === 3, seen.join(' | '));

const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
