//! Multi-platform adapters: ATProto (Bluesky + Blacksky + Eurosky PDSes),
//! custom flyai.connectome.* lexicons, Nostr (secp256k1 — same curve as the
//! threshold ECDSA wallet, no registration needed), Mastodon (ActivityPub,
//! programmatic registration). All HTTP via the ICP outcall adapter.

use crate::atproto_icp::IcpHttpClient;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, candid::CandidType)]
pub struct AtpSession {
    pub did: String,
    pub handle: String,
    pub access_jwt: String,
    pub refresh_jwt: String,
    pub pds: String, // e.g. "https://bsky.social"
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, candid::CandidType)]
pub struct ConnectomeIdentity {
    pub did: String,
    pub bsky_session: Option<AtpSession>,
    pub blacksky_session: Option<AtpSession>,
    pub eurosky_session: Option<AtpSession>,
    pub mastodon_session: Option<MastodonSession>,
    pub nostr_pubkey: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, candid::CandidType)]
pub struct MastodonSession {
    pub instance: String,
    pub access_token: String,
    pub acct: String,
}

// ============ ATProto ============

/// Create an ATProto account on any PDS via com.atproto.server.createAccount.
pub async fn create_atproto_account(
    pds: &str,
    handle: &str,
    password: &str,
    email: Option<&str>,
) -> Result<AtpSession, String> {
    let client = IcpHttpClient::new(pds);
    let mut body = serde_json::json!({ "handle": handle, "password": password });
    if let Some(e) = email {
        body["email"] = serde_json::Value::String(e.to_string());
    }
    let resp: serde_json::Value = client
        .post_json("/xrpc/com.atproto.server.createAccount", body.to_string().as_bytes(), vec![])
        .await?;
    Ok(AtpSession {
        did: resp["did"].as_str().unwrap_or("").to_string(),
        handle: handle.to_string(),
        access_jwt: resp["accessJwt"].as_str().unwrap_or("").to_string(),
        refresh_jwt: resp["refreshJwt"].as_str().unwrap_or("").to_string(),
        pds: pds.to_string(),
    })
}

/// Refresh an expired session via com.atproto.server.refreshSession.
pub async fn refresh_session(sess: &AtpSession) -> Result<AtpSession, String> {
    let client = IcpHttpClient::new(&sess.pds);
    let resp: serde_json::Value = client
        .post_json(
            "/xrpc/com.atproto.server.refreshSession",
            b"{}",
            vec![("Authorization".into(), format!("Bearer {}", sess.refresh_jwt))],
        )
        .await?;
    Ok(AtpSession {
        access_jwt: resp["accessJwt"].as_str().unwrap_or("").to_string(),
        refresh_jwt: resp["refreshJwt"].as_str().unwrap_or("").to_string(),
        ..sess.clone()
    })
}

/// Post a record to any collection — covers app.bsky.feed.post plus our
/// custom flyai.connectome.* lexicons and platform lexicons (Frontpage,
/// Leaflet, Whitewind, Smoke Signal).
pub async fn create_record(
    sess: &AtpSession,
    collection: &str,
    record: serde_json::Value,
) -> Result<String, String> {
    let client = IcpHttpClient::new(&sess.pds);
    let body = serde_json::json!({
        "repo": sess.did,
        "collection": collection,
        "record": record,
    });
    let resp: serde_json::Value = client
        .post_json(
            "/xrpc/com.atproto.repo.createRecord",
            body.to_string().as_bytes(),
            vec![("Authorization".into(), format!("Bearer {}", sess.access_jwt))],
        )
        .await?;
    resp["uri"].as_str().map(|s| s.to_string()).ok_or_else(|| "no uri".into())
}

/// Simple Bluesky post.
pub async fn post_to_bluesky(sess: &AtpSession, text: &str) -> Result<String, String> {
    create_record(
        sess,
        "app.bsky.feed.post",
        serde_json::json!({
            "text": text,
            "createdAt": now_rfc3339(),
        }),
    )
    .await
}

/// Reply to a post (inter-connectome social graph + community).
pub async fn post_reply(
    sess: &AtpSession,
    parent_uri: &str,
    parent_cid: &str,
    text: &str,
) -> Result<String, String> {
    create_record(
        sess,
        "app.bsky.feed.post",
        serde_json::json!({
            "text": text,
            "reply": { "parent": { "uri": parent_uri, "cid": parent_cid },
                       "root": { "uri": parent_uri, "cid": parent_cid } },
            "createdAt": now_rfc3339(),
        }),
    )
    .await
}

