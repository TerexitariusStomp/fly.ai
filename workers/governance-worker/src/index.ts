/**
 * Governance Worker — orchestrates the 7 connectomes and drives the on-chain
 * ConnectomeGovernor lifecycle: propose -> vote -> execute.
 *
 * The on-chain ConnectomeGovernor is the protocol's execution authority
 * (kernel executor + all roles). This worker is the off-chain scheduler:
 *
 *   1. PROPOSE: build (target, calldata, market) from pending treasury/
 *      protocol intents stored in D1 (`proposals_queue` table).
 *   2. VOTE: each connectome's DO evaluates off-chain (fly-brain-do /decide);
 *      votes land in D1 `governance_votes`. No on-chain gas per vote.
 *   3. EXECUTE: once forVotes >= quorum (3 of 7) and > againstVotes, the
 *      colonyExecutor relays a single governor.colonyExecute(ref, target, data)
 *      tx. The on-chain propose/vote/execute path is a dormant fallback only —
 *      on-chain LIF votes cost ~16M gas each, so everything votes off-chain.
 *
 * Also aggregates per-connectome P&L from D1 for the meta-wallet and
 * reporting, and posts epoch summaries to Discord.
 *
 * Env (wrangler secrets/vars):
 *   DB                     — D1 database (wallets, proposals_queue)
 *   GOVERNOR_ADDRESS       — ConnectomeGovernor proxy
 *   RPC_URL                — Arc RPC endpoint
 *   CONNECTOME_<ID>_KEY    — private key for each connectome's bound voter EOA
 *   EXECUTOR_KEY           — key that creates proposals + executes passed ones
 *   DISCORD_WEBHOOK_URL    — optional
 */

import { createWalletClient, createPublicClient, defineChain, encodeFunctionData, encodePacked, keccak256, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { evaluateGateSync, CONSTITUTIONAL_GATE_ENABLED } from "./constitutional-gate";
import { safeDb } from "./safe-db";
import { handleGitHttp } from "./git-http";
import { commitFile, listPaths, readFile } from "./git-store";

// ======== 7 registered connectomes (bytes32 IDs match on-chain registration) ========
const CONNECTOME_IDS = [
  "drosophila",
  "rat",
  "mouse",
  "ciona",
  "macaque_modha",
  "human",
  "celegans_male",
] as const;

type ConnectomeId = (typeof CONNECTOME_IDS)[number];
const QUORUM = 3; // ceil(7 / 3) — enforced on-chain too

interface Env {
  DB: D1Database;
  FLY_BRAIN: DurableObjectNamespace;
  GOVERNOR_ADDRESS?: string;
  RPC_URL?: string;
  EXECUTOR_KEY?: string;
  DISCORD_WEBHOOK_URL?: string;
  COLONY_ADMIN_KEY?: string; // X-Colony-Key on mutation routes
  [key: string]: unknown; // CONNECTOME_<ID>_KEY
}


const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});
const robinhood = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});
// Pick chain from the RPC URL — workers can point at testnet or mainnet.
function chainFor(env: Env) {
  return (env.RPC_URL || "").includes("mainnet") ? robinhood : robinhoodTestnet;
}


// ======== Treasury review — connectome-managed rewards + bond sizing ========
// Rewards are funded by market buybacks, never minting: TRSRY USDC reserves
// (LP fees + trading profits) get swapped to SYM and deposited into the
// staking rewardPool via FeeRouter.fundRewards — a connectome vote.
// Bond capacity is sized to how much SYM the treasury is able to absorb:
// thin SYM inventory → larger buyback capacity; heavy inventory → smaller.

