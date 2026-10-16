// Reading a battle from the protocol stream.
//
// The assistant watches as a spectator, so this consumes exactly what any
// spectator receives and builds up what's known about both sides. Two things to
// keep in mind about that vantage point:
//
//   - HP arrives as a percentage, not an exact number. Showdown only sends exact
//     HP to the player who owns the Pokémon. So absolute HP here is a best
//     estimate from the percentage and the computed maximum, accurate to about
//     one percent. `hpIsExact` records which it is.
//   - Our own side is as hidden as theirs. Everything revealed is tracked the
//     same way for both, and the inference layer fills in the rest.
//
// Turn order is recorded deliberately, because in this format it's evidence: all
// speeds are computable, so an opponent moving before something it shouldn't
// outspeed is proof of a Choice Scarf rather than a hint.

import { statsFor, toId } from './data.js';

/** One Pokémon as far as we can tell from watching. */
export class TrackedMon {
  constructor(dex, speciesName, level, gender) {
    this.dex = dex;
    this.speciesName = speciesName;
    this.level = level ?? null;
    this.gender = gender ?? null;

    this.data = dex.get(speciesName);
    if (this.data && this.level == null) this.level = this.data.l;

    // Revealed facts. Anything still null is genuinely unknown.
    this.revealedMoves = new Map(); // move id -> times used
    this.item = null;
    this.itemKnownGone = false;
    this.ability = null;
    this.teraType = null;
    this.terastallized = false;

    this.hpPercent = 100;
    this.hpIsExact = false;
    this.hpExact = null;
    this.status = 'none';
    this.fainted = false;
    this.restTurns = 0;
    this.sleepTurns = 0;

    this.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    this.volatiles = new Set();
    // Turns left on the volatiles that run out, counted down each turn so the
    // engine knows an Encore has two turns to go rather than guessing.
    this.volatileTurns = new Map();
    // What it used last. Encore locks to it and so does a Choice item.
    this.lastMove = null;

    // Facts you confirmed by tapping in the panel, kept apart from things seen
    // in the battle so they can be undone. Something actually witnessed never
    // can be.
    this.confirmed = { moves: new Set(), item: false, ability: false };

    // For our own side, Showdown tells us outright which moves are usable and
    // how much PP is left. That beats anything inferred.
    this.requestDisabled = new Set();
    this.pp = new Map();

    // Set when turn order proves it must be holding a Choice Scarf.
    this.scarfProven = false;
    // Move ids the last Choice lock rules out.
    this.choiceLockedTo = null;

    this.timesSeenActive = 0;
  }

  get id() { return this.data?.id ?? toId(this.speciesName); }

  /** Mark a move as definitely in its set, on your say-so. Tap again to undo. */
  confirmMove(moveName) {
    const id = toId(moveName);
    if (this.confirmed.moves.has(id)) {
      this.confirmed.moves.delete(id);
      // Only forget it if we never actually saw it used.
      if ((this.revealedMoves.get(id) ?? 0) === 0) this.revealedMoves.delete(id);
      return false;
    }
    this.confirmed.moves.add(id);
    if (!this.revealedMoves.has(id)) this.revealedMoves.set(id, 0);
    return true;
  }

  /** Mark the item, on your say-so. Tap the same one again to undo. */
  confirmItem(itemName) {
    const id = toId(itemName);
    if (this.confirmed.item && toId(this.item) === id) {
      this.confirmed.item = false;
      this.item = null;
      return false;
    }
    // Something seen in the battle outranks a tap.
    if (this.item && !this.confirmed.item) return false;
    this.item = itemName;
    this.itemKnownGone = false;
    this.confirmed.item = true;
    return true;
  }

  confirmAbility(abilityName) {
    const id = toId(abilityName);
    if (this.confirmed.ability && toId(this.ability) === id) {
      this.confirmed.ability = false;
      this.ability = null;
      return false;
    }
    if (this.ability && !this.confirmed.ability) return false;
    this.ability = abilityName;
    this.confirmed.ability = true;
    return true;
  }

  /** Is it holding a Choice Scarf, by proof or by your confirmation? */
  get hasScarf() {
    return this.scarfProven || toId(this.item ?? '') === 'choicescarf';
  }
  get types() { return this.data?.t ?? []; }
  get isKnown() { return Boolean(this.data); }

  /** Possible roles, narrowed by everything revealed so far. */
  candidateRoles() {
    if (!this.data) return [];
    const revealed = [...this.revealedMoves.keys()];
    const itemId = this.item ? toId(this.item) : null;
    const abilityId = this.ability ? toId(this.ability) : null;
    const teraId = this.teraType ? toId(this.teraType) : null;

    let roles = Object.entries(this.data.r).map(([name, r]) => ({ name, ...r }));

    const consistent = roles.filter((role) => {
      if (!revealed.every((m) => role.m.includes(m))) return false;
      if (itemId && !role.i.includes(itemId)) return false;
      if (abilityId && !role.a.includes(abilityId)) return false;
      if (teraId && role.t.length && !role.t.includes(teraId)) return false;
      return true;
    });

    // The published pools are derived from sampling, so they can be incomplete.
    // Ruling out the truth is worse than knowing nothing: if nothing survives,
    // fall back to every role rather than claiming this set is impossible.
    return consistent.length ? consistent : roles;
  }