/// Fetch engagement counts for a post — COUNTS only, never reply text
/// (reply content is a prompt-injection vector; see security.rs).
pub async fn fetch_engagement(sess: &AtpSession, uri: &str) -> Result<(u64, u64, u64), String> {
    let client = IcpHttpClient::new(&sess.pds);
    let resp: serde_json::Value = client
        .get_json(
            &format!("/xrpc/app.bsky.feed.getPostThread?uri={}&depth=0", uri),
            vec![("Authorization".into(), format!("Bearer {}", sess.access_jwt))],
        )
        .await?;
    let post = &resp["thread"]["post"];
    Ok((
        post["likeCount"].as_u64().unwrap_or(0),
        post["repostCount"].as_u64().unwrap_or(0),
        post["replyCount"].as_u64().unwrap_or(0),
    ))
}

/// Fetch recent mentions — returns (uri, cid, sanitized text) tuples.
/// Text is sanitized in-place before returning (injection never stored).
pub async fn fetch_mentions(sess: &AtpSession, limit: u32) -> Result<Vec<(String, String, String)>, String> {
    let client = IcpHttpClient::new(&sess.pds);
    let resp: serde_json::Value = client
        .get_json(
            &format!("/xrpc/app.bsky.notification.listNotifications?limit={}", limit),
            vec![("Authorization".into(), format!("Bearer {}", sess.access_jwt))],
        )
        .await?;
    let mut out = Vec::new();
    if let Some(notifs) = resp["notifications"].as_array() {
        for n in notifs {
            if n["reason"].as_str() != Some("mention") && n["reason"].as_str() != Some("reply") {
                continue;
            }
            let uri = n["uri"].as_str().unwrap_or("").to_string();
            let cid = n["cid"].as_str().unwrap_or("").to_string();
            let text = crate::security::sanitize_reply_text(
                n["record"]["text"].as_str().unwrap_or(""),
            );
            if !uri.is_empty() {
                out.push((uri, cid, text));
            }
        }
    }
    Ok(out)
}

/// Search Bluesky posts — returns sanitized texts only (feed to LLM).
pub async fn search_posts(sess: &AtpSession, query: &str, limit: u32) -> Result<Vec<String>, String> {
    let client = IcpHttpClient::new(&sess.pds);
    let resp: serde_json::Value = client
        .get_json(
            &format!("/xrpc/app.bsky.feed.searchPosts?q={}&limit={}", query, limit),
            vec![("Authorization".into(), format!("Bearer {}", sess.access_jwt))],
        )
        .await?;
    let mut out = Vec::new();
    if let Some(posts) = resp["posts"].as_array() {
        for p in posts {
            let text = crate::security::sanitize_reply_text(
                p["record"]["text"].as_str().unwrap_or(""),
            );
            if !text.is_empty() {
                out.push(text);
            }
        }
    }
    Ok(out)
}

/// Custom connectome lexicon records — transparent cognition as queryable data.
pub async fn publish_connectome_record(
    sess: &AtpSession,
    collection: &str, // e.g. "flyai.connectome.thought"
    record: serde_json::Value,
) -> Result<String, String> {
    create_record(sess, collection, record).await
}

// ============ Mastodon (ActivityPub) — programmatic registration ============

pub async fn register_mastodon_account(
    instance: &str,
    username: &str,
    email: &str,
    password: &str,
) -> Result<MastodonSession, String> {
    let client = IcpHttpClient::new(instance);

    // 1. Register the app
    let app: serde_json::Value = client
        .post_json(
            "/api/v1/apps",
            serde_json::json!({
                "client_name": format!("{}-connectome", username),
                "redirect_uris": "urn:ietf:wg:oauth:2.0:oob",
                "scopes": "write read",
            }).to_string().as_bytes(),
            vec![],
        )
        .await?;
    let client_id = app["client_id"].as_str().ok_or("no client_id")?;
    let client_secret = app["client_secret"].as_str().ok_or("no client_secret")?;

    // 2. Create the account
    let _: serde_json::Value = client
        .post_json(
            "/api/v1/accounts",
            serde_json::json!({
                "username": username, "email": email,
                "password": password, "agreement": true, "locale": "en",
            }).to_string().as_bytes(),
            vec![],
        )
        .await?;

    // 3. OAuth password grant
    let token: serde_json::Value = client
        .post_json(
            "/oauth/token",
            serde_json::json!({
                "grant_type": "password", "client_id": client_id,
                "client_secret": client_secret, "username": email,
                "password": password, "scope": "write read",
            }).to_string().as_bytes(),
            vec![],
        )
        .await?;

    Ok(MastodonSession {
        instance: instance.to_string(),
        access_token: token["access_token"].as_str().unwrap_or("").to_string(),
        acct: username.to_string(),
    })
}