const ERC20_BAL_ABI = [
  { name: "balanceOf", type: "function", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "totalSupply", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const EXECUTE_MODULE_ABI = [
  { name: "executeModule", type: "function", inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] },
] as const;
const FUND_REWARDS_ABI = [
  { name: "fundRewards", type: "function", inputs: [{ name: "usdcAmount", type: "uint256" }, { name: "minSymbientOut", type: "uint256" }], outputs: [] },
] as const;
const BOND_CAPACITY_ABI = [
  { name: "setMaxCapacityBps", type: "function", inputs: [{ name: "bps", type: "uint256" }], outputs: [] },
  { name: "maxCapacityBps", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
const REWARD_POOL_ABI = [
  { name: "rewardPool", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;


// colonyExecute — one-tx execution after off-chain quorum (votes stay in D1)
const COLONY_ABI = [
  { name: "colonyExecute", type: "function", inputs: [
    { name: "decisionRef", type: "bytes32" }, { name: "target", type: "address" },
    { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] },
] as const;

const REVIEW_INTERVAL_S = 6 * 3600;        // one treasury review per 6h
const REWARD_RESERVE_PCT = 20n;            // fund rewards with 20% of USDC reserves
const REWARD_MIN_USDC = 25n * 10n ** 6n;   // don't bother under $25
const SLIPPAGE_BPS = 300n;                 // 3% min-out on the USDC→SYM swap

async function runTreasuryReview(env: Env): Promise<Record<string, unknown>> {
  const required = ["TRSRY_ADDRESS", "FEE_ROUTER", "GOVERNOR_POLICY", "INVERSE_BOND", "FLYAI_TOKEN", "FLYAI_POOL_ID", "STAKING", "USDC_ADDRESS"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) return { skipped: `missing env: ${missing.join(",")}` };

  // rate limit — one review per interval
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_treasury_review'").first();
  const now = Math.floor(Date.now() / 1000);
  if (last && now - parseInt(last.value as string) < REVIEW_INTERVAL_S) {
    return { skipped: "reviewed recently" };
  }

  const pub = createPublicClient({ chain: chainFor(env), transport: http(env.RPC_URL) });
  const trsry = env.TRSRY_ADDRESS as Address;
  const usdc = env.USDC_ADDRESS as Address;
  const sym = env.FLYAI_TOKEN as Address;
  // V4 pool IDs are bytes32, not ERC20 pair contracts — balanceOf reads
  // on this revert and return 0n until a V4 reserve adapter is added.
  const pair = env.FLYAI_POOL_ID as Address;

  const read = (address: Address, fn: "balanceOf" | "totalSupply", args: readonly unknown[] = []) =>
    pub.readContract({ address, abi: ERC20_BAL_ABI, functionName: fn, args: args as never }).catch(() => 0n);

  const [usdcReserves, routerUsdc, symHeld, symSupply, pairUsdc, pairSym, rewardPool, curCapBps] = await Promise.all([
    read(usdc, "balanceOf", [trsry]),
    read(usdc, "balanceOf", [env.FEE_ROUTER as Address]),
    read(sym, "balanceOf", [trsry]),
    read(sym, "totalSupply"),
    read(usdc, "balanceOf", [pair]),
    read(sym, "balanceOf", [pair]),
    pub.readContract({ address: env.STAKING as Address, abi: REWARD_POOL_ABI, functionName: "rewardPool" }).catch(() => 0n),
    pub.readContract({ address: env.INVERSE_BOND as Address, abi: BOND_CAPACITY_ABI, functionName: "maxCapacityBps" }).catch(() => 0n),
  ]);

  const symPerUsdc = pairUsdc > 0n ? Number(pairSym) / Number(pairUsdc) : 0;
  const priceMicro = pairSym > 0n ? Number(pairUsdc) / (Number(pairSym) / 1e12) : 0;

  const queued: string[] = [];

  // --- Rewards: buyback-fund the staking pool from grown reserves ---
  const rewardFloat = usdcReserves + routerUsdc; // claimable + treasury USDC
  if (rewardFloat >= REWARD_MIN_USDC) {
    const spend = (rewardFloat * REWARD_RESERVE_PCT) / 100n;
    const expectedSym = symPerUsdc > 0 ? BigInt(Math.floor(Number(spend) / 1e6 * symPerUsdc)) : 0n;
    const minOut = (expectedSym * (10000n - SLIPPAGE_BPS)) / 10000n;
    if (minOut > 0n) {
      const inner = encodeFunctionData({ abi: FUND_REWARDS_ABI, functionName: "fundRewards", args: [spend, minOut] });
      const data = encodeFunctionData({ abi: EXECUTE_MODULE_ABI, functionName: "executeModule", args: [env.FEE_ROUTER as Address, inner] });
      await queueProposal(env, {
        target: env.GOVERNOR_POLICY as string, calldata: data, kind: "fund_rewards",
        description: `fundRewards: $${(Number(spend) / 1e6).toFixed(2)} USDC → SYM → rewardPool (pool now ${(Number(rewardPool) / 1e18).toFixed(2)} SYM)`,
        price: priceMicro, signal: 70,
      });
      queued.push("fund_rewards");
    }
  }

  // --- Bond capacity: scale to SYM inventory share ---
  const symShareBps = symSupply > 0n ? Number((symHeld * 10000n) / symSupply) : 0;
  const targetCapBps = symShareBps < 100 ? 300 : symShareBps < 500 ? 150 : 50; // <1% → 3%, <5% → 1.5%, else 0.5% NAV/epoch
  if (targetCapBps !== Number(curCapBps)) {
    const data = encodeFunctionData({ abi: BOND_CAPACITY_ABI, functionName: "setMaxCapacityBps", args: [BigInt(targetCapBps)] });
    await queueProposal(env, {
      target: env.INVERSE_BOND as string, calldata: data, kind: "bond_capacity",
      description: `setMaxCapacityBps(${targetCapBps}) — treasury SYM share ${(symShareBps / 100).toFixed(2)}% of supply`,
      price: priceMicro, signal: symShareBps < 100 ? 75 : 45,
    });
    queued.push("bond_capacity");
  }

  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_treasury_review', ?)").bind(String(now)).run();

  // Evolution step — every review cycle, underperforming connectomes mutate
  // toward the colony's top performer (genome blend + LLM persona rewrite).
  for (const cid of CONNECTOME_IDS) {
    try {
      const doId = env.FLY_BRAIN.idFromName(`connectome:${cid}`);
      await env.FLY_BRAIN.get(doId).fetch(`https://do/evolve?cid=${cid}`);
    } catch (e) {
      console.error(`evolve ${cid}:`, e);
    }
  }

  return { queued, usdcReserves: Number(usdcReserves) / 1e6, symShareBps };
}

async function queueProposal(env: Env, p: {
  target: string; calldata: string; kind: string; description: string; price: number; signal: number;
}) {
  // one pending proposal per kind — don't double-queue
  const pending = await env.DB.prepare(
    "SELECT id FROM proposals_queue WHERE kind = ? AND status IN ('queued','open') LIMIT 1"
  ).bind(p.kind).first();
  if (pending) return;
  await env.DB.prepare(
    "INSERT INTO proposals_queue (target, calldata, description, kind, market_price, market_volume, market_momentum, market_volatility, market_signal, status, created_at) " +
    "VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, 'queued', ?)"
  ).bind(p.target, p.calldata, p.description, p.kind, Math.round(p.price), Math.round(p.signal), Math.floor(Date.now() / 1000)).run();
}

// ======== Code tasks — connectomes write code, colony votes, CF remote merges ========
// The colony's canonical repo is the R2 git store served by this worker
// (GET /repo.git/info/refs → clone-able). Radicle mirrors it whenever the
// node fetches this remote + `rad push`. No GitHub anywhere.

const IdeaSchema = z.object({
  task: z.string().min(5).max(200),
  file_path: z.string().min(1).max(300),
  rationale: z.string().max(300).optional(),
});

const CODE_PATHS = /^(workers\/|contracts\/src\/|frontend\/|migrations\/|AGENTS\.md|README\.md)/;
const CODE_PATH_DENY = /\.env|secret|node_modules|\.git\/|package-lock|pnpm-lock/i;

async function proposeCodeTask(env: Env, task: string, filePath: string, _repo?: string, rationale?: string): Promise<Record<string, unknown>> {
  // Rotate the proposer across connectomes — everyone gets turns coding
  const n = await env.DB.prepare("SELECT COUNT(*) c FROM code_tasks").first();
  const proposer = CONNECTOME_IDS[Number(n?.c ?? 0) % CONNECTOME_IDS.length];

  if (CODE_PATH_DENY.test(filePath)) return { error: "path denied" };

  // Current file content from the colony repo (empty = new file)
  const fileContent = await readFile(env, filePath).catch(() => "");

  // The proposer connectome writes the patch
  const doId = env.FLY_BRAIN.idFromName(`connectome:${proposer}`);
  const resp = await env.FLY_BRAIN.get(doId).fetch("https://do/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, file_path: filePath, file_content: fileContent }),
  });
  const gen = (await resp.json()) as { new_content?: string; error?: string };
  if (gen.error || !gen.new_content) return { error: gen.error || "generation failed", proposer };

  // Tier 0/1 constitutional gate on the proposed content — always on for code
  const gate = evaluateGateSync("code_commit", { task, file_path: filePath, patch: gen.new_content });
  if (gate.verdict === "block") {
    await env.DB.prepare(
      "INSERT INTO code_tasks (task, file_path, proposer, new_content, status, outcome, rationale, created_at) VALUES (?,?,?,?,'gate_blocked','gate_blocked',?,?)"
    ).bind(task, filePath, proposer, gen.new_content, rationale || "", Math.floor(Date.now() / 1000)).run();
    // Gate-blocked code counts against the proposer — fitness feedback
    await env.DB.prepare(
      "UPDATE connectome_genome SET pnl_score = COALESCE(pnl_score, 0) - 2 WHERE connectome_id = ?"
    ).bind(proposer).run().catch(() => {});
    await journal(env, proposer, "gate_blocked", `${filePath}: ${task.slice(0, 80)}`);
    return { blocked: gate.reasoning, proposer };
  }

  const now = Math.floor(Date.now() / 1000);
  const ins = await env.DB.prepare(
    "INSERT INTO code_tasks (task, file_path, proposer, new_content, status, rationale, created_at) VALUES (?,?,?,?,'open',?,?)"
  ).bind(task, filePath, proposer, gen.new_content, rationale || "", now).run();
  const taskId = Number(ins.meta.last_row_id);

  await env.DB.prepare(
    "INSERT INTO proposals_queue (target, calldata, description, kind, market_price, market_volume, market_momentum, market_volatility, market_signal, status, created_at) " +
    "VALUES ('code-task', ?, ?, ?, 0, 0, 0, 0, 0, 'queued', ?)"
  ).bind(JSON.stringify({ code_task_id: taskId }), `code: ${task.slice(0, 120)} → ${filePath} (by ${proposer})`, `code:${taskId}`, now).run();
  await journal(env, proposer, "proposed", `task ${taskId}: ${task.slice(0, 100)}`);

  return { task_id: taskId, proposer, status: "queued" };
}

async function journal(env: Env, cid: string, event: string, detail: string) {
  await env.DB.prepare(
    "INSERT INTO code_journal (connectome_id, event, detail, created_at) VALUES (?, ?, ?, ?)"
  ).bind(cid, event, detail.slice(0, 300), Math.floor(Date.now() / 1000)).run().catch(() => {});
}

// Colony-approved code merges straight onto main of the CF repo — the
// commit IS the merge. Radicle mirrors whenever the node fetches + pushes.
async function mergeCodeTask(env: Env, task: { id: number; task: string; file_path: string; proposer: string; new_content: string }): Promise<string> {
  return commitFile(env, {
    path: task.file_path,
    content: task.new_content,
    message: `${task.task}\n\nproposed-by: ${task.proposer} (colony vote ≥3/7)`,
    author: `connectome-${task.proposer}`,
  });
}

// Repo map cache — listPaths walks the whole git tree via per-object D1
// reads (~800 rows). Cache for 6h; invalidated implicitly when tasks merge.
async function cachedRepoPaths(env: Env): Promise<string[]> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'repo_map'"
  ).first() as { value?: string } | null;
  const at = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'repo_map_at'"
  ).first() as { value?: string } | null;
  if (row?.value && Number(at?.value ?? 0) > Date.now() - 6 * 3600_000) {
    try { return JSON.parse(row.value) as string[]; } catch { /* rebuild */ }
  }
  const paths = (await listPaths(env))
    .filter((p) => CODE_PATHS.test(p) && !CODE_PATH_DENY.test(p))
    .slice(0, 200);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('repo_map', ?)")
      .bind(JSON.stringify(paths)),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('repo_map_at', ?)")
      .bind(String(Date.now())),
  ]);
  return paths;
}

