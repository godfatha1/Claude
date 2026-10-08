"""Check our stat maths against teams the real simulator generated.

The whole point of this layer is being exactly right about the opponent's stats.
If the arithmetic is right, an opponent outspeeding us when it shouldn't is proof
of a Choice Scarf; if it's a little off, it's a hunch. So rather than trust the
port, we generate real teams with the simulator itself and diff every number.

One thing to keep straight. Our live set data tracks the current ladder, while an
installed simulator release is a frozen snapshot, so the two drift apart every
time the format gets rebalanced — levels move, roles get added and dropped. That
drift is normal and is not a bug in this code. So the tests here are split:

- **Arithmetic** is checked against the simulator's own teams, feeding in the
  level the simulator used. These must pass exactly, always. They're testing our
  port of the generator's rules, and nothing about them depends on which version
  of the set data is in play.
- **Agreement with the snapshot's set data** is checked separately, against the
  sets bundled inside the same simulator release. These must pass exactly too,
  because there the versions match by construction.
- **Drift against live data** is reported, not asserted.

Regenerate the fixture with `scripts/dump_simulator_teams.sh 400` (needs node).
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

from assistant.data.dex import battle_forme, compute_stat, compute_stats, to_id
from assistant.data.dex import species as get_species
from assistant.data.sets import SetIndex, spread_for

FIXTURE = Path(__file__).parent / "fixtures" / "simulator_teams.json"


@pytest.fixture(scope="module")
def fixture() -> dict:
    if not FIXTURE.exists():
        pytest.skip(f"no fixture at {FIXTURE} — run scripts/dump_simulator_teams.sh")
    return json.loads(FIXTURE.read_text())


@pytest.fixture(scope="module")
def sim_sets(fixture) -> list[dict]:
    return fixture["teams"]


@pytest.fixture(scope="module")
def snapshot_sets(fixture) -> dict:
    """The set data bundled in the same simulator release that made the teams."""
    return fixture["sets"]


@pytest.fixture(scope="module")
def index() -> SetIndex:
    return SetIndex.load()


# ------------------------------------------------- the fixture itself


def test_fixture_is_substantial(sim_sets):
    assert len(sim_sets) >= 500, "too few sets to say anything"
    assert len({s["speciesId"] for s in sim_sets}) >= 200


def test_nature_is_always_neutral(sim_sets):
    """Our stat maths skips the nature step, so this has to hold."""
    assert {s["nature"] for s in sim_sets} == {"Serious"}


# ------------------------------------- arithmetic: must always be exact


def test_spreads_match_the_simulator(sim_sets):
    """Every EV and IV we predict matches what the simulator handed out."""
    mismatches = []
    for entry in sim_sets:
        sp = get_species(entry["speciesId"])
        evs, ivs = spread_for(
            sp,
            entry["level"],
            entry["ability"],
            entry["item"],
            tuple(entry["moves"]),
        )
        for stat in ("hp", "atk", "def", "spa", "spd", "spe"):
            if evs[stat] != entry["evs"][stat] or ivs[stat] != entry["ivs"][stat]:
                mismatches.append(
                    f"{entry['species']} ({entry.get('role')}) {stat}: "
                    f"ours {evs[stat]}/{ivs[stat]} vs sim "
                    f"{entry['evs'][stat]}/{entry['ivs'][stat]} "
                    f"[item {entry['item']}, ability {entry['ability']}, "
                    f"moves {','.join(entry['moves'])}]"
                )

    if mismatches:
        shown = "\n  ".join(mismatches[:25])
        pytest.fail(
            f"{len(mismatches)} spread mismatches across {len(sim_sets)} sets:\n  {shown}"
        )


def test_final_stats_match_the_simulator(sim_sets):
    """The stats themselves, not just the spread that feeds them."""
    bad = []
    for entry in sim_sets:
        sp = get_species(entry["speciesId"])
        evs, ivs = spread_for(
            sp, entry["level"], entry["ability"], entry["item"], tuple(entry["moves"])
        )
        ours = compute_stats(sp.base_stats, entry["level"], evs, ivs)
        theirs = compute_stats(sp.base_stats, entry["level"], entry["evs"], entry["ivs"])
        if ours != theirs:
            bad.append(f"{entry['species']}: {ours} vs {theirs}")

    assert not bad, "stat mismatches:\n  " + "\n  ".join(bad[:20])


def test_speed_is_exact_at_the_level_the_simulator_used(sim_sets):
    """Speed is the number scarf detection rests on, so check it hard.

    A set either runs the usual spread or deliberately zeroes Speed for Trick
    Room or Gyro Ball. Both numbers have to land exactly, which is what makes
    turn order usable as evidence rather than a hint.
    """
    wrong = []
    for entry in sim_sets:
        sp = get_species(entry["speciesId"])
        level = entry["level"]
        actual = compute_stats(sp.base_stats, level, entry["evs"], entry["ivs"])["spe"]
        zeroed = entry["evs"]["spe"] == 0
        expected = compute_stat(
            sp.base_speed, 0 if zeroed else 31, 0 if zeroed else 85, level, is_hp=False
        )
        if actual != expected:
            wrong.append(
                f"{entry['species']} (spe EV {entry['evs']['spe']}): "
                f"sim {actual} vs ours {expected}"
            )
    assert not wrong, "speed mismatches:\n  " + "\n  ".join(sorted(set(wrong))[:20])


# ------------------------- agreement with the snapshot's own set data


def _normalise_snapshot(snapshot_sets: dict) -> dict:
    """Reshape the simulator's own set data into the shape our index uses.

    The two sources are laid out differently, and the difference matters:

    - The simulator keys by id (`greattusk`) and holds a `sets` list whose
      entries carry a `movepool`. It publishes **no items** — the generator picks
      those at runtime from the role, ability and moves.
    - The pkmn data we use keys by display name and holds a `roles` map whose
      entries carry `moves` *and* an item pool, which they derived by running the
      generator many times and recording what came out.

    So the pkmn data is strictly more useful for inference, since per-role item
    pools are exactly what narrows an opponent's set. But being derived, it can
    only be as complete as the sampling behind it, which is why inference must
    treat these pools as a strong prior and never as a hard constraint.
    """
    out = {}
    for key, entry in snapshot_sets.items():
        roles: dict[str, dict[str, set[str]]] = {}
        for role in entry.get("sets", ()):
            # A handful of species carry two different sets under one role name.
            # The live data unions their pools, so union them here as well —
            # anything else would make the comparison lie.
            slot = roles.setdefault(
                role["role"], {"moves": set(), "abilities": set(), "teraTypes": set()}
            )
            slot["moves"] |= {to_id(m) for m in role.get("movepool", ())}
            slot["abilities"] |= {to_id(a) for a in role.get("abilities", ())}
            slot["teraTypes"] |= {to_id(t) for t in role.get("teraTypes", ())}
        out[to_id(key)] = {"level": int(entry.get("level", 80)), "roles": roles}
    return out


@pytest.fixture(scope="module")
def snapshot(snapshot_sets) -> dict:
    return _normalise_snapshot(snapshot_sets)


def _lookup(snapshot: dict, species_id: str, item: str | None = None) -> dict | None:
    """Find an entry the way the live index does.

    Three steps, in order: resolve an item-led forme (Zacian plus a Rusted Sword
    is really Zacian-Crowned, and the generator reports the base name), then try
    the exact species, then fall back to the base species for cosmetic formes.
    """
    resolved = battle_forme(species_id, item)
    if resolved in snapshot:
        return snapshot[resolved]
    if species_id in snapshot:
        return snapshot[species_id]
    try:
        base = get_species(species_id).base_id
    except KeyError:
        return None
    return snapshot.get(base)


def test_levels_match_the_snapshot_set_data(sim_sets, snapshot):
    """Levels come straight out of the set data, so they must agree exactly."""
    wrong = []
    for entry in sim_sets:
        found = _lookup(snapshot, entry["speciesId"], entry.get("item"))
        if found is None:
            wrong.append(f"{entry['species']}: no entry in the snapshot's set data")
            continue
        if found["level"] != entry["level"]:
            wrong.append(
                f"{entry['species']}: set data says {found['level']} "
                f"but the sim used {entry['level']}"
            )
    assert not wrong, "level mismatches:\n  " + "\n  ".join(sorted(set(wrong))[:20])


def test_every_species_resolves_to_set_data(sim_sets, snapshot):
    """No species the simulator can hand out may be unresolvable.

    Cosmetic and stat-identical formes (Gastrodon-East, Minior-Blue,
    Maushold-Four) arrive under a forme name and are filed under the base, so
    this is really a test of that fallback.
    """
    unresolved = sorted(
        {e["species"] for e in sim_sets if _lookup(snapshot, e["speciesId"], e.get("item")) is None}
    )
    assert not unresolved, f"{len(unresolved)} species didn't resolve: {unresolved[:20]}"


def test_role_pools_cover_what_the_simulator_actually_uses(sim_sets, snapshot):
    """A role's move and ability pools must contain everything it hands out.

    Items aren't checked here because the simulator's own data doesn't publish
    them per role; that gap is what the live pkmn data fills in.
    """
    gaps: Counter[str] = Counter()
    for entry in sim_sets:
        found = _lookup(snapshot, entry["speciesId"], entry.get("item"))
        role_name = entry.get("role")
        if found is None or not role_name:
            continue
        role = found["roles"].get(role_name)
        if role is None:
            gaps[f"{entry['species']}: no role {role_name!r}"] += 1
            continue
        if entry["ability"] and to_id(entry["ability"]) not in role["abilities"]:
            gaps[f"{entry['species']}/{role_name}: ability {entry['ability']}"] += 1
        for mv in entry["moves"]:
            if to_id(mv) not in role["moves"]:
                gaps[f"{entry['species']}/{role_name}: move {mv}"] += 1

    if gaps:
        shown = "\n  ".join(f"{k} (x{v})" for k, v in gaps.most_common(25))
        pytest.fail(
            f"{len(gaps)} gaps between the snapshot's set data and its own teams:\n  {shown}"
        )


# ------------------------------------------- drift: reported, not asserted


def test_report_drift_against_live_set_data(fixture, index, snapshot, capsys):
    """Say how far the live set data has moved from this simulator snapshot.

    This never fails. Our live data tracking the current ladder is the point —
    it's what we want when advising on live games. This just makes the size of
    the gap visible so a surprising test failure elsewhere has context.
    """
    level_drift, missing_here, extra_here = [], [], []

    snapshot_ids = set(snapshot)
    live_ids = {s.id for s in index.all()}

    for species_id, entry in snapshot.items():
        live = index.get(species_id)
        if live is None:
            missing_here.append(species_id)
            continue
        if live.level != entry["level"]:
            level_drift.append(
                f"{species_id}: live {live.level} vs snapshot {entry['level']}"
            )

    extra_here = sorted(live_ids - snapshot_ids)

    print(f"\nsimulator snapshot: {fixture.get('simulatorVersion', 'unknown')}")
    print(f"species — live {len(live_ids)}, snapshot {len(snapshot_ids)}")
    print(f"level changes since the snapshot: {len(level_drift)}")
    for line in sorted(level_drift)[:15]:
        print(f"  {line}")
    if missing_here:
        print(f"in the snapshot but not live ({len(missing_here)}): {missing_here[:10]}")
    if extra_here:
        print(f"live but not in the snapshot ({len(extra_here)}): {extra_here[:10]}")

    assert True  # informational only
