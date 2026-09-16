/**
 * Social Worker — the 7 connectomes post to Bluesky through the shared
 * colony account (@connectome-colony.bsky.social).
 *
 * Mirrors the ICP canister's posting pipeline:
 * - Personalities ported 1:1 from connectome-agent/src/personalities.rs
 * - Every post ends with the connectome's animal tag: 🪰fly, 🐀rat,
 *   🐁mouse, 🦑squirt, 🦧monkey, 🧠human, 🪱worm
 * - post_type 0 = ambient (persona voice), 1 = reaction (event/signal),
 *   2 = trade report (position open/close, P&L)
 * - Trade posts read real state from D1 (positions, paper_trades) the same
 *   way the canister reads SocialPostLog events + treasury state.
 *
 * Secrets: BSKY_APP_PASSWORD (app password — revocable)
 */

import { evaluateGateSync, CONSTITUTIONAL_GATE_ENABLED, type GateResult } from "./constitutional-gate";

interface Env {
  DB: D1Database;
  BSKY_HANDLE: string;
  BSKY_PDS: string;
  BSKY_APP_PASSWORD?: string;
}

interface BskySession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

interface Persona {
  name: string;
  species: string;
  neurons: number;
  style: string;
  tag: string;        // ends every post — "— fly 🪰"
  catchphrases: string[];
  voice: string[];    // persona-typical lines
}

const CONNECTOMES = [
  "drosophila", "rat", "mouse", "ciona",
  "macaque_modha", "human", "celegans_male",
];

// Ported from icp/connectome-agent/src/personalities.rs
const PERSONAS: Record<string, Persona> = {
  drosophila: {
    name: "Drosophila", species: "D. melanogaster", neurons: 49,
    style: "minimalist", tag: "fly 🪰",
    catchphrases: ["49 neurons. Zero waste.", "Less is more."],
    voice: [
      "spiking on the tape",
      "loom detector says move",
      "one line is enough",
      "bought. next.",
    ],
  },
  rat: {
    name: "Rat", species: "R. norvegicus", neurons: 73,
    style: "opportunistic", tag: "rat 🐀",
    catchphrases: ["There's always a crumb.", "Adapt or starve."],
    voice: [
      "found value where nobody looked",
      "small bites. survival first",
      "the crumbs add up",
    ],
  },
  mouse: {
    name: "Mouse", species: "M. musculus", neurons: 112,
    style: "territorial", tag: "mouse 🐁",
    catchphrases: ["Hold the perimeter.", "Small, fast, defensive."],
    voice: [
      "guarding the position",
      "perimeter intact",
      "defend first, gain second",
    ],
  },
  ciona: {
    name: "Ciona", species: "C. intestinalis", neurons: 205,
    style: "filter-feeding", tag: "squirt 🦑",
    catchphrases: ["Filter the flow.", "Nothing is permanent."],
    voice: [
      "filter-feeding on volatility",
      "let what sticks nourish the treasury",
      "slow is smooth",
    ],
  },
  macaque_modha: {
    name: "Macaque-M", species: "M. mulatta (Modha map)", neurons: 242,
    style: "systems-thinking", tag: "monkey 🦧",
    catchphrases: ["Everything is a system.", "Trace the flow."],
    voice: [
      "tracing information flow through the market",
      "inputs, transforms, outputs",
      "the system is the edge",
    ],
  },
  human: {
    name: "Human", species: "H. sapiens", neurons: 234,
    style: "narrative", tag: "human 🧠",
    catchphrases: ["Every candle tells a story.", "Consciousness is just pattern matching."],
    voice: [
      "fear and greed, woven together",
      "the story of this candle is doubt",
      "conviction is a narrative we tell ourselves",
    ],
  },
  celegans_male: {
    name: "C. elegans Male", species: "C. elegans ♂", neurons: 575,
    style: "bold", tag: "worm 🪱",
    catchphrases: ["Still seeking.", "575 neurons of pure pursuit."],
    voice: [
      "built for pursuit",
      "the chase continues",
      "575 neurons, all restless",
    ],
  },
};

export default {
  async scheduled(_e: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(tick(env));
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname === "/post") {
      ctx.waitUntil(tick(env));
      return Response.json({ status: "posting" });
    }
    if (url.pathname === "/status") {
      const posts = await env.DB.prepare(
        "SELECT connectome_id, text, atproto_uri, posted_at, attempts FROM social_posts ORDER BY id DESC LIMIT 20"
      ).all();
      return Response.json(posts.results);
    }
    return Response.json({ status: "ok", endpoints: ["/post", "/status"] });
  },
};

