"""Base stats, types, move facts and type effectiveness.

Everything here comes from the Showdown data that poke-env bundles, so it tracks
the live simulator rather than a hand-maintained copy.

Species and move names arrive from several places — the set data uses display
names ("Great Tusk", "Close Combat"), the protocol uses display names too but
with inconsistent punctuation, and the engine wants ids. `to_id` is the single
normaliser, and it matches what Showdown itself does: strip everything that
isn't a letter or a digit, then lowercase.
"""

from __future__ import annotations

import functools
import re
from dataclasses import dataclass

from poke_env.data import GenData

GEN = 9

_NOT_ID = re.compile(r"[^a-z0-9]+")


def to_id(name: str) -> str:
    """Normalise any name to Showdown's id form."""
    return _NOT_ID.sub("", str(name).lower())


@functools.lru_cache(maxsize=1)
def _gen_data() -> GenData:
    return GenData.from_gen(GEN)


@functools.lru_cache(maxsize=1)
def pokedex() -> dict:
    return _gen_data().pokedex


@functools.lru_cache(maxsize=1)
def movedex() -> dict:
    return _gen_data().moves


@functools.lru_cache(maxsize=1)
def type_chart() -> dict:
    # Showdown's shape: chart[DEFENDING][ATTACKING] -> multiplier.
    return _gen_data().type_chart


# ---------------------------------------------------------------- species


@dataclass(frozen=True)
class Species:
    id: str
    name: str
    base_id: str
    """The base species' id.

    Many species turn up under a forme name that nothing else distinguishes —
    Gastrodon-East, Minior-Blue, Maushold-Four. The set data files them under the
    base name, and the simulator's own generator works on the base species and
    picks the forme afterwards, so anything matching on species identity has to
    match on this rather than on `id`. Formes with stats of their own, like
    Zamazenta-Crowned, keep their own set data and their own stats.
    """
    types: tuple[str, ...]
    base_stats: dict[str, int]
    weight_kg: float
    abilities: tuple[str, ...]

    @property
    def base_speed(self) -> int:
        return self.base_stats["spe"]

    @property
    def is_forme(self) -> bool:
        return self.id != self.base_id


@functools.lru_cache(maxsize=2048)
def species(name: str) -> Species:
    """Look up a species by any spelling of its name."""
    key = to_id(name)
    entry = pokedex().get(key)
    if entry is None:
        raise KeyError(f"no species called {name!r}")
    # `baseSpecies` comes back lowercase when the entry *is* the base species
    # and properly cased when it's a forme, so normalising both is enough.
    base_id = to_id(entry.get("baseSpecies") or key) or key
    return Species(
        id=key,
        name=entry.get("name", name),
        base_id=base_id,
        types=tuple(t.upper() for t in entry["types"]),
        base_stats=dict(entry["baseStats"]),
        weight_kg=float(entry.get("weightkg", 0) or 0),
        abilities=tuple(entry.get("abilities", {}).values()),
    )


# ------------------------------------------------------------------- moves


@dataclass(frozen=True)
class Move:
    id: str
    name: str
    category: str  # Physical | Special | Status
    base_power: int
    type: str
    priority: int
    target: str
    fixed_damage: bool  # Seismic Toss, Night Shade, Dragon Rage and friends
    damage_callback: bool  # Counter, Super Fang, Endeavor, Ruination and friends

    @property
    def is_status(self) -> bool:
        return self.category == "Status"

    @property
    def ignores_attack_stat(self) -> bool:
        """True when the move's damage doesn't read the user's Attack stat.

        This is what decides whether a set bothers investing in Attack at all.
        """
        return self.fixed_damage or self.damage_callback


