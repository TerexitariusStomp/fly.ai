import { TOKENS, TokenName } from "@/lib/tokens";

/** Tab on the Wrap page. */
export type WrapMode = "wrap" | "unwrap";

/**
 * A concrete conversion path on the Wrap page: the tab plus the selected source
 * token. Each flow maps to a distinct contract call sequence (see useWrapFlowSequence):
 * - wrap-symbient:            stake(to, amt, false, false) + unwrap(to, wstAmt)   SYM → wstSYM → stSYM
 * - wrap-symbient-to-wstsymbient: stake(to, amt, false, false)                       SYM → wstSYM
 * - wrap-stsymbient:          wrap(amt) on wstSYM contract                      stSYM → wstSYM
 * - unwrap-wstsymbient:      unwrap(amt) on wstSYM contract                     wstSYM → stSYM
 * - unwrap-wstsymbient-to-symbient: unstake(to, amt, false, false)                   wstSYM → SYM
 * - unstake-stsymbient:     wrap(amt) + unstake(to, wstAmt, false, false)        stSYM → wstSYM → SYM
 */
export type WrapFlow = "wrap-symbient" | "wrap-symbient-to-wstsymbient" | "wrap-stsymbient" | "unwrap-wstsymbient" | "unwrap-wstsymbient-to-symbient" | "unstake-stsymbient";

/** Selectable source tokens per tab. The output token is determined by the flow. */
export const SOURCE_TOKENS: Record<WrapMode, readonly TokenName[]> = {
  wrap: [TokenName.SYM, TokenName.STSYM],
  unwrap: [TokenName.WSTSYM, TokenName.STSYM],
};

export function defaultSourceToken(mode: WrapMode): TokenName {
  return mode === "wrap" ? TokenName.SYM : TokenName.WSTSYM;
}

/** Resolve a `?token=` query value (matched by symbol, e.g. "stSYM") to a valid source for the tab. */
export function parseSourceTokenParam(mode: WrapMode, value: string | null): TokenName | undefined {
  if (!value) return undefined;
  return SOURCE_TOKENS[mode].find(
    (name) => TOKENS[name].symbol.toLowerCase() === value.toLowerCase(),
  );
}

/** Available output tokens for a given source token in wrap mode. */
export function getOutputTokens(mode: WrapMode, sourceToken: TokenName): readonly TokenName[] {
  if (mode === "wrap") {
    if (sourceToken === TokenName.SYM) return [TokenName.STSYM, TokenName.WSTSYM];
    if (sourceToken === TokenName.STSYM) return [TokenName.WSTSYM];
  } else {
    if (sourceToken === TokenName.WSTSYM) return [TokenName.STSYM, TokenName.SYM];
    if (sourceToken === TokenName.STSYM) return [TokenName.SYM];
  }
  return [];
}

export function defaultOutputToken(mode: WrapMode, sourceToken: TokenName): TokenName {
  const outputs = getOutputTokens(mode, sourceToken);
  return outputs[0] ?? sourceToken;
}

export function getWrapFlow(mode: WrapMode, sourceToken: TokenName, outputToken: TokenName): WrapFlow {
  if (mode === "wrap") {
    if (sourceToken === TokenName.SYM) {
      return outputToken === TokenName.WSTSYM ? "wrap-symbient-to-wstsymbient" : "wrap-symbient";
    }
    if (sourceToken === TokenName.STSYM) return "wrap-stsymbient";
    return "wrap-symbient";
  }
  return sourceToken === TokenName.STSYM ? "unstake-stsymbient" : outputToken === TokenName.SYM ? "unwrap-wstsymbient-to-symbient" : "unwrap-wstsymbient";
}

type FlowSpec = {
  input: TokenName;
  output: TokenName;
  /** How the output amount is derived: wstSYM-index conversion, or 1:1 identity. */
  conversion: "wrap" | "unwrap" | "identity";
  /** User-facing copy, shared by the form button, modal, and toasts. */
  copy: {
    /** Header of the amount input, e.g. "Wrap" / "Unstake". */
    inputLabel: string;
    /** Modal title, e.g. "Wrap stSYM". */
    title: string;
    /** Submit/execute button label, e.g. "Wrap stSYM to wstSYM". */
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
    input: TokenName.SYM,
    output: TokenName.STSYM,
    conversion: "identity",
    copy: {
      inputLabel: "Stake",
      title: "Stake SYM",
      action: "Stake SYM to stSYM",
      approve: "Approve Staking",
    },
    toast: { progressive: "Staking", past: "Staked", noun: "Stake" },
    analyticsAction: "wrap",
  },
  "wrap-symbient-to-wstsymbient": {
    input: TokenName.SYM,
    output: TokenName.WSTSYM,
    conversion: "wrap",
    copy: {
      inputLabel: "Stake & Wrap",
      title: "Stake SYM to wstSYM",
      action: "Stake SYM to wstSYM",
      approve: "Approve Staking",
    },
    toast: { progressive: "Staking", past: "Staked", noun: "Stake" },
    analyticsAction: "wrap_to_wstsymbient",
  },
  "wrap-stsymbient": {
    input: TokenName.STSYM,
    output: TokenName.WSTSYM,
    conversion: "wrap",
    copy: {
      inputLabel: "Wrap",
      title: "Wrap stSYM",
      action: "Wrap stSYM to wstSYM",
      approve: "Approve Wrapping",
    },
    toast: { progressive: "Wrapping", past: "Wrapped", noun: "Wrap" },
    analyticsAction: "wrap_ssymbient",
  },
  "unwrap-wstsymbient": {
    input: TokenName.WSTSYM,
    output: TokenName.STSYM,
    conversion: "unwrap",
    copy: {
      inputLabel: "Unwrap",
      title: "Unwrap wstSYM",
      action: "Unwrap wstSYM to stSYM",
      approve: "Approve Unwrapping",
    },
    toast: { progressive: "Unwrapping", past: "Unwrapped", noun: "Unwrap" },
    analyticsAction: "unwrap",
  },
  "unwrap-wstsymbient-to-symbient": {
    input: TokenName.WSTSYM,
    output: TokenName.SYM,
    conversion: "unwrap",
    copy: {
      inputLabel: "Unwrap & Unstake",
      title: "Unwrap wstSYM to SYM",
      action: "Unwrap & Unstake wstSYM to SYM",
      approve: "Approve Unwrapping",
    },
    toast: { progressive: "Unwrapping", past: "Unwrapped", noun: "Unwrap" },
    analyticsAction: "unwrap_to_symbient",
  },
  "unstake-stsymbient": {
    input: TokenName.STSYM,
    output: TokenName.SYM,
    conversion: "identity",
    copy: {
      inputLabel: "Unstake",
      title: "Unstake stSYM",
      action: "Unstake stSYM to SYM",
      approve: "Approve Unstaking",
    },
    toast: { progressive: "Unstaking", past: "Unstaked", noun: "Unstake" },
    analyticsAction: "unstake_ssymbient",
  },
};
