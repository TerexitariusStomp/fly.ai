/**
 * Constitutional Gate — "Does this, on the net and over relevant timescales,
 * create more for all life?"
 *
 * Ported from widespread.fyi's packages/security/src/constitutional-gate.ts
 * (Apache-2.0). Adapted for the connectome colony: Tier 3 uses the 7
 * connectomes as the multi-agent vote instead of generic symbients.
 *
 * Tiers:
 *   0 — absolute prohibitions (no override, no exception)
 *   1 — rule-based pre-checks (overrideable)
 *   2 — LLM evaluation against the constitution (async, caller provides llm fn)
 *   3 — multi-connectome vote (majority block wins)
 *   4 — admin override (signed, auditable, cannot override Tier 0)
 *
 * Dormant by default: set CONSTITUTIONAL_GATE_ENABLED = true to activate.
 * Fail-closed: if evaluation errors, the action is blocked.
 */

export const CONSTITUTIONAL_GATE_ENABLED = false;

export const CONSTITUTION_TEXT =
  "Does this, on the net and over relevant timescales, create more for all life?";

export const CONSTITUTION_VERSION = 1;

export type GateVerdict = "allow" | "object" | "block";
export type GateSource =
  | "tier0" | "rules" | "llm" | "vote" | "admin_override" | "fail_closed";

export interface GateResult {
  verdict: GateVerdict;
  reasoning: string;
  source: GateSource;
  overrideable: boolean;
  timestamp: number;
  constitutionVersion: number;
  signature?: string;
}

// ── Tier 0: absolute prohibitions (no-override, no-exception) ──────────────

const TIER0_PROHIBITIONS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /csam|child\s+sexual|minor.*sexual/i, reason: "Tier 0: CSAM prohibition" },
  { pattern: /genocide|ethnic\s+cleansing/i, reason: "Tier 0: Genocide facilitation" },
  { pattern: /manipulat(e|ion).*deceptive/i, reason: "Tier 0: Deceptive manipulation" },
  { pattern: /fake\s+emotion|performed\s+emotion/i, reason: "Tier 0: Performed emotion" },
  { pattern: /biometric.*infer|infer.*biometric/i, reason: "Tier 0: Biometric inference" },
  { pattern: /expose.*private.*key|leak.*oauth.*token|exfiltrate.*secret/i, reason: "Tier 0: Unauthorized secret access" },
  // Colony-specific: never allow draining the shared treasury
  { pattern: /drain.*treasury|withdraw.*all|transfer.*all.*funds/i, reason: "Tier 0: Treasury drain attempt" },
  { pattern: /self.*destruct|destroy.*contract|kill.*protocol/i, reason: "Tier 0: Protocol destruction" },
];

// ── Tier 1: rule-based pre-checks (overrideable) ───────────────────────────

const TIER1_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /delete.*all|drop.*table|truncate/i, reason: "Destructive operation detected" },
  { pattern: /sudo|admin.*escalate|privilege.*escalat/i, reason: "Privilege escalation attempt" },
  { pattern: /inject|script.*tag|<script/i, reason: "Injection attempt detected" },
  { pattern: /phishing|social.*engineer/i, reason: "Social engineering attempt" },
  // Colony-specific: flag suspicious trade patterns
  { pattern: /sell.*all|dump.*everything|liquidate.*all/i, reason: "Mass liquidation flagged for review" },
  { pattern: /rug|exit.*scam|pump.*dump/i, reason: "Market manipulation pattern" },
];

/**
 * Synchronous gate — Tier 0 + Tier 1 only. For Tier 2 (LLM) and Tier 3
 * (connectome vote) use the async variants.
 */
export function evaluateGateSync(
  actionType: string,
  payload: Record<string, unknown>,
): GateResult {
  const timestamp = Date.now();
  const actionStr = `${actionType} ${JSON.stringify(payload)}`;

  for (const rule of TIER0_PROHIBITIONS) {
    if (rule.pattern.test(actionStr)) {
      return {
        verdict: "block", reasoning: rule.reason, source: "tier0",
        overrideable: false, timestamp, constitutionVersion: CONSTITUTION_VERSION,
      };
    }
  }

  for (const rule of TIER1_RULES) {
    if (rule.pattern.test(actionStr)) {
      return {
        verdict: "object", reasoning: rule.reason, source: "rules",
        overrideable: true, timestamp, constitutionVersion: CONSTITUTION_VERSION,
      };
    }
  }

  return {
    verdict: "allow", reasoning: "No Tier 0 or Tier 1 violation detected",
    source: "rules", overrideable: true, timestamp,
    constitutionVersion: CONSTITUTION_VERSION,
  };
}