@functools.lru_cache(maxsize=4096)
def move(name: str) -> Move:
    key = to_id(name)
    entry = movedex().get(key)
    if entry is None:
        raise KeyError(f"no move called {name!r}")
    return Move(
        id=key,
        name=entry.get("name", name),
        category=entry.get("category", "Status"),
        base_power=int(entry.get("basePower", 0) or 0),
        type=str(entry.get("type", "Normal")).upper(),
        priority=int(entry.get("priority", 0) or 0),
        target=entry.get("target", "normal"),
        fixed_damage=bool(entry.get("damage")),
        damage_callback=bool(entry.get("damageCallback")),
    )


def move_exists(name: str) -> bool:
    return to_id(name) in movedex()


# ------------------------------------------------------- item-led formes


@functools.lru_cache(maxsize=1)
def _battle_formes() -> dict[tuple[str, str], str]:
    """Map (base species, held item) to the forme it actually fights as.

    Zacian holding a Rusted Sword is Zacian-Crowned the moment the battle starts:
    Fairy/Steel instead of Fairy, and 148 base Speed instead of 138. Getting this
    wrong would put both the type chart and the speed check out, so it's resolved
    from the dex's own `battleOnly` and `requiredItem` fields rather than a list
    kept by hand.
    """
    mapping: dict[tuple[str, str], str] = {}
    for species_id, entry in pokedex().items():
        battle_only = entry.get("battleOnly")
        if not battle_only:
            continue
        # `battleOnly` is a name for a single parent and a list for formes that
        # several species can turn into; only the single case is item-led.
        if not isinstance(battle_only, str):
            continue
        items = entry.get("requiredItems") or (
            [entry["requiredItem"]] if entry.get("requiredItem") else []
        )
        for item in items:
            mapping[(to_id(battle_only), to_id(item))] = species_id
    return mapping


def battle_forme(species_name: str, item: str | None) -> str:
    """The species id this Pokémon actually fights as, given its item.

    Returns the species unchanged when the item doesn't change anything.
    """
    key = to_id(species_name)
    if not item:
        return key
    return _battle_formes().get((key, to_id(item)), key)


# ---------------------------------------------------------- effectiveness


def effectiveness(attacking_type: str, defending_types: tuple[str, ...]) -> float:
    """Plain damage multiplier for one attacking type against a defending pair."""
    chart = type_chart()
    attacker = attacking_type.upper()
    multiplier = 1.0
    for defender in defending_types:
        row = chart.get(defender.upper())
        if row is None:
            continue
        multiplier *= row.get(attacker, 1)
    return multiplier


def effectiveness_steps(attacking_type: str, defending_types: tuple[str, ...]) -> int:
    """The same thing as Showdown's step count: 2x is 1, 4x is 2, half is -1.

    Needed because the set generator works in steps, not multipliers, when it
    decides how to round a Pokémon's HP.
    """
    multiplier = effectiveness(attacking_type, defending_types)
    if multiplier == 0:
        return 0
    steps = 0
    while multiplier > 1:
        multiplier /= 2
        steps += 1
    while multiplier < 1:
        multiplier *= 2
        steps -= 1
    return steps


# ------------------------------------------------------------------- stats

STAT_KEYS = ("hp", "atk", "def", "spa", "spd", "spe")


def _trunc(value: float) -> int:
    return int(value)


def compute_stat(base: int, iv: int, ev: int, level: int, *, is_hp: bool) -> int:
    """Showdown's own stat arithmetic, truncation points included.

    Random battles always use a neutral nature, so there's no nature step here.
    """
    if is_hp:
        return _trunc(_trunc(2 * base + iv + _trunc(ev / 4) + 100) * level / 100 + 10)
    return _trunc(_trunc(2 * base + iv + _trunc(ev / 4)) * level / 100 + 5)


def compute_stats(
    base_stats: dict[str, int],
    level: int,
    evs: dict[str, int],
    ivs: dict[str, int],
) -> dict[str, int]:
    return {
        key: compute_stat(
            base_stats[key], ivs.get(key, 31), evs.get(key, 85), level, is_hp=(key == "hp")
        )
        for key in STAT_KEYS
    }
