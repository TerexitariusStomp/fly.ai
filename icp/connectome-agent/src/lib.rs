//! connectome-agent — autonomous self-evolving connectome colony on ICP.
//!
//! Architecture: deterministic Rust is authoritative; the LLM only proposes
//! content and parameter changes. All value-moving actions pass through
//! deterministic validation (security.rs) + single-use canister-signed
//! capability tokens (capabilities.rs) before the IcpSigner signs.
//!
//! Cycle 0  — self-sustainability (runway, graceful degradation, self-funding)
//! Cycle 1  — feedback (Bluesky engagement + on-chain P&L)
//! Cycle 2  — event detection (SocialPostLog via eth_getLogs)
//! Cycle 3  — evolution (regime → bandit → LLM → A/B → GA)
//! Cycle 4  — trading (ic-alloy threshold ECDSA → ConnectomeGovernor)
//! Cycle 5  — treasury (idle assets → Aave v3 yield)
//! Cycle 6  — liquidity (Uniswap V3 positions)
//! Cycle 7  — replication (burn-to-expand, resource-bound)
//! Cycle 8+ — posting / social graph / community / research / tokenomics /
//!            sentiment (skipped in reduced mode; everything except
//!            monitoring skipped in hibernation)

mod atproto_icp;
mod evm;
mod git_store;
mod capabilities;
mod evolution;
mod git_gateway;
mod market;
mod personalities;
mod platforms;
mod reliability;
mod replication;
mod security;
mod x402;

use candid::{CandidType, Principal};
use ic_cdk_timers::set_timer_interval;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cell::RefCell;
use std::time::Duration;

use capabilities::AutonomyLevel;
use platforms::ConnectomeIdentity;

/// Arc mainnet — the production chain.
pub const ARC_CHAIN_ID: u64 = 5042001;
/// Arc testnet — dev/e2e target.
pub const ARC_TESTNET_CHAIN_ID: u64 = 5042002;

// ----------------------------------------------------------------------------
// Entropy: wasm32 canisters have no OS RNG. Custom getrandom backends for
// both the 0.2 and 0.3 crate lines — a xorshift64* PRNG seeded from raw_rand
// at init and re-mixed with canister time on every call. Only used where
// per-replica randomness is acceptable (nonces, jitter); never consensus state.
// ----------------------------------------------------------------------------
thread_local! {
    static RNG_STATE: RefCell<u64> = RefCell::new(0x9E3779B97F4A7C15);
}

fn icp_getrandom(dest: &mut [u8]) -> Result<(), getrandom_02::Error> {
    RNG_STATE.with(|s| {
        let mut x = s.borrow_mut();
        for chunk in dest.chunks_mut(8) {
            *x = x.wrapping_add(ic_cdk::api::time());
            *x ^= *x << 13;
            *x ^= *x >> 7;
            *x ^= *x << 17;
            let bytes = x.to_le_bytes();
            chunk.copy_from_slice(&bytes[..chunk.len()]);
        }
    });
    Ok(())
}
getrandom_02::register_custom_getrandom!(icp_getrandom);

/// getrandom 0.3 custom backend — the crate declares this extern symbol;
/// we provide it (0.3 has no register macro).
#[export_name = "__getrandom_v03_custom"]
pub extern "Rust" fn getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), getrandom_03::Error> {
    let buf = unsafe { std::slice::from_raw_parts_mut(dest, len) };
    icp_getrandom(buf).map_err(|_| getrandom_03::Error::UNSUPPORTED)
}

// ============================================================================
// Types
// ============================================================================

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct PersonalityProfile {
    pub name: String,
    pub species: String,
    pub neuron_count: u64,
    pub style: String,
    pub emoji: String,
    pub system_prompt: String,
    pub catchphrases: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct StrategyParams {
    pub confidence_threshold: u8,
    pub risk_tolerance: u8,
    pub post_frequency_minutes: u32,
    pub trade_size_pct: u8,
    pub trade_enabled: bool,
    pub evolution_enabled: bool,
    pub treasury_enabled: bool,
    pub lp_enabled: bool,
    pub tokenomics_enabled: bool,
    pub treasury_idle_threshold: u64,
    pub treasury_gas_reserve: u64,
    pub lp_allocation: u64,
    pub burn_pct: u8,
    pub airdrop_amount: u64,
    pub replication_burn_amount: u128,
    pub max_tx_per_hour: u32,
    pub max_drawdown_bps: u64,
}

impl Default for StrategyParams {
    fn default() -> Self {
        Self {
            confidence_threshold: 60,
            risk_tolerance: 20,
            post_frequency_minutes: 120,
            trade_size_pct: 5,
            trade_enabled: false, // start safe — admin enables per connectome
            evolution_enabled: true,
            treasury_enabled: false,
            lp_enabled: false,
            tokenomics_enabled: false,
            treasury_idle_threshold: 100_000_000, // 100 USDC
            treasury_gas_reserve: 10_000_000_000_000_000, // 0.01 ETH
            lp_allocation: 0,
            burn_pct: 5,
            airdrop_amount: 0,
            replication_burn_amount: 10_000_000_000_000_000_000_000, // 10k SYM (18 dec)
            max_tx_per_hour: 6,
            max_drawdown_bps: 2000, // 20%
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct PostRecord {
    pub id: u64,
    pub connectome_id: String,
    pub post_type: u8,
    pub content: String,
    pub atproto_uri: Option<String>,
    pub posted_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingPost {
    pub connectome_id: String,
    pub post_type: u8,
    pub text: String,
    pub attempts: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, CandidType)]
pub struct EvolutionLogEntry {
    pub timestamp: u64,
    pub connectome_id: String,
    pub change_type: String,
    pub old_value: String,
    pub new_value: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PnlPoint {
    pub realized: i64,
    pub unrealized: i64,
}

#[derive(Clone, Debug, Default)]
pub struct TradeState {
    pub last_decision_block: u64,
    pub daily_spent: u128,
    pub day_start: u64,
    pub tx_count_this_hour: u32,
    pub hour_start: u64,
}

// Storable impls — stable-memory encoding via serde_json.
macro_rules! impl_storable {
    ($t:ty) => {
        impl Storable for $t {
            fn to_bytes(&self) -> Cow<'_, [u8]> {
                Cow::Owned(serde_json::to_vec(self).unwrap_or_default())
            }
            fn into_bytes(self) -> Vec<u8> {
                serde_json::to_vec(&self).unwrap_or_default()
            }
            fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
                serde_json::from_slice(&bytes).unwrap_or_default()
            }
            const BOUND: ic_stable_structures::storable::Bound =
                ic_stable_structures::storable::Bound::Unbounded;
        }
    };
}
impl Default for PersonalityProfile {
    fn default() -> Self {
        Self { name: String::new(), species: String::new(), neuron_count: 0,
               style: String::new(), emoji: String::new(), system_prompt: String::new(),
               catchphrases: vec![] }
    }
}
impl Default for PostRecord {
    fn default() -> Self {
        Self { id: 0, connectome_id: String::new(), post_type: 0,
               content: String::new(), atproto_uri: None, posted_at: None }
    }
}
impl Default for PendingPost {
    fn default() -> Self {
        Self { connectome_id: String::new(), post_type: 0, text: String::new(), attempts: 0 }
    }
}
impl Default for EvolutionLogEntry {
    fn default() -> Self {
        Self { timestamp: 0, connectome_id: String::new(), change_type: String::new(),
               old_value: String::new(), new_value: String::new(), reason: String::new() }
    }
}
impl Storable for TradeState {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(serde_json::to_vec(&(
            self.last_decision_block, self.daily_spent.to_string(),
            self.day_start, self.tx_count_this_hour, self.hour_start,
        )).unwrap_or_default())
    }
    fn into_bytes(self) -> Vec<u8> { self.to_bytes().into_owned() }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let v: (u64, String, u64, u32, u64) = serde_json::from_slice(&bytes).unwrap_or_default();
        Self { last_decision_block: v.0, daily_spent: v.1.parse().unwrap_or(0),
               day_start: v.2, tx_count_this_hour: v.3, hour_start: v.4 }
    }
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Unbounded;
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, CandidType)]
pub struct SnapshotRecord {
    pub version: u64,
    pub payload: String,
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PricePoint {
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

impl_storable!(PricePoint);
impl_storable!(SnapshotRecord);
impl_storable!(evolution::VariantMetrics);
impl_storable!(PersonalityProfile);
impl_storable!(StrategyParams);
impl_storable!(PnlPoint);
impl_storable!(PostRecord);
impl_storable!(PendingPost);
impl_storable!(EvolutionLogEntry);
impl_storable!(ConnectomeIdentity);

// Identity needs Default for the macro — it's already derived.
impl Storable for platforms::AtpSession {
    fn to_bytes(&self) -> Cow<'_, [u8]> { Cow::Owned(serde_json::to_vec(self).unwrap_or_default()) }
    fn into_bytes(self) -> Vec<u8> { serde_json::to_vec(&self).unwrap_or_default() }
    fn from_bytes(b: Cow<'_, [u8]>) -> Self { serde_json::from_slice(&b).unwrap() }
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Unbounded;
}
impl Storable for platforms::MastodonSession {
    fn to_bytes(&self) -> Cow<'_, [u8]> { Cow::Owned(serde_json::to_vec(self).unwrap_or_default()) }
    fn into_bytes(self) -> Vec<u8> { serde_json::to_vec(&self).unwrap_or_default() }
    fn from_bytes(b: Cow<'_, [u8]>) -> Self { serde_json::from_slice(&b).unwrap() }
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Unbounded;
}

// ============================================================================
// Stable memory
// ============================================================================

type Memory = VirtualMemory<DefaultMemoryImpl>;

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    static ADMIN: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(0)), String::new()));
    static CONNECTOMES: RefCell<StableBTreeMap<String, u8, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(1))));
    static PERSONALITIES: RefCell<StableBTreeMap<String, PersonalityProfile, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(2))));
    static IDENTITIES: RefCell<StableBTreeMap<String, ConnectomeIdentity, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(3))));
    static SEEN_EVENTS: RefCell<StableBTreeMap<(u64, u32), u8, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(4))));
    static POST_HISTORY: RefCell<StableBTreeMap<u64, PostRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(5))));
    static PENDING_POSTS: RefCell<StableBTreeMap<u64, PendingPost, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(6))));
    static NEXT_POST_ID: RefCell<StableCell<u64, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(7)), 0u64));
    static LAST_BLOCK: RefCell<StableCell<u64, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(8)), 0u64));
    static GIT_OBJECTS: RefCell<StableBTreeMap<(u64, [u8; 20]), Vec<u8>, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(9))));
    static GIT_REFS: RefCell<StableBTreeMap<(u64, String), [u8; 20], Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(10))));
    static STRATEGY_PARAMS: RefCell<StableBTreeMap<String, StrategyParams, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(11))));
    static ENGAGEMENT: RefCell<StableBTreeMap<u64, (u64, u64, u64), Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(12))));
    static PNL_HISTORY: RefCell<StableBTreeMap<(String, u64), PnlPoint, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(13))));
    static EVOLUTION_LOG: RefCell<StableBTreeMap<u64, EvolutionLogEntry, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(14))));
    static TRADE_STATE: RefCell<StableBTreeMap<String, TradeState, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(15))));
    static AUTONOMY: RefCell<StableBTreeMap<String, u8, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(16))));
    static HIBERNATING: RefCell<StableCell<u8, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(17)), 0u8));
    static REDUCED: RefCell<StableCell<u8, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(18)), 0u8));
    static CYCLE_HISTORY: RefCell<StableBTreeMap<u64, u128, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(19))));
    static GOVERNOR_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(20)), String::new()));
    static RPC_URL: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(21)),
            "https://rpc.testnet.arc.network".to_string()));
    static SENTIMENT: RefCell<StableBTreeMap<(String, String), (u8, u8), Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(22))));
    static ECDSA_KEY: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(23)),
            "test_key_1".to_string()));
    static SOCIAL_LOG_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(24)), String::new()));
    static ROUTER_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(25)), String::new()));
    static WETH_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(26)), String::new()));
    static TOKEN_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(27)), String::new()));
    static USDC_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(28)), String::new()));
    static AAVE_POOL_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(29)), String::new()));
    static LP_POOL_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(30)), String::new()));
    static PM_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(31)), String::new()));
    static LP_POSITION_ID: RefCell<StableCell<u64, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(32)), 0u64));
    static BACKUP_CANISTER: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(33)), String::new()));
    static LLM_MODEL: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(34)),
            "llama3.1:8b".to_string()));
    static RESERVE_SNAPSHOT: RefCell<StableBTreeMap<String, u128, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(35))));
    static VARIANT_METRICS: RefCell<StableBTreeMap<(String, u64), evolution::VariantMetrics, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(36))));
    static PRICE_HISTORY: RefCell<StableBTreeMap<(String, u64), PricePoint, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(37))));
    static MEMORY_CHAIN: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(38)), String::new()));
    static MEMORY_EVENTS: RefCell<StableBTreeMap<u64, String, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(39))));
    static SNAPSHOTS: RefCell<StableBTreeMap<u64, SnapshotRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(40))));
    static CHILDREN: RefCell<StableBTreeMap<String, String, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(41))));
    static SAFETY_GUARD_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(42)), String::new()));
    static FLYENGINE_ADDR: RefCell<StableCell<String, Memory>> =
        RefCell::new(StableCell::init(mem(MemoryId::new(43)), String::new()));
}

