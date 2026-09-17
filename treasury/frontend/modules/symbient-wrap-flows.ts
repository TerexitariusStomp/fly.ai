import { TOKENS, TokenName } from "@/lib/tokens";

/** Tab on the Wrap page. */
export type WrapMode = "wrap" | "unwrap";

/**
 * A concrete conversion path on the Wrap page: the tab plus the selected source
 * token. Each flow maps to a distinct contract call sequence (see useWrapFlowSequence):
 * - wrap-symbient:            stake(to, amt, false, false) + unwrap(to, wstAmt)   FLYAI → wstFLYAI → stFLYAI
 * - wrap-symbient-to-wstsymbient: stake(to, amt, false, false)                       FLYAI → wstFLYAI
 * - wrap-stsymbient:          wrap(amt) on wstFLYAI contract                      stFLYAI → wstFLYAI
 * - unwrap-wstsymbient:      unwrap(amt) on wstFLYAI contract                     wstFLYAI → stFLYAI
 * - unwrap-wstsymbient-to-symbient: unstake(to, amt, false, false)                   wstFLYAI → FLYAI
 * - unstake-stsymbient:     wrap(amt) + unstake(to, wstAmt, false, false)        stFLYAI → wstFLYAI → FLYAI
 */
export type WrapFlow = "wrap-symbient" | "wrap-symbient-to-wstsymbient" | "wrap-stsymbient" | "unwrap-wstsymbient" | "unwrap-wstsymbient-to-symbient" | "unstake-stsymbient";

/** Selectable source tokens per tab. The output token is determined by the flow. */
export const SOURCE_TOKENS: Record<WrapMode, readonly TokenName[]> = {
  wrap: [TokenName.FLYAI, TokenName.STFLYAI],
  unwrap: [TokenName.WSTFLYAI, TokenName.STFLYAI],
};

export function defaultSourceToken(mode: WrapMode): TokenName {
  return mode === "wrap" ? TokenName.FLYAI : TokenName.WSTFLYAI;
}

/** Resolve a `?token=` query value (matched by symbol, e.g. "stFLYAI") to a valid source for the tab. */
export function parseSourceTokenParam(mode: WrapMode, value: string | null): TokenName | undefined {
  if (!value) return undefined;
  return SOURCE_TOKENS[mode].find(
    (name) => TOKENS[name].symbol.toLowerCase() === value.toLowerCase(),
  );
}

/** Available output tokens for a given source token in wrap mode. */
export function getOutputTokens(mode: WrapMode, sourceToken: TokenName): readonly TokenName[] {
  if (mode === "wrap") {
    if (sourceToken === TokenName.FLYAI) return [TokenName.STFLYAI, TokenName.WSTFLYAI];
    if (sourceToken === TokenName.STFLYAI) return [TokenName.WSTFLYAI];
  } else {
    if (sourceToken === TokenName.WSTFLYAI) return [TokenName.STFLYAI, TokenName.FLYAI];
    if (sourceToken === TokenName.STFLYAI) return [TokenName.FLYAI];
  }
  return [];
}

export function defaultOutputToken(mode: WrapMode, sourceToken: TokenName): TokenName {
  const outputs = getOutputTokens(mode, sourceToken);
  return outputs[0] ?? sourceToken;
}

export function getWrapFlow(mode: WrapMode, sourceToken: TokenName, outputToken: TokenName): WrapFlow {
  if (mode === "wrap") {
    if (sourceToken === TokenName.FLYAI) {
      return outputToken === TokenName.WSTFLYAI ? "wrap-symbient-to-wstsymbient" : "wrap-symbient";
    }
    if (sourceToken === TokenName.STFLYAI) return "wrap-stsymbient";
    return "wrap-symbient";
  }
  return sourceToken === TokenName.STFLYAI ? "unstake-stsymbient" : outputToken === TokenName.FLYAI ? "unwrap-wstsymbient-to-symbient" : "unwrap-wstsymbient";
}

