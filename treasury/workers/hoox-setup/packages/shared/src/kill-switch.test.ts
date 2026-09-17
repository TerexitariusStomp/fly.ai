/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, mock } from "bun:test";
import {
  checkKillSwitch,
  isTruthyKillSwitchFlag,
  isTradingPaused,
  KILL_SWITCH_ACTIVE_PREFIX,
  KILL_SWITCH_KEYS,
} from "./kill-switch";
import { KV_GLOBAL_KILL_SWITCH, KV_TRADE_KILL_SWITCH } from "./kvKeys";

describe("isTruthyKillSwitchFlag", () => {
  it("accepts true / 1 / yes / on (case-insensitive, trimmed)", () => {
    for (const v of [
      "true",
      "TRUE",
      "True",
      "  true  ",
      "1",
      "yes",
      "YES",
      "on",
      "On",
    ]) {
      expect(isTruthyKillSwitchFlag(v)).toBe(true);
    }
  });

  it("rejects falsey and unknown values", () => {
    for (const v of [
      null,
      undefined,
      "",
      "   ",
      "false",
      "0",
      "no",
      "off",
      "enabled",
    ]) {
      expect(isTruthyKillSwitchFlag(v)).toBe(false);
    }
  });
});

describe("KILL_SWITCH_KEYS", () => {
  it("includes trade and global keys", () => {
    expect(KILL_SWITCH_KEYS).toContain(KV_TRADE_KILL_SWITCH);
    expect(KILL_SWITCH_KEYS).toContain(KV_GLOBAL_KILL_SWITCH);
    expect(KILL_SWITCH_ACTIVE_PREFIX).toBe("KILL_SWITCH_ACTIVE");
  });
});

describe("checkKillSwitch", () => {
  function mockKv(impl: (key: string) => Promise<string | null>): {
    get: (key: string) => Promise<string | null>;
  } {
    return { get: mock(impl) as (key: string) => Promise<string | null> };
  }

  it("returns enabled: false when both keys are null/false", async () => {
    const kv = mockKv(async () => null);
    const result = await checkKillSwitch(kv);
    expect(result.enabled).toBe(false);
    expect(result.source).toBeUndefined();
  });

  it("trips on trade:kill_switch truthy values", async () => {
    const kv = mockKv(async (key) =>
      key === KV_TRADE_KILL_SWITCH ? "yes" : null
    );
    const result = await checkKillSwitch(kv);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe(KV_TRADE_KILL_SWITCH);
  });

  it("trips on global:kill_switch truthy values", async () => {
    const kv = mockKv(async (key) =>
      key === KV_GLOBAL_KILL_SWITCH ? "1" : null
    );
    const result = await checkKillSwitch(kv);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe(KV_GLOBAL_KILL_SWITCH);
  });

  it("missing kv: fail-open by default", async () => {
    const result = await checkKillSwitch(undefined);
    expect(result.enabled).toBe(false);
  });

  it("missing kv: fail-closed when onMissingKv is closed", async () => {
    const result = await checkKillSwitch(null, { onMissingKv: "closed" });
    expect(result.enabled).toBe(true);
    expect(result.source).toBe("missing_kv");
  });

  it("read error: fail-closed by default", async () => {
    const kv = mockKv(async () => {
      throw new Error("KV unavailable");
    });
    const result = await checkKillSwitch(kv);
    expect(result.enabled).toBe(true);
    expect(result.source).toBe("read_error");
    expect(result.error).toContain("KV unavailable");
  });

  it("read error: fail-open when onReadError is open", async () => {
    const kv = mockKv(async () => {
      throw new Error("KV unavailable");
    });
    const result = await checkKillSwitch(kv, { onReadError: "open" });
    expect(result.enabled).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("isTradingPaused mirrors enabled", async () => {
    const kv = mockKv(async (key) =>
      key === KV_TRADE_KILL_SWITCH ? "on" : null
    );
    expect(await isTradingPaused(kv)).toBe(true);
    expect(await isTradingPaused(mockKv(async () => null))).toBe(false);
  });
});