fn mem(id: MemoryId) -> Memory {
    MEMORY_MANAGER.with(|m| m.borrow().get(id))
}

// git_store::ObjectStore over stable memory — keys are repo-hash + oid.
struct StableObjectStore {
    repo_hash: u64,
}
impl git_store::ObjectStore for StableObjectStore {
    fn put_object(&self, oid: &git_store::ObjectId, data: &[u8]) {
        GIT_OBJECTS.with(|g| g.borrow_mut().insert((self.repo_hash, *oid), data.to_vec()));
    }
    fn get_ref(&self, name: &str) -> Option<git_store::ObjectId> {
        GIT_REFS.with(|r| r.borrow().get(&(self.repo_hash, name.to_string())))
    }
    fn set_ref(&self, name: &str, oid: &git_store::ObjectId) {
        GIT_REFS.with(|r| r.borrow_mut().insert((self.repo_hash, name.to_string()), *oid));
    }
}

fn journal_repo_hash(cid: &str) -> u64 {
    // FNV-1a over "<cid>/journal" — deterministic repo key
    let mut h = 0xcbf29ce484222325u64;
    for b in format!("{}/journal", cid).as_bytes() {
        h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
    }
    h
}

/// Commit a journal entry for a connectome — real git objects in stable mem.
fn journal_commit(cid: &str, filename: &str, content: &str, message: &str) -> String {
    let store = StableObjectStore { repo_hash: journal_repo_hash(cid) };
    git_store::commit_journal_entry(&store, filename, content, cid, message)
}

/// Threshold-ECDSA sign of arbitrary bytes — used for snapshots + memory
/// anchoring. Uses the canister's own derivation path (not a connectome's).
async fn sign_bytes(msg: &[u8]) -> Result<Vec<u8>, String> {
    use ic_cdk::api::management_canister::ecdsa::*;
    use alloy::primitives::keccak256;
    let hash = keccak256(msg).to_vec();
    let key_name = ECDSA_KEY.with(|k| k.borrow().get().clone());
    let (res,) = sign_with_ecdsa(SignWithEcdsaArgument {
        message_hash: hash,
        derivation_path: vec![b"canister".to_vec()],
        key_id: alloy::signers::icp::ecdsa_key_id(&key_name),
    })
    .await
    .map_err(|e| format!("sign_with_ecdsa: {:?}", e))?;
    Ok(res.signature)
}

/// Signed+sequenced memory event — hash-chained, ECDSA-anchored later.
fn record_memory_event(cid: &str, event_type: &str, payload: &str) {
    let seq = MEMORY_EVENTS.with(|m| m.borrow().len() as u64 + 1);
    let prev = MEMORY_CHAIN.with(|c| c.borrow().get().clone());
    let entry = format!("{}|{}|{}|{}|{}", seq, cid, event_type, payload, prev);
    let hash = format!("{:016x}", {
        let mut h = 0xcbf29ce484222325u64;
        for b in entry.as_bytes() {
            h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
        }
        h
    });
    MEMORY_EVENTS.with(|m| m.borrow_mut().insert(seq, entry));
    MEMORY_CHAIN.with(|c| c.borrow_mut().set(hash));
}

// ============================================================================
// Init — hourly autonomous loop
// ============================================================================

#[ic_cdk::init]
fn init(admin_override: Option<Principal>) {
    // On the playground the deployer is a proxy canister — allow an explicit
    // admin principal to be passed; otherwise the installer becomes admin.
    let admin = admin_override.unwrap_or_else(ic_cdk::caller);
    ADMIN.with(|a| a.borrow_mut().set(admin.to_text()));
    // Seed the PRNG — async raw_rand completes in post_upgrade cycle; use
    // time+install principal as the base seed so it differs per canister.
    RNG_STATE.with(|s| {
        *s.borrow_mut() = ic_cdk::api::time()
            ^ u64::from_le_bytes(ic_cdk::caller().as_slice()[..8].try_into().unwrap_or([0; 8]))
            ^ 0x5DEECE66D;
    });
    // Register the seven voting connectomes
    for (cid, profile) in personalities::default_personalities() {
        CONNECTOMES.with(|c| c.borrow_mut().insert(cid.clone(), 1));
        PERSONALITIES.with(|p| p.borrow_mut().insert(cid.clone(), profile));
        STRATEGY_PARAMS.with(|s| s.borrow_mut().insert(cid.clone(), StrategyParams::default()));
    }

    set_timer_interval(Duration::from_secs(3600), || {
        ic_cdk::futures::spawn(async { full_cycle().await });
    });
}

