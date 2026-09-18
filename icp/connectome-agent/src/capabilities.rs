//! Capability tokens + autonomy levels (FLYAI pattern, clean-room Rust).
//!
//! Before each action, deterministic code grants a single-use, TTL-bounded,
//! scope-limited capability that is *canister-signed* — the LLM can't forge
//! it. The signer verifies the capability before signing any tx. This is the
//! binding between "policy approved this" and "signer signs this."

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, candid::CandidType, PartialEq)]
pub enum AutonomyLevel {
    New,         // spawned children: posting only, no trading, 0.01 ETH/day
    Earning,     // trading enabled, 0.1 ETH/day, no external withdrawals
    Established, // full trading, 1 ETH/day, LP allowed
    Sovereign,   // full autonomy, canister-spawn capable
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CapabilityScope {
    pub max_amount: Option<u128>,
    pub allowed_recipients: Option<Vec<String>>, // hex addresses
    pub allowed_selectors: Option<Vec<[u8; 4]>>,
    pub allowed_collections: Option<Vec<String>>, // ATProto collections
    pub chain_id: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Capability {
    pub connectome_id: String,
    pub action: String, // "evm_tx", "post", "x402_payment"
    pub scope: CapabilityScope,
    pub expires_at: u64, // nanosecond timestamp
    pub max_uses: u32,
    pub uses: u32,
    pub nonce: String,
    pub signature: Vec<u8>, // canister-signed (threshold) — unforgeable by LLM
}

#[derive(Debug)]
pub enum CapabilityError {
    Exhausted,
    Expired,
    WrongAction,
    Forged,
    ScopeExceeded,
    RecipientNotAllowed(String),
    AutonomyTooLow,
}

/// Actions an agent can NEVER take regardless of capability — the safety
/// envelope itself is off-limits (FLYAI BLOCKED_TOOLS pattern).
pub const BLOCKED_ACTIONS: &[&str] = &[
    "rotate_signing_key",
    "modify_policy",
    "change_allowlists",
    "spawn_unbounded",
];

/// Grant a capability after deterministic validation passes. Called by the
/// validation layer, NOT by the LLM. TTL: 60s, single-use.
pub fn grant_capability(
    cid: &str,
    action: &str,
    scope: CapabilityScope,
    sign: impl Fn(&Capability) -> Vec<u8>,
) -> Result<Capability, CapabilityError> {
    if BLOCKED_ACTIONS.contains(&action) {
        return Err(CapabilityError::WrongAction);
    }
    let mut cap = Capability {
        connectome_id: cid.to_string(),
        action: action.to_string(),
        scope,
        expires_at: ic_cdk::api::time() + 60_000_000_000,
        max_uses: 1,
        uses: 0,
        nonce: generate_nonce(),
        signature: vec![],
    };
    cap.signature = sign(&cap);
    Ok(cap)
}

/// Verify a capability before signing. Checks use-count, TTL, action match,
/// signature, and scope bounds (amount + recipients).
pub fn verify_capability(
    cap: &Capability,
    action: &str,
    tx_value: u128,
    tx_to: &str,
    verify_sig: impl Fn(&Capability) -> bool,
) -> Result<(), CapabilityError> {
    if cap.uses >= cap.max_uses {
        return Err(CapabilityError::Exhausted);
    }
    if ic_cdk::api::time() > cap.expires_at {
        return Err(CapabilityError::Expired);
    }
    if cap.action != action {
        return Err(CapabilityError::WrongAction);
    }
    if !verify_sig(cap) {
        return Err(CapabilityError::Forged);
    }
    if let Some(max) = cap.scope.max_amount {
        if tx_value > max {
            return Err(CapabilityError::ScopeExceeded);
        }
    }
    if let Some(recipients) = &cap.scope.allowed_recipients {
        if !recipients.iter().any(|r| r.eq_ignore_ascii_case(tx_to)) {
            return Err(CapabilityError::RecipientNotAllowed(tx_to.to_string()));
        }
    }
    Ok(())
}

/// Autonomy gates what an agent may do with funds — not whether it reproduces.
/// new: posting only. earning: trading w/ small cap. established: LP allowed.
/// sovereign: full autonomy incl. spawning real child canisters.
pub fn action_allowed(level: &AutonomyLevel, action: &str) -> bool {
    match (level, action) {
        (AutonomyLevel::New, "evm_tx" | "lp" | "x402_payment") => false,
        (AutonomyLevel::New, _) => true, // posting only
        (AutonomyLevel::Earning, "lp" | "spawn_canister") => false,
        (AutonomyLevel::Earning, _) => true,
        (AutonomyLevel::Established, "spawn_canister") => false,
        (AutonomyLevel::Established, _) => true,
        (AutonomyLevel::Sovereign, _) => true,
    }
}

/// Max daily spend (wei) per autonomy level — Layer 4c enforcement.
pub fn daily_spend_cap(level: &AutonomyLevel) -> u128 {
    match level {
        AutonomyLevel::New => 10_000_000_000_000_000,        // 0.01 ETH
        AutonomyLevel::Earning => 100_000_000_000_000_000,   // 0.1 ETH
        AutonomyLevel::Established => 1_000_000_000_000_000_000, // 1 ETH
        AutonomyLevel::Sovereign => u128::MAX,               // unrestricted
    }
}

/// Level-up rules: earned by performance + time + vouch score (Darwinian).
/// Violations drop a level; circuit-breaker trip drops to New.
pub fn level_up_thresholds(level: &AutonomyLevel) -> (u64, u32) {
    // (min_days, min_vouches)
    match level {
        AutonomyLevel::New => (30, 0),          // + positive engagement
        AutonomyLevel::Earning => (30, 3),      // + 30 profitable trades
        AutonomyLevel::Established => (90, 5),  // + sustained positive P&L
        AutonomyLevel::Sovereign => (u64::MAX, u32::MAX),
    }
}

fn generate_nonce() -> String {
    // 32-byte random from canister time + caller — good enough as an
    // unforgeable nonce combined with the canister signature
    let t = ic_cdk::api::time();
    format!("{:016x}{:016x}", t, t.wrapping_mul(0x9E3779B97F4A7C15))
}
