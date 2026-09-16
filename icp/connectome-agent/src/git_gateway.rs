//! Git smart-HTTP gateway served by the canister's HTTP gateway.
//! Routes: /<conn>/journal.git/info/refs and /<conn>/journal.git/git-upload-pack.
//! Objects live in stable memory (GIT_OBJECTS/GIT_REFS in lib.rs); this module
//! is pure protocol glue — pkt-line framing + packfile response assembly.

pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Object store interface — lib.rs provides the stable-memory impl.
pub trait GitStore {
    fn get_ref(&self, repo: &str, name: &str) -> Option<[u8; 20]>;
    fn get_object(&self, repo: &str, oid: &[u8; 20]) -> Option<Vec<u8>>;
    fn list_refs(&self, repo: &str) -> Vec<(String, [u8; 20])>;
}

pub fn handle(path: &str, body: &[u8], store: &dyn GitStore) -> HttpResponse {
    let (repo, tail) = match split_repo(path) {
        Some(v) => v,
        None => return not_found(),
    };
    if tail.starts_with("/info/refs") {
        handle_info_refs(repo, store)
    } else if tail.starts_with("/git-upload-pack") {
        handle_upload_pack(repo, body, store)
    } else {
        not_found()
    }
}

fn split_repo(path: &str) -> Option<(&str, &str)> {
    // /<conn>/journal.git/...
    let idx = path.find("/journal.git")?;
    let repo = &path[1..idx];
    Some((repo, &path[idx + "/journal.git".len()..]))
}

fn handle_info_refs(repo: &str, store: &dyn GitStore) -> HttpResponse {
    let mut out = Vec::new();
    out.extend(pkt_line(b"# service=git-upload-pack\n"));
    out.extend(pkt_line(b"")); // flush
    for (name, oid) in store.list_refs(repo) {
        out.extend(pkt_line(
            format!("{} {}\n", hex::encode(oid), name).as_bytes(),
        ));
    }
    if let Some(head) = store.get_ref(repo, "refs/heads/main") {
        out.extend(pkt_line(
            format!("{} HEAD\n", hex::encode(head)).as_bytes(),
        ));
    }
    out.extend(pkt_line(b"")); // flush
    HttpResponse {
        status_code: 200,
        headers: vec![(
            "Content-Type".into(),
            "application/x-git-upload-pack-advertisement".into(),
        )],
        body: out,
    }
}

fn handle_upload_pack(repo: &str, body: &[u8], store: &dyn GitStore) -> HttpResponse {
    // Parse "want <sha>" lines
    let wants: Vec<String> = String::from_utf8_lossy(body)
        .lines()
        .filter_map(|l| l.strip_prefix("want ").map(|s| s[..40].to_string()))
        .collect();

    // Collect all reachable objects (walk commits/trees/blobs from wants)
    let objects = collect_reachable(repo, &wants, store);

    let mut resp = Vec::new();
    for w in &wants {
        resp.extend(pkt_line(format!("ACK {} common\n", w).as_bytes()));
    }
    resp.extend(pkt_line(b""));
    resp.extend(objects);
    HttpResponse {
        status_code: 200,
        headers: vec![(
            "Content-Type".into(),
            "application/x-git-upload-pack-result".into(),
        )],
        body: resp,
    }
}

fn collect_reachable(repo: &str, wants: &[String], store: &dyn GitStore) -> Vec<u8> {
    let mut pack = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<[u8; 20]> = wants
        .iter()
        .filter_map(|w| hex::decode(w).ok().and_then(|v| <[u8; 20]>::try_from(v.as_slice()).ok()))
        .collect();
    while let Some(oid) = stack.pop() {
        if !seen.insert(oid) {
            continue;
        }
        if let Some(raw) = store.get_object(repo, &oid) {
            // Walk parent/tree references — objects stored as raw git payloads
            for parent in extract_referenced_oids(&raw) {
                if !seen.contains(&parent) {
                    stack.push(parent);
                }
            }
            pack.extend_from_slice(&raw);
        }
    }
    pack
}

/// Extract referenced object ids (tree sha + parent shas) from a raw commit,
/// or entry ids from a raw tree. Best-effort binary parse.
fn extract_referenced_oids(raw: &[u8]) -> Vec<[u8; 20]> {
    let mut refs = Vec::new();
    let text = String::from_utf8_lossy(raw);
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("tree ") {
            if let Some(oid) = decode_oid(rest) {
                refs.push(oid);
            }
        } else if let Some(rest) = line.strip_prefix("parent ") {
            if let Some(oid) = decode_oid(rest) {
                refs.push(oid);
            }
        }
    }
    // Tree entries: <mode> <name>\0<20-byte oid> — scan for the binary layout
    let mut i = 0;
    while i + 21 < raw.len() && raw[i] != 0 {
        i += 1;
        // after a NUL, next 20 bytes are an oid
        if i + 20 <= raw.len() && raw[i - 1] == 0 {
            refs.push(<[u8; 20]>::try_from(&raw[i..i + 20]).unwrap());
            i += 20;
        }
    }
    refs
}

fn decode_oid(hexs: &str) -> Option<[u8; 20]> {
    let v = hex::decode(hexs.trim()).ok()?;
    <[u8; 20]>::try_from(v.as_slice()).ok()
}

fn pkt_line(data: &[u8]) -> Vec<u8> {
    if data.is_empty() {
        return b"0000".to_vec();
    }
    let mut out = format!("{:04x}", data.len() + 4).into_bytes();
    out.extend_from_slice(data);
    out
}

fn not_found() -> HttpResponse {
    HttpResponse {
        status_code: 404,
        headers: vec![],
        body: b"not found".to_vec(),
    }
}