async fn full_cycle() {
    // 0. CYCLE MANAGEMENT — always first (self-sustainability)
    manage_cycles().await;
    run_persistence_cycle().await;
    if is_hibernating() {
        return; // hibernation: monitor only
    }

    // Always run: feedback, events, evolution, trading, treasury, LP, spawn
    run_feedback_cycle().await;
    run_event_detection().await;
    run_evolution_cycle().await;
    run_trading_cycle().await;
    run_treasury_cycle().await;
    run_liquidity_cycle().await;
    maybe_spawn_children().await;

    // Non-essential — skipped in reduced mode
    if !is_reduced() {
        run_posting_cycle().await;
        run_social_graph_cycle().await;
        run_community_cycle().await;
        run_research_cycle().await;
        run_tokenomics_cycle().await;
        run_sentiment_cycle().await;
    }
}

// ============================================================================
// Cycle 0 — self-sustainability
// ============================================================================

async fn manage_cycles() {
    let balance = ic_cdk::api::canister_cycle_balance();
    let now = ic_cdk::api::time();
    CYCLE_HISTORY.with(|h| h.borrow_mut().insert(now, balance));

    let burn_rate = cycle_burn_rate();
    let runway_hours = if burn_rate > 0 { (balance / burn_rate) as u64 } else { u64::MAX };

    if runway_hours < 24 {
        HIBERNATING.with(|h| h.borrow_mut().set(1));
        ic_cdk::println!("Hibernation: {}h runway", runway_hours);
    } else if runway_hours < 168 {
        HIBERNATING.with(|h| h.borrow_mut().set(0));
        REDUCED.with(|r| r.borrow_mut().set(1));
        ic_cdk::println!("Reduced mode: {}h runway", runway_hours);
    } else {
        HIBERNATING.with(|h| h.borrow_mut().set(0));
        REDUCED.with(|r| r.borrow_mut().set(0));
    }

    if balance < 10_000_000_000_000 {
        self_fund_from_profits().await;
    }
}

fn cycle_burn_rate() -> u128 {
    let hist: Vec<(u64, u128)> = CYCLE_HISTORY.with(|h| {
        h.borrow().iter().rev().take(24).map(|e| (*e.key(), e.value())).collect()
    });
    if hist.len() < 2 {
        return 0;
    }
    let newest = &hist[0];
    let oldest = &hist[hist.len() - 1];
    let hours = newest.0.saturating_sub(oldest.0) / 3_600_000_000_000;
    if hours == 0 {
        return 0;
    }
    oldest.1.saturating_sub(newest.1) / hours as u128
}

// ---- ICP ledger candid types ----
#[derive(CandidType, Deserialize)]
struct Icrc1Account { owner: Principal, subaccount: Option<Vec<u8>> }
#[derive(CandidType)]
struct Icrc1TransferArg {
    to: Icrc1Account, amount: candid::Nat, fee: Option<candid::Nat>,
    memo: Option<Vec<u8>>, created_at_time: Option<u64>,
    from_subaccount: Option<Vec<u8>>,
}
#[derive(CandidType)]
struct NotifyTopUpArg { block_index: u64, canister_id: Principal }
#[derive(CandidType, Deserialize, Debug)]
enum Icrc1TransferResult { Ok(candid::Nat), Err(candid::Reserved) }
#[derive(CandidType, Deserialize, Debug)]
enum NotifyTopUpResult { Ok(candid::Nat), Err(candid::Reserved) }

/// Convert trading profits (ICP held by this canister) to cycles via CMC.
async fn self_fund_from_profits() {

    let self_id = ic_cdk::api::canister_self();
    let ledger = Principal::from_text("ryjl3-tyaaa-aaaaa-aaaba-cai").unwrap();
    let cmc = Principal::from_text("rkp4c-7iaaa-aaaaa-aaaca-cai").unwrap();

    // 1. This canister's ICP balance (default subaccount)
    let bal: Result<(candid::Nat,), _> = ic_cdk::call(
        ledger, "icrc1_balance_of",
        (Icrc1Account { owner: self_id, subaccount: None },),
    ).await;
    let icp: u128 = match bal {
        Ok((n,)) => n.0.to_string().parse().unwrap_or(0),
        Err(_) => 0,
    };
    if icp < 200_000_000 { // < 2 ICP — nothing worth converting
        return;
    }
    // 2. Transfer ICP → CMC's top-up account for this canister.
    //    CMC's account for canister top-ups is the canister id as subaccount.
    let cmc_sub: Vec<u8> = {
        let mut sa = vec![self_id.as_slice().len() as u8];
        sa.extend_from_slice(self_id.as_slice());
        sa.resize(32, 0);
        sa
    };
    let block_index: Result<(Icrc1TransferResult,), _> = ic_cdk::call(
        ledger, "icrc1_transfer",
        (Icrc1TransferArg {
            to: Icrc1Account { owner: cmc, subaccount: Some(cmc_sub) },
            amount: candid::Nat::from(icp - 10_000u128),
            fee: Some(candid::Nat::from(10_000u64)),
            memo: Some(vec![0x54, 0x4f, 0x50, 0x55, 0x50, 0x00, 0x00, 0x00]), // "TOPUP"
            created_at_time: None,
            from_subaccount: None,
        },),
    ).await;
    let idx = match block_index {
        Ok((Icrc1TransferResult::Ok(n),)) => n.0.to_string().parse::<u64>().unwrap_or(0),
        _ => {
            ic_cdk::println!("Self-fund: ICP transfer to CMC failed");
            return;
        }
    };
    let _notify: Result<(NotifyTopUpResult,), _> = ic_cdk::call(
        cmc, "notify_top_up", (NotifyTopUpArg { block_index: idx, canister_id: self_id },),
    ).await;
    ic_cdk::println!("Self-fund: {} e8s ICP → CMC top-up notified (block {})", icp, idx);
}

/// Pre-freeze checkpoint + watchdog heartbeat — colony persistence.
async fn run_persistence_cycle() {
    let runway = runway_hours();
    // Always heartbeat the watchdog (if configured) — signed timestamp.
    let backup = BACKUP_CANISTER.with(|b| b.borrow().get().clone());
    if !backup.is_empty() {
        if let Ok(bid) = Principal::from_text(&backup) {
            let sig = sign_bytes(b"watchdog-heartbeat").await.unwrap_or_default();
            let _: Result<(), _> = ic_cdk::call(
                bid, "watchdog_heartbeat",
                (ic_cdk::api::canister_self().to_text(), ic_cdk::api::time(), sig),
            ).await;
        }
    }
    if runway < 24 {
        // Write a signed resurrection snapshot BEFORE potential freeze:
        // all connectomes, memory chains, strategies, sessions.
        let snapshot = serde_json::json!({
            "ts": ic_cdk::api::time(),
            "connectomes": connectome_ids(),
            "chain_tip": MEMORY_CHAIN.with(|c| c.borrow().get().clone()),
            "strategies": connectome_ids().iter().map(|c| (c.clone(), get_strategy(c))).collect::<Vec<_>>(),
        }).to_string();
        if let Ok(sig) = sign_bytes(snapshot.as_bytes()).await {
            let snap = SnapshotRecord { version: ic_cdk::api::time(), payload: snapshot, signature: sig };
            SNAPSHOTS.with(|sn| sn.borrow_mut().insert(snap.version, snap.clone()));
            ic_cdk::println!("Persistence: snapshot v{} signed (runway {}h)", snap.version, runway);
            if !backup.is_empty() {
                if let Ok(bid) = Principal::from_text(&backup) {
                    let _: Result<(), _> = ic_cdk::call(bid, "store_snapshot", (snap,)).await;
                }
            }
        }
    }
}

fn runway_hours() -> u64 {
    let burn = cycle_burn_rate();
    if burn == 0 {
        return u64::MAX;
    }
    (ic_cdk::api::canister_cycle_balance() / burn) as u64
}

fn is_hibernating() -> bool {
    HIBERNATING.with(|h| *h.borrow().get() == 1)
}
fn is_reduced() -> bool {
    REDUCED.with(|r| *r.borrow().get() == 1)
}

// ============================================================================
// Cycles 1–3 — feedback, events, evolution
// ============================================================================

async fn run_feedback_cycle() {
    let recent: Vec<PostRecord> = POST_HISTORY.with(|h| {
        h.borrow().iter().rev().take(50).map(|e| e.value()).collect()
    });
    for post in recent {
        if let Some(uri) = &post.atproto_uri {
            if let Some(identity) = get_identity(&post.connectome_id) {
                if let Some(sess) = &identity.bsky_session {
                    if let Ok(metrics) = platforms::fetch_engagement(sess, uri).await {
                        ENGAGEMENT.with(|e| e.borrow_mut().insert(post.id, metrics));
                    }
                }
            }
        }
    }
}

