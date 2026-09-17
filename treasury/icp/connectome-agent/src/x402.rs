//! x402 agentic payments — pay HTTP 402 challenges with a signed EIP-3009
//! transferWithAuthorization (gasless USDC). Pattern from widespread-wallet
//! (MIT). The connectome signs typed-data via ICP threshold ECDSA — no gas
//! needed on the settlement chain. All policy checks are deterministic —
//! the LLM cannot bypass them.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct X402Requirements {
    pub scheme: String,
    pub network: String,          // e.g. "arc", "arc-testnet"
    pub max_amount_required: u128,
    pub pay_to: String,
    pub asset: String,            // token address
    pub max_timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct X402Payload {
    pub signature: String,
    pub authorization: Eip3009Authorization,
}

#[derive(Clone, Debug, Serialize)]
pub struct X402Payment {
    pub x402_version: u8,
    pub scheme: String,
    pub network: String,
    pub payload: X402Payload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Eip3009Authorization {
    pub from: String,
    pub to: String,
    pub value: u128,
    pub valid_after: u64,
    pub valid_before: u64,
    pub nonce: String, // 0x + 64 hex
}

#[derive(Debug)]
pub enum X402Error {
    NotAllowed(String),
    TooLarge,
    WrongAsset,
    WrongChain,
    DailyCapExceeded,
    BadResponse,
}

/// Parse the 402 response body into PaymentRequirements.
pub fn parse_requirements(body: &[u8]) -> Result<X402Requirements, X402Error> {
    #[derive(Deserialize)]
    struct Wire {
        accepts: Vec<WireAccept>,
    }
    #[derive(Deserialize)]
    struct WireAccept {
        scheme: String,
        network: String,
        #[serde(rename = "maxAmountRequired")]
        max_amount_required: serde_json::Value,
        #[serde(rename = "payTo")]
        pay_to: String,
        asset: String,
        #[serde(rename = "maxTimeoutSeconds")]
        max_timeout_seconds: Option<u64>,
    }
    let wire: Wire = serde_json::from_slice(body).map_err(|_| X402Error::BadResponse)?;
    let a = wire.accepts.into_iter().next().ok_or(X402Error::BadResponse)?;
    let amount = match &a.max_amount_required {
        serde_json::Value::String(s) => s.parse().unwrap_or(0),
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) as u128,
        _ => 0,
    };
    Ok(X402Requirements {
        scheme: a.scheme,
        network: a.network,
        max_amount_required: amount,
        pay_to: a.pay_to,
        asset: a.asset,
        max_timeout_seconds: a.max_timeout_seconds,
    })
}

/// Deterministic policy gate — the LLM cannot bypass this.
/// payTo must be allowlisted, amount capped, asset + chain approved.
pub fn validate_payment(
    req: &X402Requirements,
    allowed_recipients: &[String],
    max_per_payment: u128,
    approved_tokens: &[String],
    approved_chain_ids: &[u64],
    daily_spent: u128,
    daily_cap: u128,
) -> Result<(), X402Error> {
    if !allowed_recipients.iter().any(|r| r.eq_ignore_ascii_case(&req.pay_to)) {
        return Err(X402Error::NotAllowed(req.pay_to.clone()));
    }
    if req.max_amount_required > max_per_payment {
        return Err(X402Error::TooLarge);
    }
    if !approved_tokens.iter().any(|t| t.eq_ignore_ascii_case(&req.asset)) {
        return Err(X402Error::WrongAsset);
    }
    if daily_spent + req.max_amount_required > daily_cap {
        return Err(X402Error::DailyCapExceeded);
    }
    // network → chain id
    if !approved_chain_ids.contains(&network_chain_id(&req.network)) {
        return Err(X402Error::WrongChain);
    }
    Ok(())
}

pub fn network_chain_id(network: &str) -> u64 {
    match network {
        "arc" | "eip155:5042001" => 5042001,
        "arc-testnet" | "eip155:5042002" => 5042002,
        _ => 0,
    }
}

/// Build the EIP-3009 typed-data message (to be signed by threshold ECDSA).
pub fn build_authorization(
    from: &str,
    req: &X402Requirements,
    nonce: String,
    now_secs: u64,
) -> Eip3009Authorization {
    Eip3009Authorization {
        from: from.to_string(),
        to: req.pay_to.clone(),
        value: req.max_amount_required,
        valid_after: 0,
        valid_before: now_secs + req.max_timeout_seconds.unwrap_or(60),
        nonce,
    }
}

/// Wrap signature + authorization into the X-PAYMENT header value (base64).
pub fn build_x_payment_header(req: &X402Requirements, auth: Eip3009Authorization, signature: String) -> String {
    let payment = X402Payment {
        x402_version: 1,
        scheme: req.scheme.clone(),
        network: req.network.clone(),
        payload: X402Payload { signature, authorization: auth },
    };
    base64_encode(&serde_json::to_vec(&payment).unwrap_or_default())
}

pub fn base64_encode(data: &[u8]) -> String {
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}
