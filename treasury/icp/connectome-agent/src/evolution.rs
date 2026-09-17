//! Self-improvement loop — wires 5 OSS libraries into one cycle:
//!   indicators-ta     → market regime detection (HMM + ensemble)
//!   ta-statistics     → rolling P&L / engagement stats
//!   rl-bandit         → UCB1 personality-variant selection
//!   ic-llm            → LLM generates variants + thoughts in-voice
//!   ab-testing        → chi-squared significance gate before promotion
//!   genetic_algorithms→ evolve strategy params within bounds
//!
//! The LLM only proposes — promotion requires p<0.05 statistical
//! significance, and all params stay within admin-set bounds.

use crate::{PersonalityProfile, StrategyParams};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct VariantMetrics {
    pub successes: u64,
    pub total: u64,
}

impl VariantMetrics {
    pub fn rate(&self) -> f64 {
        if self.total == 0 { 0.0 } else { self.successes as f64 / self.total as f64 }
    }
}

/// Detected market regime → strategy adaptation (surpasses AEGIS HMM).
pub fn regime_to_strategy(regime: &str) -> &'static str {
    match regime {
        "Trending" => "trend_following",
        "MeanReverting" => "mean_reversion",
        "Volatile" => "reduced_exposure",
        _ => "stay_cash",
    }
}

/// Fitness for the strategy-param GA: weighted P&L + engagement − drawdown.
pub fn fitness(pnl: f64, engagement: f64, max_drawdown: f64) -> f64 {
    pnl * 0.5 + engagement * 0.3 - max_drawdown * 0.2
}

/// Clamp GA output back inside the admin-set bounds before applying —
/// the GA explores, it never escapes the safety envelope.
pub fn clamp_params(chromosome: &[f64], bounds: &StrategyBounds) -> StrategyParamPatch {
    StrategyParamPatch {
        confidence_threshold: chromosome[0].clamp(bounds.conf_min, bounds.conf_max) as u8,
        risk_tolerance: chromosome[1].clamp(bounds.risk_min, bounds.risk_max) as u8,
        post_frequency_minutes: chromosome[2].clamp(bounds.freq_min, bounds.freq_max) as u32,
        trade_size_pct: chromosome[3].clamp(bounds.size_min, bounds.size_max) as u8,
    }
}

pub struct StrategyBounds {
    pub conf_min: f64, pub conf_max: f64,
    pub risk_min: f64, pub risk_max: f64,
    pub freq_min: f64, pub freq_max: f64,
    pub size_min: f64, pub size_max: f64,
}

impl Default for StrategyBounds {
    fn default() -> Self {
        Self {
            conf_min: 30.0, conf_max: 95.0,
            risk_min: 1.0, risk_max: 90.0,
            freq_min: 30.0, freq_max: 480.0,
            size_min: 1.0, size_max: 25.0,
        }
    }
}

pub struct StrategyParamPatch {
    pub confidence_threshold: u8,
    pub risk_tolerance: u8,
    pub post_frequency_minutes: u32,
    pub trade_size_pct: u8,
}

/// The LLM prompt for one evolution cycle — performance data in, JSON out.
pub fn evolution_prompt(
    profile: &PersonalityProfile,
    regime: &str,
    regime_strategy: &str,
    pnl_mean: f64,
    pnl_std: f64,
    pnl_drawdown: f64,
    eng_mean: f64,
    eng_trend: f64,
    selected_variant: &str,
) -> String {
    format!(
        "Market regime: {} (strategy: {})\n\
         Performance: P&L mean={:.2}%, std={:.2}%, max_drawdown={:.2}%\n\
         Engagement: mean={:.1}/post, trend={:.3}/hr\n\
         Current personality variant: {}\n\
         Generate JSON: {{\"new_system_prompt\": \"...\", \"thought\": \"...\", \"strategy_note\": \"...\"}}\n\
         The new_system_prompt should be a refined version of your personality that might engage better. \
         Keep your core identity but adjust tone, style, or emphasis based on what's working.",
        regime, regime_strategy,
        pnl_mean, pnl_std, pnl_drawdown, eng_mean, eng_trend, selected_variant,
    )
    .replace("{species}", &profile.species) // species is already in system_prompt
}

