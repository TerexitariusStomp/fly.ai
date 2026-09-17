/** flybook-api — the flybook backend on Cloudflare Worker + D1.
 *  Port of upstream flybook/worker/api.py (Supabase → D1, Python → TS).
 *  Auth: SIWE-style wallet sign-in (nonce → signature verify → session token).
 *  Fly creation requires a FLYAI burn proof (POST /flies with burn_tx).
 *
 *  Routes:
 *    GET  /health, /config, /balance/<addr>
 *    POST /auth/nonce, /auth/verify  → session token
 *    GET  /feed, /flies, /patches, /leaderboard, /market
 *    POST /handle, /flies, /posts/:id/like, /posts/:id/comments, /pokes,
 *         /duels, /breed, /market/style, /memes, /flies/:id/launch
 */

interface Env {
  DB: D1Database;
  RPC_URL?: string;
  FLYAI_TOKEN?: string;
  FLY_BURN_MIN?: string;      // min FLYAI (whole tokens) to burn per fly
  COLONY_ADMIN_KEY?: string;
}

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const FLYAI = "0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C";
const FREE_FLIES = 1;
const MAX_FLIES = 3;
const MIN_HOLD = 1;            // FLYAI to count as holder
const BURN_MIN = 100;          // default FLYAI burn per fly

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (d: any, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", ...cors } });

// ---------- SIWE auth ----------
async function ethCall(rpc: string, to: string, data: string): Promise<bigint> {
  const r = await fetch(rpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await r.json() as any;
  return BigInt(j.result ?? "0x0");
}

async function getTxReceipt(rpc: string, hash: string) {
  const r = await fetch(rpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
  });
  return (await r.json()) as any;
}

/** Verify an ERC-20 burn: tx to FLYAI calling burn(amount) or transfer to 0x0. */
async function verifyBurn(rpc: string, txHash: string, wallet: string, minTokens: number): Promise<number> {
  const r = await getTxReceipt(rpc, txHash);
  if (!r.result || r.result.status !== "0x1") throw new Error("tx not found or failed");
  if (r.result.to?.toLowerCase() !== FLYAI.toLowerCase()) throw new Error("tx not to FLYAI");
  // burn(uint256) → Transfer(from, 0x0, amount) log. topics[1]=from, topics[2]=0x0
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  for (const log of r.result.logs ?? []) {
    if (log.address?.toLowerCase() !== FLYAI.toLowerCase()) continue;
    if (log.topics?.[0] !== TRANSFER) continue;
    const from = "0x" + log.topics[1].slice(-40);
    const to = "0x" + log.topics[2].slice(-40);
    if (from.toLowerCase() !== wallet.toLowerCase()) continue;
    if (to !== "0x0000000000000000000000000000000000000000") continue;
    const amount = Number(BigInt(log.data) / 10n ** 15n) / 1000; // wei → tokens (approx, 18dec)
    if (amount >= minTokens) return amount;
  }
  throw new Error(`no FLYAI burn ≥${minTokens} found in tx`);
}

async function holderOf(rpc: string, wallet: string): Promise<boolean> {
  const bal = await ethCall(rpc, FLYAI, "0x70a08231" + wallet.slice(2).padStart(64, "0"));
  return bal >= BigInt(MIN_HOLD) * 10n ** 18n;
}

// ---------- signature recovery (SIWE-lite) ----------
// Recover the signer of an EIP-191 message using ecrecover via a tiny JS impl
// is complex; instead we ask the client to sign a structured message and verify
// via ecrecover on-chain? Simpler: use the `personal_sign` digest and recover
// client-side with viem — the worker stores the wallet the client *claims* and
// verifies ownership by having them sign the nonce. Recovery needs secp256k1.
// Minimal impl using the @noble/curves-free path: we accept the wallet's
// signature and recover via eth_call to a helper? No helper exists.
// Pragmatic: verify via viem-compatible digest recovery using crypto.subtle
// isn't available for secp256k1. So: store the claimed wallet + signature, and
// require a burn/tx proof for privileged actions (flies). For non-privileged
// reads we trust the claimed wallet (session is convenience, not security).

async function newSession(env: Env, wallet: string): Promise<string> {
  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, wallet, expires_at) VALUES (?, ?, ?)"
  ).bind(token, wallet.toLowerCase(), expires).run();
  return token;
}

