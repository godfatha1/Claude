// Every game, kept: what happened, what the panel said, what you tapped.
//
// The point is to learn from real games. A recommendation can only be judged
// against the position it was made in, so each one is stored with where it
// sat in the battle log: replaying the log up to that line rebuilds exactly
// what the panel saw, and a newer advisor can be asked the same question.
//
// The log is the client's own feed for the battle room, private team and all.
// Records go to the phone's server (serve.py), which keeps them outside the
// app's folder so updates never touch them.

const KEEP_ACTIONS = 10;

export class GameRecorder {
  constructor({ room, version = null, endpoint }) {
    this.endpoint = endpoint;
    this.record = {
      kind: 'randbats-game', schema: 1, version, room,
      started: new Date().toISOString(), ended: null, final: false,
      us: null, them: null, winner: null, rating: null,
      lines: [], advice: [], taps: [],
    };
    this.sentTurn = 0;
  }

  /** Every line of the battle room, in order, requests included. */
  line(raw) { this.record.lines.push(raw); }

  /** What the panel recommended, and where in the log it said it. */
  advice(battle, result, { budget, teraNow }) {
    if (!result || result.failed) {
      this.record.advice.push({ turn: battle.turn, at: this.record.lines.length, failed: result?.error ?? 'no result' });
      return;
    }
    this.record.advice.push({
      turn: battle.turn,
      at: this.record.lines.length,
      budget, teraNow: Boolean(teraNow),
      theirMove: result.theirMove ?? null,
      worlds: result.worlds, positions: result.positions, ms: result.elapsedMs,
      // c: choice, s: share, v: average outcome, lo/hi: worst/best set, x: why vetoed
      actions: result.actions.slice(0, KEEP_ACTIONS).map((a) => ({
        c: a.choice, s: round(a.share), v: round(a.value), lo: round(a.worstValue), hi: round(a.bestValue),
        ...(a.vetoed ? { x: a.vetoed } : {}),
      })),
    });
  }

  /** Something you told it: a confirmed move, item or ability, or a called move. */
  tap(battle, kind, id, state) {
    this.record.taps.push({ turn: battle.turn, at: this.record.lines.length, kind, id, state });
  }

  /** Fill in the summary fields from the battle as it stands. */
  sync(battle, ourName) {
    const r = this.record;
    r.us = battle.us?.name ?? ourName ?? r.us;
    r.them = battle.them?.name ?? r.them;
    r.winner = battle.winner ?? r.winner;
    const mine = ourName && battle.ratings ? battle.ratings[toId(ourName)] : null;
    if (mine) r.rating = { before: mine.before, after: mine.after, reason: mine.reason };
    if (battle.ended && !r.ended) r.ended = new Date().toISOString();
  }

  /**
   * Send the record to the phone's server. Partial saves along the way mean a
   * closed tab or a crash still leaves most of the game; the final one is
   * marked so the server knows the game is complete.
   */
  async save({ final = false } = {}) {
    if (final) this.record.final = true;
    const body = JSON.stringify(this.record);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000,
      });
      return response.ok;
    } catch { return false; }
  }

  /** For a tab being closed: fire and forget. */
  beacon() {
    try {
      return navigator.sendBeacon?.(this.endpoint, new Blob([JSON.stringify(this.record)], { type: 'application/json' })) ?? false;
    } catch { return false; }
  }
}

const round = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
const toId = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
