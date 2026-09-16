/**
 * Governance Worker — orchestrates the 7 connectomes and drives the on-chain
 * ConnectomeGovernor lifecycle: propose -> vote -> execute.
 *
 * The on-chain ConnectomeGovernor is the protocol's execution authority
 * (kernel executor + all roles). This worker is the off-chain scheduler:
 *
 *   1. PROPOSE: build (target, calldata, market) from pending treasury/
 *      protocol intents stored in D1 (`proposals_queue` table).
 *   2. VOTE: for each registered connectome, call governor.vote(pid, cid)
 *      from the connectome's bound voter key — the vote runs the connectome's
 *      on-chain LIF inference via FlyEngine.analyze().
 *   3. EXECUTE: once forVotes >= quorum (3 of 7) and > againstVotes, call
 *      governor.execute(pid). Permissionless — any keeper can.
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

import { createWalletClient, createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evaluateGateSync, CONSTITUTIONAL_GATE_ENABLED } from "./constitutional-gate";

// ======== 7 registered connectomes (bytes32 IDs match on-chain registration) ========
const CONNECTOME_IDS = [
  "rosophila",
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
  [key: string]: unknown; // CONNECTOME_<ID>_KEY
}

// ======== Minimal ABI for the governor lifecycle ========
const GOVERNOR_ABI = [
  {
    name: "propose",
    type: "function",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "price", type: "int256" },
          { name: "volume", type: "int256" },
          { name: "momentum", type: "int256" },
          { name: "volatility", type: "int256" },
          { name: "signalScore", type: "int256" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "vote",
    type: "function",
    inputs: [
      { name: "proposalId", type: "bytes32" },
      { name: "connectomeId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "execute",
    type: "function",
    inputs: [{ name: "proposalId", type: "bytes32" }],
    outputs: [{ type: "bytes" }],
  },
  {
    name: "getProposal",
    type: "function",
    inputs: [{ name: "proposalId", type: "bytes32" }],
    outputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "deadline", type: "uint256" },
      { name: "forVotes", type: "uint256" },
      { name: "againstVotes", type: "uint256" },
      { name: "executed", type: "bool" },
    ],
    stateMutability: "view",
  },
  {
    name: "isPassed",
    type: "function",
    inputs: [{ name: "proposalId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    name: "hasVoted",
    type: "function",
    inputs: [
      { name: "proposalId", type: "bytes32" },
      { name: "connectomeId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    name: "quorum",
    type: "function",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [""] } },
});

function bytes32Of(id: string): Hex {
  // bytes32(string) — right-padded ASCII
  const bytes = new TextEncoder().encode(id).slice(0, 32);
  const padded = new Uint8Array(32);
  padded.set(bytes);
  let hex = "0x";
  for (const b of padded) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/governance/epoch") return Response.json(await runEpoch(env));
    if (url.pathname === "/governance/cycle") return Response.json(await runGovernanceCycle(env));
    if (url.pathname === "/governance/status") return Response.json(await getStatus(env));
    return Response.json({ error: "unknown endpoint" }, { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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

  const publicClient = createPublicClient({ chain: arc, transport: http(env.RPC_URL) });
  const executorAccount = privateKeyToAccount(env.EXECUTOR_KEY as Hex);
  const executor = createWalletClient({ account: executorAccount, chain: arc, transport: http(env.RPC_URL) });
  const governor = env.GOVERNOR_ADDRESS as Address;

  const results: Record<string, unknown> = { proposed: 0, voted: 0, executed: 0 };

  // --- Phase A: submit queued proposals on-chain ---
  const queued = await env.DB.prepare(
    "SELECT * FROM proposals_queue WHERE status = 'queued' LIMIT 5"
  ).all();

  for (const q of (queued.results || []) as unknown as QueuedProposal[]) {
    const market = {
      price: BigInt(Math.round(q.market_price)),
      volume: BigInt(Math.round(q.market_volume)),
      momentum: BigInt(Math.round(q.market_momentum)),
      volatility: BigInt(Math.round(q.market_volatility)),
      signalScore: BigInt(Math.round(q.market_signal)),
    };
    try {
      const hash = await executor.writeContract({
        address: governor,
        abi: GOVERNOR_ABI,
        functionName: "propose",
        args: [q.target as Address, q.calldata as Hex, market],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // Read back the proposal id from the ProposalCreated event log (topic1)
      const log = receipt.logs[0] as { topics?: Hex[] } | undefined;
      const pid = log?.topics?.[1] as Hex | undefined;
      if (pid) {
        await env.DB.prepare(
          "UPDATE proposals_queue SET onchain_id = ?, status = 'open' WHERE id = ?"
        ).bind(pid, q.id).run();
        results.proposed = (results.proposed as number) + 1;
      }
    } catch (e) {
      console.error(`propose failed for queue id ${q.id}:`, e);
    }
  }

  // --- Phase B: connectome votes on open proposals ---
  const open = await env.DB.prepare(
    "SELECT * FROM proposals_queue WHERE status = 'open' LIMIT 10"
  ).all();

  for (const q of (open.results || []) as unknown as QueuedProposal[]) {
    const pid = q.onchain_id as Hex;
    if (!pid) continue;

    for (const cid of CONNECTOME_IDS) {
      const cidBytes = bytes32Of(cid);
      const already = await publicClient.readContract({
        address: governor, abi: GOVERNOR_ABI, functionName: "hasVoted", args: [pid, cidBytes],
      });
      if (already) continue;

      const key = env[`CONNECTOME_${cid.toUpperCase()}_KEY`] as string | undefined;
      if (!key) continue; // no bound voter configured for this connectome
      try {
        const wallet = createWalletClient({
          account: privateKeyToAccount(key as Hex), chain: arc, transport: http(env.RPC_URL),
        });
        await wallet.writeContract({
          address: governor, abi: GOVERNOR_ABI, functionName: "vote", args: [pid, cidBytes],
        });
        results.voted = (results.voted as number) + 1;
      } catch (e) {
        console.error(`vote failed ${cid} on ${pid}:`, e);
      }
    }

    // --- Phase C: execute passed proposals ---
    const passed = await publicClient.readContract({
      address: governor, abi: GOVERNOR_ABI, functionName: "isPassed", args: [pid],
    });
    if (passed) {
      // Constitutional gate — dormant unless CONSTITUTIONAL_GATE_ENABLED
      if (CONSTITUTIONAL_GATE_ENABLED) {
        const gate = evaluateGateSync("governance", {
          proposalId: pid,
          target: q.target,
          calldata: q.calldata,
        });
        await env.DB.prepare(
          "INSERT INTO gate_evaluations (action_type, payload, verdict, reasoning, source, connectome_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind("governance", JSON.stringify({ proposalId: pid }), gate.verdict, gate.reasoning, gate.source, "governor", Math.floor(Date.now() / 1000)).run();
        if (gate.verdict === "block") {
          await env.DB.prepare(
            "UPDATE proposals_queue SET status = 'constitutionally_blocked' WHERE id = ?"
          ).bind(q.id).run();
          continue;
        }
      }
      try {
        await executor.writeContract({
          address: governor, abi: GOVERNOR_ABI, functionName: "execute", args: [pid],
        });
        await env.DB.prepare(
          "UPDATE proposals_queue SET status = 'executed' WHERE id = ?"
        ).bind(q.id).run();
        results.executed = (results.executed as number) + 1;
      } catch (e) {
        console.error(`execute failed ${pid}:`, e);
      }
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