  /** Speed if it's running the usual spread. Exact, not estimated. */
  get normalSpeed() { return this.data?.sp?.[1] ?? null; }
  /** Speed for the Trick Room and Gyro Ball sets, which zero it on purpose. */
  get minSpeed() { return this.data?.sp?.[0] ?? null; }
  /** The fastest this species can move in this format, Choice Scarf included. */
  get maxSpeed() { return this.data?.sp?.[2] ?? null; }

  /** Apply the current boost stage, paralysis and a proven Scarf to a base value. */
  applySpeedModifiers(speed) {
    if (speed == null) return null;
    if (this.hasScarf) speed = Math.trunc(speed * 1.5);
    const stage = this.boosts.spe;
    if (stage > 0) speed = Math.trunc(speed * (2 + stage) / 2);
    if (stage < 0) speed = Math.trunc(speed * 2 / (2 - stage));
    if (this.status === 'par') speed = Math.trunc(speed * 0.5);
    return speed;
  }

  /** Current effective speed, assuming the usual spread. */
  effectiveSpeed() {
    return this.applySpeedModifiers(this.normalSpeed);
  }

  /**
   * The range its real speed could be in, given what we know.
   *
   * Nearly every set runs the standard spread, but a Trick Room or Gyro Ball set
   * zeroes Speed on purpose, which makes it much slower than its published
   * value. Reasoning with a single number treats that legitimate outspeed as
   * proof of a Choice Scarf — it was the last false claim this check made.
   */
  speedRange() {
    const normal = this.normalSpeed;
    if (normal == null) return null;

    // Could it be one of the sets that gives Speed away?
    const slowSets = this.candidateRoles().some((role) =>
      role.m.includes('trickroom') || role.m.includes('gyroball'));
    const low = slowSets ? this.minSpeed : normal;

    return {
      min: this.applySpeedModifiers(low),
      max: this.applySpeedModifiers(normal),
    };
  }

  /** Our best guess at the concrete set, for handing to the engine. */
  bestGuessSet() {
    const roles = this.candidateRoles();
    const role = roles[0] ?? null;

    const moves = [...this.revealedMoves.keys()];
    if (role) {
      // Pad with the likeliest unrevealed moves from the role's pool.
      for (const m of role.m) {
        if (moves.length >= 4) break;
        if (!moves.includes(m)) moves.push(m);
      }
    }

    const item = this.item
      ?? (this.hasScarf ? 'choicescarf' : null)
      ?? (role?.i?.[0] ?? this.data?.I?.[0] ?? '');
    const ability = this.ability ?? role?.a?.[0] ?? this.data?.A?.[0] ?? '';
    const teraType = this.teraType ?? role?.t?.[0] ?? '';

    const stats = this.data
      ? statsFor(this.dex, this.data, this.id, this.level, ability, item, moves)
      : [100, 100, 100, 100, 100, 100];

    const maxhp = stats[0];
    const hp = this.fainted ? 0
      : this.hpIsExact && this.hpExact != null ? this.hpExact
      : Math.max(1, Math.round(maxhp * this.hpPercent / 100));

    return {
      id: this.id,
      level: this.level,
      types: this.terastallized && this.teraType ? [this.teraType] : this.types,
      hp,
      maxhp,
      ability: toId(ability),
      item: this.itemKnownGone ? '' : toId(item),
      stats,
      status: this.status,
      teraType: toId(teraType),
      terastallized: this.terastallized,
      weight: this.data?.w ?? 0,
      moves: moves.slice(0, 4),
      disabled: this.disabledMoves(moves.slice(0, 4)),
      pp: moves.slice(0, 4).map((m) => this.pp.get(m) ?? 16),
      restTurns: this.restTurns,
      sleepTurns: this.sleepTurns,
    };
  }

  /**
   * Which of these moves can't be used right now.
   *
   * Two sources, both certain: what Showdown itself said in the request (our
   * side only — it names Encore, Taunt, Disable and a Choice lock outright),
   * and a Choice lock we worked out ourselves for the other side.
   */
  disabledMoves(moves) {
    const out = new Set(this.requestDisabled);
    if (this.choiceLockedTo) {
      for (const m of moves) if (m !== this.choiceLockedTo) out.add(m);
    }
    return moves.filter((m) => out.has(m));
  }

  /** Volatiles in the engine's own spelling, with the turns they have left. */
  volatilesForEngine() {
    const names = [];
    for (const v of this.volatiles) {
      const upper = ENGINE_VOLATILE_ALIASES[v] ?? v.toUpperCase();
      if (ENGINE_VOLATILES.has(upper)) names.push(upper);
    }
    const turns = (name, fallback) => this.volatileTurns.get(name) ?? (this.volatiles.has(name) ? fallback : 0);
    return {
      volatiles: names,
      confusionTurns: turns('confusion', 2),
      encoreTurns: turns('encore', 3),
      lockedMoveTurns: turns('lockedmove', 2),
      slowStartTurns: turns('slowstart', 5),
      tauntTurns: turns('taunt', 3),
      yawnTurns: turns('yawn', 1),
    };
  }
}

