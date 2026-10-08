# How the assistant sees your battle

This was the hardest design question, and the answer was forced by two of your
constraints: you play on a phone, and hosting is GitHub Pages.

## What ruled out the obvious plan

The obvious plan was to serve our own copy of the Showdown client, wrapped in our
own page with a sidebar. That doesn't work, and the reason is specific.

Showdown's login is a three-step handshake: the client gets a `challstr` from the
battle server, posts it with your credentials to the *login* server, gets back an
assertion, and presents that to the battle server. The official client makes that
middle call to **`/~~showdown/action.php`** — a same-origin path that their web
server proxies through to the login server. It's written that way deliberately.

GitHub Pages serves static files. It cannot rewrite or proxy anything. So there's
nowhere to put that hop, and a login from our own domain would be a cross-origin
request to an endpoint built to avoid being one.

Showdown does have an OAuth flow for third-party clients, which is the sanctioned
way round this, but it needs a client ID registered against our exact domain —
which means asking Smogon staff and waiting on a human.

## What we do instead: spectate

**Spectating a battle needs no account at all.** So the assistant opens its own
connection to the official server as a guest, finds your battle, and watches.

Verified against a real Showdown server, not assumed:

| | |
|---|---|
| Unnamed connection gets an identity | yes — `Guest 8`, automatically |
| Guest can join a battle room | **yes** — `/join battle-gen9randombattle-1` → `init|battle` |
| Guest receives live turns for both sides | yes — `switch`, `move`, damage, everything public |
| Guest receives `request` (a player's own hidden team) | **no** |
| Can find your battle from just your name | **yes** — `/cmd userdetails <you>` returns your live rooms |

That last one matters for the phone: you type your Showdown name once and it finds
your battle itself. No pasting links, no copying anything mid-game.

A sample of what the spectator actually receives:

```
|switch|p1a: Bisharp|Bisharp, L79, F|100/100
|switch|p2a: Terapagos|Terapagos, L77, M|100/100
|move|p1a: Bisharp|Sucker Punch|p2a: Terapagos
|move|p2a: Terapagos|Rapid Spin|p1a: Bisharp
```

Species and level are right there on switch-in, which is all the set data needs to
pin down exact stats.

## The one real limitation, stated plainly

A spectator sees your side the way your *opponent* sees it. So the assistant knows
your opponent's position as completely as you do, but knows your own hidden moves,
items and bench only as they get revealed.

Which is a smaller problem than it sounds, for three reasons:

1. **The opponent's side is the hard part, and we get it in full.** Working out
   what they're holding and what they'll do is where the thinking is. Your own
   side you can already see.
2. **Our side narrows the same way theirs does.** Species and level come in exact
   on switch-in, and the published set data cuts it to a handful of roles. The
   search samples our own uncertainty exactly as it samples theirs.
3. **It gets pinned the moment you act.** Every move you use removes a possibility,
   so the advice sharpens as the battle goes on.

And for the lead, where turn-1 advice matters most, the panel offers a one-tap
confirm: it shows the two or three roles your lead could be, you tap the one
matching what your client shows you, and our side is exact from then on. Optional,
not required.

## What this buys

- Nothing to log into. The assistant never touches your account or your password.
- It can't play for you even by accident — a spectator connection has no power to
  choose a move. That's the safest possible posture.
- Static hosting is enough. One URL, no server, no deployment.
- Works in mobile Safari and Chrome, where extensions don't.

## If OAuth ever happens

If a client ID gets registered, playing inside our own page becomes possible and
the `request` feed closes the gap above completely. That's an upgrade, not a
prerequisite — worth doing later, not worth blocking on now.
