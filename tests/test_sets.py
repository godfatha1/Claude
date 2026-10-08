"""Tests for the set data layer that don't need node or a fixture."""

from __future__ import annotations

import pytest

from assistant.data.dex import battle_forme, compute_stat, effectiveness, effectiveness_steps
from assistant.data.dex import species as get_species
from assistant.data.dex import to_id
from assistant.data.sets import SetIndex, spread_for, stats_for


@pytest.fixture(scope="module")
def index() -> SetIndex:
    return SetIndex.load()


# -------------------------------------------------------------- the index


def test_index_covers_the_format(index):
    assert len(index) > 400


def test_lookup_takes_any_spelling(index):
    for spelling in ("Great Tusk", "greattusk", "GREAT TUSK", "great-tusk"):
        assert index[spelling].id == "greattusk"


def test_missing_species_raises(index):
    with pytest.raises(KeyError):
        index["Not A Pokemon"]
    assert index.get("Not A Pokemon") is None


def test_cosmetic_formes_resolve_to_the_base_species(index):
    """These arrive under a forme name and are filed under the base."""
    for forme, base in (
        ("Gastrodon-East", "gastrodon"),
        ("Minior-Blue", "minior"),
        ("Maushold-Four", "maushold"),
        ("Polteageist-Antique", "polteageist"),
        ("Pikachu-Alola", "pikachu"),
    ):
        found = index.get(forme)
        assert found is not None, f"{forme} didn't resolve"
        assert found.id == base


def test_formes_with_their_own_stats_keep_their_own_entry(index):
    """Zamazenta-Crowned isn't cosmetic, so it mustn't collapse into the base."""
    base = index["Zamazenta"]
    crowned = index["Zamazenta-Crowned"]
    assert base.id != crowned.id
    assert base.level != crowned.level


# ----------------------------------------------------------- item formes


def test_item_decides_the_crowned_formes():
    assert battle_forme("Zacian", "Rusted Sword") == "zaciancrowned"
    assert battle_forme("Zamazenta", "Rusted Shield") == "zamazentacrowned"
    # Without the item, nothing changes.
    assert battle_forme("Zacian", "Life Orb") == "zacian"
    assert battle_forme("Zacian", None) == "zacian"
    # And an item that changes nothing leaves an ordinary species alone.
    assert battle_forme("Great Tusk", "Leftovers") == "greattusk"


def test_the_crowned_formes_really_do_differ():
    """If these were the same, resolving them wouldn't matter."""
    plain = get_species("Zacian")
    crowned = get_species("Zacian-Crowned")
    assert plain.types != crowned.types
    assert plain.base_speed != crowned.base_speed


# ---------------------------------------------------------------- speeds


def test_speed_numbers_are_ordered(index):
    tusk = index["Great Tusk"]
    assert tusk.min_speed < tusk.normal_speed < tusk.max_speed


def test_scarf_speed_is_one_and_a_half_times(index):
    for sets in list(index.all())[:50]:
        assert sets.max_speed == (sets.normal_speed * 3) // 2


def test_speed_matches_the_stat_formula(index):
    tusk = index["Great Tusk"]
    assert tusk.normal_speed == compute_stat(
        tusk.species.base_speed, 31, 85, tusk.level, is_hp=False
    )


# ------------------------------------------------------- role narrowing


def test_one_move_can_pin_a_role(index):
    """The point of role data: a single move often collapses the options."""
    pult = index["Dragapult"]
    assert len(pult.roles) > 1
    # Dragon Dance only appears on the Tera Blast set.
    narrowed = pult.roles_with_move("Dragon Dance")
    assert len(narrowed) == 1
    assert narrowed[0].items == ("Life Orb",)


def test_a_move_no_role_has_narrows_to_nothing(index):
    assert index["Great Tusk"].roles_with_move("Hydro Pump") == ()


def test_every_role_pool_is_non_empty(index):
    """An empty pool would silently rule everything out during inference."""
    bad = []
    for sets in index.all():
        for role in sets.roles:
            if not role.moves:
                bad.append(f"{sets.name}/{role.name}: no moves")
            if not role.abilities:
                bad.append(f"{sets.name}/{role.name}: no abilities")
    assert not bad, bad[:10]


def test_role_move_pools_roll_up_into_the_species(index):
    tusk = index["Great Tusk"]
    for role in tusk.roles:
        assert role.move_ids <= tusk.all_move_ids


# -------------------------------------------------------------- spreads


def test_special_attackers_give_up_attack():
    """Nothing in this set reads Attack, so the generator zeroes it."""
    evs, ivs = spread_for(
        get_species("Dragapult"),
        77,
        "Infiltrator",
        "Choice Specs",
        ("Draco Meteor", "Fire Blast", "Shadow Ball", "U-turn"),
    )
    # U-turn is physical, so this set *does* keep Attack.
    assert evs["atk"] == 85

    evs, ivs = spread_for(
        get_species("Dragapult"),
        77,
        "Infiltrator",
        "Choice Specs",
        ("Draco Meteor", "Fire Blast", "Shadow Ball", "Thunderbolt"),
    )
    assert evs["atk"] == 0 and ivs["atk"] == 0


