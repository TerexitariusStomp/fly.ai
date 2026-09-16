//! Retry-with-backoff + token-bucket rate limiter + fallback adapter chain.
//! Patterns from widespread-wallet (MIT), reimplemented in ~40 lines of Rust.
//!
//! Rules:
//! - Retry idempotent reads only — NEVER retry tx broadcasts (double-submit).
//! - Token bucket prevents API throttling (Bluesky, RPC, outcalls).
//! - Fallback chain: first non-error adapter wins.

/// Exponential backoff with jitter, for idempotent HTTPS reads only.
/// Never wrap transaction broadcasts — double-submit risk.
pub async fn retry_read<T, E, F, Fut>(mut f: F, max_attempts: u32) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: core::future::Future<Output = Result<T, E>>,
{
    let mut delay_ms: u64 = 250;
    let mut last_err: Option<E> = None;
    for _ in 0..max_attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = Some(e);
                // jitter: 0-100% of delay added, derived from canister time
                let jitter = (ic_cdk::api::time() % 1000) as u64 * delay_ms / 1000;
                sleep_ns((delay_ms + jitter) * 1_000_000).await;
                delay_ms = (delay_ms * 2).min(8_000);
            }
        }
    }
    Err(last_err.unwrap())
}

/// Token-bucket rate limiter. One instance per resource
/// (bluesky_api, market_data, per-connectome posting).
pub struct RateLimiter {
    capacity: f64,
    tokens: f64,
    refill_per_sec: f64,
    last_refill_ns: u64,
}

impl RateLimiter {
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            capacity,
            tokens: capacity,
            refill_per_sec,
            last_refill_ns: ic_cdk::api::time(),
        }
    }

    /// Returns true and consumes a token if available; false if throttled.
    pub fn try_acquire(&mut self) -> bool {
        let now = ic_cdk::api::time();
        let elapsed_s = (now - self.last_refill_ns) as f64 / 1e9;
        self.tokens = (self.tokens + elapsed_s * self.refill_per_sec).min(self.capacity);
        self.last_refill_ns = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// ICP-native async sleep: one-shot timer resolving a oneshot channel.
async fn sleep_ns(nanos: u64) {
    let (tx, rx) = futures::channel::oneshot::channel::<()>();
    ic_cdk_timers::set_timer(std::time::Duration::from_nanos(nanos), move || {
        let _ = tx.send(());
    });
    let _ = rx.await;
}

/// Fallback adapter chain: try each source in order, first success wins.
/// Market data: GeckoTerminal → DexScreener → CoinGecko.
pub async fn first_ok<T, E, I, F, Fut>(sources: I) -> Result<T, E>
where
    I: IntoIterator<Item = F>,
    F: FnMut() -> Fut,
    Fut: core::future::Future<Output = Result<T, E>>,
    E: core::fmt::Debug,
{
    let mut last_err: Option<E> = None;
    for mut f in sources {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap())
}