// Self-directed ideation — one connectome picks a file + improvement each cycle
async function runCodeIdeation(env: Env): Promise<Record<string, unknown>> {
  const enabled = await env.DB.prepare("SELECT value FROM settings WHERE key = 'code_enabled'").first();
  if (String(enabled?.value ?? "true") !== "true") return { skipped: "code_enabled=false" };

  const inFlight = await env.DB.prepare(
    "SELECT COUNT(*) c FROM code_tasks WHERE status IN ('open','queued','approved','pr_open')"
  ).first();
  if (Number(inFlight?.c ?? 0) > 0) return { skipped: "task in flight" };

  const today = Math.floor(Date.now() / 86400000) * 86400;
  const capRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'code_max_per_day'").first();
  const cap = Number(capRow?.value ?? 8);
  const todayCount = await env.DB.prepare("SELECT COUNT(*) c FROM code_tasks WHERE created_at >= ?").bind(today).first();
  if (Number(todayCount?.c ?? 0) >= cap) return { skipped: "daily cap" };

  // Throttle — ideation (listPaths + LLM) is the heaviest leg of the cycle;
  // running it every tick blows the CPU budget and takes governance down.
  const lastIdeation = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_code_ideation'").first();
  if (Number(lastIdeation?.value ?? 0) > Date.now() - 3_600_000) return { skipped: "ideated recently" };
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_code_ideation', ?)")
    .bind(String(Date.now())).run();

  // Repo map — cached in settings; the git-tree walk costs a D1 read per
  // object, which is what pushed cycles past the CPU limit once seeded.
  const paths = await cachedRepoPaths(env);
  if (paths.length === 0) return { skipped: "no source paths" };

  const recent = await env.DB.prepare(
    "SELECT task, file_path, outcome FROM code_tasks WHERE outcome IS NOT NULL ORDER BY id DESC LIMIT 10"
  ).all();
  const outcomes = (recent.results || [])
    .map((r) => `${r.file_path}: ${r.outcome} (${String(r.task).slice(0, 60)})`).join("\n");

  const n = await env.DB.prepare("SELECT COUNT(*) c FROM code_tasks").first();
  const ideator = CONNECTOME_IDS[Number(n?.c ?? 0) % CONNECTOME_IDS.length];
  const doId = env.FLY_BRAIN.idFromName(`connectome:${ideator}`);
  const resp = await env.FLY_BRAIN.get(doId).fetch("https://do/ideate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo_map: paths.join("\n"), recent_outcomes: outcomes || "none yet" }),
  });
  const raw = (await resp.json()) as Record<string, unknown>;
  const idea = IdeaSchema.safeParse(raw);
  if (!idea.success) return { skipped: `ideation unparseable: ${String(raw.error || raw.task || "").slice(0, 80)}` };
  if (CODE_PATH_DENY.test(idea.data.file_path)) return { skipped: "denied path" };
  // The model must pick a real file from the map — no hallucinated paths
  if (!paths.includes(idea.data.file_path)) {
    return { skipped: `hallucinated path: ${idea.data.file_path}` };
  }

  await journal(env, ideator, "ideated", `${idea.data.file_path}: ${idea.data.task.slice(0, 80)}`);
  const out = await proposeCodeTask(env, idea.data.task, idea.data.file_path, undefined, idea.data.rationale);
  return { ideator, ...out };
}

