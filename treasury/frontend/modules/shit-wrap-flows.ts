import { TOKENS, TokenName } from "@/lib/tokens";

/** Tab on the Wrap page. */
export type WrapMode = "wrap" | "unwrap";

/**
 * A concrete conversion path on the Wrap page: the tab plus the selected source
 * token. Each flow maps to a distinct contract call sequence (see useWrapFlowSequence):
 * - wrap-symbient:            stake(to, amt, false, false) + unwrap(to, wstAmt)   SYM → wstSYM → stSYM
 * - wrap-symbient-to-wstsym: stake(to, amt, false, false)                       SYM → wstSYM
 * - wrap-stsym:          wrap(amt) on wstSYM contract                      stSYM → wstSYM
 * - unwrap-wstsym:      unwrap(amt) on wstSYM contract                     wstSYM → stSYM
 * - unwrap-wstsym-to-symbient: unstake(to, amt, false, false)                   wstSYM → SYM
 * - unstake-stsym:     wrap(amt) + unstake(to, wstAmt, false, false)        stSYM → wstSYM → SYM
 */
export type WrapFlow = "wrap-symbient" | "wrap-symbient-to-wstsym" | "wrap-stsym" | "unwrap-wstsym" | "unwrap-wstsym-to-symbient" | "unstake-stsym";

/** Selectable source tokens per tab. The output token is determined by the flow. */
export const SOURCE_TOKENS: Record<WrapMode, readonly TokenName[]> = {
  wrap: [TokenName.SYM, TokenName.stsym],
  unwrap: [TokenName.Wstsym, TokenName.stsym],
};

export function defaultSourceToken(mode: WrapMode): TokenName {
  return mode === "wrap" ? TokenName.SYM : TokenName.Wstsym;
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
    if (sourceToken === TokenName.SYM) return [TokenName.stsym, TokenName.Wstsym];
    if (sourceToken === TokenName.stsym) return [TokenName.Wstsym];
  } else {
    if (sourceToken === TokenName.Wstsym) return [TokenName.stsym, TokenName.SYM];
    if (sourceToken === TokenName.stsym) return [TokenName.SYM];
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
      return outputToken === TokenName.Wstsym ? "wrap-symbient-to-wstsym" : "wrap-symbient";
    }
    if (sourceToken === TokenName.stsym) return "wrap-stsym";
    return "wrap-symbient";
  }
  return sourceToken === TokenName.stsym ? "unstake-stsym" : outputToken === TokenName.SYM ? "unwrap-wstsym-to-symbient" : "unwrap-wstsym";
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
    /** Modal title, e.g. "Wrap sSHIT". */
    title: string;
    /** Submit/execute button label, e.g. "Wrap sSHIT to wstSYM". */
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
    output: TokenName.stsym,
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
  "wrap-symbient-to-wstsym": {
    input: TokenName.SYM,
    output: TokenName.Wstsym,
    conversion: "wrap",
    copy: {
      inputLabel: "Stake & Wrap",
      title: "Stake SYM to wstSYM",
      action: "Stake SYM to wstSYM",
      approve: "Approve Staking",
    },
    toast: { progressive: "Staking", past: "Staked", noun: "Stake" },
    analyticsAction: "wrap_to_wstsym",
  },
  "wrap-stsym": {
    input: TokenName.stsym,
    output: TokenName.Wstsym,
    conversion: "wrap",
    copy: {
      inputLabel: "Wrap",
      title: "Wrap stSYM",
      action: "Wrap stSYM to wstSYM",
      approve: "Approve Wrapping",
    },
    toast: { progressive: "Wrapping", past: "Wrapped", noun: "Wrap" },
    analyticsAction: "wrap_sshit",
  },
  "unwrap-wstsym": {
    input: TokenName.Wstsym,
    output: TokenName.stsym,
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
  "unwrap-wstsym-to-symbient": {
    input: TokenName.Wstsym,
    output: TokenName.SYM,
    conversion: "unwrap",
    copy: {
      inputLabel: "Unwrap & Unstake",
      title: "Unwrap wstSYM to SYM",
      action: "Unwrap & Unstake wstSYM to SYM",
      approve: "Approve Unwrapping",
    },
    toast: { progressive: "Unwrapping", past: "Unwrapped", noun: "Unwrap" },
    analyticsAction: "unwrap_to_shit",
  },
  "unstake-stsym": {
    input: TokenName.stsym,
    output: TokenName.SYM,
    conversion: "identity",
    copy: {
      inputLabel: "Unstake",
      title: "Unstake stSYM",
      action: "Unstake stSYM to SYM",
      approve: "Approve Unstaking",
    },
    toast: { progressive: "Unstaking", past: "Unstaked", noun: "Unstake" },
    analyticsAction: "unstake_sshit",
  },
};