/// Chi-squared significance gate — ab-testing crate does the math; we wrap
/// the decision. p<0.05 AND higher rate → promote the variant.
pub struct ChiSqResult {
    pub p_value: f64,
}

pub fn should_promote(result: &ChiSqResult, control: &VariantMetrics, variant: &VariantMetrics) -> bool {
    result.p_value < 0.05 && variant.rate() > control.rate()
}

// ============================================================================
// Full evolution cycle — the real OSS chain
// ============================================================================

use std::cell::RefCell;
use rl_bandit::bandit::Bandit;

thread_local! {
    /// UCB bandit per connectome — internal arm stats aren't serializable,
    /// so the bandit lives in heap memory and is reconstructed from
    /// VariantMetrics on first use after an upgrade.
    static BANDITS: RefCell<std::collections::HashMap<String, rl_bandit::bandits::ucb::UCB>> =
        RefCell::new(std::collections::HashMap::new());
}

pub struct EvolutionOutcome {
    pub regime: String,
    pub regime_strategy: String,
    pub variant_chosen: usize,
    pub new_system_prompt: String,
    pub thought: String,
    pub promoted: bool,
    pub param_patch: StrategyParamPatch,
}

/// Bandit reward = normalized engagement for that variant.
fn reward_for(m: &VariantMetrics) -> f64 { m.rate() }

