// The chat strip's reader, against lines in the server's own formats.
import { readChat } from '../../app/chat.js';

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};
const who = { them: 'Foe Guy', us: 'Rayan' };
const r = (line) => readChat(line, who);

check("the opponent's line is theirs", r('|c|☆Foe Guy|gg')?.kind === 'them');
check('ours is ours, away marker and all', r('|c:|1700000000|☆Rayan@!|lol')?.kind === 'us');
check('a spectator is just chat', r('|c| spectator|nice')?.kind === 'chat');
check('chat markup is dropped', r('|c|☆Foe Guy|**gg** __ez__')?.text === 'gg ez', r('|c|☆Foe Guy|**gg** __ez__')?.text);
check('a pipe inside a message survives', r('|c|☆Foe Guy|a|b')?.text === 'a|b');
check('/me reads as an action', r('|c|☆Foe Guy|/me sighs')?.text === '* Foe Guy sighs');
check('the rating line becomes plain text',
  r("|raw|Rayan's rating: 1234 &rarr; <strong>1250</strong><br />(+16 for winning)")?.text
    === "Rayan's rating: 1234 → 1250 (+16 for winning)");
check('the timer is a notice', r('|inactive|Foe Guy has 60 seconds left.')?.kind === 'notice');
check('a forfeit is a notice', r('|-message|Foe Guy forfeited.')?.text === 'Foe Guy forfeited.');
check('server errors show as text',
  r('|html|<div class="message-error">You must be registered to chat.</div>')?.text === 'You must be registered to chat.');
check('commands are not chat', r('|c|☆Foe Guy|/challenge gen9randombattle') === null);
check('battle lines are not chat', r('|move|p1a: X|Tackle|p2a: Y') === null && r('|j| someone') === null);

const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} FAILED` : '\nall green');
process.exit(failed ? 1 : 0);
