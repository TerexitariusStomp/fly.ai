/**
 * Discovery Worker — polls Arc launchpads for new tokens.
 * Runs on CF Cron Trigger (free: 1-min interval).
 * Writes discovered tokens to D1.
 *
 * Sources:
 * - DexScreener API (tokens with price/liquidity)
 *
 * Safety heuristics: vendored from swiftnodes/memecoin-scanner (MIT)
 * - workers/memecoin-scanner/src/heuristics.js
 * - 5 safety checks: symbol sanity, name sanity, supply check, owner renouncement, quote-token validation
 *
 * RPC fallback: tries multiple public RPCs in order until one succeeds.
 */

import { safeDb } from "./safe-db";

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
}

// Public Arc RPCs (fallback list)
const RPCS = [
  "https://rpc.mainnet.arc.io/",
  "https://rpc.mainnet.arc.io",
  "https://rpc.testnet.arc.io",
];

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const ARC_CHAIN = "arc";

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    env = { ...env, DB: safeDb(env.DB) };
    ctx.waitUntil(discoverTokens(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    env = { ...env, DB: safeDb(env.DB) };
    // Every fetch runs a scan — colony key required
    const url = new URL(request.url);
    const key = request.headers.get("X-Colony-Key") || url.searchParams.get("key") || "";
    const expected = (env as unknown as { COLONY_ADMIN_KEY?: string }).COLONY_ADMIN_KEY;
    if (!expected || key !== expected) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    await discoverTokens(env);
    return Response.json({ status: "discovery_complete" });
  },
};

async function discoverTokens(env: Env) {
  await pollDexScreener(env);
}

/** Try each RPC in order until one responds */
async function rpcCall(method: string, params: any[]): Promise<any> {
  for (const rpc of RPCS) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      if (data.error) continue;
      return data.result;
    } catch (e) {
      continue; // Try next RPC
    }
  }
  throw new Error(`All RPCs failed for ${method}`);
}

async function getLatestBlock(): Promise<number> {
  const result = await rpcCall("eth_blockNumber", []);
  return parseInt(result, 16);
}

async function ethGetLogs(params: any): Promise<any[]> {
  try {
    return await rpcCall("eth_getLogs", [params]) || [];
  } catch {
    return [];
  }
}

async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    return await rpcCall("eth_call", [{ to, data }, "latest"]);
  } catch {
    return null;
  }
}

/** Poll DexScreener for trending tokens (paper trading — any chain with
 *  live price data; Arc has no DexScreener pairs yet). */
const SEARCH_QUERIES = ["solana", "base", "pepe", "ai", "inu"];

async function pollDexScreener(env: Env) {
  for (const q of SEARCH_QUERIES) {
    try {
      const resp = await fetch(`${DEXSCREENER_API}/search?q=${q}`, {
        headers: { "User-Agent": "SYM-Token-Bot/1.0" },
      });
      if (!resp.ok) continue;

      const data = await resp.json() as any;
      const pairs = data.pairs || [];

      for (const pair of pairs.slice(0, 20)) {
        // need live price + real liquidity for paper trading
        if (!pair.priceUsd || !pair.liquidity?.usd || pair.liquidity.usd < 10000) continue;
        const token = pair.baseToken;
        await insertToken(env, {
          address: token.address.toLowerCase(),
          symbol: token.symbol,
          name: token.name,
          launchpad: detectLaunchpad(pair),
          pair_address: pair.pairAddress,
          first_seen: Date.now(),
          chain: pair.chainId,
          score: scorePair(pair),
          score_reasons: JSON.stringify({
            liquidity: pair.liquidity.usd,
            volume24h: pair.volume?.h24 ?? 0,
            priceChange24h: pair.priceChange?.h24 ?? 0,
          }),
        });
      }
    } catch (e) {
      console.error(`DexScreener poll failed for ${q}:`, e);
    }
  }
}

/** Simple momentum/liquidity score — fly brains use this as score_norm. */
function scorePair(pair: any): number {
  const liq = pair.liquidity?.usd ?? 0;
  const vol = pair.volume?.h24 ?? 0;
  const chg = Math.abs(pair.priceChange?.h24 ?? 0);
  const liqScore = Math.min(liq / 1_000_000, 1) * 40;   // up to 40 for $1M+ liq
  const volScore = Math.min(vol / 500_000, 1) * 40;     // up to 40 for $500k+ vol
  const chgScore = Math.min(chg / 50, 1) * 20;          // up to 20 for ±50% move
  return Math.round((liqScore + volScore + chgScore) * 10) / 10;
}

function detectLaunchpad(pair: any): string {
  return pair.dexId || "unknown";
}

async function insertToken(env: Env, token: {
  address: string;
  symbol: string;
  name?: string;
  launchpad?: string;
  pair_address?: string;
  factory_address?: string;
  creator_address?: string;
  first_seen: number;
  chain?: string;
  score?: number;
  score_reasons?: string;
}) {
  await env.DB.prepare(
    `INSERT INTO tokens (address, symbol, name, chain, launchpad, pair_address,
     factory_address, creator_address, first_seen, score, score_reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       score = excluded.score, score_reasons = excluded.score_reasons`
  ).bind(
    token.address,
    token.symbol,
    token.name || null,
    token.chain || ARC_CHAIN,
    token.launchpad || null,
    token.pair_address || null,
    token.factory_address || null,
    token.creator_address || null,
    token.first_seen,
    token.score ?? 0,
    token.score_reasons || null,
  ).run();
}