/// The full self-improvement run for one connectome.
/// `variants` — engagement metrics per personality variant (index = arm)
/// `prices` — recent (high, low, close) triples for regime detection
/// `pnl` — realized+unrealized P&L series
/// `engagement` — per-post engagement series
pub async fn run(
    cid: &str,
    profile: &PersonalityProfile,
    variants: &[VariantMetrics],
    prices: &[(f64, f64, f64)],
    pnl: &[f64],
    engagement: &[f64],
    bounds: &StrategyBounds,
    model: &str,
) -> Result<EvolutionOutcome, String> {
    // ---- 1. Market regime via indicators-ta ensemble (HMM + indicators) ----
    let mut det = indicators::EnsembleRegimeDetector::default_config();
    let mut regime = indicators::MarketRegime::Uncertain;
    for &(h, l, c) in prices {
        let r = det.update(h, l, c);
        regime = r.regime;
    }
    let regime_name = match regime {
        indicators::MarketRegime::Trending(_) => "Trending",
        indicators::MarketRegime::MeanReverting => "MeanReverting",
        indicators::MarketRegime::Volatile => "Volatile",
        indicators::MarketRegime::Uncertain => "Uncertain",
    }
    .to_string();
    let regime_strategy = regime_to_strategy(&regime_name);

    // ---- 2. Rolling stats via ta-statistics (P&L) + local (engagement) ----
    let pnl_stats = {
        let mut m = ta_statistics::SingleStatistics::<f64>::new(24);
        for &v in pnl { m.next(v); }
        stats::RollingStats {
            mean: m.mean().unwrap_or(0.0),
            std: m.stddev().unwrap_or(0.0),
            max_drawdown: m.max_drawdown().unwrap_or(0.0),
            ..stats::compute(pnl)
        }
    };
    let eng_stats = stats::compute(engagement);

    // ---- 3. Bandit picks which variant arm to pull (explore/exploit) ----
    let n_arms = variants.len().max(2);
    let chosen = BANDITS.with(|bs| {
        let mut map = bs.borrow_mut();
        let bandit = map
            .entry(cid.to_string())
            .or_insert_with(|| rl_bandit::bandits::ucb::UCB::new(n_arms, 2.0));
        // Feed the latest observed rewards so exploration counts stay fresh
        for (i, m) in variants.iter().enumerate() {
            bandit.update(i, reward_for(m));
        }
        bandit.choose() as usize
    });

    // ---- 4. LLM generates a personality variant for the chosen arm ----
    let variant_name = format!("variant-{}", chosen);
    let prompt = evolution_prompt(
        profile, &regime_name, regime_strategy,
        pnl_stats.mean, pnl_stats.std, pnl_stats.max_drawdown,
        eng_stats.mean, eng_stats.trend_slope, &variant_name,
    );
    let response = ic_llm::chat(model)
        .with_messages(vec![
            ic_llm::ChatMessage::System { content: profile.system_prompt.clone() },
            ic_llm::ChatMessage::User { content: prompt },
        ])
        .send()
        .await;
    let raw = response.message.content.unwrap_or_default();
    let parsed: serde_json::Value =
        serde_json::from_str(raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim())
            .unwrap_or(serde_json::json!({}));
    let new_prompt = parsed["new_system_prompt"].as_str().unwrap_or("").to_string();
    let thought = parsed["thought"].as_str().unwrap_or("").to_string();

    // ---- 5. A/B significance gate before promotion (ab-testing) ----
    let promoted = if variants.len() >= 2 && !new_prompt.is_empty() {
        let control = &variants[0];
        let variant = variants.get(chosen).unwrap_or(control);
        let mut exp = ab_testing::Experiment::new("personality-variant");
        exp.add_variant(
            ab_testing::Variant::new("control")
                .with_conversion(control.successes as usize, control.total as usize),
        );
        exp.add_variant(
            ab_testing::Variant::new(&variant_name)
                .with_conversion(variant.successes as usize, variant.total as usize),
        );
        if let Some(res) = exp.run_chi_squared() {
            should_promote(&ChiSqResult { p_value: res.p_value }, control, variant)
        } else {
            false
        }
    } else {
        false
    };

    // ---- 6. Param optimization via Nelder-Mead simplex within admin bounds ----
    // Cost = −fitness (minimize). Nelder-Mead is derivative-free; the 4-param
    // problem is small enough that a hand-rolled simplex (~50 lines) avoids
    // pulling basin (which drags web-time → wasm-bindgen — invalid imports).
    let pnl_owned: Vec<f64> = pnl.to_vec();
    let eng_mean = eng_stats.mean;
    let cost = move |x: &[f64]| -> f64 {
        let size_frac = (x[3] / 100.0).clamp(0.01, 1.0);
        let adj: Vec<f64> = pnl_owned.iter().map(|p| p * size_frac).collect();
        let s = stats::compute(&adj);
        -fitness(s.mean, eng_mean * (x[2] / 240.0).clamp(0.1, 2.0), s.max_drawdown)
    };
    let start = [
        (bounds.conf_min + bounds.conf_max) / 2.0,
        (bounds.risk_min + bounds.risk_max) / 2.0,
        (bounds.freq_min + bounds.freq_max) / 2.0,
        (bounds.size_min + bounds.size_max) / 2.0,
    ];
    let bnds = [
        (bounds.conf_min, bounds.conf_max),
        (bounds.risk_min, bounds.risk_max),
        (bounds.freq_min, bounds.freq_max),
        (bounds.size_min, bounds.size_max),
    ];
    let best = nelder_mead(&cost, &start, &bnds, 200);
    let param_patch = clamp_params(&best, bounds);

    Ok(EvolutionOutcome {
        regime: regime_name,
        regime_strategy: regime_strategy.to_string(),
        variant_chosen: chosen,
        new_system_prompt: new_prompt,
        thought,
        promoted,
        param_patch,
    })
}

/// Rolling statistics helpers via ta-statistics — thin wrappers so lib.rs
/// doesn't carry stats math.
pub mod stats {
    /// Simple rolling stats over a slice — mean, std, max drawdown, trend slope.
    pub struct RollingStats {
        pub mean: f64,
        pub std: f64,
        pub max_drawdown: f64,
        pub trend_slope: f64,
    }