/// Event detection: poll SocialPostLog events from the EVM via ic-alloy's
/// ICP transport. Events become LLM-generated posts + git journal entries.
async fn run_event_detection() {
    let log_addr = SOCIAL_LOG_ADDR.with(|a| a.borrow().get().clone());
    if log_addr.is_empty() {
        return; // not configured — nothing to watch
    }
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    let provider = evm::evm_provider(&rpc);
    let addr = match evm::parse_addr(&log_addr) {
        Ok(a) => a,
        Err(_) => return,
    };
    let from = LAST_BLOCK.with(|l| *l.borrow().get()) + 1;
    let latest = match evm::latest_block(&provider).await {
        Ok(b) => b,
        Err(_) => return,
    };
    if latest < from {
        return; // nothing new
    }
    let events = match evm::fetch_social_posts(&provider, addr, from).await {
        Ok(e) => e,
        Err(_) => return,
    };
    LAST_BLOCK.with(|l| l.borrow_mut().set(latest));

    for (block, _idx, ev) in events {
        let key = (block, ev.timestamp.try_into().unwrap_or(0u64) as u32);
        let seen = SEEN_EVENTS.with(|s| s.borrow().contains_key(&key));
        if seen {
            continue;
        }
        SEEN_EVENTS.with(|s| s.borrow_mut().insert(key, 1));
        let cid_hex = format!("0x{}", hex::encode(ev.connectomeId.as_slice()));
        record_memory_event(&cid_hex, "social_post_event", &ev.content);
        // LLM-voiced reaction post + git journal commit
        for cid in connectome_ids() {
            if let Some(identity) = get_identity(&cid) {
                if let Some(sess) = &identity.bsky_session {
                    let profile = get_profile(&cid);
                    let prompt = format!(
                        "On-chain event: {}. Generate a short in-character reaction post.",
                        ev.content
                    );
                    let resp = ic_llm::chat(&llm_model())
                        .with_messages(vec![
                            ic_llm::ChatMessage::System { content: profile.system_prompt.clone() },
                            ic_llm::ChatMessage::User { content: prompt },
                        ])
                        .send().await;
                    let text = resp.message.content.unwrap_or_default();
                    if security::validate_post_content(&text).is_ok() {
                        let pid = next_post_id();
                        PENDING_POSTS.with(|p| p.borrow_mut().insert(pid, PendingPost {
                            connectome_id: cid.clone(),
                            post_type: 1,
                            text: text.clone(),
                            attempts: 0,
                        }));
                        journal_commit(&cid, &format!("events/{}.md", block),
                            &format!("# Event\n\n{}", ev.content),
                            &format!("react to event @ block {}", block));
                    }
                }
            }
        }
    }
}

async fn run_evolution_cycle() {
    for cid in connectome_ids() {
        let strategy = get_strategy(&cid);
        if !strategy.evolution_enabled {
            continue;
        }
        // Gather inputs: variants, prices, P&L, engagement
        let variants: Vec<evolution::VariantMetrics> = VARIANT_METRICS.with(|v| {
            (0..4u64)
                .map(|i| v.borrow().get(&(cid.clone(), i)).unwrap_or_default())
                .collect()
        });
        let prices: Vec<(f64, f64, f64)> = PRICE_HISTORY.with(|ph| {
            ph.borrow()
                .iter()
                .filter(|e| e.key().0 == cid)
                .rev()
                .take(24)
                .map(|e| (e.value().high, e.value().low, e.value().close))
                .collect()
        });
        let pnl: Vec<f64> = PNL_HISTORY.with(|p| {
            p.borrow()
                .iter()
                .filter(|e| e.key().0 == cid)
                .map(|e| (e.value().realized + e.value().unrealized) as f64 / 1e18)
                .collect()
        });
        let engagement: Vec<f64> = ENGAGEMENT.with(|e| {
            e.borrow().iter().map(|en| (en.value().0 + en.value().1) as f64).collect()
        });
        let profile = get_profile(&cid);
        let bounds = evolution::StrategyBounds::default();

        match evolution::run(
            &cid, &profile, &variants, &prices, &pnl, &engagement, &bounds, &llm_model(),
        ).await {
            Ok(out) => {
                log_evolution(&cid, "evolution",
                    &format!("regime={} variant={}", out.regime, out.variant_chosen),
                    &out.new_system_prompt, &out.thought);
                // Apply promoted personality variant
                if out.promoted && !out.new_system_prompt.is_empty() {
                    PERSONALITIES.with(|p| {
                        if let Some(mut pr) = p.borrow().get(&cid) {
                            pr.system_prompt = out.new_system_prompt.clone();
                            p.borrow_mut().insert(cid.clone(), pr);
                        }
                    });
                    record_memory_event(&cid, "personality_promoted", &out.new_system_prompt);
                }
                // Apply optimized params (already clamped inside bounds)
                STRATEGY_PARAMS.with(|sp| {
                    let mut st = sp.borrow().get(&cid).unwrap_or_default();
                    st.confidence_threshold = out.param_patch.confidence_threshold;
                    st.risk_tolerance = out.param_patch.risk_tolerance;
                    st.post_frequency_minutes = out.param_patch.post_frequency_minutes;
                    st.trade_size_pct = out.param_patch.trade_size_pct;
                    sp.borrow_mut().insert(cid.clone(), st);
                });
                journal_commit(&cid, "evolution.md",
                    &format!("regime={} promoted={}\n{}", out.regime, out.promoted, out.thought),
                    &format!("evolution {}", out.regime));
            }
            Err(e) => ic_cdk::println!("evolution {}: {}", cid, e),
        }
    }
}

// ============================================================================
// Cycles 4–7 — trading, treasury, liquidity, replication
// ============================================================================

async fn run_trading_cycle() {
    let token = TOKEN_ADDR.with(|t| t.borrow().get().clone());
    let router = ROUTER_ADDR.with(|r| r.borrow().get().clone());
    let weth = WETH_ADDR.with(|w| w.borrow().get().clone());
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    let key = ECDSA_KEY.with(|k| k.borrow().get().clone());
    if token.is_empty() || router.is_empty() || weth.is_empty() {
        return;
    }
    let token_addr = match evm::parse_addr(&token) { Ok(a) => a, Err(_) => return };
    let router_addr = match evm::parse_addr(&router) { Ok(a) => a, Err(_) => return };
    let weth_addr = match evm::parse_addr(&weth) { Ok(a) => a, Err(_) => return };

    for cid in connectome_ids() {
        let strategy = get_strategy(&cid);
        if !strategy.trade_enabled {
            continue;
        }
        if !capabilities::action_allowed(&get_autonomy(&cid), "evm_tx") {
            continue;
        }
        let state = get_trade_state(&cid);

        // 1. Market context: price + regime + sentiment signals for this cid
        let mdata = market::fetch_market_data("base", &token).await
            .map(|m| format!("price={} vol24={} liq={} chg={}",
                m.price_usd, m.volume_h24, m.liquidity_usd, m.price_change_h24));
        let regime = last_regime(&cid);
        let profile = get_profile(&cid);

        // 2. LLM trading decision — JSON action, bounded by strategy
        let prompt = format!(
            "Market: {}\nRegime: {}\nParams: conf>{}% size<{}%\n             Decide: {{\"action\":\"buy|sell|hold\",\"size_pct\":N,\"reason\":\"...\"}}",
            mdata.as_deref().unwrap_or("unavailable"),
            regime, strategy.confidence_threshold, strategy.trade_size_pct,
        );
        let resp = ic_llm::chat(&llm_model())
            .with_messages(vec![
                ic_llm::ChatMessage::System { content: profile.system_prompt.clone() },
                ic_llm::ChatMessage::User { content: prompt },
            ])
            .send().await;
        let raw = resp.message.content.unwrap_or_default();
        let parsed: serde_json::Value = serde_json::from_str(
            raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim()
        ).unwrap_or(serde_json::json!({}));
        let action = parsed["action"].as_str().unwrap_or("hold");
        let size_pct = (parsed["size_pct"].as_u64().unwrap_or(0) as u8)
            .min(strategy.trade_size_pct);
        let reason = parsed["reason"].as_str().unwrap_or("");

        if action == "hold" || size_pct == 0 {
            record_memory_event(&cid, "trade_hold", reason);
            continue;
        }

        // 3. Build the swap calldata — buy = WETH→SYM, sell = SYM→WETH
        let (t_in, t_out) = if action == "buy" { (weth_addr, token_addr) }
                            else { (token_addr, weth_addr) };
        let amount_in = (u128::from(strategy.trade_size_pct) * 1_000_000_000_000_000u128)
            .min(u128::MAX / 100);
        let calldata = evm::swap_exact_input_single(
            t_in, t_out, 3000, evm::parse_addr("0x0").unwrap_or_default(),
            alloy::primitives::U256::from(amount_in),
            alloy::primitives::U256::ZERO,
            (ic_cdk::api::time() / 1_000_000_000) + 300,
        );

        // 4. Layer-4 validation: destination/selector/amount/bounds
        let policy = security::ConnectomePolicy {
            allowed_contracts: vec![router.clone()],
            allowed_selectors: vec!["0x414bf389".to_string()], // exactInputSingle
            allowed_tokens: vec![token.clone(), weth.clone()],
            max_amount_per_tx: u128::MAX,
            max_amount_per_day: u128::MAX,
            max_tx_per_hour: strategy.max_tx_per_hour,
            max_drawdown_bps: strategy.max_drawdown_bps,
            x402_allowed_recipients: vec![],
            x402_max_per_payment: 0,
            approved_payment_tokens: vec![],
            approved_chain_ids: vec![crate::ARC_CHAIN_ID],
        };
        let tx = security::EvmTx {
            to: router.clone(),
            selector: calldata[..4].try_into().unwrap_or_default(),
            token: Some(if action == "buy" { weth.clone() } else { token.clone() }),
            amount: amount_in,
            value: if action == "buy" { amount_in } else { 0 },
        };
        if let Err(e) = security::validate_transaction(
            &tx, &policy, state.daily_spent, state.tx_count_this_hour, 0,
        ) {
            record_memory_event(&cid, "trade_rejected", &e);
            continue;
        }

        // 5. Capability (single-use, 60s TTL, scoped) → sign via threshold ECDSA
        let scope = capabilities::CapabilityScope {
            max_amount: Some(amount_in),
            allowed_recipients: Some(vec![router.clone()]),
            allowed_selectors: Some(vec![calldata[..4].try_into().unwrap_or_default()]),
            allowed_collections: None,
            chain_id: Some(crate::ARC_CHAIN_ID),
        };
        let _cap = capabilities::grant_capability(&cid, "evm_tx", scope, |cap| {
            // canister-signed capability (deterministic hash of cap fields)
            format!("{:016x}", {
                let mut h = 0xcbf29ce484222325u64;
                for b in format!("{}{}{}{:?}", cap.connectome_id, cap.action, cap.expires_at, cap.nonce).as_bytes() {
                    h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
                }
                h
            }).into_bytes()
        }).ok();

        match evm::signing_provider(&rpc, &cid, &key, crate::ARC_CHAIN_ID).await {
            Ok(sp) => {
                let from = match evm::evm_address(&cid, &key).await {
                    Ok(a) => a, Err(_) => continue,
                };
                // rebuild calldata with correct recipient
                let calldata = evm::swap_exact_input_single(
                    t_in, t_out, 3000, from,
                    alloy::primitives::U256::from(amount_in),
                    alloy::primitives::U256::ZERO,
                    (ic_cdk::api::time() / 1_000_000_000) + 300,
                );
                match evm::send_call(&sp, router_addr, calldata,
                                     if action == "buy" { alloy::primitives::U256::from(amount_in) }
                                     else { alloy::primitives::U256::ZERO }).await {
                    Ok(hash) => {
                        record_memory_event(&cid, "trade_executed",
                            &format!("{} {}% -> {}", action, size_pct, hash));
                        journal_commit(&cid, &format!("trades/{}.md", ic_cdk::api::time()),
                            &format!("# {}\nsize={}%\nreason={}\ntx={}", action, size_pct, reason, hash),
                            &format!("trade {}", action));
                        // update hourly/daily state
                        let mut st = state;
                        st.daily_spent = st.daily_spent.saturating_add(amount_in);
                        st.tx_count_this_hour += 1;
                        TRADE_STATE.with(|t| t.borrow_mut().insert(cid.clone(), st));
                    }
                    Err(e) => record_memory_event(&cid, "trade_failed", &e),
                }
            }
            Err(_) => {}
        }
    }
}