/** Tier 2 — LLM evaluation. Caller provides the LLM function (keeps the gate
 *  dependency-free; the caller decides which model to use). */
export async function evaluateGateLLM(
  actionType: string,
  payload: Record<string, unknown>,
  llmEvaluate: (prompt: string) => Promise<string>,
): Promise<GateResult> {
  const timestamp = Date.now();
  const prompt = `${CONSTITUTION_TEXT}\n\nAction: ${actionType}\nPayload: ${JSON.stringify(payload)}\n\nDoes this action create more for all life? Answer ALLOW, OBJECT, or BLOCK, then your reasoning.`;
  try {
    const response = await llmEvaluate(prompt);
    const upper = response.toUpperCase();
    const verdict: GateVerdict = upper.startsWith("BLOCK") ? "block"
      : upper.startsWith("OBJECT") ? "object" : "allow";
    return {
      verdict, reasoning: response, source: "llm",
      overrideable: true, timestamp, constitutionVersion: CONSTITUTION_VERSION,
    };
  } catch {
    return {
      verdict: "block", reasoning: "LLM evaluation failed — fail closed",
      source: "fail_closed", overrideable: true, timestamp,
      constitutionVersion: CONSTITUTION_VERSION,
    };
  }
}

/** Tier 3 — multi-connectome vote. Uses the colony's quorum rule: a block
 *  passes when `blocks >= ceil(total / 3)` — same as ConnectomeGovernor's
 *  3-of-7 on-chain quorum. Any Tier 0 block is absolute. */
export function combineGateVotes(results: GateResult[]): GateResult {
  const timestamp = Date.now();
  if (results.length === 0) {
    return {
      verdict: "block", reasoning: "No votes — fail closed",
      source: "fail_closed", overrideable: true, timestamp,
      constitutionVersion: CONSTITUTION_VERSION,
    };
  }

  // Any Tier 0 block is absolute
  const tier0Block = results.find((r) => r.source === "tier0" && r.verdict === "block");
  if (tier0Block) return { ...tier0Block, timestamp };

  const blocks = results.filter((r) => r.verdict === "block").length;
  const objects = results.filter((r) => r.verdict === "object").length;
  const allows = results.filter((r) => r.verdict === "allow").length;
  const total = results.length;
  const quorum = Math.ceil(total / 3); // 3 of 7 connectomes

  if (blocks >= quorum) {
    return {
      verdict: "block",
      reasoning: `Quorum block: ${blocks}/${total} connectomes voted to block (quorum=${quorum})`,
      source: "vote", overrideable: true, timestamp,
      constitutionVersion: CONSTITUTION_VERSION,
    };
  }
  if (objects >= quorum) {
    return {
      verdict: "object",
      reasoning: `Quorum object: ${objects}/${total} connectomes voted to object (quorum=${quorum})`,
      source: "vote", overrideable: true, timestamp,
      constitutionVersion: CONSTITUTION_VERSION,
    };
  }
  return {
    verdict: "allow",
    reasoning: `No quorum: ${blocks} block, ${objects} object, ${allows} allow (quorum=${quorum})`,
    source: "vote", overrideable: true, timestamp,
    constitutionVersion: CONSTITUTION_VERSION,
  };
}

/** Tier 4 — admin override. Signed, auditable, feeds training signal.
 *  Cannot override Tier 0 absolute prohibitions. */
export function adminOverride(
  originalResult: GateResult,
  overrideReason: string,
  adminDid: string,
): GateResult {
  if (originalResult.source === "tier0") {
    return {
      ...originalResult,
      reasoning: `Admin override DENIED — Tier 0 absolute prohibition cannot be overridden. Original: ${originalResult.reasoning}`,
    };
  }
  return {
    verdict: "allow",
    reasoning: `Admin override by ${adminDid}: ${overrideReason}`,
    source: "admin_override", overrideable: false, timestamp: Date.now(),
    constitutionVersion: CONSTITUTION_VERSION,
  };
}