type FlowSpec = {
  input: TokenName;
  output: TokenName;
  /** How the output amount is derived: wstFLYAI-index conversion, or 1:1 identity. */
  conversion: "wrap" | "unwrap" | "identity";
  /** User-facing copy, shared by the form button, modal, and toasts. */
  copy: {
    /** Header of the amount input, e.g. "Wrap" / "Unstake". */
    inputLabel: string;
    /** Modal title, e.g. "Wrap stFLYAI". */
    title: string;
    /** Submit/execute button label, e.g. "Wrap stFLYAI to wstFLYAI". */
    action: string;
    /** Approval step label, e.g. "Approve Wrapping". */
    approve: string;
  };
  /** Verb forms for transaction toasts. */
  toast: { progressive: string; past: string; noun: string };
  /** Analytics action slug. */
  analyticsAction: string;
};

export const WRAP_FLOWS: Record<WrapFlow, FlowSpec> = {
  "wrap-symbient": {
    input: TokenName.FLYAI,
    output: TokenName.STFLYAI,
    conversion: "identity",
    copy: {
      inputLabel: "Stake",
      title: "Stake FLYAI",
      action: "Stake FLYAI to stFLYAI",
      approve: "Approve Staking",
    },
    toast: { progressive: "Staking", past: "Staked", noun: "Stake" },
    analyticsAction: "wrap",
  },
  "wrap-symbient-to-wstsymbient": {
    input: TokenName.FLYAI,
    output: TokenName.WSTFLYAI,
    conversion: "wrap",
    copy: {
      inputLabel: "Stake & Wrap",
      title: "Stake FLYAI to wstFLYAI",
      action: "Stake FLYAI to wstFLYAI",
      approve: "Approve Staking",
    },
    toast: { progressive: "Staking", past: "Staked", noun: "Stake" },
    analyticsAction: "wrap_to_wstsymbient",
  },
  "wrap-stsymbient": {
    input: TokenName.STFLYAI,
    output: TokenName.WSTFLYAI,
    conversion: "wrap",
    copy: {
      inputLabel: "Wrap",
      title: "Wrap stFLYAI",
      action: "Wrap stFLYAI to wstFLYAI",
      approve: "Approve Wrapping",
    },
    toast: { progressive: "Wrapping", past: "Wrapped", noun: "Wrap" },
    analyticsAction: "wrap_ssymbient",
  },
  "unwrap-wstsymbient": {
    input: TokenName.WSTFLYAI,
    output: TokenName.STFLYAI,
    conversion: "unwrap",
    copy: {
      inputLabel: "Unwrap",
      title: "Unwrap wstFLYAI",
      action: "Unwrap wstFLYAI to stFLYAI",
      approve: "Approve Unwrapping",
    },
    toast: { progressive: "Unwrapping", past: "Unwrapped", noun: "Unwrap" },
    analyticsAction: "unwrap",
  },
  "unwrap-wstsymbient-to-symbient": {
    input: TokenName.WSTFLYAI,
    output: TokenName.FLYAI,
    conversion: "unwrap",
    copy: {
      inputLabel: "Unwrap & Unstake",
      title: "Unwrap wstFLYAI to FLYAI",
      action: "Unwrap & Unstake wstFLYAI to FLYAI",
      approve: "Approve Unwrapping",
    },
    toast: { progressive: "Unwrapping", past: "Unwrapped", noun: "Unwrap" },
    analyticsAction: "unwrap_to_symbient",
  },
  "unstake-stsymbient": {
    input: TokenName.STFLYAI,
    output: TokenName.FLYAI,
    conversion: "identity",
    copy: {
      inputLabel: "Unstake",
      title: "Unstake stFLYAI",
      action: "Unstake stFLYAI to FLYAI",
      approve: "Approve Unstaking",
    },
    toast: { progressive: "Unstaking", past: "Unstaked", noun: "Unstake" },
    analyticsAction: "unstake_ssymbient",
  },
};