/** One side's team and field, as far as we can tell. */
class TrackedSide {
  constructor() {
    this.name = null;
    this.teamSize = 6;
    this.team = []; // TrackedMon, in the order we first saw them
    this.activeIndex = 0;
    this.conditions = {
      stealthRock: 0, spikes: 0, toxicSpikes: 0, stickyWeb: 0,
      reflect: 0, lightScreen: 0, auroraVeil: 0, tailwind: 0, safeguard: 0,
      toxicCount: 0,
    };
    this.teraUsed = false;
    /** Showdown said our active can't switch (our side only). */
    this.trapped = false;
    /** The last thing this side did: a move id, or 'switch'. */
    this.lastAction = null;
  }

  get active() { return this.team[this.activeIndex] ?? null; }

  /** Find a tracked Pokémon by the name the protocol uses for it. */
  find(speciesName) {
    const id = toId(speciesName);
    return this.team.find((m) => toId(m.speciesName) === id || m.id === id) ?? null;
  }

  get aliveCount() {
    const seen = this.team.filter((m) => !m.fainted).length;
    // Anything we haven't seen yet is still alive.
    return seen + Math.max(0, this.teamSize - this.team.length);
  }
}

const SIDE_CONDITION_KEYS = {
  'stealth rock': 'stealthRock',
  spikes: 'spikes',
  'toxic spikes': 'toxicSpikes',
  'sticky web': 'stickyWeb',
  reflect: 'reflect',
  'light screen': 'lightScreen',
  'aurora veil': 'auroraVeil',
  tailwind: 'tailwind',
  safeguard: 'safeguard',
};

/**
 * Every volatile status the engine knows, in its spelling. Showdown's effect
 * ids map onto these by uppercasing; anything not on the list is dropped, since
 * the engine would otherwise quietly file it under "none".
 */
const ENGINE_VOLATILES = new Set(`
  AQUARING ATTRACT AUTOTOMIZE BANEFULBUNKER BIDE BOUNCE BURNINGBULWARK CHARGE CONFUSION CURSE
  DEFENSECURL DESTINYBOND DIG DISABLE DIVE ELECTRIFY ELECTROSHOT EMBARGO ENCORE ENDURE FLASHFIRE
  FLINCH FLY FOCUSENERGY FOLLOWME FORESIGHT FREEZESHOCK GASTROACID GEOMANCY GLAIVERUSH GRUDGE
  HEALBLOCK HELPINGHAND ICEBURN IMPRISON INGRAIN KINGSSHIELD LASERFOCUS LEECHSEED LIGHTSCREEN
  LOCKEDMOVE MAGICCOAT MAGNETRISE MAXGUARD METEORBEAM MINIMIZE MIRACLEEYE MUSTRECHARGE NIGHTMARE
  NORETREAT OCTOLOCK PARTIALLYTRAPPED PERISH4 PERISH3 PERISH2 PERISH1 PHANTOMFORCE POWDER
  POWERSHIFT POWERTRICK PROTECT PROTOSYNTHESISATK PROTOSYNTHESISDEF PROTOSYNTHESISSPA
  PROTOSYNTHESISSPD PROTOSYNTHESISSPE QUARKDRIVEATK QUARKDRIVEDEF QUARKDRIVESPA QUARKDRIVESPD
  QUARKDRIVESPE RAGE RAGEPOWDER RAZORWIND REFLECT ROOST SALTCURE SHADOWFORCE SKULLBASH SKYATTACK
  SKYDROP SILKTRAP SLOWSTART SMACKDOWN SNATCH SOLARBEAM SOLARBLADE SPARKLINGARIA SPIKYSHIELD
  SPOTLIGHT STOCKPILE SUBSTITUTE SYRUPBOMB TARSHOT TAUNT TELEKINESIS THROATCHOP TRUANT TORMENT
  TYPECHANGE UNBURDEN UPROAR YAWN
`.trim().split(/\s+/));

/** Showdown ids that don't uppercase straight onto an engine name. */
const ENGINE_VOLATILE_ALIASES = {
  stockpile1: 'STOCKPILE', stockpile2: 'STOCKPILE', stockpile3: 'STOCKPILE',
  bind: 'PARTIALLYTRAPPED', wrap: 'PARTIALLYTRAPPED', firespin: 'PARTIALLYTRAPPED',
  whirlpool: 'PARTIALLYTRAPPED', sandtomb: 'PARTIALLYTRAPPED', magmastorm: 'PARTIALLYTRAPPED',
  infestation: 'PARTIALLYTRAPPED', snaptrap: 'PARTIALLYTRAPPED', thundercage: 'PARTIALLYTRAPPED',
  clamp: 'PARTIALLYTRAPPED',
};

/** How long these last, in turns, from when they start. */
const VOLATILE_LENGTH = { encore: 3, taunt: 3, confusion: 2, yawn: 1, slowstart: 5, lockedmove: 2 };

/**
 * Moves whose priority depends on the field rather than the move.
 *
 * Grassy Glide is the one that matters in this format: +1 in Grassy Terrain, 0
 * otherwise, and the move data only carries the 0. It was the cause of two of
 * the four wrong Scarf claims this check used to make.
 */
