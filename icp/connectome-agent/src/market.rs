//! Market data: GeckoTerminal / DexScreener / CoinGecko via ICP HTTPS
//! outcalls, with a fallback chain (reliability.rs) and sanitization
//! (security.rs) before anything reaches the LLM.

use crate::atproto_icp::IcpHttpClient;
use crate::reliability;
use ic_cdk::api::management_canister::http_request::HttpMethod;
use serde::Deserialize;

#[derive(Clone, Debug, Default)]
pub struct MarketData {
    pub price_usd: f64,
    pub volume_h24: f64,
    pub liquidity_usd: f64,
    pub price_change_h24: f64,
}

#[derive(Clone, Debug)]
pub struct PnlRecord {
    pub timestamp: u64,
    pub realized_pnl: i64,
    pub unrealized_pnl: i64,
    pub positions: u32,
}

#[derive(Deserialize)]
struct GeckoTokenResponse {
    data: Option<GeckoData>,
}
#[derive(Deserialize)]
struct GeckoData {
    attributes: Option<GeckoAttrs>,
}
#[derive(Deserialize)]
struct GeckoAttrs {
    price_usd: Option<String>,
    volume_usd: Option<GeckoVolume>,
    total_reserve_in_usd: Option<String>,
    price_change_percentage: Option<GeckoChange>,
}
#[derive(Deserialize)]
struct GeckoVolume {
    h24: Option<String>,
}
#[derive(Deserialize)]
struct GeckoChange {
    h24: Option<String>,
}

/// Token address on Arc — set via admin call; defaults to empty.
pub async fn fetch_market_data(network: &str, token: &str) -> Result<MarketData, String> {
    // Fallback chain: GeckoTerminal → DexScreener (reliability.rs pattern)
    match fetch_geckoterminal(network, token).await {
        Ok(m) => Ok(m),
        Err(e1) => fetch_dexscreener(token).await
            .map_err(|e2| format!("gecko: {}; dexscreener: {}", e1, e2)),
    }
}

async fn fetch_geckoterminal(network: &str, token: &str) -> Result<MarketData, String> {
    let client = IcpHttpClient::new("https://api.geckoterminal.com");
    let path = format!("/api/v2/networks/{}/tokens/{}", network, token);
    let parsed: GeckoTokenResponse = client
        .get_json(&path, vec![("Accept".into(), "application/json".into())])
        .await?;
    let attrs = parsed
        .data
        .and_then(|d| d.attributes)
        .ok_or("gecko: no attributes")?;
    Ok(MarketData {
        price_usd: attrs.price_usd.and_then(|v| v.parse().ok()).unwrap_or(0.0),
        volume_h24: attrs
            .volume_usd
            .and_then(|v| v.h24)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
        liquidity_usd: attrs
            .total_reserve_in_usd
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
        price_change_h24: attrs
            .price_change_percentage
            .and_then(|c| c.h24)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0),
    })
}

async fn fetch_dexscreener(token: &str) -> Result<MarketData, String> {
    let client = IcpHttpClient::new("https://api.dexscreener.com");
    let path = format!("/latest/dex/tokens/{}", token);
    let parsed: serde_json::Value = client
        .get_json(&path, vec![("Accept".into(), "application/json".into())])
        .await?;
    let pair = parsed["pairs"]
        .as_array()
        .and_then(|p| p.first())
        .cloned()
        .ok_or("dexscreener: no pairs")?;
    Ok(MarketData {
        price_usd: pair["priceUsd"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0.0),
        volume_h24: pair["volume"]["h24"].as_f64().unwrap_or(0.0),
        liquidity_usd: pair["liquidity"]["usd"].as_f64().unwrap_or(0.0),
        price_change_h24: pair["priceChange"]["h24"].as_f64().unwrap_or(0.0),
    })
}

/// Generic HTTPS outcall for paid/x402 endpoints.
pub async fn http_outcall_get(url: &str) -> Result<(u16, Vec<u8>), String> {
    let client = IcpHttpClient::new("");
    let (scheme_rest) = url.strip_prefix("https://").ok_or("https only")?;
    let slash = scheme_rest.find('/').unwrap_or(scheme_rest.len());
    let base = format!("https://{}", &scheme_rest[..slash]);
    let path = &scheme_rest[slash.min(scheme_rest.len())..];
    let client = IcpHttpClient::new(&base);
    client.send(HttpMethod::GET, path, vec![], None, 2_000_000).await
}

pub async fn http_outcall_get_with_header(
    url: &str,
    header: &str,
    value: &str,
) -> Result<(u16, Vec<u8>), String> {
    let rest = url.strip_prefix("https://").ok_or("https only")?;
    let slash = rest.find('/').unwrap_or(rest.len());
    let base = format!("https://{}", &rest[..slash]);
    let path = &rest[slash.min(rest.len())..];
    let client = IcpHttpClient::new(&base);
    client
        .send(HttpMethod::GET, path, vec![(header.to_string(), value.to_string())], None, 2_000_000)
        .await
}