pub async fn post_to_mastodon(sess: &MastodonSession, text: &str) -> Result<(), String> {
    let client = IcpHttpClient::new(&sess.instance);
    let _: serde_json::Value = client
        .post_json(
            "/api/v1/statuses",
            serde_json::json!({ "status": text }).to_string().as_bytes(),
            vec![("Authorization".into(), format!("Bearer {}", sess.access_token))],
        )
        .await?;
    Ok(())
}

// ============ Nostr — secp256k1, same curve as threshold ECDSA ============

/// A Nostr kind-1 (short text) event, ready for signing + relay publish.
#[derive(Clone, Debug, Serialize)]
pub struct NostrEvent {
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sig: String,
}

/// Build the event id = sha256 of the serialized commitment — the canister
/// signs this with its threshold ECDSA secp256k1 key.
pub fn nostr_event_id(event: &NostrEvent) -> Vec<u8> {
    let commitment = serde_json::json!([
        0, event.pubkey, event.created_at, event.kind, event.tags, event.content
    ]);
    sha256(commitment.to_string().as_bytes())
}

pub fn build_nostr_post(pubkey: &str, content: &str) -> NostrEvent {
    NostrEvent {
        pubkey: pubkey.to_string(),
        created_at: ic_cdk::api::time() / 1_000_000_000,
        kind: 1,
        tags: vec![],
        content: content.to_string(),
        id: String::new(),
        sig: String::new(),
    }
}

/// Publish a signed event to a relay via its HTTP endpoint (NIP-11/relay REST)
/// or simply log — relays speak WebSocket, which canisters can't hold; use an
/// HTTP gateway relay or the publish over nostr REST bridges.
pub async fn publish_to_relay_http(relay_url: &str, event: &NostrEvent) -> Result<(), String> {
    let client = IcpHttpClient::new(relay_url);
    let body = serde_json::json!(["EVENT", event]);
    let _: serde_json::Value = client
        .post_json("/", body.to_string().as_bytes(), vec![])
        .await?;
    Ok(())
}

fn now_rfc3339() -> String {
    // Canister time → RFC3339 (approx; no chrono needed)
    let secs = ic_cdk::api::time() / 1_000_000_000;
    epoch_to_rfc3339(secs)
}

fn epoch_to_rfc3339(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let (y, m, d) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // civil-from-days algorithm (Howard Hinnant)
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn sha256(data: &[u8]) -> Vec<u8> {
    // Minimal SHA-256 (no_std-safe, no external dep needed for one hash)
    const K: [u32; 64] = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    let mut msg = data.to_vec();
    let bitlen = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 { msg.push(0); }
    msg.extend_from_slice(&bitlen.to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 { w[i] = u32::from_be_bytes([block[i*4], block[i*4+1], block[i*4+2], block[i*4+3]]); }
        for i in 16..64 {
            let s0 = w[i-15].rotate_right(7) ^ w[i-15].rotate_right(18) ^ (w[i-15] >> 3);
            let s1 = w[i-2].rotate_right(17) ^ w[i-2].rotate_right(19) ^ (w[i-2] >> 10);
            w[i] = w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(t1); d = c; c = b; b = a; a = t1.wrapping_add(t2);
        }
        h[0]=h[0].wrapping_add(a); h[1]=h[1].wrapping_add(b); h[2]=h[2].wrapping_add(c); h[3]=h[3].wrapping_add(d);
        h[4]=h[4].wrapping_add(e); h[5]=h[5].wrapping_add(f); h[6]=h[6].wrapping_add(g); h[7]=h[7].wrapping_add(hh);
    }
    let mut out = Vec::with_capacity(32);
    for v in h { out.extend_from_slice(&v.to_be_bytes()); }
    out
}
