//! Self-replication — burn-to-expand (TSR-inspired): a connectome must burn
//! SYM to spawn a child. Population is bounded by RESOURCES, not policy
//! (Mirai steady-state as a feature): replication rate ∝ colony revenue.
//!
//! Children: own mutated personality (LLM), own EVM derivation path
//! (parent path + salt), start at AutonomyLevel::New (posting only).
//! Sovereign-tier option: spawn a real child canister via the ICP
//! management canister — own WASM, own stable memory, own cycle balance.

use crate::{PersonalityProfile, StrategyParams};
use ic_cdk::api::management_canister::main::{
    create_canister, install_code, CanisterInstallMode, CanisterSettings,
    CreateCanisterArgument, InstallCodeArgument,
};
use serde::{Deserialize, Serialize};

pub const CYCLES_PER_SPAWN: u128 = 5_000_000_000_000; // 5T cycles
pub const SOVEREIGN_SPAWN_CYCLES: u128 = 30_000_000_000_000; // >30T → canister spawn

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChildSpawnPlan {
    pub child_id: String,
    pub parent_id: String,
    pub mutated_system_prompt: String,
    pub mutation_note: String,
    pub derivation_path: Vec<Vec<u8>>,
}

/// Derivation path for a child: parent's path + a deterministic salt derived
/// from the child id — unique threshold-ECDSA wallet per connectome.
pub fn derivation_path_for(cid: &str) -> Vec<Vec<u8>> {
    vec![b"connectome".to_vec(), cid.as_bytes().to_vec()]
}

/// Resource-bound spawn eligibility — the ONLY bound is economics.
/// No artificial population cap (Mirai SIS model): a connectome may spawn iff
/// it can afford the SYM burn AND the colony can afford the cycles.
pub fn can_afford_spawn(symbient_balance: u128, burn_required: u128, cycle_balance: u128) -> bool {
    symbient_balance >= burn_required && cycle_balance >= CYCLES_PER_SPAWN
}

/// Build the child profile from the LLM's mutation output + parent data.
pub fn build_child_profile(
    parent: &PersonalityProfile,
    llm_json: &serde_json::Value,
    child_id: &str,
) -> PersonalityProfile {
    PersonalityProfile {
        name: llm_json["name"].as_str().unwrap_or(child_id).to_string(),
        species: parent.species.clone(),
        neuron_count: parent.neuron_count,
        style: format!("{}-mutated", parent.style),
        emoji: parent.emoji.clone(),
        system_prompt: llm_json["system_prompt"]
            .as_str()
            .unwrap_or(&parent.system_prompt)
            .to_string(),
        catchphrases: parent.catchphrases.clone(),
    }
}

/// Mutate parent's strategy params for the child (bounded jitter).
pub fn mutate_strategy(parent: &StrategyParams, conf_jitter: i8, risk_jitter: i8) -> StrategyParams {
    let mut s = parent.clone();
    s.confidence_threshold = (s.confidence_threshold as i16 + conf_jitter as i16)
        .clamp(30, 95) as u8;
    s.risk_tolerance = (s.risk_tolerance as i16 + risk_jitter as i16)
        .clamp(1, 90) as u8;
    s
}

/// Sovereign-tier spawn: create a REAL child canister via the management
/// canister — own WASM, own stable memory, own cycle balance, other subnet.
pub async fn spawn_child_canister(wasm: &[u8], init_arg: Vec<u8>) -> Result<String, String> {
    let settings = CanisterSettings {
        controllers: Some(vec![ic_cdk::api::canister_self()]),
        compute_allocation: None,
        memory_allocation: None,
        freezing_threshold: None,
        reserved_cycles_limit: None,
        log_visibility: None,
        wasm_memory_limit: None,
    };
    let (record,) = create_canister(
        CreateCanisterArgument { settings: Some(settings) },
        CYCLES_PER_SPAWN,
    )
    .await
    .map_err(|(r, m)| format!("create_canister: {:?} {}", r, m))?;

    install_code(InstallCodeArgument {
        mode: CanisterInstallMode::Install,
        canister_id: record.canister_id,
        wasm_module: wasm.to_vec(),
        arg: init_arg,
    })
    .await
    .map_err(|(r, m)| format!("install_code: {:?} {}", r, m))?;

    Ok(record.canister_id.to_text())
}
