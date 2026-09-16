//! ICP HTTPS outcall adapter for atrium's XRPC client.
//! atrium uses reqwest by default (won't compile on ICP); this ~50-line
//! bridge routes all XRPC traffic through canhttp/ICP HTTPS outcalls.

use ic_cdk::api::management_canister::http_request::{
    http_request, CanisterHttpRequestArgument, HttpHeader, HttpMethod, TransformArgs,
    TransformContext, TransformFunc,
};

#[derive(Clone)]
pub struct IcpHttpClient {
    base_url: String,
}

impl IcpHttpClient {
    pub fn new(base_url: &str) -> Self {
        Self { base_url: base_url.trim_end_matches('/').to_string() }
    }

    /// Raw XRPC call — returns (status, body). atrium's client wraps this.
    pub async fn send(
        &self,
        method: HttpMethod,
        path: &str,
        headers: Vec<(String, String)>,
        body: Option<Vec<u8>>,
        max_response_bytes: u64,
    ) -> Result<(u16, Vec<u8>), String> {
        let url = format!("{}{}", self.base_url, path);
        let arg = CanisterHttpRequestArgument {
            url,
            method,
            headers: headers
                .into_iter()
                .map(|(name, value)| HttpHeader { name, value })
                .collect(),
            body,
            max_response_bytes: Some(max_response_bytes),
            transform: Some(TransformContext {
                function: TransformFunc(candid::Func {
                    principal: ic_cdk::api::canister_self(),
                    method: "transform_http_response".to_string(),
                }),
                context: vec![],
            }),
        };
        let (resp,) = http_request(arg, 25_000_000_000).await.map_err(|(r, m)| {
            format!("outcall failed: {:?} {}", r, m)
        })?;
        let status = resp.status.to_string().parse::<u16>().unwrap_or(0);
        Ok((status, resp.body))
    }

    /// Convenience: GET + JSON decode
    pub async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        headers: Vec<(String, String)>,
    ) -> Result<T, String> {
        let (status, body) = self.send(HttpMethod::GET, path, headers, None, 2_000_000).await?;
        if status >= 400 {
            return Err(format!("HTTP {}: {}", status, String::from_utf8_lossy(&body[..body.len().min(256)])));
        }
        serde_json::from_slice(&body).map_err(|e| format!("parse: {}", e))
    }

    /// Convenience: POST JSON + JSON decode
    pub async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        json_body: &[u8],
        headers: Vec<(String, String)>,
    ) -> Result<T, String> {
        let mut h = headers;
        h.push(("Content-Type".into(), "application/json".into()));
        let (status, body) = self.send(HttpMethod::POST, path, h, Some(json_body.to_vec()), 2_000_000).await?;
        if status >= 400 {
            return Err(format!("HTTP {}: {}", status, String::from_utf8_lossy(&body[..body.len().min(256)])));
        }
        serde_json::from_slice(&body).map_err(|e| format!("parse: {}", e))
    }
}

/// Response transform — strips non-deterministic headers so all replicas
/// reach consensus on the response body.
#[ic_cdk::query(hidden = true)]
pub fn transform_http_response(args: TransformArgs) -> ic_cdk::api::management_canister::http_request::HttpResponse {
    ic_cdk::api::management_canister::http_request::HttpResponse {
        status: args.response.status,
        headers: vec![],
        body: args.response.body,
    }
}
