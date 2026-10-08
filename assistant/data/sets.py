"""The set model for random battles, and exact stats for any set.

Two things make this format unusually tractable, and both live here.

**Sets are published as roles.** A species doesn't have one set, it has a handful
of named roles, and each role carries its own tighter pool of abilities, items,
tera types and moves. Great Tusk's "Fast Bulky Setup" means Booster Energy, full
stop. So the moment a move or an item shows up, whole roles drop out and the
remaining possibilities narrow sharply.

**Stats are not guesswork.** Levels come from the set data and spreads are fixed,
so a species' stats are computable rather than estimated. The catch is that
"fixed" isn't quite "85 everywhere" — the generator tunes HP downward to round
Stealth Rock damage, and zeroes Attack or Speed in specific cases. Those rules
are ported here move for move from the simulator's own generator, because the
whole value of this is being exactly right: if the arithmetic is right, an
opponent outspeeding you when it shouldn't is proof of a Choice Scarf rather
than a hunch.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cached_property

from . import fetch
from .dex import STAT_KEYS, Species, compute_stat, compute_stats, effectiveness_steps
from .dex import move as get_move
from .dex import species as get_species
from .dex import to_id

# --- the handful of exceptions the generator carves out, by name ---

# Crash-damage users want odd HP so they survive two misses. The generator
# forces their Stealth Rock weakness to 2 to get there.
CRASH_MOVES = frozenset({"axekick", "highjumpkick", "jumpkick", "supercellslam"})

# Sets that want Sitrus Berry to fire after one activation.
SITRUS_HALVERS = frozenset({"bellydrum", "filletaway", "shedtail"})

# Holding either of these means Stealth Rock rounding doesn't apply.
SR_IGNORING_ITEMS = frozenset({"leftovers", "lifeorb"})

# Tera Blast counts as physical on these, so they still want Attack.
PHYSICAL_TERA_ABILITIES = frozenset({"contrary", "defiant"})

# Physical moves that read a stat other than the user's Attack.
ATTACK_FREE_PHYSICAL = frozenset({"bodypress", "foulplay"})


@dataclass(frozen=True)
class Role:
    """One named way a species can be built."""

    name: str
    abilities: tuple[str, ...]
    items: tuple[str, ...]
    tera_types: tuple[str, ...]
    moves: tuple[str, ...]

    @cached_property
    def move_ids(self) -> frozenset[str]:
        return frozenset(to_id(m) for m in self.moves)

    @cached_property
    def item_ids(self) -> frozenset[str]:
        return frozenset(to_id(i) for i in self.items)

    @cached_property
    def ability_ids(self) -> frozenset[str]:
        return frozenset(to_id(a) for a in self.abilities)

    @cached_property
    def tera_ids(self) -> frozenset[str]:
        return frozenset(to_id(t) for t in self.tera_types)

    def can_have_move(self, move_name: str) -> bool:
        return to_id(move_name) in self.move_ids

    def can_have_item(self, item_name: str) -> bool:
        return to_id(item_name) in self.item_ids

    def can_have_ability(self, ability_name: str) -> bool:
        return to_id(ability_name) in self.ability_ids


@dataclass(frozen=True)
class SpeciesSets:
    """Everything the format publishes about one species."""

    species: Species
    level: int
    abilities: tuple[str, ...]
    items: tuple[str, ...]
    roles: tuple[Role, ...]

    @property
    def id(self) -> str:
        return self.species.id

    @property
    def name(self) -> str:
        return self.species.name

    def role(self, name: str) -> Role:
        for role in self.roles:
            if role.name == name:
                return role
        raise KeyError(f"{self.name} has no role called {name!r}")

    def roles_with_move(self, move_name: str) -> tuple[Role, ...]:
        return tuple(r for r in self.roles if r.can_have_move(move_name))

    def roles_with_item(self, item_name: str) -> tuple[Role, ...]:
        return tuple(r for r in self.roles if r.can_have_item(item_name))

    @cached_property
    def all_move_ids(self) -> frozenset[str]:
        return frozenset().union(*(r.move_ids for r in self.roles)) if self.roles else frozenset()

    # --- the speed numbers that make turn order into evidence ---

    @cached_property
    def normal_speed(self) -> int:
        """Speed with the usual spread — what almost every set actually has."""
        return compute_stat(self.species.base_speed, 31, 85, self.level, is_hp=False)

    @cached_property
    def min_speed(self) -> int:
        """Speed for the Trick Room and Gyro Ball sets, which zero it deliberately."""
        return compute_stat(self.species.base_speed, 0, 0, self.level, is_hp=False)

    @cached_property
    def max_speed(self) -> int:
        """The fastest this species can move in this format, Choice Scarf included."""
        return (self.normal_speed * 3) // 2


# ----------------------------------------------------------- exact stats


def _wants_no_attack(species: Species, ability: str, moves: tuple[str, ...]) -> bool:
    """Whether the generator zeroes this set's Attack to blunt confusion damage.

    True when nothing in the set reads the user's Attack stat.
    """
    move_ids = {to_id(m) for m in moves}
    if "transform" in move_ids:
        return False

    ability_id = to_id(ability)
    for move_id in move_ids:
        try:
            mv = get_move(move_id)
        except KeyError:
            # An unknown move can't be ruled out, so assume it needs Attack.
            return False

        if mv.ignores_attack_stat:
            continue  # Seismic Toss and friends don't care about Attack.

        if move_id == "shellsidearm":
            return False  # Can land as physical, so it wants the stat.

        if move_id == "terablast":
            physical_tera = (
                species.base_id == "porygon2"
                or ability_id in PHYSICAL_TERA_ABILITIES
                or "shiftgear" in move_ids
                or species.base_stats["atk"] > species.base_stats["spa"]
            )
            if physical_tera:
                return False
            continue

        if mv.category == "Physical" and move_id not in ATTACK_FREE_PHYSICAL:
            return False

    return True


def _tuned_hp_evs(
    species: Species, level: int, ability: str, item: str, moves: tuple[str, ...]
) -> int:
    """Walk HP EVs down the way the generator does.

    Most Pokémon that are weak to Stealth Rock give up a little HP so the chip
    damage divides evenly, which buys an extra switch-in. A few sets instead want
    HP that makes Sitrus Berry fire at the right moment. Ported step for step
    from the simulator, since getting HP wrong puts every damage number out.
    """
    ability_id = to_id(ability)
    item_id = to_id(item)
    move_ids = {to_id(m) for m in moves}

    rock_immune = ability_id == "magicguard" or item_id == "heavydutyboots"
    sr_weakness = 0 if rock_immune else effectiveness_steps("ROCK", species.types)
    if move_ids & CRASH_MOVES:
        sr_weakness = 2

    evs_hp = 85
    while evs_hp > 1:
        hp = compute_stat(species.base_stats["hp"], 31, evs_hp, level, is_hp=True)

        if ("substitute" in move_ids and item_id == "sitrusberry") or species.base_id == "minior":
            # Two Substitutes should trigger Sitrus Berry; Minior wants Shields
            # Down to survive two sets of hazards.
            if hp % 4 == 0:
                break
        elif (move_ids & SITRUS_HALVERS) and (item_id == "sitrusberry" or ability_id == "gluttony"):
            if hp % 2 == 0:
                break
        elif "substitute" in move_ids and "endeavor" in move_ids:
            if hp % 4 > 0:
                break
        else:
            if sr_weakness <= 0 or ability_id == "regenerator" or item_id in SR_IGNORING_ITEMS:
                break
            divisor = 4 // sr_weakness
            if item_id != "sitrusberry" and hp % divisor > 0:
                break
            if item_id == "sitrusberry" and hp % divisor == 0:
                break
        evs_hp -= 4

    return evs_hp


def spread_for(
    species: Species,
    level: int,
    ability: str,
    item: str,
    moves: tuple[str, ...],
) -> tuple[dict[str, int], dict[str, int]]:
    """The exact EVs and IVs a set like this gets. Returns (evs, ivs)."""
    evs = dict.fromkeys(STAT_KEYS, 85)
    ivs = dict.fromkeys(STAT_KEYS, 31)

    evs["hp"] = _tuned_hp_evs(species, level, ability, item, moves)

    if _wants_no_attack(species, ability, moves):
        evs["atk"] = 0
        ivs["atk"] = 0

    move_ids = {to_id(m) for m in moves}
    if "gyroball" in move_ids or "trickroom" in move_ids:
        evs["spe"] = 0
        ivs["spe"] = 0

    return evs, ivs


def stats_for(
    species_name: str,
    level: int,
    ability: str,
    item: str,
    moves: tuple[str, ...],
) -> dict[str, int]:
    """Exact stats for a concrete set."""
    sp = get_species(species_name)
    evs, ivs = spread_for(sp, level, ability, item, moves)
    return compute_stats(sp.base_stats, level, evs, ivs)


# ------------------------------------------------------------- the index


@dataclass
class SetIndex:
    """Every species in a format, looked up by any spelling of its name."""

    fmt: str = "gen9randombattle"
    _by_id: dict[str, SpeciesSets] = field(default_factory=dict)

    @classmethod
    def load(cls, fmt: str = "gen9randombattle", *, refresh: bool = False) -> SetIndex:
        raw = fetch.load(fmt, refresh=refresh)
        index = cls(fmt=fmt)
        for display_name, entry in raw.items():
            try:
                sp = get_species(display_name)
            except KeyError:
                # A species in the set data that the bundled dex doesn't know
                # means the two are out of step. Skip it rather than crash.
                continue
            roles = tuple(
                Role(
                    name=role_name,
                    abilities=tuple(role.get("abilities", ())),
                    items=tuple(role.get("items", ())),
                    tera_types=tuple(role.get("teraTypes", ())),
                    moves=tuple(role.get("moves", ())),
                )
                for role_name, role in entry.get("roles", {}).items()
            )
            index._by_id[sp.id] = SpeciesSets(
                species=sp,
                level=int(entry.get("level", 80)),
                abilities=tuple(entry.get("abilities", ())),
                items=tuple(entry.get("items", ())),
                roles=roles,
            )
        return index

    def __len__(self) -> int:
        return len(self._by_id)

    def __contains__(self, name: str) -> bool:
        return self.get(name) is not None

    def __getitem__(self, name: str) -> SpeciesSets:
        found = self.get(name)
        if found is None:
            raise KeyError(f"{name!r} isn't in the {self.fmt} set data")
        return found

    def get(self, name: str) -> SpeciesSets | None:
        """Find a species' sets, by exact forme first and base species after.

        Cosmetic and stat-identical formes (Gastrodon-East, Minior-Blue,
        Maushold-Four) are filed under the base name, while formes with stats of
        their own (Zamazenta-Crowned) get their own entry. Trying the exact name
        first and the base second handles both without a special-case list.
        """
        key = to_id(name)
        found = self._by_id.get(key)
        if found is not None:
            return found
        try:
            base_id = get_species(key).base_id
        except KeyError:
            return None
        if base_id != key:
            return self._by_id.get(base_id)
        return None

    def all(self) -> tuple[SpeciesSets, ...]:
        return tuple(self._by_id.values())


if __name__ == "__main__":
    index = SetIndex.load()
    print(f"{len(index)} species in {index.fmt}\n")
    for name in ("Great Tusk", "Dragapult", "Iron Treads"):
        sets = index.get(name)
        if sets is None:
            continue
        print(f"{sets.name}  level {sets.level}  speed {sets.normal_speed} "
              f"(scarfed {sets.max_speed}, min {sets.min_speed})")
        for role in sets.roles:
            print(f"    {role.name:<20} items: {', '.join(role.items)}")
        print()
