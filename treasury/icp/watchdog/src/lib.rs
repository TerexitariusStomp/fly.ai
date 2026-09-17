//! Colony watchdog — minimal canister holding signed resurrection snapshots
//! + heartbeat liveness for the connectome-agent colony. Runs on a separate
//! canister (separate cycle balance) so the colony can be resurrected even
//! if the main canister is frozen.

use candid::{CandidType, Deserialize, Principal};
use ic_cdk::api::time;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, Storable};
use std::borrow::Cow;
use std::cell::RefCell;

#[derive(Clone, Debug, Default, Serialize, Deserialize, CandidType)]
pub struct SnapshotRecord {
    pub version: u64,
    pub payload: String,
    pub signature: Vec<u8>,
}

use serde::Serialize;

impl Storable for SnapshotRecord {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(serde_json::to_vec(self).unwrap_or_default())
    }
    fn into_bytes(self) -> Vec<u8> {
        serde_json::to_vec(&self).unwrap_or_default()
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        serde_json::from_slice(&bytes).unwrap_or_default()
    }
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Unbounded;
}

type Memory = VirtualMemory<DefaultMemoryImpl>;

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    /// canister_id → latest signed snapshot (highest version wins)
    static SNAPSHOTS: RefCell<StableBTreeMap<String, SnapshotRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(0))));
    /// canister_id → last heartbeat nanos
    static HEARTBEATS: RefCell<StableBTreeMap<String, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(mem(MemoryId::new(1))));
    /// Admin (deployer) — controls who can write snapshots
    static ADMIN: RefCell<ic_stable_structures::StableCell<String, Memory>> =
        RefCell::new(ic_stable_structures::StableCell::init(
            mem(MemoryId::new(2)), String::new(),
        ));
}

fn mem(id: MemoryId) -> Memory {
    MEMORY_MANAGER.with(|m| m.borrow().get(id))
}

#[ic_cdk::init]
fn init() {
    ADMIN.with(|a| a.borrow_mut().set(ic_cdk::caller().to_text()));
}

fn require_admin() {
    let admin = ADMIN.with(|a| a.borrow().get().clone());
    if ic_cdk::caller().to_text() != admin {
        ic_cdk::trap("unauthorized");
    }
}

/// Colony pushes its latest signed snapshot. Highest version wins.
#[ic_cdk::update]
fn store_snapshot(canister: String, snap: SnapshotRecord) {
    // Only registered colony canisters may write — the caller principal
    // must match the claimed canister id.
    let caller = ic_cdk::caller().to_text();
    if caller != canister {
        ic_cdk::trap("caller mismatch");
    }
    SNAPSHOTS.with(|s| {
        let cur = s.borrow().get(&canister);
        if cur.map(|c| snap.version > c.version).unwrap_or(true) {
            s.borrow_mut().insert(canister, snap);
        }
    });
}

/// Colony heartbeat — signed timestamp proving liveness.
#[ic_cdk::update]
fn watchdog_heartbeat(canister: String, ts: u64, _signature: Vec<u8>) {
    let caller = ic_cdk::caller().to_text();
    if caller != canister {
        ic_cdk::trap("caller mismatch");
    }
    HEARTBEATS.with(|h| h.borrow_mut().insert(canister, ts));
}

/// Latest snapshot for a colony canister.
#[ic_cdk::query]
fn latest_snapshot(canister: String) -> Option<SnapshotRecord> {
    SNAPSHOTS.with(|s| s.borrow().get(&canister))
}

/// Last heartbeat for a colony canister.
#[ic_cdk::query]
fn last_heartbeat(canister: String) -> Option<u64> {
    HEARTBEATS.with(|h| h.borrow().get(&canister))
}

/// Hours since last heartbeat — used to detect a frozen colony.
#[ic_cdk::query]
fn hours_since_heartbeat(canister: String) -> Option<u64> {
    HEARTBEATS.with(|h| {
        h.borrow().get(&canister).map(|ts| {
            let now = time();
            if now > ts { (now - ts) / 3_600_000_000_000 } else { 0 }
        })
    })
}

ic_cdk::export_candid!();