const CONDITIONAL_PRIORITY_MOVES = new Set([
  'grassyglide',
  'pursuit',
  'upperhand',
]);

/**
 * Abilities that move a Pokémon out of its priority bracket.
 *
 * The value says which moves the ability applies to, or null for "any". These
 * are checked against the species' whole ability pool, not just the revealed
 * ability, because the opponent's ability is usually unknown — and "it might
 * have Prankster" is enough to make the order unprovable.
 */
const PRIORITY_ABILITIES = new Map([
  ['prankster', (move) => move.category === 'Status'],
  ['galewings', (move) => move.type === 'FLYING'],
  ['triage', (move) => move.category === 'Status'],
  ['quickdraw', null],
  ['stall', null],
  ['myceliummight', (move) => move.category === 'Status'],
]);

/**
 * Abilities that change Speed itself, rather than the priority bracket.
 *
 * This list is why the Scarf check has to be careful. Swift Swim doubles speed
 * in rain and Slow Start halves it for five turns, so either one makes the
 * order say nothing about the item — both caused a wrong claim before this
 * existed. In Gen 9 the big ones are Protosynthesis and Quark Drive, which every
 * Paradox Pokémon has and which boost whichever stat is highest, often Speed.
 *
 * Checked against the species' whole ability pool, because the opponent's
 * ability is usually unknown and "it might have Swift Swim" is enough to make
 * the order unprovable.
 */
const SPEED_ALTERING_ABILITIES = new Set([
  'swiftswim', 'chlorophyll', 'sandrush', 'slushrush', 'surgesurfer',
  'unburden', 'quickfeet', 'speedboost', 'slowstart',
  'protosynthesis', 'quarkdrive',
  'steamengine', 'motordrive', 'weakarmor', 'rattled',
]);

/** Items that change Speed, other than the Scarf we're trying to detect. */
const SPEED_ALTERING_ITEMS = new Set([
  'ironball', 'machobrace', 'quickpowder', 'poweranklet', 'powerband',
  'powerbelt', 'powerbracer', 'powerlens', 'powerweight',
]);

/** Items that sometimes let a Pokémon act out of order. */
const QUEUE_JUMPING_ITEMS = new Set([
  'quickclaw',
  'custapberry',
  'laggingtail',
  'fullincense',
]);

const WEATHER_NAMES = {
  sunnyday: 'sun', desolateland: 'harshsun',
  raindance: 'rain', primordialsea: 'heavyrain',
  sandstorm: 'sand', snow: 'snow', hail: 'hail', snowscape: 'snow',
  none: 'none',
};

const TERRAIN_NAMES = {
  'electric terrain': 'electricterrain',
  'grassy terrain': 'grassyterrain',
  'misty terrain': 'mistyterrain',
  'psychic terrain': 'psychicterrain',
};

/**
 * The battle, built up line by line.
 *
 * Feed it protocol lines with `handle`. It keeps both sides' tracked teams, the
 * field, and the turn-order record the Scarf check needs.
 */
export class Battle {
  constructor(dex, { ourPlayer = null } = {}) {
    this.dex = dex;
    this.sides = { p1: new TrackedSide(), p2: new TrackedSide() };
    /** Which player slot is us. Set once we know our own name. */
    this.ourSlot = ourPlayer;

    this.turn = 0;
    this.weather = 'none';
    this.weatherTurns = 0;
    this.terrain = 'none';
    this.terrainTurns = 0;
    this.trickRoom = false;
    this.trickRoomTurns = 0;
    this.ended = false;
    this.winner = null;

    // What acted this turn and how fast each side was when it began. Both feed
    // the Scarf check, which only runs once a turn is complete.
    this.turnMoves = [];
    this.turnStartSpeeds = {};
    this.log = [];
    this.notes = []; // things worth telling the player, newest last
  }

  get us() { return this.sides[this.ourSlot ?? 'p1']; }
  get them() { return this.sides[this.ourSlot === 'p1' ? 'p2' : 'p1']; }

  /** Tell the battle which player we are, by Showdown name. */
  setOurName(name) {
    const wanted = toId(name);
    for (const slot of ['p1', 'p2']) {
      if (this.sides[slot].name && toId(this.sides[slot].name) === wanted) {
        this.ourSlot = slot;
        return slot;
      }
    }
    return null;
  }

  // ------------------------------------------------------------- parsing