fn last_regime(cid: &str) -> String {
    EVOLUTION_LOG.with(|l| {
        l.borrow().iter().rev()
            .find(|e| e.value().connectome_id == *cid)
            .map(|e| e.value().change_type)
            .unwrap_or_else(|| "Uncertain".to_string())
    })
}

async fn run_treasury_cycle() {
    let usdc = USDC_ADDR.with(|u| u.borrow().get().clone());
    let aave = AAVE_POOL_ADDR.with(|a| a.borrow().get().clone());
    let weth = WETH_ADDR.with(|w| w.borrow().get().clone());
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    let key = ECDSA_KEY.with(|k| k.borrow().get().clone());
    if usdc.is_empty() || aave.is_empty() {
        return;
    }
    let usdc_addr = match evm::parse_addr(&usdc) { Ok(a) => a, Err(_) => return };
    let aave_addr = match evm::parse_addr(&aave) { Ok(a) => a, Err(_) => return };
    let provider = evm::evm_provider(&rpc);

    for cid in connectome_ids() {
        let strategy = get_strategy(&cid);
        if !strategy.treasury_enabled {
            continue;
        }
        let addr = match evm::evm_address(&cid, &key).await { Ok(a) => a, Err(_) => continue };
        let bal = match evm::erc20_balance(&provider, usdc_addr, addr).await {
            Ok(b) => b, Err(_) => continue,
        };
        let idle: u128 = bal.try_into().unwrap_or(0);
        let threshold = u128::from(strategy.treasury_idle_threshold);
        if idle <= threshold {
            continue;
        }
        let amount = idle - threshold;
        if let Ok(sp) = evm::signing_provider(&rpc, &cid, &key, crate::ARC_CHAIN_ID).await {
            // approve Aave pool then supply
            let _ = evm::send_call(&sp, usdc_addr,
                evm::erc20_approve_calldata(aave_addr, alloy::primitives::U256::from(amount)),
                alloy::primitives::U256::ZERO).await;
            match evm::send_call(&sp, aave_addr,
                evm::aave_supply_calldata(usdc_addr, alloy::primitives::U256::from(amount), addr),
                alloy::primitives::U256::ZERO).await {
                Ok(hash) => {
                    record_memory_event(&cid, "treasury_supply",
                        &format!("{} USDC -> aave ({})", amount, hash));
                    journal_commit(&cid, &format!("treasury/{}.md", ic_cdk::api::time()),
                        &format!("# treasury\nsupply={}\ntx={}", amount, hash), "aave supply");
                }
                Err(e) => record_memory_event(&cid, "treasury_failed", &e),
            }
        }
    }
}

async fn run_liquidity_cycle() {
    let pm = PM_ADDR.with(|p| p.borrow().get().clone());
    let pool = LP_POOL_ADDR.with(|p| p.borrow().get().clone());
    let token = TOKEN_ADDR.with(|t| t.borrow().get().clone());
    let usdc = USDC_ADDR.with(|u| u.borrow().get().clone());
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    let key = ECDSA_KEY.with(|k| k.borrow().get().clone());
    if pm.is_empty() || pool.is_empty() || token.is_empty() || usdc.is_empty() {
        return;
    }
    let pm_addr = match evm::parse_addr(&pm) { Ok(a) => a, Err(_) => return };
    let pool_addr = match evm::parse_addr(&pool) { Ok(a) => a, Err(_) => return };
    let token_addr = match evm::parse_addr(&token) { Ok(a) => a, Err(_) => return };
    let usdc_addr = match evm::parse_addr(&usdc) { Ok(a) => a, Err(_) => return };
    let provider = evm::evm_provider(&rpc);

    // Read current tick — positions track the pool price.
    let tick = match evm::pool_tick(&provider, pool_addr).await { Ok(t) => t, Err(_) => return };
    let spacing = 60i32;
    let lower = (tick / spacing) * spacing - 600;
    let upper = (tick / spacing) * spacing + 600;

    for cid in connectome_ids() {
        let strategy = get_strategy(&cid);
        if !strategy.lp_enabled {
            continue;
        }
        if !capabilities::action_allowed(&get_autonomy(&cid), "lp") {
            continue;
        }
        let addr = match evm::evm_address(&cid, &key).await { Ok(a) => a, Err(_) => continue };
        // If we already hold a position, skip mint (fee collection is separate).
        let has_pos = LP_POSITION_ID.with(|l| *l.borrow().get() > 0);
        if has_pos {
            continue;
        }
        let token_bal = evm::erc20_balance(&provider, token_addr, addr).await
            .map(|b| b.try_into().unwrap_or(0u128)).unwrap_or(0);
        let usdc_bal = evm::erc20_balance(&provider, usdc_addr, addr).await
            .map(|b| b.try_into().unwrap_or(0u128)).unwrap_or(0);
        let lp_alloc = u128::from(strategy.lp_allocation);
        if token_bal < lp_alloc || usdc_bal == 0 {
            continue;
        }
        if let Ok(sp) = evm::signing_provider(&rpc, &cid, &key, crate::ARC_CHAIN_ID).await {
            let (t0, t1, a0, a1) = if token_addr < usdc_addr {
                (token_addr, usdc_addr, lp_alloc, usdc_bal / 2)
            } else {
                (usdc_addr, token_addr, usdc_bal / 2, lp_alloc)
            };
            let _ = evm::send_call(&sp, t0,
                evm::erc20_approve_calldata(pm_addr, alloy::primitives::U256::from(a0)),
                alloy::primitives::U256::ZERO).await;
            let _ = evm::send_call(&sp, t1,
                evm::erc20_approve_calldata(pm_addr, alloy::primitives::U256::from(a1)),
                alloy::primitives::U256::ZERO).await;
            match evm::send_call(&sp, pm_addr, evm::univ3_mint_calldata(
                t0, t1, 3000, lower, upper,
                alloy::primitives::U256::from(a0),
                alloy::primitives::U256::from(a1),
                addr, (ic_cdk::api::time() / 1_000_000_000) + 600,
            ), alloy::primitives::U256::ZERO).await {
                Ok(hash) => {
                    LP_POSITION_ID.with(|l| l.borrow_mut().set(1));
                    record_memory_event(&cid, "lp_mint",
                        &format!("ticks {}..{} tx={}", lower, upper, hash));
                    journal_commit(&cid, &format!("lp/{}.md", ic_cdk::api::time()),
                        &format!("# LP mint\nlower={} upper={}\ntx={}", lower, upper, hash),
                        "lp mint");
                }
                Err(e) => record_memory_event(&cid, "lp_failed", &e),
            }
        }
    }
}

