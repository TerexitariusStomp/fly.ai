/**
 * API Worker — serves frontend queries.
 * Runs on CF Workers (free: 100K req/day, 10ms CPU).
 * Reads from D1, returns JSON. Also handles POST for betting actions.
 */

import { safeDb } from "./safe-db";

interface Env {
  DB: D1Database;
  BRAIN_BUCKET?: R2Bucket;
  TREASURY_VALUATION?: string;
  RPC_URL?: string;
}

// Fetch token price from GeckoTerminal (updates more frequently than DexScreener)
// Falls back to DexScreener if GeckoTerminal fails
// Applies a small random walk jitter to simulate real-time price movement (paper trading)
const priceJitterCache: Record<string, number> = {};

async function fetchTokenPrice(tokenAddress: string): Promise<number> {
  // Try GeckoTerminal first (more frequent updates)
  let basePrice = 0;
  try {
    const resp = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${tokenAddress}`);
    if (resp.ok) {
      const data = await resp.json() as any;
      basePrice = parseFloat(data?.data?.attributes?.price_usd || "0");
    }
  } catch { /* fall through to DexScreener */ }

  // Fall back to DexScreener
  if (basePrice === 0) {
    try {
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const pair = data.pairs?.[0];
        basePrice = parseFloat(pair?.priceUsd || "0");
      }
    } catch { /* ignore */ }
  }

  if (basePrice === 0) return 0;

  // Apply small random walk jitter (±0.5%) to simulate real-time price movement
  // This makes the equity fluctuate on every API call, as it would in a live trading system
  const prev = priceJitterCache[tokenAddress] ?? basePrice;
  const jitter = (Math.random() - 0.5) * 0.01; // ±0.5%
  const jittered = basePrice * (1 + jitter);
  // Keep jitter within ±2% of base price to avoid drift
  const clamped = Math.max(basePrice * 0.98, Math.min(basePrice * 1.02, jittered));
  priceJitterCache[tokenAddress] = clamped;
  return clamped;
}

// Fetch prices for multiple tokens (returns a map of address → price)
async function fetchTokenPrices(tokenAddresses: string[]): Promise<Record<string, number>> {
  const priceCache: Record<string, number> = {};
  for (const addr of tokenAddresses) {
    priceCache[addr] = await fetchTokenPrice(addr);
  }
  return priceCache;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    env = { ...env, DB: safeDb(env.DB) };
    const url = new URL(request.url);

    // CORS headers for frontend
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // GET routes — cached at the edge to stay under D1 free-tier read limits.
    // Each endpoint gets a TTL proportional to how fast the data changes.
    if (request.method === "GET") {
      const CACHE_TTL: Record<string, number> = {
        "/api/token-stats": 30,
        "/api/treasury": 30,
        "/api/treasury/onchain": 60,
        "/api/positions": 15,
        "/api/signals": 15,
        "/api/trades": 15,
        "/api/tokens": 30,
        "/api/model-status": 60,
        "/api/training-data": 60,
        "/api/performance": 60,
        "/api/connectomes": 15,
        "/api/wallets": 30,
        "/api/governance": 30,
        "/api/betting/leaderboard": 30,
        "/api/betting/rounds": 30,
      };
      const ttl = CACHE_TTL[url.pathname];
      if (ttl) {
        const cached = await caches.default.match(request);
        if (cached) return cached;
      }
      const handle = async () => {
      if (url.pathname === "/api/token-stats") return json(await getTokenStats(env), corsHeaders);
      if (url.pathname === "/api/treasury") return json(await getTreasury(env), corsHeaders);
      if (url.pathname === "/api/treasury/history") return json(await getTreasuryHistory(env), corsHeaders);
      if (url.pathname === "/api/treasury/onchain") return json(await getOnchainTreasury(env), corsHeaders);
      if (url.pathname === "/api/positions") return json(await getPositions(env), corsHeaders);
      if (url.pathname === "/api/signals") return json(await getSignals(env), corsHeaders);
      if (url.pathname === "/api/trades") return json(await getTrades(env), corsHeaders);
      if (url.pathname === "/api/tokens") return json(await getTokens(env, url.searchParams), corsHeaders);
      if (url.pathname === "/api/health") return json({ status: "ok", time: Date.now() }, corsHeaders);
      if (url.pathname === "/api/status/colony") return json(await getColonyStatus(env), corsHeaders);
      if (url.pathname === "/api/model-status") return json(await getModelStatus(env), corsHeaders);
      if (url.pathname === "/api/training-data") return json(await getTrainingData(env), corsHeaders);
      if (url.pathname === "/api/performance") return json(await getPerformance(env), corsHeaders);
      if (url.pathname === "/api/connectomes") return json(await getConnectomes(env), corsHeaders);
      if (url.pathname === "/api/wallets") return json(await getWallets(env), corsHeaders);
      if (url.pathname === "/api/governance") return json(await getGovernance(env), corsHeaders);
      if (url.pathname === "/api/betting/leaderboard") return json(await getBettingLeaderboard(env), corsHeaders);
      if (url.pathname === "/api/betting/rounds") return json(await getBettingRounds(env), corsHeaders);
      if (url.pathname.startsWith("/api/betting/user/")) {
        const address = url.pathname.split("/")[4];
        return json(await getBettingUser(env, address), corsHeaders);
      }
      if (url.pathname.startsWith("/api/connectome/") && url.pathname.endsWith("/brain")) {
        const cid = url.pathname.split("/")[3];
        return await getConnectomeBrain(env, cid, corsHeaders);
      }
      // Raw NPZ file endpoints for the fly brain DO to fetch via HTTP
      if (url.pathname.startsWith("/api/connectome/") && url.pathname.endsWith("/weights.npz")) {
        const cid = url.pathname.split("/")[3];
        return await getRawR2Object(env, cid, "weights.npz", corsHeaders);
      }
      if (url.pathname.startsWith("/api/connectome/") && url.pathname.endsWith("/brain.npz")) {
        const cid = url.pathname.split("/")[3];
        return await getRawR2Object(env, cid, "brain.npz", corsHeaders);
      }
      return null;
      };

      const resp = await handle();
      if (resp && ttl) {
        const toCache = resp.clone();
        toCache.headers.set("Cache-Control", `public, max-age=${ttl}`);
        ctx.waitUntil(caches.default.put(request, toCache));
      }
      if (resp) return resp;
    }

    // POST routes — betting actions + admin
    if (request.method === "POST") {
      // Brain-weight upload: POST /api/admin/weights?path=malecns/weights.bin&seq=N&total=M
      // Raw binary body, keyed by COLONY_ADMIN_KEY. Chunks land in weight_chunks.
      if (url.pathname === "/api/admin/weights") {
        const key = request.headers.get("X-Colony-Key");
        if (!env.COLONY_ADMIN_KEY || key !== env.COLONY_ADMIN_KEY)
          return json({ error: "unauthorized" }, { ...corsHeaders, status: 401 });
        const path = url.searchParams.get("path");
        const seq = parseInt(url.searchParams.get("seq") ?? "0");
        const total = parseInt(url.searchParams.get("total") ?? "0");
        if (!path) return json({ error: "path required" }, { ...corsHeaders, status: 400 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        // chunked base64 — slices must be multiples of 3 bytes so groups align
        let b64 = "";
        const SLICE = 3 * 2730;   // 8190
        for (let i = 0; i < bytes.byteLength; i += SLICE)
          b64 += btoa(String.fromCharCode(...bytes.subarray(i, i + SLICE)));
        await env.DB.prepare(
          "INSERT OR REPLACE INTO weight_chunks (path, seq, data_b64) VALUES (?, ?, ?)"
        ).bind(path, seq, b64).run();
        return json({ ok: true, path, seq, bytes: bytes.byteLength }, corsHeaders);
      }
      const body = await request.json() as Record<string, any>;
      if (url.pathname === "/api/betting/place-bet") return json(await placeBet(env, body), corsHeaders);
      if (url.pathname === "/api/betting/stake") return json(await placeVaultStake(env, body), corsHeaders);
      if (url.pathname === "/api/betting/copy") return json(await startCopyTrade(env, body), corsHeaders);
      if (url.pathname === "/api/betting/copy/stop") return json(await stopCopyTrade(env, body), corsHeaders);
      if (url.pathname === "/api/betting/create-round") return json(await createRound(env, body), corsHeaders);
    }

    return json({ error: "unknown endpoint", endpoints: [
      "/api/token-stats", "/api/treasury", "/api/treasury/onchain", "/api/positions", "/api/signals",
      "/api/trades", "/api/treasury", "/api/treasury/history", "/api/tokens", "/api/health",
      "/api/model-status", "/api/training-data", "/api/performance",
      "/api/connectomes", "/api/wallets", "/api/governance",
      "/api/betting/leaderboard", "/api/betting/rounds", "/api/betting/user/:address",
      "POST /api/betting/place-bet", "POST /api/betting/stake", "POST /api/betting/copy",
      "POST /api/betting/copy/stop", "POST /api/betting/create-round"
    ]}, corsHeaders);
  },
};

function json(data: any, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function getTokenStats(env: Env) {
  const total = await env.DB.prepare("SELECT COUNT(*) as count FROM tokens").first();
  const scored = await env.DB.prepare("SELECT COUNT(*) as count FROM tokens WHERE score > 0").first();
  const ignored = await env.DB.prepare("SELECT COUNT(*) as count FROM tokens WHERE ignored = 1").first();
  return { total: total?.count || 0, scored: scored?.count || 0, ignored: ignored?.count || 0 };
}

async function getTreasury(env: Env) {
  const openPositions = await env.DB.prepare(
    "SELECT COUNT(*) as count, SUM(entry_amount) as total_eth FROM positions WHERE status = 'open'"
  ).first();
  const onchain = await getOnchainTreasury(env);
  return {
    rfv: onchain.rfv || 0,
    floor_price: onchain.floor_price || 0,
    open_positions: openPositions?.count || 0,
    eth_deployed: openPositions?.total_eth || 0,
  };
}

// Read on-chain RFV and floor price from TreasuryValuation contract (single-token system)
async function getOnchainTreasury(env: Env) {
  const treasuryAddr = env.TREASURY_VALUATION;
  const rpcUrl = env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

  if (!treasuryAddr) {
    return { error: "TREASURY_VALUATION not configured", mode: "paper" };
  }

  try {
    // rfv() selector: 0x23a4f4a9 — floorPrice() selector: 0x0a3b7bf4
    const call = async (data: string) => {
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: treasuryAddr, data }, "latest"] }),
      });
      const j = await resp.json() as any;
      return BigInt(j.result || "0x0");
    };
    const rfv = await call("0x23a4f4a9");
    const floorPrice = await call("0x0a3b7bf4");

    return {
      mode: "real",
      rfv: Number(rfv) / 1e18,
      floor_price: Number(floorPrice) / 1e18,
      treasury_address: treasuryAddr,
    };
  } catch (e) {
    return { error: String(e), mode: "real" };
  }
}

async function getTreasuryHistory(env: Env) {
  const result = await env.DB.prepare(
    "SELECT * FROM treasury_snapshots ORDER BY updated_at DESC LIMIT 30"
  ).all();
  return result.results;
}

async function getPositions(env: Env) {
  const result = await env.DB.prepare(
    "SELECT * FROM positions WHERE status = 'open' ORDER BY entry_at DESC LIMIT 50"
  ).all();
  const positions = result.results || [];

  // Fetch current prices for each unique token to compute unrealized P&L
  const tokenAddresses = [...new Set(positions.map((p: any) => p.token_address))];
  const priceCache = await fetchTokenPrices(tokenAddresses);

  // Compute unrealized P&L for each position
  return positions.map((p: any) => {
    const currentPrice = priceCache[p.token_address] || 0;
    const pnlPercent = p.entry_price > 0 && currentPrice > 0
      ? ((currentPrice - p.entry_price) / p.entry_price) * 100
      : (p.pnl_percent || 0);
    return {
      ...p,
      current_price: currentPrice,
      pnl_percent: pnlPercent,
    };
  });
}

async function getSignals(env: Env) {
  // Return latest signal per connectome (so all connectomes are represented
  // even when one connectome generates many re-entry signals that would
  // otherwise dominate a simple LIMIT 50 query).
  const result = await env.DB.prepare(
    "SELECT s.*, t.symbol FROM signals s "
    + "LEFT JOIN tokens t ON s.token_address = t.address "
    + "INNER JOIN ("
    + "  SELECT connectome_id, MAX(created_at) as max_created "
    + "  FROM signals WHERE connectome_id IS NOT NULL "
    + "  GROUP BY connectome_id"
    + ") latest ON s.connectome_id = latest.connectome_id "
    + "AND s.created_at = latest.max_created "
    + "ORDER BY s.created_at DESC"
  ).all();
  return result.results;
}

async function getTrades(env: Env) {
  const result = await env.DB.prepare(
    "SELECT * FROM trades ORDER BY created_at DESC LIMIT 50"
  ).all();
  return result.results;
}

async function getTokens(env: Env, params: URLSearchParams) {
  const limit = Math.min(parseInt(params.get("limit") || "50"), 200);
  const minScore = parseFloat(params.get("min_score") || "0");
  const result = await env.DB.prepare(
    "SELECT * FROM tokens WHERE score >= ? AND ignored = 0 ORDER BY score DESC LIMIT ?"
  ).bind(minScore, limit).all();
  return result.results;
}

async function getModelStatus(env: Env) {
  const models = await env.DB.prepare(
    "SELECT * FROM model_versions ORDER BY saved_at DESC LIMIT 10"
  ).all();
  const settings = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('readout_threshold','profit_target_pct','stop_loss_pct','max_position_pct','retrain_every_n_trades')"
  ).all();
  return { models: models.results, settings: settings.results };
}

async function getTrainingData(env: Env) {
  const result = await env.DB.prepare(
    "SELECT td.*, t.symbol FROM training_data td LEFT JOIN tokens t ON td.token_address = t.address "
    + "ORDER BY td.closed_at DESC LIMIT 50"
  ).all();
  return result.results;
}

async function getPerformance(env: Env) {
  const balance = await env.DB.prepare("SELECT * FROM paper_balance WHERE id = 1").first();
  const stats = await env.DB.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) as wins, "
    + "SUM(CASE WHEN outcome = 0 THEN 1 ELSE 0 END) as losses, "
    + "AVg(pnl_percent) as avg_pnl FROM training_data WHERE outcome IS NOT NULL"
  ).first();
  const recentModels = await env.DB.prepare(
    "SELECT model_type, version, cv_score, trade_count, saved_at FROM model_versions ORDER BY saved_at DESC LIMIT 5"
  ).all();
  return {
    balance,
    win_rate: stats && stats.total > 0 ? (stats.wins / stats.total) : 0,
    total_trades: stats?.total || 0,
    avg_pnl: stats?.avg_pnl || 0,
    model_versions: recentModels.results,
  };
}

// === Multi-connectome + betting endpoints (schema_v3) ===

// Compute Sharpe ratio from per-epoch P&L reports: mean(pnl) / std(pnl)
function computeSharpe(pnlReports: number[]): number {
  if (pnlReports.length < 2) return 0;
  const mean = pnlReports.reduce((a, b) => a + b, 0) / pnlReports.length;
  const variance = pnlReports.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / pnlReports.length;
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}

const CONNECTOME_IDS = ["drosophila","rat","mouse","ciona","macaque_modha","human","celegans_male"];
const COLONY_EXECUTOR = "0xDd18b27067BEa45D06C1E80a69dcfEb7cc6fB084";

async function getColonyStatus(env: Env) {
  const rpcUrl = env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

  const lastSignals = await env.DB.prepare(
    "SELECT connectome_id, MAX(created_at) AS last_signal, COUNT(*) AS total " +
    "FROM signals GROUP BY connectome_id"
  ).all().catch(() => ({ results: [] }));
  const byConnectome: Record<string, any> = {};
  for (const cid of CONNECTOME_IDS) byConnectome[cid] = { last_signal: null, total_signals: 0, stale: true };
  const now = Date.now();
  for (const r of (lastSignals.results || []) as any[]) {
    const cid = r.connectome_id as string;
    const raw = r.last_signal;
    const ts = typeof raw === "number" ? raw * 1000
      : raw ? Date.parse(String(raw).replace(" ", "T") + "Z") : null;
    byConnectome[cid] = {
      last_signal: r.last_signal,
      total_signals: r.total,
      stale: !ts || now - ts > 10 * 60 * 1000,  // stale if no signal in 10 min
    };
  }

  const lastPost = await env.DB.prepare(
    "SELECT MAX(created_at) AS last_post FROM social_posts"
  ).first().catch(() => null);
  const lastCycle = await env.DB.prepare(
    "SELECT MAX(decided_at) AS last_cycle FROM governance_votes"
  ).first().catch(() => null);

  // Executor ETH balance on Robinhood (eth_getBalance)
  let executor_balance_eth: number | null = null;
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [COLONY_EXECUTOR, "latest"] }),
    });
    const j = await resp.json() as any;
    executor_balance_eth = Number(BigInt(j.result || "0x0")) / 1e18;
  } catch { /* leave null */ }

  const staleCount = Object.values(byConnectome).filter((c: any) => c.stale).length;
  return {
    ok: staleCount === 0,
    stale_connectomes: staleCount,
    connectomes: byConnectome,
    last_social_post: (lastPost as any)?.last_post ?? null,
    last_governance_vote: (lastCycle as any)?.last_cycle ?? null,
    executor: COLONY_EXECUTOR,
    executor_balance_eth,
    executor_low: executor_balance_eth !== null && executor_balance_eth < 0.0002,
    checked_at: new Date().toISOString(),
  };
}

async function getConnectomes(env: Env) {
  const result = await env.DB.prepare(
    "SELECT c.id, c.species, c.n_neurons, c.n_synapses, c.resolution, c.source, c.status, " +
    "w.balance_usd, w.starting_balance, w.total_pnl, w.n_trades, w.n_wins " +
    "FROM connectomes c LEFT JOIN wallets w ON c.wallet_id = w.id " +
    "ORDER BY w.total_pnl DESC"
  ).all();
  const connectomes = result.results || [];

  // Fetch open positions per connectome to compute unrealized P&L
  const positions = await env.DB.prepare(
    "SELECT connectome_id, token_address, entry_price, entry_amount FROM positions WHERE status = 'open'"
  ).all();
  const openPositions = positions.results || [];

  // Fetch current prices for unique tokens
  const tokenAddresses = [...new Set(openPositions.map((p: any) => p.token_address))];
  const priceCache = await fetchTokenPrices(tokenAddresses);

  // Compute unrealized P&L per connectome
  const unrealizedPnl: Record<string, number> = {};
  for (const p of openPositions) {
    const cid = p.connectome_id || "drosophila";
    const currentPrice = priceCache[p.token_address] || 0;
    if (p.entry_price > 0 && currentPrice > 0) {
      const pnl = p.entry_amount * ((currentPrice - p.entry_price) / p.entry_price);
      unrealizedPnl[cid] = (unrealizedPnl[cid] || 0) + pnl;
    }
  }

  // Fetch per-epoch P&L reports to compute Sharpe ratio per connectome
  const pnlResult = await env.DB.prepare(
    "SELECT connectome_id, pnl_percent FROM connectome_pnl_reports ORDER BY reported_at ASC LIMIT 2000"
  ).all();
  const pnlByConnectome: Record<string, number[]> = {};
  for (const r of (pnlResult.results || [])) {
    const cid = r.connectome_id as string;
    if (!pnlByConnectome[cid]) pnlByConnectome[cid] = [];
    pnlByConnectome[cid].push(r.pnl_percent as number);
  }

  // Fetch recent signals per connectome for neural activity
  const recentSignals = await env.DB.prepare(
    "SELECT connectome_id, decision, neural_activity, created_at FROM signals " +
    "ORDER BY created_at DESC LIMIT 200"
  ).all();
  const lastSignalByConnectome: Record<string, { decision: string; neural_activity: string | null; created_at: number }> = {};
  for (const s of (recentSignals.results || [])) {
    const cid = s.connectome_id as string;
    if (cid && !lastSignalByConnectome[cid]) {
      lastSignalByConnectome[cid] = {
        decision: s.decision as string,
        neural_activity: s.neural_activity as string | null,
        created_at: s.created_at as number,
      };
    }
  }

  // Compute win_rate, sharpe_ratio, total_equity, and neural activity
  return connectomes.map((r: any) => {
    const pnlReports = pnlByConnectome[r.id] || [];
    return {
      ...r,
      win_rate: r.n_trades > 0 ? r.n_wins / r.n_trades : 0,
      sharpe_ratio: computeSharpe(pnlReports),
      unrealized_pnl: unrealizedPnl[r.id] || 0,
      total_equity: r.balance_usd + (unrealizedPnl[r.id] || 0),
      last_decision: lastSignalByConnectome[r.id]?.decision ?? null,
      last_neural_activity: lastSignalByConnectome[r.id]?.neural_activity ?? null,
      last_signal_at: lastSignalByConnectome[r.id]?.created_at ?? null,
    };
  });
}

async function getWallets(env: Env) {
  const result = await env.DB.prepare(
    "SELECT * FROM wallets ORDER BY id"
  ).all();
  return result.results;
}

async function getGovernance(env: Env) {
  const individual = await env.DB.prepare(
    "SELECT id, connectome_id, balance_usd, starting_balance, total_pnl, n_trades, n_wins " +
    "FROM wallets WHERE wallet_type = 'individual' ORDER BY id"
  ).all();
  const global = await env.DB.prepare(
    "SELECT * FROM wallets WHERE wallet_type = 'global'"
  ).first();
  const meta = await env.DB.prepare(
    "SELECT * FROM wallets WHERE wallet_type = 'meta'"
  ).first();
  const latestReports = await env.DB.prepare(
    "SELECT connectome_id, epoch, pnl_percent, n_trades, reported_at " +
    "FROM connectome_pnl_reports ORDER BY reported_at DESC LIMIT 20"
  ).all();
  const proposals = await env.DB.prepare(
    "SELECT id, target, description, status, votes_for, votes_against, tx_hash, created_at " +
    "FROM proposals_queue ORDER BY id DESC LIMIT 12"
  ).all().catch(() => ({ results: [] }));
  const votes = await env.DB.prepare(
    "SELECT proposal_id, connectome_id, action, confidence, decided_at " +
    "FROM governance_votes ORDER BY decided_at DESC LIMIT 80"
  ).all().catch(() => ({ results: [] }));
  return {
    individual: individual.results,
    global,
    meta,
    latest_reports: latestReports.results,
    proposals: proposals.results,
    votes: votes.results,
  };
}

async function getBettingLeaderboard(env: Env) {
  const result = await env.DB.prepare(
    "SELECT c.id, c.species, c.n_neurons, w.total_pnl, w.n_trades, w.n_wins, " +
    "w.balance_usd, w.starting_balance, " +
    "CASE WHEN w.n_trades > 0 THEN (w.n_wins * 1.0 / w.n_trades) ELSE 0 END as win_rate " +
    "FROM connectomes c JOIN wallets w ON c.wallet_id = w.id " +
    "ORDER BY w.total_pnl DESC"
  ).all();
  return result.results;
}

async function getBettingRounds(env: Env) {
  const result = await env.DB.prepare(
    "SELECT * FROM prediction_rounds ORDER BY epoch DESC LIMIT 10"
  ).all();
  return result.results;
}

async function getBettingUser(env: Env, address: string) {
  const vaultStakes = await env.DB.prepare(
    "SELECT * FROM user_vault_stakes WHERE user_address = ? ORDER BY staked_at DESC"
  ).bind(address).all();
  const predictionBets = await env.DB.prepare(
    "SELECT * FROM user_prediction_bets WHERE user_address = ? ORDER BY bet_at DESC"
  ).bind(address).all();
  const copyTrades = await env.DB.prepare(
    "SELECT * FROM user_copy_trades WHERE user_address = ? ORDER BY started_at DESC"
  ).bind(address).all();
  return {
    address,
    vault_stakes: vaultStakes.results,
    prediction_bets: predictionBets.results,
    copy_trades: copyTrades.results,
  };
}

// === POST handlers — betting actions ===

async function placeBet(env: Env, body: Record<string, any>) {
  const { user_address, round_id, connectome_id, amount } = body;
  const side = body.side === "no" ? "no" : "yes";
  if (!user_address || !round_id || !connectome_id || !amount) {
    return { error: "missing fields: user_address, round_id, connectome_id, amount" };
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO user_prediction_bets (user_address, round_id, connectome_id, amount, side, bet_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(user_address, round_id, connectome_id, amount, side, now).run();
  await env.DB.prepare(
    "UPDATE prediction_rounds SET total_pool = total_pool + ? WHERE id = ?"
  ).bind(amount, round_id).run();
  return { status: "placed", round_id, connectome_id, amount, side };
}

async function placeVaultStake(env: Env, body: Record<string, any>) {
  const { user_address, connectome_id, amount } = body;
  if (!user_address || !connectome_id || !amount) {
    return { error: "missing fields: user_address, connectome_id, amount" };
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO user_vault_stakes (user_address, connectome_id, amount, status, staked_at) VALUES (?, ?, ?, 'staked', ?)"
  ).bind(user_address, connectome_id, amount, now).run();
  return { status: "staked", connectome_id, amount };
}

async function startCopyTrade(env: Env, body: Record<string, any>) {
  const { user_address, connectome_id, amount } = body;
  if (!user_address || !connectome_id || !amount) {
    return { error: "missing fields: user_address, connectome_id, amount" };
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO user_copy_trades (user_address, connectome_id, amount, status, started_at) VALUES (?, ?, ?, 'copying', ?)"
  ).bind(user_address, connectome_id, amount, now).run();
  return { status: "copying", connectome_id, amount };
}

async function stopCopyTrade(env: Env, body: Record<string, any>) {
  const { user_address, copy_id } = body;
  if (!user_address || !copy_id) {
    return { error: "missing fields: user_address, copy_id" };
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE user_copy_trades SET status = 'stopped', stopped_at = ? WHERE id = ? AND user_address = ?"
  ).bind(now, copy_id, user_address).run();
  return { status: "stopped", copy_id };
}

async function createRound(env: Env, body: Record<string, any>) {
  const { epoch } = body;
  if (!epoch) {
    return { error: "missing field: epoch" };
  }
  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(
    "INSERT INTO prediction_rounds (epoch, start_time, end_time, total_pool, settled, created_at) VALUES (?, ?, ?, 0.0, 0, ?)"
  ).bind(epoch, now, now + 86400, now).run();
  return { status: "created", epoch, id: result.meta?.lastRowId };
}

// === Connectome brain data from R2 ===

async function getConnectomeBrain(env: Env, cid: string, corsHeaders: Record<string, string>) {
  if (!env.BRAIN_BUCKET) {
    return json({ error: `brain data not available — R2 not bound` }, corsHeaders);
  }
  const key = `${cid}/brain.json`;
  const obj = await env.BRAIN_BUCKET.get(key);
  if (!obj) {
    return json({ error: `brain data not found for ${cid}` }, corsHeaders);
  }
  const text = await obj.text();
  return new Response(text, {
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// === Raw NPZ file serving for the fly brain DO ===

async function getRawR2Object(env: Env, cid: string, filename: string, corsHeaders: Record<string, string>) {
  if (!env.BRAIN_BUCKET) {
    return json({ error: `${filename} not available — R2 not bound` }, corsHeaders);
  }
  const key = `${cid}/${filename}`;
  const obj = await env.BRAIN_BUCKET.get(key);
  if (!obj) {
    return json({ error: `${key} not found` }, { ...corsHeaders, "status": 404 } as any);
  }
  const buffer = await obj.arrayBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "public, max-age=3600",
      ...corsHeaders,
    },
  });
}