def test_body_press_and_foul_play_dont_count_as_wanting_attack():
    """Both are physical but read a stat other than the user's Attack.

    Body Press hits off Defence and Foul Play off the target's Attack, so a set
    built around either leaves its own Attack at zero.
    """
    evs, _ = spread_for(
        get_species("Forretress"), 84, "Sturdy", "Leftovers",
        ("Body Press", "Stealth Rock", "Spikes", "Toxic"),
    )
    assert evs["atk"] == 0

    evs, _ = spread_for(
        get_species("Sableye"), 87, "Prankster", "Leftovers",
        ("Foul Play", "Will-O-Wisp", "Recover", "Knock Off"),
    )
    # Knock Off is an ordinary physical move, so this set keeps its Attack.
    assert evs["atk"] == 85

    evs, _ = spread_for(
        get_species("Sableye"), 87, "Prankster", "Leftovers",
        ("Foul Play", "Will-O-Wisp", "Recover", "Taunt"),
    )
    assert evs["atk"] == 0


def test_an_ordinary_physical_move_keeps_attack():
    """Guard against the zeroing rule firing too eagerly."""
    evs, ivs = spread_for(
        get_species("Great Tusk"), 77, "Protosynthesis", "Leftovers",
        ("Bulk Up", "Close Combat", "Earthquake", "Rapid Spin"),
    )
    assert evs["atk"] == 85 and ivs["atk"] == 31


def test_fixed_damage_moves_dont_count_either():
    evs, _ = spread_for(
        get_species("Blissey"), 79, "Natural Cure", "Heavy-Duty Boots",
        ("Seismic Toss", "Soft-Boiled", "Calm Mind", "Shadow Ball"),
    )
    assert evs["atk"] == 0


def test_trick_room_and_gyro_ball_zero_speed():
    for move in ("Trick Room", "Gyro Ball"):
        evs, ivs = spread_for(
            get_species("Magnezone"), 84, "Analytic", "Leftovers",
            (move, "Flash Cannon", "Thunderbolt", "Volt Switch"),
        )
        assert evs["spe"] == 0 and ivs["spe"] == 0, move


def test_boots_stop_the_stealth_rock_hp_tuning():
    """Heavy-Duty Boots means hazard chip never lands, so HP stays untouched."""
    volcarona = get_species("Volcarona")  # 4x weak to Rock
    with_boots, _ = spread_for(
        volcarona, 72, "Flame Body", "Heavy-Duty Boots",
        ("Quiver Dance", "Fiery Dance", "Bug Buzz", "Giga Drain"),
    )
    assert with_boots["hp"] == 85


def test_hp_tuning_only_ever_walks_downward():
    """It subtracts in fours from 85, so these are the only legal values."""
    index = SetIndex.load()
    seen = set()
    for sets in list(index.all())[:120]:
        for role in sets.roles:
            item = role.items[0] if role.items else ""
            ability = role.abilities[0] if role.abilities else ""
            evs, _ = spread_for(sets.species, sets.level, ability, item, role.moves)
            seen.add(evs["hp"])
    assert seen <= {85, 81, 77, 73, 69, 65, 61, 57}, sorted(seen)
    assert all(v % 4 == 1 for v in seen), sorted(seen)


def test_stats_for_is_consistent_with_the_spread():
    stats = stats_for(
        "Great Tusk", 77, "Protosynthesis", "Leftovers",
        ("Bulk Up", "Close Combat", "Earthquake", "Rapid Spin"),
    )
    assert set(stats) == {"hp", "atk", "def", "spa", "spd", "spe"}
    assert all(v > 0 for v in stats.values())


# ---------------------------------------------------------- type chart


def test_effectiveness_reads_the_right_way_round():
    # Rock is not very effective against Ground.
    assert effectiveness("ROCK", ("GROUND",)) == 0.5
    # But doubly effective against Flying/Bug.
    assert effectiveness("ROCK", ("FLYING", "BUG")) == 4
    # Ground is immune to Electric.
    assert effectiveness("ELECTRIC", ("GROUND",)) == 0


def test_effectiveness_steps_match_the_multiplier():
    assert effectiveness_steps("ROCK", ("FLYING", "BUG")) == 2
    assert effectiveness_steps("ROCK", ("FIRE",)) == 1
    assert effectiveness_steps("ROCK", ("WATER",)) == 0
    assert effectiveness_steps("ROCK", ("GROUND",)) == -1
    assert effectiveness_steps("ROCK", ("GROUND", "FIGHTING")) == -2


def test_to_id_strips_everything_awkward():
    assert to_id("Great Tusk") == "greattusk"
    assert to_id("Ting-Lu") == "tinglu"
    assert to_id("Farfetch'd") == "farfetchd"
    assert to_id("Porygon-Z") == "porygonz"
    assert to_id("Will-O-Wisp") == "willowisp"
    assert to_id("Mr. Mime") == "mrmime"