    pub fn compute(series: &[f64]) -> RollingStats {
        if series.is_empty() {
            return RollingStats { mean: 0.0, std: 0.0, max_drawdown: 0.0, trend_slope: 0.0 };
        }
        let n = series.len() as f64;
        let mean = series.iter().sum::<f64>() / n;
        let var = series.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n;

        // max drawdown over cumulative curve
        let mut peak = f64::MIN;
        let mut max_dd = 0.0f64;
        let mut cum = 0.0f64;
        for &v in series {
            cum += v;
            if cum > peak { peak = cum; }
            let dd = peak - cum;
            if dd > max_dd { max_dd = dd; }
        }

        // least-squares slope
        let x_mean = (series.len() - 1) as f64 / 2.0;
        let mut num = 0.0;
        let mut den = 0.0;
        for (i, &y) in series.iter().enumerate() {
            num += (i as f64 - x_mean) * (y - mean);
            den += (i as f64 - x_mean).powi(2);
        }
        let slope = if den > 0.0 { num / den } else { 0.0 };

        RollingStats { mean, std: var.sqrt(), max_drawdown: max_dd, trend_slope: slope }
    }
}

// ---------------------------------------------------------------------------
// Nelder-Mead simplex (minimize), boxed into admin bounds.
// Standard coefficients: alpha=1 reflect, gamma=2 expand, rho=0.5 contract,
// sigma=0.5 shrink. Deterministic — no RNG needed.
// ---------------------------------------------------------------------------
fn nelder_mead(cost: &dyn Fn(&[f64]) -> f64, x0: &[f64], bnds: &[(f64, f64)], iters: usize) -> Vec<f64> {
    let n = x0.len();
    // Initial simplex: x0 + unit offsets
    let mut simplex: Vec<(Vec<f64>, f64)> = (0..=n)
        .map(|i| {
            let mut x = x0.to_vec();
            if i > 0 {
                x[i - 1] = (x[i - 1] + (bnds[i - 1].1 - bnds[i - 1].0) * 0.05)
                    .clamp(bnds[i - 1].0, bnds[i - 1].1);
            }
            let c = cost(&x);
            (x, c)
        })
        .collect();
    for _ in 0..iters {
        simplex.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let centroid: Vec<f64> = (0..n)
            .map(|d| simplex[..n].iter().map(|v| v.0[d]).sum::<f64>() / n as f64)
            .collect();
        let worst = &simplex[n].0;
        let mut refl: Vec<f64> = (0..n)
            .map(|d| (centroid[d] + (centroid[d] - worst[d])).clamp(bnds[d].0, bnds[d].1))
            .collect();
        let cr = cost(&refl);
        if cr < simplex[0].1 {
            // expand
            let exp: Vec<f64> = (0..n)
                .map(|d| (centroid[d] + 2.0 * (refl[d] - centroid[d])).clamp(bnds[d].0, bnds[d].1))
                .collect();
            let ce = cost(&exp);
            simplex[n] = if ce < cr { (exp, ce) } else { (refl, cr) };
        } else if cr < simplex[n - 1].1 {
            simplex[n] = (refl, cr);
        } else {
            // contract
            let con: Vec<f64> = (0..n)
                .map(|d| (centroid[d] + 0.5 * (worst[d] - centroid[d])).clamp(bnds[d].0, bnds[d].1))
                .collect();
            let cc = cost(&con);
            if cc < simplex[n].1 {
                simplex[n] = (con, cc);
            } else {
                // shrink toward best
                for i in 1..=n {
                    for d in 0..n {
                        simplex[i].0[d] = (simplex[0].0[d]
                            + 0.5 * (simplex[i].0[d] - simplex[0].0[d]))
                            .clamp(bnds[d].0, bnds[d].1);
                    }
                    simplex[i].1 = cost(&simplex[i].0);
                }
            }
        }
        let _ = refl;
    }
    simplex.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    simplex[0].0.clone()
}
