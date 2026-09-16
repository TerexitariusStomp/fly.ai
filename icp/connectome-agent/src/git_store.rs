//! Git object storage — writes real git objects (blob/tree/commit) into the
//! canister's stable memory, updating refs. The git_gateway module serves
//! them over smart HTTP so each connectome's journal is `git clone`-able
//! from `https://<canister>.icp0.io/<conn>/journal.git`.
//!
//! gix (gitoxide) is vendored for reference but NOT a dependency — its object
//! machinery pulls parking_lot/prodash/bstr (~300KB wasm). Git's object
//! format is three lines of spec; we write it directly + sha1 crate (~10KB).

use sha1::{Digest, Sha1};

/// 20-byte sha1 object id.
pub type ObjectId = [u8; 20];

/// Object store interface — lib.rs implements over stable-memory maps.
/// Objects stored as "<kind> <len>\0<payload>" loose-object bytes.
pub trait ObjectStore {
    fn put_object(&self, oid: &ObjectId, data: &[u8]);
    fn get_ref(&self, name: &str) -> Option<ObjectId>;
    fn set_ref(&self, name: &str, oid: &ObjectId);
}

fn store_obj(store: &dyn ObjectStore, kind: &str, payload: &[u8]) -> ObjectId {
    let mut loose = format!("{} {}\0", kind, payload.len()).into_bytes();
    loose.extend_from_slice(payload);
    let oid: ObjectId = Sha1::digest(&loose).into();
    store.put_object(&oid, &loose);
    oid
}

/// Commit `content` as `filename` — blob → tree → commit → ref update.
/// Returns commit oid hex.
pub fn commit_journal_entry(
    store: &dyn ObjectStore,
    filename: &str,
    content: &str,
    author_name: &str,
    message: &str,
) -> String {
    // 1. Blob — payload is the raw file content
    let blob_oid = store_obj(store, "blob", content.as_bytes());

    // 2. Tree — entries are `<mode> <name>\0<20-byte oid>` binary
    let mut tree_payload = Vec::new();
    tree_payload.extend_from_slice(b"100644 ");
    tree_payload.extend_from_slice(filename.as_bytes());
    tree_payload.push(0);
    tree_payload.extend_from_slice(&blob_oid);
    let tree_oid = store_obj(store, "tree", &tree_payload);

    // 3. Commit — canonical text format
    let ts = (ic_cdk::api::time() / 1_000_000_000) as i64;
    let email = format!(
        "{}@connectome.chain",
        author_name.to_lowercase().replace(' ', "")
    );
    let sig = format!("{} <{}> {} +0000", author_name, email, ts);
    let mut commit = format!("tree {}\n", hex::encode(tree_oid));
    if let Some(parent) = store.get_ref("refs/heads/main") {
        commit.push_str(&format!("parent {}\n", hex::encode(parent)));
    }
    commit.push_str(&format!(
        "author {}\ncommitter {}\n\n{}\n",
        sig, sig, message
    ));
    let commit_oid = store_obj(store, "commit", commit.as_bytes());

    store.set_ref("refs/heads/main", &commit_oid);
    hex::encode(commit_oid)
}
