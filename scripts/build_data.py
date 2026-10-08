#!/usr/bin/env python3
"""Generate the compact data bundle the browser loads.

Everything runs on the phone, so the data has to go with it — but the full
Showdown pokedex is a megabyte and covers 1,600 species when this format only
uses about 510. This trims it to exactly what's needed and nothing else.

Using the Python layer for this is deliberate: it's the part that's been checked
against the simulator's own generated teams, so the numbers the browser gets have
already been verified rather than re-derived by hand in a second language.

Keys are short because this file ships over mobile data.

Run:  python scripts/build_data.py
Out:  data/gen9randombattle.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from assistant.data.dex import (  # noqa: E402
    STAT_KEYS,
    _battle_formes,
    movedex,
    species,
    to_id,
    type_chart,
)
from assistant.data.dex import move as get_move  # noqa: E402
from assistant.data.sets import SetIndex  # noqa: E402

CATEGORY_CODE = {"Physical": 0, "Special": 1, "Status": 2}

# Flags the spread rules need to read, packed into one integer.
FLAG_FIXED_DAMAGE = 1  # Seismic Toss, Night Shade, Dragon Rage
FLAG_DAMAGE_CALLBACK = 2  # Counter, Super Fang, Endeavor, Ruination


def build(fmt: str = "gen9randombattle") -> dict:
    index = SetIndex.load(fmt)

    out_species: dict[str, dict] = {}
    needed_moves: set[str] = set()

    for sets in index.all():
        sp = sets.species
        roles = {}
        for role in sets.roles:
            roles[role.name] = {
                "a": sorted(role.ability_ids),
                "i": sorted(role.item_ids),
                "t": sorted(role.tera_ids),
                "m": sorted(role.move_ids),
            }
            needed_moves |= role.move_ids

        out_species[sp.id] = {
            "n": sp.name,
            "l": sets.level,
            "t": list(sp.types),
            "b": [sp.base_stats[k] for k in STAT_KEYS],
            "w": sp.weight_kg,
            "base": sp.base_id,
            "A": sorted({to_id(a) for a in sets.abilities}),
            "I": sorted({to_id(i) for i in sets.items}),
            "r": roles,
            # Precomputed because every turn's speed check reads them and the
            # arithmetic is fiddly enough to be worth not repeating.
            "sp": [sets.min_speed, sets.normal_speed, sets.max_speed],
        }

    # Every move in the generation, not just the ones in role pools.
    #
    # Tempting to ship only the role-pool moves — it was a third the size — but
    # those pools are derived from sampling and drift from the simulator, so a
    # move can turn up that the bundle has never heard of. An unknown move
    # silently changes the spread the rules compute, which is exactly the kind of
    # wrong that never announces itself. The extra few KB buys that away.
    out_moves: dict[str, dict] = {}
    all_move_ids = sorted(set(movedex()) | needed_moves)
    for move_id in all_move_ids:
        try:
            mv = get_move(move_id)
        except KeyError:
            continue
        flags = 0
        if mv.fixed_damage:
            flags |= FLAG_FIXED_DAMAGE
        if mv.damage_callback:
            flags |= FLAG_DAMAGE_CALLBACK
        entry = {
            "n": mv.name,
            "c": CATEGORY_CODE.get(mv.category, 2),
            "p": mv.base_power,
            "t": mv.type,
        }
        if mv.priority:
            entry["pr"] = mv.priority
        if flags:
            entry["f"] = flags
        out_moves[move_id] = entry

    # Formes decided by the held item (Zacian + Rusted Sword and friends),
    # flattened so the browser can look them up without the whole pokedex.
    item_formes = {f"{base}|{item}": forme for (base, item), forme in _battle_formes().items()}
    # Those target formes need stats of their own even though the set data files
    # them separately.
    for forme_id in set(item_formes.values()):
        if forme_id in out_species:
            continue
        try:
            sp = species(forme_id)
        except KeyError:
            continue
        sets = index.get(forme_id)
        out_species[forme_id] = {
            "n": sp.name,
            "l": sets.level if sets else 80,
            "t": list(sp.types),
            "b": [sp.base_stats[k] for k in STAT_KEYS],
            "w": sp.weight_kg,
            "base": sp.base_id,
            "A": sorted({to_id(a) for a in (sets.abilities if sets else sp.abilities)}),
            "I": sorted({to_id(i) for i in sets.items}) if sets else [],
            "r": {
                role.name: {
                    "a": sorted(role.ability_ids),
                    "i": sorted(role.item_ids),
                    "t": sorted(role.tera_ids),
                    "m": sorted(role.move_ids),
                }
                for role in (sets.roles if sets else ())
            },
            "sp": [sets.min_speed, sets.normal_speed, sets.max_speed] if sets else [0, 0, 0],
        }

    # Cosmetic formes arrive under a forme name and are filed under the base, so
    # the browser needs the same alias map the Python index builds at load time.
    aliases: dict[str, str] = {}
    for species_id, entry in movedex_free_formes(out_species):
        aliases[species_id] = entry

    return {
        "format": fmt,
        "species": out_species,
        "moves": out_moves,
        "types": {d: {a: v for a, v in row.items()} for d, row in type_chart().items()},
        "itemFormes": item_formes,
        "aliases": aliases,
        "statOrder": list(STAT_KEYS),
    }


def movedex_free_formes(out_species: dict[str, dict]):
    """Alias every cosmetic forme in the pokedex to the entry that covers it.

    The protocol sends what it sees — `Gastrodon-East`, `Minior-Blue` — and those
    have no set data of their own. Resolving them in the browser needs this map,
    because the browser doesn't carry the full pokedex to look up a base species.
    """
    from assistant.data.dex import pokedex

    for species_id, entry in pokedex().items():
        if species_id in out_species:
            continue
        base_id = to_id(entry.get("baseSpecies") or species_id) or species_id
        if base_id != species_id and base_id in out_species:
            yield species_id, base_id


def main() -> int:
    fmt = sys.argv[1] if len(sys.argv) > 1 else "gen9randombattle"
    bundle = build(fmt)

    out_dir = ROOT / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{fmt}.json"
    # Separators matter: the default ones add a space per field and this ships
    # over mobile data.
    out_path.write_text(json.dumps(bundle, separators=(",", ":"), sort_keys=True))

    raw_kb = out_path.stat().st_size / 1024
    import gzip

    gz_kb = len(gzip.compress(out_path.read_bytes(), 9)) / 1024
    print(f"{out_path.relative_to(ROOT)}")
    print(f"  species : {len(bundle['species'])}")
    print(f"  moves   : {len(bundle['moves'])} (every move in the gen, not just role pools)")
    print(f"  aliases : {len(bundle['aliases'])} cosmetic formes")
    print(f"  formes  : {len(bundle['itemFormes'])} decided by item")
    print(f"  size    : {raw_kb:.0f} KB raw, {gz_kb:.0f} KB gzipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