  /** Feed one protocol line. Returns true if the position changed. */
  handle(line) {
    if (!line || !line.startsWith('|')) return false;
    this.log.push(line);

    const parts = line.slice(1).split('|');
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case 'player': return this.onPlayer(args);
      case 'teamsize': return this.onTeamSize(args);
      case 'turn': return this.onTurn(args);
      case 'switch':
      case 'drag':
      case 'replace': return this.onSwitch(args, cmd);
      case 'detailschange': return this.onDetailsChange(args);
      case 'move': return this.onMove(args);
      case '-damage':
      case '-heal':
      case '-sethp': return this.onHpChange(args);
      case '-status': return this.onStatus(args);
      case '-curestatus': return this.onCureStatus(args);
      case 'faint': return this.onFaint(args);
      case '-boost': return this.onBoost(args, 1);
      case '-unboost': return this.onBoost(args, -1);
      case '-setboost': return this.onSetBoost(args);
      case '-clearboost':
      case '-clearnegativeboost': return this.onClearBoost(args);
      case '-clearallboost': return this.onClearAllBoost();
      case '-weather': return this.onWeather(args);
      case '-fieldstart': return this.onFieldStart(args);
      case '-fieldend': return this.onFieldEnd(args);
      case '-sidestart': return this.onSideStart(args);
      case '-sideend': return this.onSideEnd(args);
      case '-item': return this.onItem(args);
      case '-enditem': return this.onEndItem(args);
      case '-ability': return this.onAbility(args);
      case '-terastallize': return this.onTera(args);
      case '-start': return this.onVolatileStart(args);
      case '-end': return this.onVolatileEnd(args);
      case '-prepare': return this.onPrepare(args);
      case '-mustrecharge': return this.onMustRecharge(args);
      case '-activate': return this.onActivate(args);
      case '-transform': return true;
      case 'win': this.ended = true; this.winner = args[0]; return true;
      case 'tie': this.ended = true; return true;
      default: return false;
    }
  }

  /** `p1a: Great Tusk` -> { side, mon } */
  resolve(ref) {
    if (!ref) return { side: null, mon: null };
    const match = /^(p[12])[a-c]?:\s*(.+)$/.exec(ref);
    if (!match) return { side: null, mon: null };
    const side = this.sides[match[1]];
    // The nickname can differ from the species, so prefer the active slot and
    // fall back to a name match.
    return { side, mon: side.active ?? side.find(match[2]) };
  }

  sideOf(ref) {
    const match = /^(p[12])/.exec(ref ?? '');
    return match ? this.sides[match[1]] : null;
  }

  onPlayer([slot, name]) {
    if (!slot || !this.sides[slot]) return false;
    if (name) this.sides[slot].name = name;
    return true;
  }

  onTeamSize([slot, size]) {
    if (this.sides[slot]) this.sides[slot].teamSize = parseInt(size, 10) || 6;
    return true;
  }

  onTurn([n]) {
    // The turn that just ended is now complete, so it can be judged.
    this.evaluateTurnOrder();
    this.turn = parseInt(n, 10) || this.turn + 1;

    // Count down what runs out, and count up time asleep.
    for (const slot of ['p1', 'p2']) {
      const mon = this.sides[slot].active;
      if (!mon) continue;
      for (const [name, left] of mon.volatileTurns) {
        if (left <= 1) { mon.volatileTurns.delete(name); mon.volatiles.delete(name); }
        else mon.volatileTurns.set(name, left - 1);
      }
      if (mon.status === 'slp') {
        mon.sleepTurns += 1;
        if (mon.restTurns > 0) mon.restTurns -= 1;
      }
    }

    // Snapshot speeds as they are at the start of the turn. Anything that
    // happens during it (a Dragon Dance, paralysis landing) must not retroactively
    // change what the order implied.
    this.turnStartSpeeds = {};
    for (const slot of ['p1', 'p2']) {
      const mon = this.sides[slot].active;
      this.turnStartSpeeds[slot] = mon ? { mon, range: mon.speedRange() } : null;
    }
    return true;
  }

  onSwitch([ref, details, hp], cmd) {
    const slotMatch = /^(p[12])/.exec(ref);
    if (!slotMatch) return false;
    const side = this.sides[slotMatch[1]];
    const nameMatch = /^(p[12])[a-c]?:\s*(.+)$/.exec(ref);
    const nickname = nameMatch?.[2] ?? '';

    const [speciesPart, ...rest] = (details ?? '').split(',').map((s) => s.trim());
    const level = rest.map((r) => /^L(\d+)$/.exec(r)).find(Boolean)?.[1];
    const gender = rest.find((r) => r === 'M' || r === 'F') ?? null;

    let mon = side.find(speciesPart) ?? side.find(nickname);
    if (!mon) {
      mon = new TrackedMon(this.dex, speciesPart, level ? parseInt(level, 10) : null, gender);
      side.team.push(mon);
    }
    side.activeIndex = side.team.indexOf(mon);
    mon.timesSeenActive += 1;

    // Switching out clears boosts, volatiles and any Choice lock.
    mon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    mon.volatiles.clear();
    mon.volatileTurns.clear();
    mon.choiceLockedTo = null;
    mon.lastMove = null;
    mon.requestDisabled.clear();
    side.lastAction = 'switch';
    side.trapped = false;

    if (hp) this.applyHp(mon, hp);
    if (cmd === 'switch') side.conditions.toxicCount = 0;
    return true;
  }

  onDetailsChange([ref, details]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    // A forme change can alter types and stats outright, so re-resolve.
    const species = (details ?? '').split(',')[0].trim();
    const data = this.dex.get(species);
    if (data) {
      mon.speciesName = species;
      mon.data = data;
    }
    return true;
  }

  onMove([ref, moveName, , ...rest]) {
    const { side, mon } = this.resolve(ref);
    if (!mon) return false;

    const id = toId(moveName);
    // A move called by something else (Metronome, Sleep Talk, Copycat) isn't in
    // the user's own set, so don't record it as revealed.
    const calledByAnother = rest.some((r) => /^\[from\]/.test(r) && !/\[from\]lockedmove/.test(r));
    if (!calledByAnother) {
      mon.revealedMoves.set(id, (mon.revealedMoves.get(id) ?? 0) + 1);
    }

    const slot = /^(p[12])/.exec(ref)?.[1];
    if (slot && !this.turnMoves.some((m) => m.slot === slot)) {
      this.turnMoves.push({ slot, mon, moveId: id });
    }

    // A Choice item locks you in; if the item is known to be one, record it.
    if (mon.item && /^choice/.test(toId(mon.item))) mon.choiceLockedTo = id;

    mon.lastMove = id;
    if (side) side.lastAction = id;
    if (id === 'rest') { mon.restTurns = 2; mon.sleepTurns = 0; }
    return true;
  }

  /**
   * Work out whether turn order proves someone is holding a Choice Scarf.
   *
   * Speeds in this format are computable, so being outsped by something slower
   * ought to be proof rather than a guess. It is only proof if nothing *else*
   * could explain the order, and there turn out to be a lot of other
   * explanations. An early version of this claimed four Scarfs across eight
   * games and every one was wrong: Grassy Glide gets its priority from the
   * terrain rather than the move, a side that switched never "moved" at all, and
   * Tailwind quietly doubles things.
   *
   * So this runs at the end of a turn, on a snapshot of the speeds as they were
   * when the turn began, and refuses to conclude anything unless every other
   * explanation is ruled out. A false claim is worse than no claim: it actively
   * misleads, and the whole value of the number is that it's certain.
   */
  evaluateTurnOrder() {
    const moves = this.turnMoves;
    this.turnMoves = [];
    if (moves.length !== 2) return; // someone switched, flinched or was asleep
    const [first, second] = moves;
    if (first.slot === second.slot) return; // one side acted twice

    const snapshot = this.turnStartSpeeds;
    const firstSnap = snapshot[first.slot];
    const secondSnap = snapshot[second.slot];
    if (!firstSnap || !secondSnap) return;
    // Both must be the Pokémon the turn started with.
    if (firstSnap.mon !== first.mon || secondSnap.mon !== second.mon) return;
    if (!firstSnap.range || !secondSnap.range) return;
    if (firstSnap.range.max == null || secondSnap.range.min == null) return;

    if (this.trickRoom) return;
    // Tailwind doubles a side's speed and we don't know when it was applied
    // relative to the snapshot, so don't reason through it.
    if (this.sides.p1.conditions.tailwind || this.sides.p2.conditions.tailwind) return;

    const firstMove = this.dex.move(first.moveId);
    const secondMove = this.dex.move(second.moveId);
    if (!firstMove || !secondMove) return;
    // Different priority brackets explain the order on their own.
    if (firstMove.priority !== secondMove.priority) return;
    if (firstMove.priority !== 0) return;

    // Moves whose priority comes from the field rather than the move.
    if (CONDITIONAL_PRIORITY_MOVES.has(first.moveId)) return;
    if (CONDITIONAL_PRIORITY_MOVES.has(second.moveId)) return;

    // An ability either side *could* have that moves it out of its bracket.
    if (this.couldAlterPriority(first.mon, firstMove)) return;
    if (this.couldAlterPriority(second.mon, secondMove)) return;

    // An item either side *could* have that sometimes jumps the queue.
    if (this.couldJumpQueue(first.mon)) return;
    if (this.couldJumpQueue(second.mon)) return;

    // An ability or item either side *could* have that changes Speed outright.
    // Without this the order gets read as a Scarf when it was really rain, or
    // Slow Start wearing off, or a Paradox ability waking up.
    if (this.couldAlterSpeed(first.mon)) return;
    if (this.couldAlterSpeed(second.mon)) return;

    if (first.mon.scarfProven) return;
    // If the item is already known to be something else, it can't be a Scarf.
    if (first.mon.item && toId(first.mon.item) !== 'choicescarf') return;

    // The proof: even at its fastest possible unscarfed speed, the first mover
    // is slower than the second at its slowest possible speed. Nothing but an
    // item can account for it having gone first.
    const fastestUnscarfed = firstSnap.range.max;
    const slowestOpponent = secondSnap.range.min;
    if (fastestUnscarfed >= slowestOpponent) return;
    // And a Scarf has to actually be enough to account for it.
    if (Math.trunc(fastestUnscarfed * 1.5) < slowestOpponent) return;

    first.mon.scarfProven = true;
    first.mon.item = 'Choice Scarf';
    this.notes.push({
      turn: this.turn,
      kind: 'scarf',
      text: `${first.mon.speciesName} moved first despite topping out at `
          + `${fastestUnscarfed} speed against ${slowestOpponent} — it's holding a Choice Scarf`,
    });
  }

  /** Could this Pokémon's ability have moved it out of its priority bracket? */
  couldAlterPriority(mon, move) {
    const pool = mon.ability
      ? [toId(mon.ability)]
      : (mon.data?.A ?? []); // every ability the species can have
    for (const ability of pool) {
      if (!PRIORITY_ABILITIES.has(ability)) continue;
      const appliesTo = PRIORITY_ABILITIES.get(ability);
      if (appliesTo === null || appliesTo(move)) return true;
    }
    return false;
  }

  /** Could this Pokémon's Speed be something other than its published value? */
  couldAlterSpeed(mon) {
    const abilities = mon.ability ? [toId(mon.ability)] : (mon.data?.A ?? []);
    if (abilities.some((a) => SPEED_ALTERING_ABILITIES.has(a))) return true;
    const items = mon.item ? [toId(mon.item)] : (mon.data?.I ?? []);
    if (items.some((i) => SPEED_ALTERING_ITEMS.has(i))) return true;
    // Booster Energy wakes a Paradox ability up with no weather or terrain to
    // show for it, so treat holding one as unknown Speed.
    if (items.includes('boosterenergy')) return true;
    return false;
  }

  /** Could this Pokémon's item have let it jump the queue at random? */
  couldJumpQueue(mon) {
    if (mon.item) return QUEUE_JUMPING_ITEMS.has(toId(mon.item));
    return (mon.data?.I ?? []).some((item) => QUEUE_JUMPING_ITEMS.has(item));
  }

  applyHp(mon, hpText) {
    if (!hpText) return;
    if (/fnt/.test(hpText)) {
      mon.hpPercent = 0;
      mon.hpExact = 0;
      mon.fainted = true;
      return;
    }
    const match = /^(\d+)\/(\d+)/.exec(hpText);
    if (!match) return;
    const current = parseInt(match[1], 10);
    const max = parseInt(match[2], 10);
    if (max === 100) {
      // A spectator sees percentages, so this is accurate to about one percent.
      mon.hpPercent = current;
      mon.hpIsExact = false;
      mon.hpExact = null;
    } else {
      mon.hpExact = current;
      mon.hpIsExact = true;
      mon.hpPercent = max ? (current / max) * 100 : 0;
    }
  }

  onHpChange([ref, hp]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    this.applyHp(mon, hp);
    return true;
  }

  onStatus([ref, status]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.status = toId(status) || 'none';
    if (mon.status === 'slp') mon.sleepTurns = 0;
    return true;
  }

  onCureStatus([ref]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.status = 'none';
    mon.sleepTurns = 0;
    mon.restTurns = 0;
    return true;
  }

  onFaint([ref]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.fainted = true;
    mon.hpPercent = 0;
    mon.hpExact = 0;
    return true;
  }

  onBoost([ref, stat, amount], sign) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    const key = toId(stat);
    if (!(key in mon.boosts)) return false;
    const delta = (parseInt(amount, 10) || 0) * sign;
    mon.boosts[key] = Math.max(-6, Math.min(6, mon.boosts[key] + delta));
    return true;
  }

  onSetBoost([ref, stat, amount]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    const key = toId(stat);
    if (!(key in mon.boosts)) return false;
    mon.boosts[key] = parseInt(amount, 10) || 0;
    return true;
  }

  onClearBoost([ref]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    return true;
  }

  onClearAllBoost() {
    for (const slot of ['p1', 'p2']) {
      const mon = this.sides[slot].active;
      if (mon) mon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    }
    return true;
  }

  onWeather([weather]) {
    const id = toId(weather);
    this.weather = WEATHER_NAMES[id] ?? (id === 'none' ? 'none' : id);
    this.weatherTurns = this.weather === 'none' ? 0 : 5;
    return true;
  }

  onFieldStart([effect]) {
    const name = String(effect ?? '').replace(/^move:\s*/i, '').toLowerCase();
    if (name === 'trick room') {
      this.trickRoom = true;
      this.trickRoomTurns = 5;
    } else if (TERRAIN_NAMES[name]) {
      this.terrain = TERRAIN_NAMES[name];
      this.terrainTurns = 5;
    }
    return true;
  }

  onFieldEnd([effect]) {
    const name = String(effect ?? '').replace(/^move:\s*/i, '').toLowerCase();
    if (name === 'trick room') {
      this.trickRoom = false;
      this.trickRoomTurns = 0;
    } else if (TERRAIN_NAMES[name]) {
      this.terrain = 'none';
      this.terrainTurns = 0;
    }
    return true;
  }

  onSideStart([sideRef, effect]) {
    const side = this.sideOf(sideRef);
    if (!side) return false;
    const name = String(effect ?? '').replace(/^move:\s*/i, '').toLowerCase();
    const key = SIDE_CONDITION_KEYS[name];
    if (!key) return false;
    if (key === 'spikes' || key === 'toxicSpikes') {
      side.conditions[key] = Math.min(key === 'spikes' ? 3 : 2, side.conditions[key] + 1);
    } else if (key === 'stealthRock' || key === 'stickyWeb') {
      side.conditions[key] = 1;
    } else {
      side.conditions[key] = 5;
    }
    return true;
  }

  onSideEnd([sideRef, effect]) {
    const side = this.sideOf(sideRef);
    if (!side) return false;
    const name = String(effect ?? '').replace(/^move:\s*/i, '').toLowerCase();
    const key = SIDE_CONDITION_KEYS[name];
    if (key) side.conditions[key] = 0;
    return true;
  }

  onItem([ref, item]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.item = item;
    mon.itemKnownGone = false;
    if (/^choice/.test(toId(item))) {
      // A revealed Choice item means the last move it used is its lock.
      const last = [...mon.revealedMoves.keys()].pop();
      if (last) mon.choiceLockedTo = last;
    }
    return true;
  }

  onEndItem([ref]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.itemKnownGone = true;
    mon.choiceLockedTo = null;
    return true;
  }

  onAbility([ref, ability]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.ability = ability;
    return true;
  }

  onTera([ref, type]) {
    const { side, mon } = this.resolve(ref);
    if (!mon) return false;
    mon.terastallized = true;
    mon.teraType = type;
    if (side) side.teraUsed = true;
    return true;
  }

  onVolatileStart([ref, effect]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    const name = toId(String(effect ?? '').replace(/^(move|ability):\s*/i, ''));
    mon.volatiles.add(name);
    if (VOLATILE_LENGTH[name]) mon.volatileTurns.set(name, VOLATILE_LENGTH[name]);
    return true;
  }

  onVolatileEnd([ref, effect]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    const name = toId(String(effect ?? '').replace(/^(move|ability):\s*/i, ''));
    mon.volatiles.delete(name);
    mon.volatileTurns.delete(name);
    return true;
  }

  /** Two-turn moves: the user is in the air, underground, charging. */
  onPrepare([ref, moveName]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.volatiles.add(toId(moveName));
    return true;
  }

  onMustRecharge([ref]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    mon.volatiles.add('mustrecharge');
    return true;
  }

  onActivate([ref, effect]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    // A Choice lock announcing itself is worth recording.
    if (/choice/i.test(String(effect ?? ''))) {
      const last = [...mon.revealedMoves.keys()].pop();
      if (last) mon.choiceLockedTo = last;
    }
    return true;
  }

  /** Everything about a side's active slot the engine takes, beyond the team. */
  slotFactsFor(side) {
    const mon = side.active;
    const v = mon ? mon.volatilesForEngine() : {
      volatiles: [], confusionTurns: 0, encoreTurns: 0, lockedMoveTurns: 0,
      slowStartTurns: 0, tauntTurns: 0, yawnTurns: 0,
    };
    // A fresh Substitute has a quarter of max HP. We can't see damage it takes
    // after that, so this is an upper bound — still far better than telling the
    // engine there is no Substitute at all.
    let substituteHealth = 0;
    if (mon && mon.volatiles.has('substitute')) {
      substituteHealth = Math.max(1, Math.floor(mon.bestGuessSet().maxhp / 4));
    }
    return {
      ...v,
      substituteHealth,
      lastUsedMove: side.lastAction === 'switch' ? 'switch' : (mon?.lastMove ?? ''),
      forceTrapped: Boolean(side.trapped),
    };
  }

  // -------------------------------------------- handing it to the engine

  /** Build the object the engine takes. */
  toEngineState() {
    const sideFor = (side) => {
      const team = side.team.map((m) => m.bestGuessSet());
      const active = side.active;
      return {
        active: Math.max(0, side.team.indexOf(active)),
        pokemon: team,
        boosts: active
          ? [active.boosts.atk, active.boosts.def, active.boosts.spa,
             active.boosts.spd, active.boosts.spe,
             active.boosts.accuracy, active.boosts.evasion]
          : [0, 0, 0, 0, 0, 0, 0],
        stealthRock: side.conditions.stealthRock,
        spikes: side.conditions.spikes,
        toxicSpikes: side.conditions.toxicSpikes,
        stickyWeb: side.conditions.stickyWeb,
        reflect: side.conditions.reflect,
        lightScreen: side.conditions.lightScreen,
        auroraVeil: side.conditions.auroraVeil,
        tailwind: side.conditions.tailwind,
        safeguard: side.conditions.safeguard,
        toxicCount: side.conditions.toxicCount,
      };
    };

    return {
      ours: sideFor(this.us),
      theirs: sideFor(this.them),
      weather: this.weather,
      weatherTurns: this.weatherTurns,
      terrain: this.terrain,
      terrainTurns: this.terrainTurns,
      trickRoom: this.trickRoom,
      trickRoomTurns: this.trickRoomTurns,
    };
  }

  /** A short readout of what's known, for the panel. */
  summary() {
    const describe = (side) => ({
      name: side.name,
      alive: side.aliveCount,
      seen: side.team.length,
      teamSize: side.teamSize,
      active: side.active && {
        species: side.active.speciesName,
        level: side.active.level,
        hpPercent: Math.round(side.active.hpPercent),
        hpIsExact: side.active.hpIsExact,
        status: side.active.status,
        revealed: [...side.active.revealedMoves.keys()],
        roles: side.active.candidateRoles().map((r) => r.name),
        item: side.active.item,
        scarfProven: side.active.scarfProven,
        speed: side.active.effectiveSpeed(),
      },
    });
    return {
      turn: this.turn,
      ended: this.ended,
      winner: this.winner,
      weather: this.weather,
      terrain: this.terrain,
      trickRoom: this.trickRoom,
      us: describe(this.us),
      them: describe(this.them),
      notes: this.notes.slice(-5),
    };
  }
}
