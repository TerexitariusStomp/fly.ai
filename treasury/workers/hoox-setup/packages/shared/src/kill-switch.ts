/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared kill-switch semantics for all HOOX consumers (gateway, trade-worker,
 * telegram, CLI, dashboard).
 *
 * Canonical keys:
 * - `trade:kill_switch` — agent-worker, CLI, telegram, dashboard risk
 * - `global:kill_switch` — gateway dashboard section field
 *
 * Either key set to a truthy flag enables the breaker.
 */

import { KV_GLOBAL_KILL_SWITCH, KV_TRADE_KILL_SWITCH } from "./kvKeys";

/** Prefix for trade-worker kill-switch error messages (message.startsWith checks). */
export const KILL_SWITCH_ACTIVE_PREFIX = "KILL_SWITCH_ACTIVE";

export const KILL_SWITCH_KEYS = [
  KV_TRADE_KILL_SWITCH,
  KV_GLOBAL_KILL_SWITCH,
] as const;

/**
 * Truthy kill-switch flag values (case-insensitive, trimmed):
 * true, 1, yes, on
 */
export function isTruthyKillSwitchFlag(
  value: string | null | undefined
): boolean {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export type KillSwitchFailMode = "open" | "closed";

export interface KillSwitchResult {
  enabled: boolean;
  source?: string;
  error?: string;
}

export interface CheckKillSwitchOptions {
  /**
   * When CONFIG_KV is missing.
   * Default "open" (gateway/dev). Trade-worker should pass "closed".
   */
  onMissingKv?: KillSwitchFailMode;
  /**
   * When KV get throws.
   * Default "closed" for safety (stricter than the gateway's historical fail-open).
   */
  onReadError?: KillSwitchFailMode;
}

/** Minimal KV surface used by kill-switch checks (avoids workers-types dependency). */
export type KillSwitchKv = {
  get(key: string): Promise<string | null>;
};

/**
 * Read both kill-switch keys in parallel. If any value is truthy, trading is paused.
 *
 * Fail modes:
 * - Missing kv → enabled iff onMissingKv === "closed" (source: "missing_kv")
 * - Read error → enabled iff onReadError === "closed"
 */
export async function checkKillSwitch(
  kv: KillSwitchKv | undefined | null,
  options?: CheckKillSwitchOptions
): Promise<KillSwitchResult> {
  const onMissingKv: KillSwitchFailMode = options?.onMissingKv ?? "open";
  const onReadError: KillSwitchFailMode = options?.onReadError ?? "closed";

  if (!kv) {
    if (onMissingKv === "closed") {
      return { enabled: true, source: "missing_kv" };
    }
    return { enabled: false };
  }

  try {
    const values = await Promise.all(
      KILL_SWITCH_KEYS.map(async (key) => ({
        key,
        value: await kv.get(key),
      }))
    );

    for (const { key, value } of values) {
      if (isTruthyKillSwitchFlag(value)) {
        return { enabled: true, source: key };
      }
    }

    return { enabled: false };
  } catch (error: unknown) {
    const errorStr = String(error);
    if (onReadError === "closed") {
      return { enabled: true, source: "read_error", error: errorStr };
    }
    return { enabled: false, error: errorStr };
  }
}

/**
 * Convenience boolean wrapper around {@link checkKillSwitch}.
 */
export async function isTradingPaused(
  kv: KillSwitchKv | undefined | null,
  options?: CheckKillSwitchOptions
): Promise<boolean> {
  const result = await checkKillSwitch(kv, options);
  return result.enabled;
}
