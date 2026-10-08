//! Browser-side search.
//!
//! The whole engine runs on the phone, so a battle never leaves the device and
//! there's no server to deploy or keep running.
//!
//! The boundary takes a plain object rather than the engine's own serialized
//! string. That string packs 29 comma-separated fields per Pokémon and another
//! 29 per side, so building it by hand in JavaScript would be a steady source of
//! silent off-by-one bugs. Doing the conversion here instead puts it next to the
//! types, where the compiler checks it.

use std::str::FromStr;
use std::time::Duration;

use poke_engine::choices::{Choices, MOVES};
use poke_engine::engine::abilities::Abilities;
use poke_engine::engine::items::Items;
use poke_engine::engine::state::MoveChoice;
use poke_engine::mcts::{perform_mcts, MctsSideResult};
use poke_engine::pokemon::PokemonName;
use poke_engine::engine::state::{Terrain, Weather};
use poke_engine::state::{
    Move, Pokemon, PokemonIndex, PokemonMoves, PokemonNature, PokemonStatus, PokemonType, Side,
    SideConditions, SidePokemon, State, StateTerrain, StateTrickRoom, StateWeather,
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------- input shape

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct InMon {
    id: String,
    level: i8,
    types: Vec<String>,
    hp: i16,
    maxhp: i16,
    ability: String,
    item: String,
    /// hp, atk, def, spa, spd, spe
    stats: Vec<i16>,
    status: String,
    tera_type: String,
    terastallized: bool,
    weight: f32,
    /// Move ids. Fewer than four is fine; the rest are filled in as empty.
    moves: Vec<String>,
    /// Remaining PP, matched to `moves` by position. Defaults to full.
    pp: Vec<i8>,
    /// Move ids currently unusable, e.g. locked out by a Choice item.
    disabled: Vec<String>,
    rest_turns: i8,
    sleep_turns: i8,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct InSide {
    active: usize,
    pokemon: Vec<InMon>,
    /// atk, def, spa, spd, spe, accuracy, evasion
    boosts: Vec<i8>,
    stealth_rock: i8,
    spikes: i8,
    toxic_spikes: i8,
    sticky_web: i8,
    reflect: i8,
    light_screen: i8,
    aurora_veil: i8,
    tailwind: i8,
    safeguard: i8,
    toxic_count: i8,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct InState {
    ours: InSide,
    theirs: InSide,
    weather: String,
    weather_turns: i8,
    terrain: String,
    terrain_turns: i8,
    trick_room: bool,
    trick_room_turns: i8,
}

// --------------------------------------------------------------- output shape

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ranked {
    /// What to click, in the same wording the client uses.
    choice: String,
    /// How much of the search went here. This is the engine's own confidence.
    share: f32,
    /// Average outcome, 0 to 1, where 1 is a win.
    value: f32,
    visits: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchOut {
    ours: Vec<Ranked>,
    theirs: Vec<Ranked>,
    total_visits: u32,
    /// Milliseconds the search actually took, for pacing the next one.
    elapsed_ms: u32,
}

// ------------------------------------------------------------------ building

fn parse_type(name: &str) -> PokemonType {
    PokemonType::from_str(name).unwrap_or(PokemonType::TYPELESS)
}

fn build_mon(m: &InMon) -> Result<Pokemon, String> {
    let id = PokemonName::from_str(&m.id).map_err(|_| format!("unknown species {:?}", m.id))?;

    let t0 = m.types.first().map(|s| parse_type(s)).unwrap_or(PokemonType::TYPELESS);
    let t1 = m.types.get(1).map(|s| parse_type(s)).unwrap_or(PokemonType::TYPELESS);

    let ability = Abilities::from_str(&m.ability).unwrap_or(Abilities::NONE);
    let item = Items::from_str(&m.item).unwrap_or(Items::NONE);
    let status = PokemonStatus::from_str(&m.status).unwrap_or(PokemonStatus::NONE);

    // Random battles always use a neutral nature and a fixed spread, and the
    // caller has already turned those into final stats, so EVs here only need to
    // be self-consistent — nothing downstream reads them for this format.
    let stat = |i: usize, fallback: i16| m.stats.get(i).copied().unwrap_or(fallback);

    let mut moves = PokemonMoves {
        m0: Move::default(),
        m1: Move::default(),
        m2: Move::default(),
        m3: Move::default(),
    };
    for (i, move_id) in m.moves.iter().take(4).enumerate() {
        let choice = Choices::from_str(move_id).unwrap_or(Choices::NONE);
        let built = Move {
            id: choice,
            disabled: m.disabled.iter().any(|d| d == move_id),
            pp: m.pp.get(i).copied().unwrap_or(16),
            choice: MOVES.get(&choice).cloned().unwrap_or_default(),
        };
        match i {
            0 => moves.m0 = built,
            1 => moves.m1 = built,
            2 => moves.m2 = built,
            _ => moves.m3 = built,
        }
    }

    Ok(Pokemon {
        id,
        level: if m.level > 0 { m.level } else { 80 },
        types: (t0, t1),
        base_types: (t0, t1),
        hp: m.hp,
        maxhp: if m.maxhp > 0 { m.maxhp } else { stat(0, 1) },
        ability,
        base_ability: ability,
        item,
        nature: PokemonNature::SERIOUS,
        evs: (85, 85, 85, 85, 85, 85),
        attack: stat(1, 100),
        defense: stat(2, 100),
        special_attack: stat(3, 100),
        special_defense: stat(4, 100),
        speed: stat(5, 100),
        status,
        rest_turns: m.rest_turns,
        sleep_turns: m.sleep_turns,
        weight_kg: m.weight,
        terastallized: m.terastallized,
        tera_type: if m.tera_type.is_empty() {
            PokemonType::TYPELESS
        } else {
            parse_type(&m.tera_type)
        },
        moves,
        ..Default::default()
    })
}

fn index_of(i: usize) -> PokemonIndex {
    match i {
        0 => PokemonIndex::P0,
        1 => PokemonIndex::P1,
        2 => PokemonIndex::P2,
        3 => PokemonIndex::P3,
        4 => PokemonIndex::P4,
        _ => PokemonIndex::P5,
    }
}

fn build_side(s: &InSide) -> Result<Side, String> {
    let mut side = Side::default();

    // The engine always holds six slots. Anything we haven't seen yet stays an
    // empty slot rather than a guess, so the search treats it as unknown instead
    // of as a Pokémon that cannot act.
    let mut slots: [Pokemon; 6] = Default::default();
    for (i, m) in s.pokemon.iter().take(6).enumerate() {
        slots[i] = build_mon(m)?;
    }
    side.pokemon = SidePokemon { pkmn: slots };
    side.active_index = index_of(s.active.min(5));

    side.side_conditions = SideConditions {
        stealth_rock: s.stealth_rock,
        spikes: s.spikes,
        toxic_spikes: s.toxic_spikes,
        sticky_web: s.sticky_web,
        reflect: s.reflect,
        light_screen: s.light_screen,
        aurora_veil: s.aurora_veil,
        tailwind: s.tailwind,
        safeguard: s.safeguard,
        toxic_count: s.toxic_count,
        ..Default::default()
    };

    let boost = |i: usize| s.boosts.get(i).copied().unwrap_or(0);
    side.attack_boost = boost(0);
    side.defense_boost = boost(1);
    side.special_attack_boost = boost(2);
    side.special_defense_boost = boost(3);
    side.speed_boost = boost(4);
    side.accuracy_boost = boost(5);
    side.evasion_boost = boost(6);

    Ok(side)
}

fn build_state(input: &InState) -> Result<State, String> {
    Ok(State {
        side_one: build_side(&input.ours)?,
        side_two: build_side(&input.theirs)?,
        weather: StateWeather {
            weather_type: Weather::from_str(&input.weather).unwrap_or(Weather::NONE),
            turns_remaining: input.weather_turns,
        },
        terrain: StateTerrain {
            terrain_type: Terrain::from_str(&input.terrain).unwrap_or(Terrain::NONE),
            turns_remaining: input.terrain_turns,
        },
        trick_room: StateTrickRoom {
            active: input.trick_room,
            turns_remaining: input.trick_room_turns,
        },
        ..Default::default()
    })
}

fn rank(side: &Side, results: &[MctsSideResult], total: u32) -> Vec<Ranked> {
    let mut out: Vec<Ranked> = results
        .iter()
        .map(|r| Ranked {
            choice: match &r.move_choice {
                MoveChoice::Switch(_) => format!("switch {}", r.move_choice.to_string(side)),
                other => other.to_string(side),
            },
            share: if total > 0 { r.visits as f32 / total as f32 } else { 0.0 },
            value: if r.visits > 0 { r.total_score / r.visits as f32 } else { 0.0 },
            visits: r.visits,
        })
        .collect();
    out.sort_by(|a, b| b.visits.cmp(&a.visits));
    out
}

// ---------------------------------------------------------------- public API

/// Search one position and return every legal action, ranked.
///
/// Cap the work with `iterations` to keep results repeatable across devices, or
/// with `duration_ms` to keep the panel responsive on a slow phone. Iterations
/// wins when both are given.
#[wasm_bindgen]
pub fn search(state_json: &str, duration_ms: u32, iterations: u32) -> Result<String, JsValue> {
    let input: InState =
        serde_json::from_str(state_json).map_err(|e| JsValue::from_str(&format!("bad state: {e}")))?;
    let mut state = build_state(&input).map_err(|e| JsValue::from_str(&e))?;

    let (ours, theirs) = state.root_get_all_options();

    // Nothing to decide, so don't spend the battery proving it.
    let iters = if ours.len() <= 1 { 100 } else { iterations };

    #[cfg(target_arch = "wasm32")]
    let started = web_time::Instant::now();
    #[cfg(not(target_arch = "wasm32"))]
    let started = std::time::Instant::now();

    let result = perform_mcts(
        &mut state,
        ours,
        theirs,
        Duration::from_millis(duration_ms as u64),
        iters,
    );

    let total = result.iteration_count;
    let out = SearchOut {
        ours: rank(&state.side_one, &result.s1, total),
        theirs: rank(&state.side_two, &result.s2, total),
        total_visits: total,
        elapsed_ms: started.elapsed().as_millis() as u32,
    };
    serde_json::to_string(&out).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// List the legal actions for a position without searching it.
///
/// Used to render the panel immediately, before any thinking has happened, so
/// the page is never blank while it works.
#[wasm_bindgen]
pub fn options(state_json: &str) -> Result<String, JsValue> {
    let input: InState =
        serde_json::from_str(state_json).map_err(|e| JsValue::from_str(&format!("bad state: {e}")))?;
    let mut state = build_state(&input).map_err(|e| JsValue::from_str(&e))?;
    let (ours, _) = state.root_get_all_options();
    let labels: Vec<String> = ours
        .iter()
        .map(|c| match c {
            MoveChoice::Switch(_) => format!("switch {}", c.to_string(&state.side_one)),
            other => other.to_string(&state.side_one),
        })
        .collect();
    serde_json::to_string(&labels).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Check a state is well formed, so the panel can fail loudly rather than quietly.
#[wasm_bindgen]
pub fn check(state_json: &str) -> Result<String, JsValue> {
    let input: InState =
        serde_json::from_str(state_json).map_err(|e| JsValue::from_str(&format!("bad state: {e}")))?;
    let mut state = build_state(&input).map_err(|e| JsValue::from_str(&e))?;
    let (ours, theirs) = state.root_get_all_options();
    Ok(format!("ok: {} ours, {} theirs", ours.len(), theirs.len()))
}
