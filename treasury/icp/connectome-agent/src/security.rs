//! Deterministic security layer — the LLM never bypasses this.
//!
//! Layer 2: input sanitization (strip addresses/URLs/base64/Morse before LLM)
//! Layer 3: content validation (anti-shilling — only SYM, no addresses/URLs)
//! Layer 4: transaction validation (contract/function/token allowlists,
//!          amount bounds, rate limits, circuit breaker)
//!
//! OSS: `hanzo-guard` handles PII + prompt-injection detection; `rustrict`
//! handles profanity; `regex` does the deterministic stripping.

use hanzo_guard::config::{InjectionConfig, PiiConfig};
use hanzo_guard::injection::InjectionDetector;
use hanzo_guard::pii::PiiDetector;

/// Sanitize external text (market data, trending posts) before it ever
/// reaches the LLM. Strips every known injection vector.
pub fn sanitize_reply_text(data: &str) -> String {
    let mut clean = data.to_string();

    // hanzo-guard: injection attempt → drop everything
    let detector = InjectionDetector::new(InjectionConfig::default());
    if detector.should_block(&detector.detect(&clean)) {
        return String::new();
    }

    // Contract addresses
    clean = regex_lite::Regex::new(r"0x[0-9a-fA-F]{40}")
        .unwrap().replace_all(&clean, "[ADDR]").to_string();
    // URLs
    clean = regex_lite::Regex::new(r"https?://\S+")
        .unwrap().replace_all(&clean, "[URL]").to_string();
    // base64 payloads
    clean = regex_lite::Regex::new(r"[A-Za-z0-9+/]{40,}={0,2}")
        .unwrap().replace_all(&clean, "[B64]").to_string();
    // Morse code patterns
    clean = regex_lite::Regex::new(r"[\.\-\s]{20,}")
        .unwrap().replace_all(&clean, "[MORSE]").to_string();
    // Unicode escapes / hex escapes
    clean = regex_lite::Regex::new(r"\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}")
        .unwrap().replace_all(&clean, "[ESC]").to_string();

    clean
}

/// Validate LLM-generated content BEFORE it is published anywhere.
/// Deterministic — no model judgement involved.
pub fn validate_post_content(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("Post empty".into());
    }
    if text.len() > 300 {
        return Err("Post too long".into());
    }

    // PII in OUTPUT too (belt & suspenders)
    if !PiiDetector::new(PiiConfig::default())
        .detect(text).is_empty() {
        return Err("Post contains PII".into());
    }

    // No contract addresses — kills the shilling vector dead
    if regex_lite::Regex::new(r"0x[0-9a-fA-F]{40}").unwrap().is_match(text) {
        return Err("Post contains contract address — possible shilling".into());
    }

    // No external URLs
    if regex_lite::Regex::new(r"https?://").unwrap().is_match(text) {
        return Err("Post contains external URL".into());
    }

    // Only $SYM ticker allowed
    let scam_re = regex_lite::Regex::new(r"\$[A-Za-z0-9]{2,10}").unwrap();
    for m in scam_re.find_iter(text) {
        let ticker = &m.as_str()[1..];
        if !ticker.eq_ignore_ascii_case("SYM") {
            return Err(format!("Post mentions unauthorized token: ${}", ticker));
        }
    }

    // No transfer solicitations
    if regex_lite::Regex::new(r"(?i)(send|transfer|donate)\s+(to|funds?)")
        .unwrap().is_match(text)
    {
        return Err("Post contains transfer solicitation language".into());
    }

    // No base64
    if regex_lite::Regex::new(r"[A-Za-z0-9+/]{40,}={0,2}").unwrap().is_match(text) {
        return Err("Post contains possible base64-encoded content".into());
    }

    // Profanity — deterministic blocklist (rustrict vendored for reference;
    // its ~1MB embedded dictionary is too large for the wasm budget)
    static PROFANITY: &[&str] = &[
        "nigger", "faggot", "cunt", "nazi", "hitler", "kike", "spic",
        "chink", "gook", "tranny", "retard", "rape", "pedophil",
    ];
    let lower = text.to_lowercase();
    if PROFANITY.iter().any(|w| lower.contains(w)) {
        return Err("Post contains inappropriate content".into());
    }

    Ok(())
}

/// Per-connectome transaction policy (Layer 4). Deterministic Rust checks —
/// decoded calldata selectors validated via `chaincodec-evm`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, candid::CandidType)]
pub struct ConnectomePolicy {
    pub allowed_contracts: Vec<String>,   // lowercase hex
    pub allowed_selectors: Vec<String>,   // 0x + 8 hex chars
    pub allowed_tokens: Vec<String>,      // lowercase hex
    pub max_amount_per_tx: u128,
    pub max_amount_per_day: u128,
    pub max_tx_per_hour: u32,
    pub max_drawdown_bps: u64,
    pub x402_allowed_recipients: Vec<String>,
    pub x402_max_per_payment: u128,
    pub approved_payment_tokens: Vec<String>,
    pub approved_chain_ids: Vec<u64>,
}