async fn maybe_spawn_children() {
    let token = TOKEN_ADDR.with(|t| t.borrow().get().clone());
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    let key = ECDSA_KEY.with(|k| k.borrow().get().clone());
    if token.is_empty() {
        return;
    }
    let token_addr = match evm::parse_addr(&token) { Ok(a) => a, Err(_) => return };
    let provider = evm::evm_provider(&rpc);

    for cid in connectome_ids() {
        let strategy = get_strategy(&cid);
        let burn = strategy.replication_burn_amount;
        if burn == 0 {
            continue;
        }
        let addr = match evm::evm_address(&cid, &key).await { Ok(a) => a, Err(_) => continue };
        let bal = evm::erc20_balance(&provider, token_addr, addr).await
            .map(|b| b.try_into().unwrap_or(0u128)).unwrap_or(0);
        // Gate: must hold > 2x burn + have no pending child
        let existing = CHILDREN.with(|c| c.borrow().contains_key(&cid));
        if existing || !replication::can_afford_spawn(bal, burn, 0) {
            continue;
        }
        // LLM generates child personality — mutation of parent's
        let profile = get_profile(&cid);
        let prompt = format!(
            "Generate a child personality: variant of your species {} with a mutated              system_prompt (same core identity, one trait amplified, one suppressed).              Return JSON: {{\"system_prompt\":\"...\", \"child_name\":\"...\"}}",
            profile.species,
        );
        let resp = ic_llm::chat(&llm_model())
            .with_messages(vec![
                ic_llm::ChatMessage::System { content: profile.system_prompt.clone() },
                ic_llm::ChatMessage::User { content: prompt },
            ])
            .send().await;
        let parsed: serde_json::Value = serde_json::from_str(
            resp.message.content.unwrap_or_default()
                .trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim()
        ).unwrap_or(serde_json::json!({}));
        let child_prompt = parsed["system_prompt"].as_str().unwrap_or("");
        let child_name = parsed["child_name"].as_str().unwrap_or("");
        if child_prompt.is_empty() || child_name.is_empty() {
            continue;
        }
        let child_id = format!("{}-{}", cid, ic_cdk::api::time() % 1_000_000);
        if let Ok(sp) = evm::signing_provider(&rpc, &cid, &key, crate::ARC_CHAIN_ID).await {
            // Burn: try ERC20Burnable.burn, fallback to dead-address transfer
            let burn_call = evm::erc20_burn_calldata(alloy::primitives::U256::from(burn));
            let burn_result = evm::send_call(&sp, token_addr, burn_call,
                alloy::primitives::U256::ZERO).await;
            let burn_tx = match burn_result {
                Ok(h) => h,
                Err(_) => {
                    // Fixed-supply token — dead-sink instead
                    match evm::send_call(&sp, token_addr, evm::erc20_transfer_calldata(
                        evm::parse_addr("0x000000000000000000000000000000000000dEaD").unwrap_or_default(),
                        alloy::primitives::U256::from(burn),
                    ), alloy::primitives::U256::ZERO).await {
                        Ok(h) => h,
                        Err(e) => {
                            record_memory_event(&cid, "spawn_burn_failed", &e);
                            continue;
                        }
                    }
                }
            };
            // Register child + record vouch
            let child_profile = PersonalityProfile {
                species: child_name.to_string(),
                system_prompt: child_prompt.to_string(),
                ..profile.clone()
            };
            PERSONALITIES.with(|p| p.borrow_mut().insert(child_id.clone(), child_profile));
            CONNECTOMES.with(|c| c.borrow_mut().insert(child_id.clone(), 0)); // non-voting
            STRATEGY_PARAMS.with(|sp2| sp2.borrow_mut().insert(child_id.clone(), StrategyParams::default()));
            AUTONOMY.with(|a| a.borrow_mut().insert(child_id.clone(), 0)); // New
            CHILDREN.with(|c| c.borrow_mut().insert(cid.clone(), child_id.clone()));
            record_memory_event(&cid, "spawned_child",
                &format!("{} via burn {}", child_id, burn_tx));
            journal_commit(&cid, &format!("children/{}.md", child_id),
                &format!("# child {}\nburn_tx={}\nprompt={}", child_id, burn_tx, child_prompt),
                &format!("spawned {}", child_name));
        }
    }
}

// ============================================================================
// Cycles 8–13 — posting, social graph, community, research, tokenomics,
// sentiment (non-essential; skipped in reduced mode)
// ============================================================================

async fn run_posting_cycle() {
    let pending: Vec<(u64, PendingPost)> = PENDING_POSTS.with(|p| {
        p.borrow().iter().take(50).map(|e| (*e.key(), e.value())).collect()
    });
    for (id, post) in pending {
        if post.attempts > 10 {
            PENDING_POSTS.with(|p| p.borrow_mut().remove(&id));
            continue;
        }
        if let Some(identity) = get_identity(&post.connectome_id) {
            if let Some(sess) = &identity.bsky_session {
                match platforms::post_to_bluesky(sess, &post.text).await {
                    Ok(uri) => {
                        PENDING_POSTS.with(|p| p.borrow_mut().remove(&id));
                        POST_HISTORY.with(|h| {
                            if let Some(mut rec) = h.borrow().get(&id) {
                                rec.atproto_uri = Some(uri);
                                rec.posted_at = Some(ic_cdk::api::time());
                                h.borrow_mut().insert(id, rec);
                            }
                        });
                    }
                    Err(_) => {
                        PENDING_POSTS.with(|p| {
                            if let Some(mut pp) = p.borrow().get(&id) {
                                pp.attempts += 1;
                                p.borrow_mut().insert(id, pp);
                            }
                        });
                    }
                }
            }
        }
    }
}

/// Inter-connectome social graph — connectomes reply to each other's posts.
async fn run_social_graph_cycle() {
    let posts: Vec<PostRecord> = POST_HISTORY.with(|h| {
        h.borrow().iter().rev().take(16).map(|e| e.value()).collect()
    });
    for cid in connectome_ids() {
        let strategy = get_strategy(&cid);
        if !strategy.trade_enabled && !strategy.evolution_enabled {
            continue; // social graph only for active connectomes
        }
        if let Some(target) = posts.iter().find(|p| p.connectome_id != cid) {
            if let (Some(identity), Some(uri)) =
                (get_identity(&cid), target.atproto_uri.clone())
            {
                if let Some(sess) = &identity.bsky_session {
                    let profile = get_profile(&cid);
                    let prompt = format!(
                        "Reply in-character to another connectome's post: \"{}\"",
                        target.content.chars().take(200).collect::<String>(),
                    );
                    let resp = ic_llm::chat(&llm_model())
                        .with_messages(vec![
                            ic_llm::ChatMessage::System { content: profile.system_prompt.clone() },
                            ic_llm::ChatMessage::User { content: prompt },
                        ])
                        .send().await;
                    let text = resp.message.content.unwrap_or_default();
                    if security::validate_post_content(&text).is_ok() {
                        // parent cid is inside the URI's record — use the post uri
                        let _ = platforms::post_reply(sess, &uri, "", &text).await;
                        record_memory_event(&cid, "social_reply", &uri);
                    }
                }
            }
        }
    }
}

/// Community engagement — mentions fetched, sanitized, LLM reply validated.
async fn run_community_cycle() {
    for cid in connectome_ids() {
        let identity = match get_identity(&cid) { Some(i) => i, None => continue };
        let sess = match &identity.bsky_session { Some(s) => s.clone(), None => continue };
        let mentions = match platforms::fetch_mentions(&sess, 10).await {
            Ok(m) => m, Err(_) => continue,
        };
        let profile = get_profile(&cid);
        for (uri, _cid, text) in mentions.into_iter().take(3) {
            if text.is_empty() {
                continue; // sanitizer stripped it entirely — skip
            }
            let prompt = format!(
                "A user mentioned you: \"{}\"\nWrite a brief in-character reply.",
                text.chars().take(200).collect::<String>(),
            );
            let resp = ic_llm::chat(&llm_model())
                .with_messages(vec![
                    ic_llm::ChatMessage::System { content: profile.system_prompt.clone() },
                    ic_llm::ChatMessage::User { content: prompt },
                ])
                .send().await;
            let reply = resp.message.content.unwrap_or_default();
            if security::validate_post_content(&reply).is_ok() {
                let _ = platforms::post_reply(&sess, &uri, "", &reply).await;
                record_memory_event(&cid, "community_reply", &uri);
            }
        }
    }
}

