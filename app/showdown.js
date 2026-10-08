// The connection that watches your battle.
//
// This joins the official server as a guest and spectates. Spectating needs no
// account, which is the whole reason the site can be static files on a plain
// host: there's no login to proxy and nothing of yours to hold.
//
// It also means this connection physically cannot choose a move. It watches and
// nothing else, which is the safest posture available — it can't play for you
// even by accident.
//
// The one thing a spectator doesn't get is the private `request` feed, so your
// own unrevealed moves and bench are as hidden to it as your opponent's. See
// docs/connecting.md.

export const OFFICIAL_SERVER = 'wss://sim3.psim.us/showdown/websocket';

/** The trailing number of a battle room, used to tell newer from older. */
function battleNumber(room) {
  const match = /-(\d+)$/.exec(room);
  return match ? parseInt(match[1], 10) : 0;
}

export class Spectator {
  constructor({ server = OFFICIAL_SERVER } = {}) {
    this.server = server;
    this.socket = null;
    this.room = null;
    this.identity = null;

    this.onLine = () => {};
    this.onStatus = () => {};
    this.onRoom = () => {};

    this._queryWaiters = [];
    this._closedOnPurpose = false;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.onStatus({ state: 'connecting', server: this.server });
      let socket;
      try {
        socket = new WebSocket(this.server);
      } catch (err) {
        reject(new Error(`couldn't open a connection: ${err.message}`));
        return;
      }
      this.socket = socket;
      this._closedOnPurpose = false;

      const giveUp = setTimeout(() => {
        reject(new Error('the server did not answer in time'));
        socket.close();
      }, 15000);

      socket.onmessage = (event) => this._receive(String(event.data));

      socket.onopen = () => {
        // The server hands out a guest identity on its own; we never name
        // ourselves, so there's nothing to authenticate.
        this.onStatus({ state: 'connected', server: this.server });
      };

      socket.onerror = () => {
        clearTimeout(giveUp);
        this.onStatus({ state: 'error', message: 'the connection failed' });
        reject(new Error('the connection failed'));
      };

      socket.onclose = () => {
        clearTimeout(giveUp);
        this.onStatus({
          state: this._closedOnPurpose ? 'closed' : 'dropped',
        });
      };

      // Resolve once the server has greeted us.
      this._waitForLine((line) => line.startsWith('|challstr|'), 15000)
        .then(() => { clearTimeout(giveUp); resolve(this); })
        .catch((err) => { clearTimeout(giveUp); reject(err); });
    });
  }

  send(message) {
    if (!this.connected) throw new Error('not connected');
    this.socket.send(message);
  }

  close() {
    this._closedOnPurpose = true;
    this.socket?.close();
  }

  _receive(data) {
    let currentRoom = '';
    for (const raw of data.split('\n')) {
      if (raw.startsWith('>')) { currentRoom = raw.slice(1).trim(); continue; }
      if (!raw) continue;

      if (raw.startsWith('|updateuser|')) {
        const name = raw.split('|')[2]?.trim();
        if (name) {
          this.identity = name;
          this.onStatus({ state: 'identified', identity: name });
        }
      }

      for (let i = this._queryWaiters.length - 1; i >= 0; i--) {
        if (this._queryWaiters[i].test(raw)) {
          this._queryWaiters[i].resolve(raw);
          this._queryWaiters.splice(i, 1);
        }
      }

      this.onLine(raw, currentRoom || this.room);
    }
  }

  _waitForLine(test, ms = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve };
      this._queryWaiters.push(waiter);
      setTimeout(() => {
        const at = this._queryWaiters.indexOf(waiter);
        if (at >= 0) {
          this._queryWaiters.splice(at, 1);
          reject(new Error('the server did not answer'));
        }
      }, ms);
    });
  }

  /**
   * Find someone's live battles from their name alone.
   *
   * This is what makes it workable on a phone: you type your Showdown name once
   * and it finds the battle itself, so there's nothing to copy or paste while
   * you're playing.
   */
  async findBattles(username) {
    this.send(`|/cmd userdetails ${username}`);
    const line = await this._waitForLine((l) => l.startsWith('|queryresponse|userdetails'));
    const payload = line.slice('|queryresponse|userdetails|'.length);
    let details;
    try {
      details = JSON.parse(payload);
    } catch {
      throw new Error(`couldn't read the server's answer about ${username}`);
    }
    if (!details || details.rooms === false) {
      // `rooms: false` means offline, which is different from "no battles".
      return { online: false, battles: [] };
    }
    const rooms = Object.keys(details.rooms ?? {});
    const battles = rooms
      // The server prefixes a room with the player's rank in it.
      .map((r) => r.replace(/^[^a-z0-9]*/i, ''))
      .filter((r) => r.startsWith('battle-'))
      // Most recent first. Battle rooms end in an incrementing number, and an
      // abandoned game can sit in the list for a long time — picking whichever
      // the server happened to list first lands you in a battle that finished
      // hours ago.
      .sort((a, b) => (battleNumber(b) - battleNumber(a)));
    return { online: true, battles, name: details.name ?? username };
  }

  /** Join a battle room as a spectator. */
  async watch(room) {
    this.send(`|/join ${room}`);
    await this._waitForLine((l) => l.startsWith('|init|battle'));
    this.room = room;
    this.onRoom(room);
    return room;
  }

  /** Stop watching, without dropping the connection. */
  leave() {
    if (!this.room) return;
    try { this.send(`|/leave ${this.room}`); } catch { /* already gone */ }
    this.room = null;
  }
}