impl Default for ConnectomePolicy {
    fn default() -> Self {
        Self {
            allowed_contracts: vec![],
            allowed_selectors: vec![],
            allowed_tokens: vec![],
            max_amount_per_tx: 0,
            max_amount_per_day: 0,
            max_tx_per_hour: 10,
            max_drawdown_bps: 2000,
            x402_allowed_recipients: vec![],
            x402_max_per_payment: 0,
            approved_payment_tokens: vec![],
            approved_chain_ids: vec![5042001, 5042002], // Arc mainnet + testnet
        }
    }
}

/// Validate a transaction BEFORE signing. `tx` fields are already decoded.
pub struct EvmTx {
    pub to: String,
    pub selector: [u8; 4],
    pub token: Option<String>,
    pub amount: u128,
    pub value: u128,
}

pub fn validate_transaction(
    tx: &EvmTx,
    policy: &ConnectomePolicy,
    daily_spent: u128,
    hourly_tx_count: u32,
    current_drawdown_bps: u64,
) -> Result<(), String> {
    // Destination allowlist
    if !policy.allowed_contracts.iter().any(|c| c.eq_ignore_ascii_case(&tx.to)) {
        return Err(format!("Destination not whitelisted: {}", tx.to));
    }

    // Function selector allowlist (calldata decoded via chaincodec-evm at
    // build time — here we check the 4-byte selector)
    let sel = format!("0x{}", hex::encode(tx.selector));
    if !policy.allowed_selectors.iter().any(|s| s.eq_ignore_ascii_case(&sel)) {
        return Err(format!("Function not whitelisted: {}", sel));
    }

    // Token allowlist (if this is a token-moving call)
    if let Some(token) = &tx.token {
        if !policy.allowed_tokens.iter().any(|t| t.eq_ignore_ascii_case(token)) {
            return Err(format!("Token not whitelisted: {}", token));
        }
    }

    // Amount bounds
    if tx.amount > policy.max_amount_per_tx {
        return Err(format!(
            "Amount {} exceeds per-tx max {}",
            tx.amount, policy.max_amount_per_tx
        ));
    }

    // Daily cumulative limit
    if daily_spent + tx.amount > policy.max_amount_per_day {
        return Err(format!(
            "Daily limit exceeded: {} + {} > {}",
            daily_spent, tx.amount, policy.max_amount_per_day
        ));
    }

    // Rate limiting
    if hourly_tx_count >= policy.max_tx_per_hour {
        return Err("Hourly rate limit exceeded".into());
    }

    // Circuit breaker
    if current_drawdown_bps > policy.max_drawdown_bps {
        return Err(format!(
            "Circuit breaker: drawdown {}bps > max {}bps",
            current_drawdown_bps, policy.max_drawdown_bps
        ));
    }

    Ok(())
}

/// Voice-drift detection (Symbient pattern): stylometric fingerprint vs
/// rolling baseline. Drift > threshold → post held. Catches post-injection
/// style changes (attacker instructions altering the connectome's voice).
pub fn voice_drift_score(text: &str, baseline: &VoiceBaseline) -> f64 {
    let features = extract_features(text);
    let mut sum_sq = 0.0;
    for (f, (mu, sigma)) in features.iter().zip(baseline.means.iter().zip(baseline.stds.iter())) {
        let s = if *sigma > 0.0 { *sigma } else { 1.0 };
        sum_sq += ((f - mu) / s).powi(2);
    }
    sum_sq.sqrt()
}

pub struct VoiceBaseline {
    pub means: [f64; 4],
    pub stds: [f64; 4],
}

/// Stylometric features: [avg sentence len, vocab richness, punctuation rate, emoji rate]
fn extract_features(text: &str) -> [f64; 4] {
    let words: Vec<&str> = text.split_whitespace().collect();
    let sentences = text.split(|c| c == '.' || c == '!' || c == '?')
        .filter(|s| !s.trim().is_empty()).count().max(1);
    let unique: std::collections::HashSet<&&str> = words.iter().collect();
    let punct = text.chars().filter(|c| c.is_ascii_punctuation()).count();
    let emoji = text.chars().filter(|c| !c.is_ascii()).count();
    [
        words.len() as f64 / sentences as f64,
        unique.len() as f64 / words.len().max(1) as f64,
        punct as f64 / text.len().max(1) as f64,
        emoji as f64 / text.len().max(1) as f64,
    ]
}