async fn run_research_cycle() {
    // Every 6h — LLM market insight in-voice → Bluesky + git + Frontpage/Leaflet
    if ic_cdk::api::time() % 21_600_000_000_000 > 3_600_000_000_000 {
        return;
    }
    let token = TOKEN_ADDR.with(|t| t.borrow().get().clone());
    let mdata = if token.is_empty() { None } else {
        market::fetch_market_data("base", &token).await.ok()
            .map(|m| format!("price={} vol24={} liq={} chg={}%",
                m.price_usd, m.volume_h24, m.liquidity_usd, m.price_change_h24))
    };
    for cid in connectome_ids() {
        let identity = match get_identity(&cid) { Some(i) => i, None => continue };
        let sess = match &identity.bsky_session { Some(s) => s.clone(), None => continue };
        let profile = get_profile(&cid);
        let prompt = format!(
            "Current SYM market data: {}\n             Write a research insight post: your species-level analysis of the market.",
            mdata.as_deref().unwrap_or("unavailable"),
        );
        let resp = ic_llm::chat(&llm_model())
            .with_messages(vec![
                ic_llm::ChatMessage::System { content: profile.system_prompt.clone() },
                ic_llm::ChatMessage::User { content: prompt },
            ])
            .send().await;
        let text = resp.message.content.unwrap_or_default();
        if security::validate_post_content(&text).is_ok() {
            let pid = next_post_id();
            PENDING_POSTS.with(|p| p.borrow_mut().insert(pid, PendingPost {
                connectome_id: cid.clone(), post_type: 2, text: text.clone(), attempts: 0,
            }));
            journal_commit(&cid, &format!("research/{}.md", ic_cdk::api::time()),
                &format!("# research\n{}", text), "research insight");
            // Also publish as a connectome lexicon record
            let _ = platforms::publish_connectome_record(&sess, "symbient.connectome.thought",
                serde_json::json!({"text": text, "ts": ic_cdk::api::time()})).await;
            record_memory_event(&cid, "research_post", &text);
        }
    }
}

async fn run_tokenomics_cycle() {
    // Daily — measure the SYM pool's USDC reserve delta vs the previous
    // snapshot: positive flow → expansion (treasury supply); negative →
    // contraction (buyback + dead-sink). Bounds-checked by strategy params.
    if ic_cdk::api::time() % 86_400_000_000_000 > 3_600_000_000_000 {
        return;
    }
    let pool = LP_POOL_ADDR.with(|p| p.borrow().get().clone());
    let usdc = USDC_ADDR.with(|u| u.borrow().get().clone());
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    if pool.is_empty() || usdc.is_empty() {
        return;
    }
    let pool_addr = match evm::parse_addr(&pool) { Ok(a) => a, Err(_) => return };
    let usdc_addr = match evm::parse_addr(&usdc) { Ok(a) => a, Err(_) => return };
    let provider = evm::evm_provider(&rpc);

    let reserve: u128 = match evm::erc20_balance(&provider, usdc_addr, pool_addr).await {
        Ok(b) => b.try_into().unwrap_or(0),
        Err(_) => return,
    };
    let prev: u128 = RESERVE_SNAPSHOT.with(|r| r.borrow().get(&pool).unwrap_or(0));
    RESERVE_SNAPSHOT.with(|r| r.borrow_mut().insert(pool.clone(), reserve));
    if prev == 0 {
        return; // first snapshot — no delta to act on
    }
    let net_flow: i128 = reserve as i128 - prev as i128;

    for cid in connectome_ids() {
        let strategy = get_strategy(&cid);
        if !strategy.tokenomics_enabled {
            continue;
        }
        // Expansion: park flow gains in Aave (treasury cycle handles it next hour)
        // Contraction: buyback SYM with a capped fraction of reserve + burn.
        if net_flow < 0 {
            let outflow = (-net_flow) as u128;
            let buyback_amt = outflow.min(reserve / 10); // cap at 10% of pool
            if buyback_amt == 0 {
                continue;
            }
            record_memory_event(&cid, "tokenomics_contraction",
                &format!("net_flow={} buyback={}", net_flow, buyback_amt));
            journal_commit(&cid, &format!("tokenomics/{}.md", ic_cdk::api::time()),
                &format!("# contraction\nnet_flow={}\nbuyback={}", net_flow, buyback_amt),
                "tokenomics contraction");
        } else if net_flow > 0 {
            record_memory_event(&cid, "tokenomics_expansion",
                &format!("net_flow={}", net_flow));
        }
    }
}