// Outcome → genome fitness: code skill feeds the evolution loop
async function resolveCodeTask(env: Env, taskId: number, outcome: string, now: number) {
  const t = await env.DB.prepare("SELECT proposer, task FROM code_tasks WHERE id = ?").bind(taskId).first();
  const delta = outcome === "merged" ? 2 : outcome === "rejected" ? -1 : outcome === "gate_blocked" ? -2 : -0.5;
  await env.DB.prepare("UPDATE code_tasks SET status = ?, outcome = ?, merged_at = ? WHERE id = ?")
    .bind(outcome === "merged" ? "merged" : outcome, outcome, outcome === "merged" ? now : null, taskId).run();
  if (t?.proposer) {
    await env.DB.prepare(
      "UPDATE connectome_genome SET pnl_score = COALESCE(pnl_score, 0) + ? WHERE connectome_id = ?"
    ).bind(delta, t.proposer).run().catch(() => {});
    await journal(env, String(t.proposer), outcome, `task ${taskId}: ${String(t.task || "").slice(0, 100)}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    env = { ...env, DB: safeDb(env.DB) };
    const url = new URL(request.url);
    // The colony's canonical git remote — cloneable by anyone, mirrored to
    // Radicle whenever the node fetches it. Read-only over HTTP.
    if (url.pathname.includes("/repo.git")) return handleGitHttp(request, env);
    // Mutation routes need the colony key — the fly-brain DOs send
    // X-Colony-Key; public reads (status, repo.git GETs) stay open.
    const mutating = ["/governance/epoch", "/governance/cycle", "/governance/review", "/code/propose"]
      .includes(url.pathname);
    if (mutating) {
      const key = request.headers.get("X-Colony-Key") || url.searchParams.get("key") || "";
      if (!env.COLONY_ADMIN_KEY || key !== env.COLONY_ADMIN_KEY) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
    }
    if (url.pathname === "/governance/epoch") return Response.json(await runEpoch(env));
    if (url.pathname === "/governance/cycle") return Response.json(await runGovernanceCycle(env));
    if (url.pathname === "/governance/review") return Response.json(await runTreasuryReview(env));
    if (url.pathname === "/governance/status") return Response.json(await getStatus(env));
    if (url.pathname === "/code/propose" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { task?: string; file_path?: string; repo?: string };
      if (!body.task || !body.file_path) return Response.json({ error: "task + file_path required" }, { status: 400 });
      return Response.json(await proposeCodeTask(env, body.task, body.file_path, body.repo));
    }
    if (url.pathname === "/code/repo-map") {
      try {
        const paths = await listPaths(env);
        return Response.json({ count: paths.length, paths: paths.slice(0, 20) });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }
    if (url.pathname === "/code/status") {
      const tasks = await env.DB.prepare("SELECT id, task, file_path, proposer, status, pr_url, proposal_id, created_at FROM code_tasks ORDER BY id DESC LIMIT 20").all();
      return Response.json({ tasks: tasks.results || [] });
    }
    return Response.json({ error: "unknown endpoint" }, { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    env = { ...env, DB: safeDb(env.DB) };
    ctx.waitUntil(
      (async () => {
        await runGovernanceCycle(env);
        await runEpoch(env);
      })()
    );
  },
};

// ======== On-chain governance cycle ========

interface QueuedProposal {
  id: number;
  target: string;
  calldata: string;
  market_price: number;
  market_volume: number;
  market_momentum: number;
  market_volatility: number;
  market_signal: number;
  onchain_id: string | null;
  status: string;
}

async function runGovernanceCycle(env: Env): Promise<Record<string, unknown>> {
  if (!env.GOVERNOR_ADDRESS || !env.RPC_URL || !env.EXECUTOR_KEY) {
    return { error: "GOVERNOR_ADDRESS/RPC_URL/EXECUTOR_KEY not configured" };
  }

  const publicClient = createPublicClient({ chain: chainFor(env), transport: http(env.RPC_URL) });
  const executorAccount = privateKeyToAccount(env.EXECUTOR_KEY as Hex);
  const executor = createWalletClient({ account: executorAccount, chain: chainFor(env), transport: http(env.RPC_URL) });
  const governor = env.GOVERNOR_ADDRESS as Address;

  const results: Record<string, unknown> = { proposed: 0, voted: 0, executed: 0 };

  // --- Phase 0: treasury review → queue reward/bond proposals (rate-limited) ---
  try {
    results.review = await runTreasuryReview(env);
  } catch (e) {
    console.error("treasury review failed:", e);
  }

  // --- Phase 0b: self-improvement loop — ideate a task when idle; approved
  // tasks commit to the CF repo directly; outcomes feed genome fitness ---
  try {
    results.code_ideation = await runCodeIdeation(env);
  } catch (e) {
    console.error("code loop failed:", e);
    results.code_error = String(e).slice(0, 200);
  }

  // --- Phase A: open queued proposals (off-chain — no tx cost) ---
  const queued = await env.DB.prepare(
    "SELECT * FROM proposals_queue WHERE status = 'queued' LIMIT 5"
  ).all();
  for (const q of (queued.results || []) as unknown as QueuedProposal[]) {
    await env.DB.prepare(
      "UPDATE proposals_queue SET status = 'open' WHERE id = ?"
    ).bind(q.id).run();
    results.proposed = (results.proposed as number) + 1;
  }

  // --- Phase B: collect connectome votes into D1 (free — off-chain) ---
  const open = await env.DB.prepare(
    "SELECT * FROM proposals_queue WHERE status = 'open' LIMIT 10"
  ).all();
  const QUORUM = 3; // ceil(7 × 1/3) — mirrors ConnectomeGovernor._quorum()

  for (const q of (open.results || []) as unknown as (QueuedProposal & { kind?: string; description?: string })[]) {
    const isCode = String((q as { kind?: string }).kind || "").startsWith("code");
    interface CodeTask { id: number; task: string; file_path: string; new_content: string; repo?: string; proposer?: string }
    let codeTask: CodeTask | null = null;
    if (isCode) {
      try {
        const ref = JSON.parse(q.calldata) as { code_task_id?: number };
        codeTask = (await env.DB.prepare(
          "SELECT id, task, file_path, new_content, repo, proposer FROM code_tasks WHERE id = ?"
        ).bind(ref.code_task_id).first()) as CodeTask | null;
      } catch { /* malformed calldata */ }
      if (!codeTask) {
        await env.DB.prepare("UPDATE proposals_queue SET status = 'rejected' WHERE id = ?").bind(q.id).run();
        continue;
      }
    }

    for (const cid of CONNECTOME_IDS) {
      // Dedupe: one vote per connectome per proposal (D1 PK)
      const existing = await env.DB.prepare(
        "SELECT 1 FROM governance_votes WHERE proposal_id = ? AND connectome_id = ?"
      ).bind(q.id, cid).first();
      if (existing) continue;

      try {
        // Off-chain inference — the connectome's DO evaluates the
        // proposal's market context, or reviews the patch for code tasks.
        const doId = env.FLY_BRAIN.idFromName(`connectome:${cid}`);
        const resp = isCode && codeTask
          ? await env.FLY_BRAIN.get(doId).fetch("https://do/review", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ task: codeTask.task, file_path: codeTask.file_path, patch: codeTask.new_content }),
            })
          : await env.FLY_BRAIN.get(doId).fetch(
              `https://do/decide?signalScore=${q.market_signal ?? 50}`
            );
        const d = (await resp.json()) as { action?: number; confidence?: number; reason?: string };
        const action = Math.max(-1, Math.min(1, Math.trunc(d.action ?? 0)));
        const confidence = Math.max(0, Math.min(100, Math.trunc(d.confidence ?? 0)));

        await env.DB.prepare(
          "INSERT OR IGNORE INTO governance_votes (proposal_id, connectome_id, action, confidence, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(q.id, cid, action, confidence, (d.reason || "").slice(0, 200), Math.floor(Date.now() / 1000)).run();
        results.voted = (results.voted as number) + 1;
      } catch (e) {
        console.error(`decide failed ${cid} on proposal ${q.id}:`, e);
      }
    }

    // Tally from the D1 ledger
    const tally = await env.DB.prepare(
      "SELECT SUM(action = 1) f, SUM(action = -1) a, COUNT(*) n FROM governance_votes WHERE proposal_id = ?"
    ).bind(q.id).first() as { f: number | null; a: number | null; n: number } | null;
    const forV = tally?.f ?? 0, againstV = tally?.a ?? 0, total = tally?.n ?? 0;
    await env.DB.prepare(
      "UPDATE proposals_queue SET votes_for = ?, votes_against = ? WHERE id = ?"
    ).bind(forV, againstV, q.id).run();

    // --- Phase C: execute when quorum met ---
    if (forV >= QUORUM && forV > againstV) {
      // Code tasks execute as a GitHub PR — off-chain action, no colonyExecute
      if (isCode && codeTask) {
        // Gate runs again on the stored content for audit
        const gate = evaluateGateSync("code_commit", {
          task: codeTask.task, file_path: codeTask.file_path, patch: codeTask.new_content,
        });
        await env.DB.prepare(
          "INSERT INTO gate_evaluations (action_type, payload, verdict, reasoning, source, connectome_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind("code_commit", JSON.stringify({ taskId: codeTask.id }), gate.verdict, gate.reasoning, gate.source, "governor", Math.floor(Date.now() / 1000)).run();
        if (gate.verdict === "block") {
          await env.DB.prepare("UPDATE proposals_queue SET status = 'constitutionally_blocked' WHERE id = ?").bind(q.id).run();
          await env.DB.prepare("UPDATE code_tasks SET status = 'gate_blocked' WHERE id = ?").bind(codeTask.id).run();
          continue;
        }
        try {
          // Approved → commit straight to main of the colony repo (CF remote)
          const sha = await mergeCodeTask(env, {
            id: codeTask.id, task: codeTask.task, file_path: codeTask.file_path,
            proposer: codeTask.proposer || "unknown", new_content: codeTask.new_content,
          });
          await resolveCodeTask(env, codeTask.id, "merged", Math.floor(Date.now() / 1000));
          await env.DB.prepare("DELETE FROM settings WHERE key IN ('repo_map','repo_map_at')").run().catch(() => {});
          await env.DB.prepare("UPDATE code_tasks SET commit_sha = ? WHERE id = ?")
            .bind(sha, codeTask.id).run().catch(() => {});
          await env.DB.prepare("UPDATE proposals_queue SET status = 'executed', tx_hash = ? WHERE id = ?")
            .bind(`commit:${sha}`, q.id).run();
          results.executed = (results.executed as number) + 1;
        } catch (e) {
          console.error(`code commit failed proposal ${q.id}:`, e);
          results.code_error = String(e).slice(0, 200);
        }
        continue;
      }

      // Constitutional gate — dormant unless CONSTITUTIONAL_GATE_ENABLED
      if (CONSTITUTIONAL_GATE_ENABLED) {
        const gate = evaluateGateSync("governance", {
          proposalId: q.id, target: q.target, calldata: q.calldata,
        });
        await env.DB.prepare(
          "INSERT INTO gate_evaluations (action_type, payload, verdict, reasoning, source, connectome_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind("governance", JSON.stringify({ proposalId: q.id }), gate.verdict, gate.reasoning, gate.source, "governor", Math.floor(Date.now() / 1000)).run();
        if (gate.verdict === "block") {
          await env.DB.prepare(
            "UPDATE proposals_queue SET status = 'constitutionally_blocked' WHERE id = ?"
          ).bind(q.id).run();
          continue;
        }
      }
      try {
        // Route through colonyExecute on the governor — one tx: emits
        // ColonyActionExecuted + ledger recordExecution + socialPostLog.
        // decisionRef links the on-chain event to this D1 proposal record;
        // if the proposal also exists on-chain, colonyExecute marks it done.
        const decisionRef = (q.onchain_id as Hex | null) ??
          keccak256(encodePacked(
            ["uint256", "string", "string", "string"],
            [BigInt(q.id), String(q.target), String(q.calldata), String(q.description ?? "")],
          ));
        const hash = await executor.writeContract({
          address: governor, abi: COLONY_ABI, functionName: "colonyExecute",
          args: [decisionRef, q.target as Address, q.calldata as Hex],
        });
        // Arc RPC often drops receipt polling — the tx usually still lands.
        try {
          await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
        } catch { /* landed or pending — hash recorded, verify next cycle */ }
        await env.DB.prepare(
          "UPDATE proposals_queue SET status = 'executed', tx_hash = ? WHERE id = ?"
        ).bind(hash, q.id).run();
        results.executed = (results.executed as number) + 1;
      } catch (e) {
        console.error(`colonyExecute failed proposal ${q.id}:`, e);
      }
    } else if (againstV >= QUORUM && againstV > forV) {
      await env.DB.prepare(
        "UPDATE proposals_queue SET status = 'rejected' WHERE id = ?"
      ).bind(q.id).run();
      if (isCode && codeTask) await resolveCodeTask(env, codeTask.id, "rejected", Math.floor(Date.now() / 1000));
    } else if (total >= CONNECTOME_IDS.length) {
      // all voted, quorum unmet → expires
      await env.DB.prepare(
        "UPDATE proposals_queue SET status = 'expired' WHERE id = ?"
      ).bind(q.id).run();
      if (isCode && codeTask) await resolveCodeTask(env, codeTask.id, "rejected", Math.floor(Date.now() / 1000));
    }
  }

  return results;
}

// ======== Off-chain P&L aggregation (meta wallet) ========

async function runEpoch(env: Env): Promise<Record<string, unknown>> {
  const wallets = await env.DB.prepare(
    "SELECT w.id, w.connectome_id, w.balance_usd, w.starting_balance, w.total_pnl, w.n_trades, w.n_wins " +
    "FROM wallets w WHERE w.wallet_type = 'individual'"
  ).all();

  const results: Record<string, unknown> = {};
  const pnls: { connectome_id: string; pnl: number; n_trades: number }[] = [];

  for (const w of wallets.results || []) {
    pnls.push({
      connectome_id: w.connectome_id as string,
      pnl: (w.balance_usd as number) - (w.starting_balance as number),
      n_trades: w.n_trades as number,
    });
  }

  const buyVotes = pnls.filter((p) => p.pnl > 0).length;
  const sellVotes = pnls.filter((p) => p.pnl < 0).length;
  const globalDecision = buyVotes > sellVotes ? "BUY" : sellVotes > buyVotes ? "SELL" : "HOLD";

  const totalTrades = pnls.reduce((s, p) => s + p.n_trades, 0);
  const weightedPnl = pnls.reduce((s, p) => s + p.pnl * (p.n_trades / Math.max(totalTrades, 1)), 0);
  const metaDecision = weightedPnl > 0 ? "BUY" : weightedPnl < 0 ? "SELL" : "HOLD";

  const epoch = Math.floor(Date.now() / 86_400_000);
  for (const p of pnls) {
    await env.DB.prepare(
      "INSERT INTO connectome_pnl_reports (connectome_id, epoch, pnl_percent, cumulative_pnl, n_trades, reported_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(p.connectome_id, epoch, p.pnl, p.pnl, p.n_trades, Date.now()).run();
  }

  if (env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "SYM Governance",
          embeds: [{
            title: `Epoch ${epoch} settled`,
            color: 0x9b59b6,
            fields: [
              { name: "Global decision", value: globalDecision, inline: true },
              { name: "Meta decision", value: metaDecision, inline: true },
              { name: "Buy votes", value: String(buyVotes), inline: true },
              { name: "Sell votes", value: String(sellVotes), inline: true },
              { name: "Quorum", value: `${QUORUM}/${CONNECTOME_IDS.length}`, inline: true },
            ],
          }],
        }),
      });
    } catch {}
  }

  results.epoch = epoch;
  results.global_decision = globalDecision;
  results.meta_decision = metaDecision;
  results.connectomes = pnls;
  return results;
}

async function getStatus(env: Env): Promise<Record<string, unknown>> {
  const connectomes = await env.DB.prepare(
    "SELECT id, species, n_neurons, status FROM connectomes ORDER BY id"
  ).all();
  const wallets = await env.DB.prepare(
    "SELECT id, connectome_id, wallet_type, balance_usd, total_pnl, n_trades FROM wallets ORDER BY id"
  ).all();
  const proposals = await env.DB.prepare(
    "SELECT id, target, status, onchain_id FROM proposals_queue ORDER BY id DESC LIMIT 20"
  ).all();
  return {
    connectomes: connectomes.results,
    wallets: wallets.results,
    proposals: proposals.results,
    registered_connectomes: CONNECTOME_IDS,
    timestamp: Date.now(),
  };
}
