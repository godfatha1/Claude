//! Browser-side search.
//!
//! Thin wrapper over the engine so the whole thing runs on the phone: nothing
//! about a battle leaves the device, and there's no server to deploy or keep up.
use std::time::Duration;

use poke_engine::engine::state::MoveChoice;
use poke_engine::mcts::perform_mcts;
use poke_engine::state::{Side, State};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
pub struct Option_ {
    pub choice: String,
    pub visits: u32,
    pub score: f32,
    /// Share of the search spent on this option. The engine's own confidence.
    pub share: f32,
    /// Average value of the option, between 0 and 1.
    pub value: f32,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub ours: Vec<Option_>,
    pub theirs: Vec<Option_>,
    pub total_visits: u32,
}

fn choice_label(side: &Side, choice: &MoveChoice) -> String {
    match choice {
        MoveChoice::Switch(_) => format!("switch {}", choice.to_string(side)),
        _ => choice.to_string(side),
    }
}

fn rank(side: &Side, results: &[poke_engine::mcts::MctsSideResult], total: u32) -> Vec<Option_> {
    let mut out: Vec<Option_> = results
        .iter()
        .map(|r| Option_ {
            choice: choice_label(side, &r.move_choice),
            visits: r.visits,
            score: r.total_score,
            share: if total > 0 { r.visits as f32 / total as f32 } else { 0.0 },
            value: if r.visits > 0 { r.total_score / r.visits as f32 } else { 0.0 },
        })
        .collect();
    out.sort_by(|a, b| b.visits.cmp(&a.visits));
    out
}

/// Search a position and return every legal action, ranked.
///
/// Pass `iterations` to cap the work by position count, which keeps results
/// repeatable across devices, or `duration_ms` to cap it by wall clock, which
/// keeps the panel responsive on a slow phone. Iterations wins if both are set.
#[wasm_bindgen]
pub fn search(state_str: &str, duration_ms: u32, iterations: u32) -> Result<String, JsValue> {
    let mut state: State = State::deserialize(state_str);
    let (ours, theirs) = state.root_get_all_options();

    let mut iters = iterations;
    if ours.len() <= 1 {
        iters = 100; // nothing to decide; don't burn the battery on it
    }

    let result = perform_mcts(
        &mut state,
        ours,
        theirs,
        Duration::from_millis(duration_ms as u64),
        iters,
    );

    let total = result.iteration_count;
    let payload = SearchResult {
        ours: rank(&state.side_one, &result.s1, total),
        theirs: rank(&state.side_two, &result.s2, total),
        total_visits: total,
    };
    serde_json::to_string(&payload).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Check a state string parses, so the panel can fail loudly rather than quietly.
#[wasm_bindgen]
pub fn check_state(state_str: &str) -> Result<String, JsValue> {
    let mut state: State = State::deserialize(state_str);
    let (ours, _) = state.root_get_all_options();
    Ok(format!("{} options", ours.len()))
}