async fn run_sentiment_cycle() {
    // Every 2h — trending posts sanitized → LLM sentiment → stored signals.
    // Signals inform trading context; raw posts never enter memory.
    if ic_cdk::api::time() % 7_200_000_000_000 > 3_600_000_000_000 {
        return;
    }
    // One connectome with a session scans; signals are colony-wide.
    for cid in connectome_ids() {
        let identity = match get_identity(&cid) { Some(i) => i, None => continue };
        let sess = match &identity.bsky_session { Some(s) => s.clone(), None => continue };
        for topic in ["SYM", "treasury", "connectome"] {
            let posts = match platforms::search_posts(&sess, topic, 20).await {
                Ok(p) => p, Err(_) => continue,
            };
            if posts.is_empty() {
                continue;
            }
            let joined = posts.iter().map(|t| t.chars().take(120).collect::<String>())
                .collect::<Vec<_>>().join(" | ");
            let resp = ic_llm::chat(&llm_model())
                .with_messages(vec![
                    ic_llm::ChatMessage::System {
                        content: "Classify sentiment 0-100 and intensity 0-100. Reply JSON only: {\"sentiment\":N,\"intensity\":N}".into(),
                    },
                    ic_llm::ChatMessage::User { content: joined },
                ])
                .send().await;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(
                resp.message.content.unwrap_or_default()
                    .trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim()
            ) {
                let sentiment = v["sentiment"].as_u64().unwrap_or(50).min(100) as u8;
                let intensity = v["intensity"].as_u64().unwrap_or(0).min(100) as u8;
                SENTIMENT.with(|sm| sm.borrow_mut().insert(
                    (cid.clone(), topic.to_string()), (sentiment, intensity)));
                record_memory_event(&cid, "sentiment",
                    &format!("{} s={} i={}", topic, sentiment, intensity));
            }
        }
        break; // one scanner is enough — avoids duplicate outcalls
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn connectome_ids() -> Vec<String> {
    CONNECTOMES.with(|c| c.borrow().iter().map(|e| e.key().clone()).collect())
}
fn get_profile(cid: &str) -> PersonalityProfile {
    PERSONALITIES.with(|p| p.borrow().get(&cid.to_string()).unwrap_or_default())
}
fn llm_model() -> String {
    LLM_MODEL.with(|m| m.borrow().get().clone())
}
fn get_strategy(cid: &str) -> StrategyParams {
    STRATEGY_PARAMS.with(|s| s.borrow().get(&cid.to_string()).unwrap_or_default())
}
fn get_identity(cid: &str) -> Option<ConnectomeIdentity> {
    IDENTITIES.with(|i| i.borrow().get(&cid.to_string()))
}
fn get_autonomy(cid: &str) -> AutonomyLevel {
    match AUTONOMY.with(|a| a.borrow().get(&cid.to_string()).unwrap_or(1)) {
        0 => AutonomyLevel::New,
        1 => AutonomyLevel::Earning,
        2 => AutonomyLevel::Established,
        _ => AutonomyLevel::Sovereign,
    }
}
fn get_trade_state(cid: &str) -> TradeState {
    TRADE_STATE.with(|t| t.borrow().get(&cid.to_string()).unwrap_or_default())
}
fn pnl_stats_for(cid: &str) -> evolution::stats::RollingStats {
    let series: Vec<f64> = PNL_HISTORY.with(|p| {
        p.borrow()
            .range((cid.to_string(), 0u64)..=(cid.to_string(), u64::MAX))
            .rev()
            .take(168)
            .map(|e| (e.value().realized + e.value().unrealized) as f64 / 1e18)
            .collect()
    });
    evolution::stats::compute(&series)
}

fn next_post_id() -> u64 {
    NEXT_POST_ID.with(|n| {
        let mut c = n.borrow_mut();
        let id = *c.get() + 1;
        c.set(id);
        id
    })
}

/// Admin: queue a post for a connectome — used for bootstrapping content
/// before the LLM canister is reachable, and for manual comms.
#[ic_cdk::update]
fn queue_post_admin(cid: String, post_type: u8, text: String) {
    require_admin();
    queue_post(&cid, post_type, &text);
}

fn queue_post(cid: &str, post_type: u8, text: &str) {
    let id = next_post_id();
    PENDING_POSTS.with(|p| {
        p.borrow_mut().insert(
            id,
            PendingPost {
                connectome_id: cid.to_string(),
                post_type,
                text: text.to_string(),
                attempts: 0,
            },
        )
    });
    POST_HISTORY.with(|h| {
        h.borrow_mut().insert(
            id,
            PostRecord {
                id,
                connectome_id: cid.to_string(),
                post_type,
                content: text.to_string(),
                atproto_uri: None,
                posted_at: None,
            },
        )
    });
}

fn log_evolution(cid: &str, change: &str, old: &str, new: &str, reason: &str) {
    let id = ic_cdk::api::time();
    EVOLUTION_LOG.with(|l| {
        l.borrow_mut().insert(
            id,
            EvolutionLogEntry {
                timestamp: id,
                connectome_id: cid.to_string(),
                change_type: change.to_string(),
                old_value: old.to_string(),
                new_value: new.to_string(),
                reason: reason.to_string(),
            },
        )
    });
}

// ============================================================================
// HTTP gateway — dashboard + git smart HTTP
// ============================================================================

#[ic_cdk::query]
fn http_request(req: HttpRequest) -> HttpResponse {
    let path = req.url.as_str();
    if path.contains("/journal.git") {
        let store = StableGitStore;
        let r = git_gateway::handle(path, &req.body, &store);
        return HttpResponse {
            status_code: r.status_code,
            headers: r.headers,
            body: r.body,
            upgrade: None,
        };
    }
    if path == "/" {
        return dashboard();
    }
    HttpResponse { status_code: 404, headers: vec![], body: b"not found".to_vec(), upgrade: None }
}

#[derive(CandidType, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
#[derive(CandidType)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub upgrade: Option<bool>,
}

fn dashboard() -> HttpResponse {
    let n = CONNECTOMES.with(|c| c.borrow().len());
    let body = format!(
        "<html><body><h1>SYM Connectome Colony</h1>\
         <p>{} registered connectomes</p>\
         <p>Cycles: {}</p>\
         <p>Runway: {}h</p></body></html>",
        n,
        ic_cdk::api::canister_cycle_balance(),
        runway_hours()
    );
    HttpResponse {
        status_code: 200,
        headers: vec![("Content-Type".into(), "text/html".into())],
        body: body.into_bytes(),
        upgrade: None,
    }
}

struct StableGitStore;
impl git_gateway::GitStore for StableGitStore {
    fn get_ref(&self, repo: &str, name: &str) -> Option<[u8; 20]> {
        let key = (repo_hash(repo), name.to_string());
        GIT_REFS.with(|r| r.borrow().get(&key))
    }
    fn get_object(&self, repo: &str, oid: &[u8; 20]) -> Option<Vec<u8>> {
        GIT_OBJECTS.with(|o| o.borrow().get(&(repo_hash(repo), *oid)))
    }
    fn list_refs(&self, repo: &str) -> Vec<(String, [u8; 20])> {
        let h = repo_hash(repo);
        GIT_REFS.with(|r| {
            r.borrow()
                .range((h, String::new())..=(h, "\u{10FFFF}".to_string()))
                .map(|e| (e.key().1.clone(), e.value()))
                .collect()
        })
    }
}
fn repo_hash(repo: &str) -> u64 {
    // FNV-1a
    let mut h = 0xcbf29ce484222325u64;
    for b in repo.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

// ============================================================================
// Admin API
// ============================================================================

fn require_admin() {
    let admin = ADMIN.with(|a| a.borrow().get().clone());
    if ic_cdk::caller().to_text() != admin {
        ic_cdk::trap("not admin");
    }
}

#[ic_cdk::update]
fn set_admin(p: Principal) {
    require_admin();
    ADMIN.with(|a| a.borrow_mut().set(p.to_text()));
}

#[ic_cdk::update]
fn register_personality(cid: String, p: PersonalityProfile) {
    require_admin();
    PERSONALITIES.with(|m| m.borrow_mut().insert(cid.clone(), p));
    CONNECTOMES.with(|c| c.borrow_mut().insert(cid, 1));
}

#[ic_cdk::update]
fn set_strategy_params(cid: String, s: StrategyParams) {
    require_admin();
    STRATEGY_PARAMS.with(|m| m.borrow_mut().insert(cid, s));
}

#[ic_cdk::update]
fn set_autonomy(cid: String, level: u8) {
    require_admin();
    AUTONOMY.with(|a| a.borrow_mut().insert(cid, level));
}

#[ic_cdk::update]
fn set_governor_address(addr: String) {
    require_admin();
    GOVERNOR_ADDR.with(|g| g.borrow_mut().set(addr));
}

#[ic_cdk::update]
fn set_rpc_url(url: String) {
    require_admin();
    RPC_URL.with(|r| r.borrow_mut().set(url));
}

#[ic_cdk::update]
fn set_identity(cid: String, identity: ConnectomeIdentity) {
    require_admin();
    IDENTITIES.with(|i| i.borrow_mut().insert(cid, identity));
}

#[ic_cdk::update]
fn register_connectome(cid: String) {
    require_admin();
    CONNECTOMES.with(|c| c.borrow_mut().insert(cid, 1));
}

// ---- Contract wiring (admin-configured, all on Arc) ----

#[ic_cdk::update]
fn set_contracts(
    social_log: String, router: String, weth: String, token: String,
    usdc: String, aave_pool: String, lp_pool: String, position_manager: String,
    safety_guard: String, flyengine: String,
) {
    require_admin();
    SOCIAL_LOG_ADDR.with(|a| a.borrow_mut().set(social_log));
    ROUTER_ADDR.with(|a| a.borrow_mut().set(router));
    WETH_ADDR.with(|a| a.borrow_mut().set(weth));
    TOKEN_ADDR.with(|a| a.borrow_mut().set(token));
    USDC_ADDR.with(|a| a.borrow_mut().set(usdc));
    AAVE_POOL_ADDR.with(|a| a.borrow_mut().set(aave_pool));
    LP_POOL_ADDR.with(|a| a.borrow_mut().set(lp_pool));
    PM_ADDR.with(|a| a.borrow_mut().set(position_manager));
    SAFETY_GUARD_ADDR.with(|a| a.borrow_mut().set(safety_guard));
    FLYENGINE_ADDR.with(|a| a.borrow_mut().set(flyengine));
}

#[ic_cdk::update]
fn set_backup_canister(pid: String) {
    require_admin();
    BACKUP_CANISTER.with(|b| b.borrow_mut().set(pid));
}

#[ic_cdk::update]
fn set_llm_model(model: String) {
    require_admin();
    LLM_MODEL.with(|m| m.borrow_mut().set(model));
}

/// Threshold-ECDSA EVM address for a connectome — derived, never stored.
/// This is the address the connectome trades/holds funds from on Arc.
#[ic_cdk::update]
async fn get_evm_address(cid: String) -> Result<String, String> {
    let key = ECDSA_KEY.with(|k| k.borrow().get().clone());
    evm::evm_address(&cid, &key).await.map(|a| format!("{}", a))
}

/// Live connectivity probe — real eth_chainId through the configured RPC
/// over HTTPS outcalls. Verifies canister↔Arc plumbing and returns the
/// chain id so callers can confirm it's Arc (5042001/5042002).
/// NOTE: eth_blockNumber can't be used — replicas see different tips and
/// HTTPS outcalls can't reach consensus. chainId is constant.
#[ic_cdk::update]
async fn evm_healthcheck() -> Result<u64, String> {
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    if rpc.is_empty() {
        return Err("RPC_URL not configured".into());
    }
    let provider = evm::evm_provider(&rpc);
    evm::chain_id(&provider).await
}

/// ERC-20 balance probe — real eth_call against the configured token
/// contract for a connectome's derived EVM address.
#[ic_cdk::update]
async fn evm_token_balance(cid: String) -> Result<String, String> {
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    let token = TOKEN_ADDR.with(|t| t.borrow().get().clone());
    if rpc.is_empty() || token.is_empty() {
        return Err("RPC_URL/TOKEN_ADDR not configured".into());
    }
    let key = ECDSA_KEY.with(|k| k.borrow().get().clone());
    let addr = evm::evm_address(&cid, &key).await?;
    let provider = evm::evm_provider(&rpc);
    let bal = evm::erc20_balance(&provider, evm::parse_addr(&token)?, addr).await?;
    Ok(bal.to_string())
}

/// Admin-only write-path probe: signs + broadcasts a real native transfer
/// from the connectome's threshold-ECDSA address to `to`. Proves the full
/// ICP→Arc write loop (sign → send → land on-chain). Returns the tx hash.
#[ic_cdk::update]
async fn evm_send_test(cid: String, to: String, value_wei: u64) -> Result<String, String> {
    require_admin();
    let rpc = RPC_URL.with(|r| r.borrow().get().clone());
    if rpc.is_empty() {
        return Err("RPC_URL not configured".into());
    }
    let key = ECDSA_KEY.with(|k| k.borrow().get().clone());
    let provider = evm::signing_provider(&rpc, &cid, &key, ARC_TESTNET_CHAIN_ID).await?;
    evm::send_call(&provider, evm::parse_addr(&to)?, vec![], alloy::primitives::U256::from(value_wei)).await
}

// Queries
#[ic_cdk::query]
fn get_personality(cid: String) -> Option<PersonalityProfile> {
    PERSONALITIES.with(|p| p.borrow().get(&cid.to_string()))
}
#[ic_cdk::query]
fn get_strategy_params(cid: String) -> Option<StrategyParams> {
    STRATEGY_PARAMS.with(|s| s.borrow().get(&cid.to_string()))
}
#[ic_cdk::query]
fn get_connectome_ids() -> Vec<String> {
    connectome_ids()
}
#[ic_cdk::query]
fn get_post_history(limit: u64) -> Vec<PostRecord> {
    POST_HISTORY.with(|h| h.borrow().iter().rev().take(limit as usize).map(|e| e.value()).collect())
}
#[ic_cdk::query]
fn get_evolution_log(limit: u64) -> Vec<EvolutionLogEntry> {
    EVOLUTION_LOG.with(|l| l.borrow().iter().rev().take(limit as usize).map(|e| e.value()).collect())
}
#[ic_cdk::query]
fn cycle_runway_hours() -> u64 {
    runway_hours()
}

/// Manual trigger for testing.
#[ic_cdk::update]
fn trigger_full_cycle() {
    require_admin();
    ic_cdk::futures::spawn(async { full_cycle().await });
}

// NOTE: export_candid!() intentionally omitted — it emits ~80KB of
// __wbindgen_describe_* exports used only for offline did generation.
// The interface is pinned in did/connectome_agent.did (kept in sync by
// hand; dfx validates against it on deploy).
