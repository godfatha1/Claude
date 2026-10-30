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

    // The move you've called for them this turn: "I think they'll click this".
    // Cleared when the turn ends or they switch.
    this.nextMove = null;

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

  /**
   * One tap on a move, cycling through what you can say about it:
   *
   *   not seen:  maybe -> they have it -> they'll use it next turn -> maybe
   *   seen:      seen  -> they'll use it next turn -> seen
   *
   * Calling the next move implies they have it, so it's only offered once the
   * move is confirmed or seen. Returns the new state.
   */
  cycleMove(moveName) {
    const id = toId(moveName);
    const seen = (this.revealedMoves.get(id) ?? 0) > 0;
    if (seen) {
      this.nextMove = this.nextMove === id ? null : id;
      return this.nextMove ? 'next' : 'seen';
    }
    if (!this.confirmed.moves.has(id)) { this.confirmMove(id); return 'sure'; }
    if (this.nextMove !== id) { this.nextMove = id; return 'next'; }
    this.nextMove = null;
    this.confirmMove(id); // second call undoes it
    return 'maybe';
  }

  /**
   * How likely each still-possible role is, given everything known.
   *
   * Starts from how often the generator picks each role, then weighs it by how
   * well it explains what's been seen: a role that runs Choice Band half the
   * time is half as likely once Leftovers shows up. Falls back to an even split
   * where the data has no frequencies.
   */
  roleOdds() {
    const roles = this.candidateRoles();
    if (!roles.length) return [];
    const known = [...this.revealedMoves.keys()];
    const item = this.item ? toId(this.item) : null;
    const ability = this.ability ? toId(this.ability) : null;
    const tera = this.teraType ? toId(this.teraType) : null;
    const freq = (ids, freqs, id) => {
      const at = ids.indexOf(id);
      if (at < 0) return ids.length ? 0.02 : 1; // pools are sampled; never zero
      return freqs ? Math.max(0.02, freqs[at]) : 1 / ids.length;
    };
    const weighed = roles.map((role) => {
      let w = role.W ?? 1 / roles.length;
      for (const m of known) w *= role.mf ? freq(role.m, role.mf, m) : 1;
      if (item) w *= freq(role.i, role.if, item);
      if (ability) w *= freq(role.a, role.af, ability);
      if (tera && role.t.length) w *= freq(role.t, role.tf, tera);
      return { role, w };
    });
    const total = weighed.reduce((sum, r) => sum + r.w, 0);
    return weighed.map(({ role, w }) => ({ role, p: total > 0 ? w / total : 1 / roles.length }));
  }

  /**
   * The chance of each move being in its set, from 0 to 1. Seen or confirmed
   * moves are 1. For the rest: the open slots, shared out by how often each
   * move turns up in the role, summed over the roles it could be.
   */
  moveOdds() {
    const out = new Map();
    const known = new Set(this.revealedMoves.keys());
    for (const id of known) out.set(id, 1);
    for (const { role, p } of this.roleOdds()) {
      const open = role.m.filter((m) => !known.has(m));
      // Without counts, assume four picked evenly from the pool.
      const f = (m) => (role.mf ? role.mf[role.m.indexOf(m)] : Math.min(1, 4 / role.m.length));
      let slots = Math.max(0, 4 - [...known].filter((m) => role.m.includes(m)).length);
      // Moves the role always has fill their slots first; the rest share what's left.
      const always = open.filter((m) => f(m) >= 0.999);
      const rest = open.filter((m) => f(m) < 0.999);
      for (const m of always) out.set(m, (out.get(m) ?? 0) + p * (slots > 0 ? 1 : 0));
      slots = Math.max(0, slots - always.length);
      const spread = rest.reduce((sum, m) => sum + f(m), 0);
      for (const m of rest) {
        const chance = spread > 0 ? Math.min(1, slots * f(m) / spread) : 0;
        out.set(m, (out.get(m) ?? 0) + p * chance);
      }
    }
    return out;
  }

  /** The chance of each item, summed over the roles it could be. */
  itemOdds() {
    if (this.item && !this.itemKnownGone) return new Map([[toId(this.item), 1]]);
    return this.optionOdds('i', 'if');
  }

  abilityOdds() {
    if (this.ability) return new Map([[toId(this.ability), 1]]);
    return this.optionOdds('a', 'af');
  }

  optionOdds(key, freqKey) {
    const out = new Map();
    for (const { role, p } of this.roleOdds()) {
      const ids = role[key] ?? [];
      const freqs = role[freqKey];
      ids.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + p * (freqs ? freqs[i] : 1 / ids.length)));
    }
    return out;
  }

  /**
   * When every set it could be running has the same ability, it has that
   * ability — so treat it as known until something shows otherwise. Null when
   * the ability is actually known, or when there's more than one possibility.
   */
  get assumedAbility() {
    if (this.ability) return null;
    return onlyOne(this.candidateRoles().flatMap((r) => r.a));
  }

  /** Same for the item. */
  get assumedItem() {
    if (this.item || this.itemKnownGone) return null;
    return onlyOne(this.candidateRoles().flatMap((r) => r.i));
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

  /** Is it holding a Choice Scarf: proven, confirmed, seen, or its only option? */
  get hasScarf() {
    if (this.itemKnownGone) return false; // knocked off or tricked away
    return this.scarfProven || toId(this.item ?? this.assumedItem ?? '') === 'choicescarf';
  }
  /**
   * Does it have Truant? Known when the ability was revealed or confirmed, and
   * otherwise when it's the only ability the species can have — which is
   * Slaking, the one that matters.
   */
  get hasTruant() {
    const ability = this.ability ?? this.assumedAbility;
    if (ability) return toId(ability) === 'truant';
    const pool = this.data?.A ?? [];
    return pool.length === 1 && pool[0] === 'truant';
  }

  /** Could this species have this ability at all? Guards against crediting the wrong side. */
  couldHaveAbility(id) {
    if (!this.data) return true;
    const pool = new Set([...(this.data.A ?? []), ...Object.values(this.data.r ?? {}).flatMap((r) => r.a ?? [])]);
    return pool.size === 0 || pool.has(id);
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

/** The single distinct value in a list, or null if there are none or several. */
function onlyOne(list) {
  const distinct = [...new Set(list)];
  return distinct.length === 1 ? distinct[0] : null;
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
    /** Showdown said our active can Tera right now, and into what (our side only). */
    this.canTera = null;
    /**
     * What the active looked like when it came in, and what it's been
     * credited with since. Illusion is why: Zoroark arrives looking like a
     * teammate, and everything it does gets pinned on the disguise until it's
     * hit. When the disguise breaks, this is what gets handed back.
     */
    this.sinceSwitch = null;
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
    /** Ladder ratings posted after the game, by player id: { before, after, reason }. */
    this.ratings = {};

    // What acted this turn and how fast each side was when it began. Both feed
    // the Scarf check, which only runs once a turn is complete.
    this.turnMoves = [];
    this.turnStartSpeeds = {};
    this.replacedThisTurn = false;
    this.formeChangedThisTurn = false;
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

    // Abilities and items announce themselves in passing far more often than
    // with a line of their own: "[from] item: Leftovers" on a heal, "[from]
    // ability: Rough Skin" on chip damage, "[from] ability: Drought" on the
    // weather. Each one is as certain as a reveal.
    const revealed = this.noteRevealedEffects(cmd, args);

    switch (cmd) {
      case 'player': return this.onPlayer(args);
      case 'teamsize': return this.onTeamSize(args);
      case 'turn': return this.onTurn(args);
      case 'switch':
      case 'drag': return this.onSwitch(args, cmd);
      case 'replace': return this.onReplace(args);
      case 'detailschange': return this.onDetailsChange(args);
      case '-formechange': return this.onFormeChange(args);
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
      case '-activate': return this.onActivate(args) || revealed;
      case '-transform': {
        // Ditto and friends: from here its moves are the target's, not its own.
        const { mon } = this.resolve(args[0]);
        if (mon) mon.volatiles.add('transform');
        return true;
      }
      case 'cant': return this.onCant(args);
      case 'raw': return this.onRaw(args);
      case 'win': this.ended = true; this.winner = args[0]; return true;
      case 'tie': this.ended = true; return true;
      default: return revealed;
    }
  }

  /**
   * Credit abilities and items named in `[from]` tags to whoever has them.
   *
   * Who that is depends on the message. Rough Skin's chip lands on the
   * attacker with the holder in `[of]`; Volt Absorb's heal lands on the holder
   * with the attacker in `[of]`. So each kind of line names who to try first,
   * and the species' own ability pool settles it: Volt Absorb is never credited
   * to something that can't have it. Returns true if anything was learned.
   */
  noteRevealedEffects(cmd, args) {
    const kw = {};
    const positional = [];
    for (const a of args) {
      const m = /^\[(\w+)\]\s?(.*)$/.exec(a);
      if (m) kw[m[1]] = m[2]; else positional.push(a);
    }
    const main = this.resolve(positional[0]).mon;
    const of = kw.of ? this.resolve(kw.of).mon : null;
    let learned = false;

    const ability = /^ability:\s*(.+)$/i.exec(kw.from ?? '')?.[1];
    if (ability && cmd !== '-ability') {
      // The holder is the target of these; [of] is whoever set it off.
      const holderFirst = ['-heal', '-immune', '-curestatus', '-formechange', '-transform',
        '-start', '-end', '-activate', '-cureteam', '-clearnegativeboost', 'cant'].includes(cmd)
        || (cmd === '-item' && !/frisk/i.test(ability));
      learned = this.creditAbility(ability, holderFirst ? [main, of] : [of, main]) || learned;
    }
    // "ability: X" as an argument: the Pokémon named first is the holder.
    if (cmd === 'cant' || cmd === '-activate') {
      const named = positional.map((a) => /^ability:\s*(.+)$/i.exec(a)?.[1]).find(Boolean);
      if (named) learned = this.creditAbility(named, [main, of]) || learned;
    }

    const item = /^item:\s*(.+)$/i.exec(kw.from ?? '')?.[1];
    if (item) {
      // A heal or a self-inflicted hit is the holder's own item; recoil from
      // Rocky Helmet names the holder in [of].
      const holder = cmd === '-damage' && of ? of : main;
      if (holder && !['-item', '-enditem'].includes(cmd)) {
        holder.item = item;
        holder.itemKnownGone = false;
        holder.confirmed.item = false;
        learned = true;
      }
    }
    if (cmd === '-activate') {
      const named = positional.map((a) => /^item:\s*(.+)$/i.exec(a)?.[1]).find(Boolean);
      if (named && main) { main.item = named; main.confirmed.item = false; learned = true; }
    }
    return learned;
  }

  /**
   * Showdown says "As One"; the data says "As One (Glastrier)". When the name
   * shown isn't in the species' pool but exactly one entry starts with it,
   * that entry is the one.
   */
  canonicalAbility(mon, name) {
    const id = toId(name);
    if (!mon.data || mon.couldHaveAbility(id)) return name;
    const pool = [...new Set([...(mon.data.A ?? []), ...Object.values(mon.data.r ?? {}).flatMap((r) => r.a ?? [])])];
    const match = pool.filter((a) => a.startsWith(id));
    return match.length === 1 ? (this.dex.names?.abilities?.[match[0]] ?? match[0]) : name;
  }

  /** Give an ability to the first of these that could have it. */
  creditAbility(name, candidates) {
    const id = toId(name);
    const present = candidates.filter(Boolean);
    // With only one Pokémon named there's no one else it could be, even if
    // the set data has never seen that ability on it (the pools are sampled).
    const holder = present.length === 1 ? present[0] : present.find((m) => m.couldHaveAbility(id));
    if (!holder) return false;
    // Something seen in the battle outranks a tap, and the first one seen is
    // its own: anything after is an ability that changed hands mid-battle.
    if (holder.ability && !holder.confirmed.ability) return false;
    holder.ability = name;
    holder.confirmed.ability = false;
    return true;
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
      mon.nextMove = null; // a call was for the turn that just ended
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

    for (const m of side.team) m.nextMove = null;
    let mon = side.find(speciesPart) ?? side.find(nickname);
    if (!mon) {
      mon = new TrackedMon(this.dex, speciesPart, level ? parseInt(level, 10) : null, gender);
      side.team.push(mon);
    }
    side.activeIndex = side.team.indexOf(mon);
    mon.timesSeenActive += 1;
    // A temporary forme ends on switching out; the details say what it is now.
    const now = this.dex.get(speciesPart);
    if (now && now.id !== mon.data?.id) { mon.data = now; mon.speciesName = speciesPart; }
    side.sinceSwitch = {
      mon, moves: [],
      before: {
        hpPercent: mon.hpPercent, hpExact: mon.hpExact, hpIsExact: mon.hpIsExact,
        status: mon.status, item: mon.item, itemKnownGone: mon.itemKnownGone,
        ability: mon.ability, scarfProven: mon.scarfProven,
      },
    };

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

  /**
   * `|replace|`: an Illusion just broke. The Pokémon on the field was never
   * what it looked like, so hand everything it did since it came in to the
   * real one, and put the disguise back the way it was.
   */
  onReplace([ref, details, hp]) {
    const slot = /^(p[12])/.exec(ref ?? '')?.[1];
    if (!slot) return false;
    const side = this.sides[slot];
    const disguise = side.active;
    const since = side.sinceSwitch;

    const [speciesPart, ...rest] = (details ?? '').split(',').map((x) => x.trim());
    const level = rest.map((r) => /^L(\d+)$/.exec(r)).find(Boolean)?.[1];
    const gender = rest.find((r) => r === 'M' || r === 'F') ?? null;
    let mon = side.find(speciesPart);
    if (!mon) {
      mon = new TrackedMon(this.dex, speciesPart, level ? parseInt(level, 10) : null, gender);
      side.team.push(mon);
    }
    side.activeIndex = side.team.indexOf(mon);
    this.replacedThisTurn = true;

    if (disguise && disguise !== mon) {
      // The real one keeps what happened on the field.
      mon.boosts = disguise.boosts;
      mon.volatiles = disguise.volatiles;
      mon.volatileTurns = disguise.volatileTurns;
      mon.lastMove = disguise.lastMove;
      mon.timesSeenActive += 1;
      disguise.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
      disguise.volatiles = new Set();
      disguise.volatileTurns = new Map();
      disguise.lastMove = null;
      disguise.timesSeenActive = Math.max(0, disguise.timesSeenActive - 1);

      if (since?.mon === disguise) {
        for (const id of since.moves) {
          const n = (disguise.revealedMoves.get(id) ?? 0) - 1;
          if (n > 0 || disguise.confirmed.moves.has(id)) disguise.revealedMoves.set(id, Math.max(0, n));
          else disguise.revealedMoves.delete(id);
          mon.revealedMoves.set(id, (mon.revealedMoves.get(id) ?? 0) + 1);
        }
        const b = since.before;
        const falseScarf = disguise.scarfProven && !b.scarfProven;
        // Whatever it was credited with while disguised was the real one's —
        // except a Scarf "proven" from speeds that were never its own.
        if (disguise.item !== b.item && !falseScarf) { mon.item = disguise.item; mon.itemKnownGone = disguise.itemKnownGone; }
        if (disguise.ability !== b.ability) mon.ability = disguise.ability;
        Object.assign(disguise, {
          hpPercent: b.hpPercent, hpExact: b.hpExact, hpIsExact: b.hpIsExact, status: b.status,
          item: b.item, itemKnownGone: b.itemKnownGone, ability: b.ability,
        });
        // A Scarf "proven" on the disguise was the real one outspeeding.
        if (falseScarf) {
          disguise.scarfProven = false;
          this.notes = this.notes.filter((n) => !(n.kind === 'scarf' && n.text.startsWith(disguise.speciesName)));
        }
      }
    }
    side.sinceSwitch = { mon, moves: [], before: since?.before ?? {} };
    if (hp) this.applyHp(mon, hp);
    return true;
  }

  /**
   * A permanent forme change: Terapagos into Terastal, Eiscue losing its Ice
   * Face. Types, stats and Speed all change, and sometimes the ability too,
   * so the data is re-resolved and the name follows it.
   */
  onDetailsChange([ref, details]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    const species = (details ?? '').split(',')[0].trim();
    if (this.changeForme(mon, species)) mon.speciesName = species;
    return true;
  }

  /**
   * A forme change that lasts while it's out (Meloetta after Relic Song,
   * Minior dropping its shell). The name stays, so it's still found when it
   * switches back in; the data — and so the stats and Speed — follow the forme.
   */
  onFormeChange([ref, species]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    this.changeForme(mon, String(species ?? '').trim());
    return true;
  }

  changeForme(mon, species) {
    const data = this.dex.get(species);
    if (!data) return false;
    const before = mon.data;
    mon.data = data;
    // Speed just changed under us: this turn's order proves nothing.
    this.formeChangedThisTurn = true;
    // A forme with an ability of its own (Terapagos-Terastal has Tera Shell).
    const own = data.A ?? [];
    if (own.length === 1 && before?.A?.join() !== own.join()) {
      mon.ability = this.dex.names?.abilities?.[own[0]] ?? own[0];
      mon.confirmed.ability = false;
    }
    return true;
  }

  onMove([ref, moveName, , ...rest]) {
    const { side, mon } = this.resolve(ref);
    if (!mon) return false;

    const id = toId(moveName);
    // A move called by something else (Metronome, Sleep Talk, Copycat) isn't in
    // the user's own set, so don't record it as revealed. Nor is Struggle (out
    // of PP), nor anything a transformed Pokémon uses — those are copies.
    const calledByAnother = rest.some((r) => /^\[from\]/.test(r) && !/\[from\]lockedmove/.test(r))
      || id === 'struggle' || mon.volatiles.has('transform');
    if (!calledByAnother) {
      mon.revealedMoves.set(id, (mon.revealedMoves.get(id) ?? 0) + 1);
      if (side?.sinceSwitch?.mon === mon) side.sinceSwitch.moves.push(id);
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

    // Truant: having just moved, it loafs next turn. Showdown keeps this as a
    // silent volatile that never shows in the log, so it has to be inferred
    // from the ability. The engine models it the same way — a TRUANT volatile
    // means "this turn is the loaf" — so this is what it needs to be told.
    if (!calledByAnother && mon.hasTruant) mon.volatiles.add('truant');
    return true;
  }

  /**
   * `|cant|p2a: Slaking|ability: Truant` — it loafed, so it moves next turn.
   *
   * Other reasons (asleep, flinched, paralysed) leave the Truant clock where it
   * was, which matches the simulator: a sleeping Slaking that was due to loaf
   * still loafs when it wakes.
   */
  onCant([ref, reason]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    if (/^ability:\s*truant$/i.test(String(reason ?? ''))) {
      mon.ability = 'Truant';
      mon.volatiles.delete('truant');
      return true;
    }
    return false;
  }

  /**
   * The ladder posts each player's rating change into the room after the game:
   * `Name's rating: 1234 &rarr; <strong>1250</strong><br />(+16 for winning)`.
   */
  onRaw(args) {
    const html = args.join('|');
    const match = /^(.+?)'s rating: (\d+) &rarr; <strong>(\d+)<\/strong>(?:<br \/>\((.*?)\))?/.exec(html);
    if (!match) return false;
    const name = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    this.ratings[toId(name)] = {
      name,
      before: parseInt(match[2], 10),
      after: parseInt(match[3], 10),
      reason: match[4] ?? '',
    };
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
    // An Illusion broke, or a forme changed, this turn: someone's Speed
    // wasn't what the snapshot said.
    const unreliable = this.replacedThisTurn || this.formeChangedThisTurn;
    this.replacedThisTurn = false;
    this.formeChangedThisTurn = false;
    if (unreliable) return;
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
    mon.confirmed.item = false;
    if (/^choice/.test(toId(item))) {
      // A revealed Choice item means the last move it used is its lock.
      const last = [...mon.revealedMoves.keys()].pop();
      if (last) mon.choiceLockedTo = last;
    }
    return true;
  }

  onEndItem([ref, item]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    // What it was holding is still worth knowing: it narrows the set.
    if (item && (!mon.item || mon.confirmed.item)) { mon.item = item; mon.confirmed.item = false; }
    mon.itemKnownGone = true;
    mon.choiceLockedTo = null;
    return true;
  }

  onAbility([ref, ability, ...rest]) {
    const { mon } = this.resolve(ref);
    if (!mon) return false;
    const from = rest.map((r) => /^\[from\]\s?(.*)$/.exec(r)?.[1]).find(Boolean);
    if (!from) {
      // Its own ability, announced. Beats anything tapped — but the first one
      // shown is the one it came with: Calyrex's As One later announces
      // "Chilling Neigh" when it boosts, and that isn't a different ability.
      if (!mon.ability || mon.confirmed.ability) {
        mon.ability = this.canonicalAbility(mon, ability);
        mon.confirmed.ability = false;
      }
      return true;
    }
    // A copied or swapped ability isn't the one it came in with. Trace is
    // the exception worth reading: the tracer has Trace, the one it copied
    // from has what was copied.
    const of = this.resolve(rest.map((r) => /^\[of\]\s?(.*)$/.exec(r)?.[1]).find(Boolean)).mon;
    if (/^ability:\s*trace$/i.test(from)) {
      this.creditAbility('Trace', [mon]);
      if (of) this.creditAbility(ability, [of]);
    } else if (/^ability:/i.test(from)) {
      this.creditAbility(from.replace(/^ability:\s*/i, ''), [of, mon]);
    }
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
      ratings: this.ratings,
      weather: this.weather,
      terrain: this.terrain,
      trickRoom: this.trickRoom,
      us: describe(this.us),
      them: describe(this.them),
      notes: this.notes.slice(-5),
    };
  }
}