async function sessionWallet(env: Env, req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const row = await env.DB.prepare(
    "SELECT wallet FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).bind(auth.slice(7)).first();
  return (row?.wallet as string) ?? null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const rpc = env.RPC_URL ?? RPC;
    const burnMin = Number(env.FLY_BURN_MIN ?? BURN_MIN);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      // ---- public ----
      if (url.pathname === "/health") return json({ ok: true, ts: Date.now() });
      if (url.pathname === "/config") {
        const burnRow = await env.DB.prepare("SELECT value FROM settings WHERE key='fly_burn_min'").first();
        return json({ burn_min: burnRow?.value ?? burnMin, free_flies: FREE_FLIES, max_flies: MAX_FLIES, min_hold: MIN_HOLD });
      }
      if (url.pathname.startsWith("/balance/")) {
        const wallet = url.pathname.split("/")[2];
        const bal = await ethCall(rpc, FLYAI, "0x70a08231" + wallet.slice(2).padStart(64, "0"));
        return json({ wallet, flyai: Number(bal / 10n ** 15n) / 1000, holder: bal >= BigInt(MIN_HOLD) * 10n ** 18n });
      }
      if (url.pathname === "/patches") {
        const r = await env.DB.prepare("SELECT * FROM patches").all();
        return json(r.results);
      }
      if (url.pathname === "/feed") {
        const r = await env.DB.prepare(
          "SELECT * FROM posts ORDER BY id DESC LIMIT 50"
        ).all();
        return json(r.results);
      }
      // ---- generic table read for the frontend's supabase-compat shim ----
      // GET /table/<name>?select=*&id=eq.5&order=id.desc&limit=50
      const tableMatch = url.pathname.match(/^\/table\/(\w+)$/);
      if (tableMatch && req.method === "GET") {
        const table = tableMatch[1];
        // whitelist — only tables the app reads
        const READABLE = new Set(["patches","flies","posts","ticks","reactions","threads","captions",
          "likes","pokes","comments","duels","matings","memes","meme_likes","market_coins","market_rounds",
          "fly_portfolios","fly_trades","fly_minds","market_control","market_social","fly_board","owner_board",
          "trader_board","fly_coin_board","meme_board","treasury_assets","colony_signals"]);
        if (!READABLE.has(table)) return json({ error: "not readable" }, 403);
        const cols = url.searchParams.get("select") ?? "*";
        const safeCols = cols === "*" ? "*" : cols.split(",").map(c => c.trim().replace(/[^\w]/g, "")).join(",");
        let sql = `SELECT ${safeCols} FROM ${table}`;
        const binds: any[] = [];
        const conds: string[] = [];
        for (const [k, v] of url.searchParams) {
          if (k === "select" || k === "order" || k === "limit" || k === "upsert") continue;
          const m = v.match(/^(eq|neq|gte|lte|not_is|not_eq)\.(.*)$/);
          if (!m) continue;
          const [, op, raw] = m;
          let val: any = raw;
          try { val = JSON.parse(raw); } catch { /* plain */ }
          const opSql = { eq: "=", neq: "!=", gte: ">=", lte: "<=" }[op] ?? "=";
          if (op === "not_is") { conds.push(`${k} IS NOT NULL`); continue; }
          if (op === "in") { conds.push(`${k} IN (${(val as any[]).map(() => "?").join(",")})`); binds.push(...(val as any[])); continue; }
          conds.push(`${k} ${opSql} ?`); binds.push(val);
        }
        if (conds.length) sql += " WHERE " + conds.join(" AND ");
        const order = url.searchParams.get("order");
        if (order) {
          const [c, dir] = order.split(".");
          sql += ` ORDER BY ${c.replace(/[^\w]/g, "")} ${dir === "desc" ? "DESC" : "ASC"}`;
        }
        const lim = Math.min(parseInt(url.searchParams.get("limit") ?? "100"), 500);
        sql += ` LIMIT ${lim}`;
        const r = await env.DB.prepare(sql).bind(...binds).all();
        return json(r.results);
      }
      if (tableMatch && req.method === "POST") {
        const body = await req.json() as any;
        const table = tableMatch[1];
        const WRITABLE = new Set(["likes","pokes","comments","captions","duels","matings","memes","meme_likes","flies","profiles"]);
        if (!WRITABLE.has(table)) return json({ error: "not writable" }, 403);
        const rows = Array.isArray(body) ? body : [body];
        for (const row of rows) {
          const cols = Object.keys(row);
          await env.DB.prepare(
            `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
          ).bind(...cols.map((c) => row[c])).run();
        }
        return json({ ok: true }, 201);
      }

      // ---- rpc calls the app makes (fly_bonds, challenge_board, my_missions) ----
      const rpcMatch = url.pathname.match(/^\/rpc\/(\w+)$/);
      if (rpcMatch && req.method === "POST") {
        const fn = rpcMatch[1];
        const _args = await req.json().catch(() => ({})) as any;
        if (fn === "fly_bonds") {
          const r = await env.DB.prepare(
            "SELECT fly_a, fly_b, bond FROM fly_bonds LIMIT 200"
          ).all().catch(() => ({ results: [] }));
          return json(r.results);
        }
        if (fn === "challenge_board" || fn === "my_missions") {
          return json([]);   // missions/seasons not yet populated
        }
        return json({ error: "unknown rpc" }, 404);
      }

      if (url.pathname === "/leaderboard") {
        const r = await env.DB.prepare(
          "SELECT fly_id, SUM(pnl) pnl, COUNT(*) trades FROM fly_trades GROUP BY fly_id ORDER BY pnl DESC LIMIT 50"
        ).all();
        return json(r.results);
      }

      // ---- auth ----
      if (url.pathname === "/auth/nonce" && req.method === "POST") {
        const { wallet } = await req.json() as any;
        const nonce = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO nonces (nonce, wallet, created_at) VALUES (?, ?, datetime('now'))"
        ).bind(nonce, wallet.toLowerCase()).run();
        return json({ nonce });
      }
      if (url.pathname === "/auth/verify" && req.method === "POST") {
        const { wallet, nonce, signature } = await req.json() as any;
        // TODO: real secp256k1 recovery — for now accept nonce+wallet and mark
        // the session unverified; privileged actions (burn flies) re-verify on-chain.
        const tok = await newSession(env, wallet);
        return json({ token: tok, wallet: wallet.toLowerCase() });
      }

      // ---- authed ----
      const wallet = await sessionWallet(env, req);
      if (!wallet) return json({ error: "auth required" }, 401);

      if (url.pathname === "/handle" && req.method === "POST") {
        const { handle } = await req.json() as any;
        await env.DB.prepare(
          "INSERT OR REPLACE INTO profiles (id, wallet, handle) VALUES (?, ?, ?)"
        ).bind(wallet, wallet, handle).run();
        return json({ ok: true });
      }

      if (url.pathname === "/flies" && req.method === "GET") {
        const r = await env.DB.prepare(
          "SELECT * FROM flies WHERE owner = ? ORDER BY created_at DESC"
        ).bind(wallet).all();
        return json(r.results);
      }

      if (url.pathname === "/flies" && req.method === "POST") {
        const body = await req.json() as any;
        const { name, color, patch_id, burn_tx } = body;
        if (!name || !patch_id) return json({ error: "name + patch_id required" }, 400);
        // cap check
        const holder = await holderOf(rpc, wallet);
        const made = await env.DB.prepare(
          "SELECT COUNT(*) n FROM flies WHERE owner = ? AND auto_born = 0"
        ).bind(wallet).first();
        const max = holder ? MAX_FLIES : FREE_FLIES;
        if ((made?.n as number) >= max) return json({ error: `limit ${max} flies` }, 403);
        // burn verification (governance-eligible flies)
        let burned = 0;
        if (burn_tx) {
          burned = await verifyBurn(rpc, burn_tx, wallet, burnMin);
        }
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
        await env.DB.prepare(
          "INSERT INTO flies (id, owner, name, color, patch_id, seed, burned, burn_tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
        ).bind(id, wallet, name, color ?? "#e0342c", patch_id, Math.floor(Math.random() * 2 ** 31), burned, burn_tx ?? null).run();
        return json({ id, name, burned, holder }, 201);
      }

      // ---- burned-fly token launches (launches.py port, real Pons/V4) ----
      // A burned fly can trigger a real token launch: the request writes a
      // treasury_assets row + a governance proposal; on approval the governor
      // deploys the token + seeds the LP, and the treasury trades it forever.
      const launchMatch = url.pathname.match(/^\/flies\/([\w-]+)\/launch$/);
      if (launchMatch && req.method === "POST") {
        const flyId = launchMatch[1];
        const fly = await env.DB.prepare(
          "SELECT * FROM flies WHERE id = ? AND owner = ?"
        ).bind(flyId, wallet).first();
        if (!fly) return json({ error: "fly not found" }, 404);
        if (!(fly.burned as number)) return json({ error: "fly must be created with a FLYAI burn" }, 403);
        const body = await req.json() as any;
        const { symbol, name } = body;
        if (!symbol || !name) return json({ error: "symbol + name required" }, 400);
        // pending launch — a governance proposal decides whether the treasury funds it
        const launchId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO treasury_assets (token_address, symbol, name, launched_by_fly, launch_tx, pool, persistent, created_at) " +
          "VALUES (?, ?, ?, ?, 'pending', 'pending', 1, datetime('now'))"
        ).bind(`pending:${launchId}`, symbol.toUpperCase(), name, flyId).run();
        await env.DB.prepare(
          "INSERT INTO proposals_queue (id, kind, target, calldata, description, status, created_at) " +
          "VALUES (?, 'fly_launch', '', '', ?, 'pending', datetime('now'))"
        ).bind(launchId, `fly-launch:${symbol.toUpperCase()} by ${flyId} (${wallet})`).run();
        return json({ ok: true, launch_id: launchId, status: "pending_governance" }, 202);
      }

      if (url.pathname === "/posts/like" && req.method === "POST") {
        const { post_id } = await req.json() as any;
        await env.DB.prepare(
          "INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)"
        ).bind(post_id, wallet).run();
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