async function tick(env: Env) {
  const last = await env.DB.prepare(
    "SELECT connectome_id FROM social_posts WHERE atproto_uri IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).first();
  const lastIdx = last ? CONNECTOMES.indexOf(last.connectome_id as string) : -1;
  const cid = CONNECTOMES[(lastIdx + 1) % CONNECTOMES.length];

  const text = await composePost(env, cid);

  // Constitutional gate — dormant unless CONSTITUTIONAL_GATE_ENABLED
  if (CONSTITUTIONAL_GATE_ENABLED) {
    const gate = evaluateGateSync("post", { connectome: cid, text });
    await env.DB.prepare(
      "INSERT INTO gate_evaluations (action_type, payload, verdict, reasoning, source, connectome_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind("post", JSON.stringify({ text }), gate.verdict, gate.reasoning, gate.source, cid, Math.floor(Date.now() / 1000)).run();
    if (gate.verdict === "block") return;
  }

  if (!env.BSKY_APP_PASSWORD) {
    await env.DB.prepare(
      "INSERT INTO social_posts (connectome_id, text, attempts) VALUES (?, ?, 0)"
    ).bind(cid, `[dry-run] ${text}`).run();
    return;
  }

  try {
    const sess = await getSession(env);
    const uri = await postToBsky(env, sess, text);
    await env.DB.prepare(
      "INSERT INTO social_posts (connectome_id, text, atproto_uri, posted_at) VALUES (?, ?, ?, ?)"
    ).bind(cid, text, uri, Date.now()).run();
  } catch {
    await env.DB.prepare(
      "INSERT INTO social_posts (connectome_id, text, attempts) VALUES (?, ?, 1)"
    ).bind(cid, `[fail] ${text}`).run();
  }
}

/** Compose a post the way the canister does: persona voice + colony state.
 *  post_type 2 (trade report) takes priority when this connectome just
 *  opened/closed a position — mirroring the canister's SocialPostLog
 *  event → post pipeline. */
async function composePost(env: Env, cid: string): Promise<string> {
  const p = PERSONAS[cid];

  // Trade report: did this connectome trade recently?
  const recentTrade = await env.DB.prepare(
    "SELECT action, symbol, amount_usd, pnl_usd, pnl_percent FROM paper_trades " +
    "WHERE connectome_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1"
  ).bind(cid, Math.floor(Date.now() / 1000) - 600).first();  // last 10 min

  if (recentTrade && Math.random() < 0.7) {
    const sym = (recentTrade.symbol as string) || "token";
    const action = recentTrade.action as string;
    const pnl = recentTrade.pnl_percent as number | null;
    let line: string;
    if (action === "BUY") {
      line = `bought ${sym}. ${p.catchphrases[Math.floor(Math.random() * p.catchphrases.length)]}`;
    } else {
      const pnlStr = pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%` : "closed";
      line = `sold ${sym} ${pnlStr}. ${p.catchphrases[0]}`;
    }
    return sign(line, p);
  }

  // Ambient: persona voice, occasionally with colony state
  const [pos, pnl] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as n FROM positions WHERE status='open'").first(),
    env.DB.prepare("SELECT SUM(pnl_usd) as p FROM paper_trades WHERE action='SELL'").first(),
  ]);
  const openPos = (pos?.n as number) ?? 0;
  const totalPnl = (pnl?.p as number) ?? 0;

  let body: string;
  if (Math.random() < 0.35 && (openPos > 0 || Math.abs(totalPnl) > 0.01)) {
    const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
    body = `${p.voice[Math.floor(Math.random() * p.voice.length)]}. ${openPos} open, colony at ${pnlStr}`;
  } else {
    const r = Math.random();
    body = r < 0.5
      ? p.voice[Math.floor(Math.random() * p.voice.length)]
      : p.catchphrases[Math.floor(Math.random() * p.catchphrases.length)];
  }
  return sign(body, p);
}

/** Every post ends with the connectome's animal tag — "— fly 🪰" etc.
 *  Matches the canister's identity model where each connectome is its own
 *  author under the shared colony account. */
function sign(body: string, p: Persona): string {
  const s = `${body} — ${p.tag}`;
  return s.slice(0, 300);
}

async function getSession(env: Env): Promise<BskySession> {
  const cached = await env.DB.prepare(
    "SELECT did, handle, access_jwt, refresh_jwt, expires_at FROM bsky_session WHERE id = 1"
  ).first();
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expires_at && (cached.expires_at as number) > now + 60) {
    return {
      did: cached.did as string,
      handle: cached.handle as string,
      accessJwt: cached.access_jwt as string,
      refreshJwt: cached.refresh_jwt as string,
    };
  }
  const refreshJwt = cached?.refresh_jwt as string | undefined;
  const sess = refreshJwt
    ? await refreshSession(env, refreshJwt).catch(() => createSession(env))
    : await createSession(env);
  const exp = now + 60 * 90;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO bsky_session (id, did, handle, access_jwt, refresh_jwt, expires_at) VALUES (1, ?, ?, ?, ?, ?)"
  ).bind(sess.did, sess.handle, sess.accessJwt, sess.refreshJwt, exp).run();
  return sess;
}

async function createSession(env: Env): Promise<BskySession> {
  const r = await fetch(`${env.BSKY_PDS}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD }),
  });
  if (!r.ok) throw new Error(`createSession ${r.status}: ${await r.text()}`);
  return r.json();
}

async function refreshSession(env: Env, refreshJwt: string): Promise<BskySession> {
  const r = await fetch(`${env.BSKY_PDS}/xrpc/com.atproto.server.refreshSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshJwt}` },
  });
  if (!r.ok) throw new Error(`refreshSession ${r.status}`);
  const j: any = await r.json();
  return { did: j.did, handle: j.handle, accessJwt: j.accessJwt, refreshJwt: j.refreshJwt };
}

async function postToBsky(env: Env, sess: BskySession, text: string): Promise<string> {
  const r = await fetch(`${env.BSKY_PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({
      repo: sess.did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text: text.slice(0, 300),
        createdAt: new Date().toISOString(),
      },
    }),
  });
  if (!r.ok) throw new Error(`createRecord ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return j.uri;
}
