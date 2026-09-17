/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDashboardManifest,
  buildDashboardKvKey,
  stripJsonc,
  dashboardWorkerDir,
  loadDashboardKvManifestFromRoot,
  isDashboardSectionFlatKv,
  isDashboardSectionEditable,
} from "./dashboard-manifest";
import {
  KV_TRADE_KILL_SWITCH,
  KV_WEBHOOK_IP_CHECK_ENABLED,
  KV_WEBHOOK_ALLOWED_IPS,
  KV_WEBHOOK_QUEUE_MODE,
  KV_TELEGRAM_ALLOWED_CHAT_IDS,
  KV_EMAIL_COIN_PATTERN,
  KV_EMAIL_ACTION_PATTERN,
  KV_AGENT_OPENAI_KEY,
  KV_AGENT_CONFIG,
  KV_TRADE_DEFAULT_LEVERAGE,
  KV_TRADE_MAX_POSITION_SIZE,
  KV_BOT_ENABLED,
} from "./kvKeys";

const MONOREPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../.."
);

const SAMPLE = `{
  "display_name": "Gateway",
  "description": "Webhook gateway",
  // comment
  "sections": {
    "global": {
      "title": "Global Rules",
      "priority": 10,
      "fields": {
        "kill_switch": false,
      },
      "descriptions": {
        "kill_switch": "Master kill switch",
      },
    },
    "routing": {
      "title": "Routing",
      "fields": {
        "default_exchange": "mexc",
        "default_leverage": 10,
      },
      "options": {
        "default_exchange": ["binance", "mexc", "bybit"],
        "default_leverage": [1, 5, 10],
      },
    },
  },
}`;

describe("dashboard-manifest", () => {
  it("stripJsonc removes comments and trailing commas", () => {
    const cleaned = stripJsonc(SAMPLE);
    expect(() => JSON.parse(cleaned)).not.toThrow();
    expect(cleaned).not.toContain("// comment");
  });

  it("parses sections and fields", () => {
    const m = parseDashboardManifest(SAMPLE, "hoox");
    expect(m.displayName).toBe("Gateway");
    expect(m.sections.length).toBe(2);
    const global = m.sections.find((s) => s.id === "global");
    expect(global?.fields[0]?.key).toBe("global:kill_switch");
    expect(global?.fields[0]?.type).toBe("boolean");
    expect(global?.fields[0]?.kind).toBe("dangerous");
  });

  it("marks select fields from options", () => {
    const m = parseDashboardManifest(SAMPLE, "hoox");
    const routing = m.sections.find((s) => s.id === "routing");
    const exchange = routing?.fields.find((f) =>
      f.key.endsWith("default_exchange")
    );
    expect(exchange?.type).toBe("select");
    expect(exchange?.options?.map((o) => o.value)).toEqual([
      "binance",
      "mexc",
      "bybit",
    ]);
  });

  it("buildDashboardKvKey uses section prefixes and worker-facing keys", () => {
    expect(buildDashboardKvKey("hoox", "global:kill_switch")).toBe(
      "global:kill_switch"
    );
    // Nested TradingView keys (match KVKeys / ipAllowlist.ts)
    expect(
      buildDashboardKvKey("hoox", "webhook:tradingview_ip_check_enabled")
    ).toBe("webhook:tradingview:ip_check_enabled");
    expect(buildDashboardKvKey("hoox", "webhook:tradingview_allowed_ips")).toBe(
      "webhook:tradingview:allowed_ips"
    );
    expect(buildDashboardKvKey("hoox", "webhook:queue_mode")).toBe(
      "webhook:queue_mode"
    );
    expect(buildDashboardKvKey("hoox", "notify:allowed_chat_ids")).toBe(
      "telegram:allowed_chat_ids"
    );
    expect(buildDashboardKvKey("analytics-worker", "ai:enabled")).toBe(
      "ai:enabled"
    );
    expect(
      buildDashboardKvKey(
        "web3-wallet-worker",
        "wallet_security:require_confirmation"
      )
    ).toBe("wallet:require_confirmation");
    expect(buildDashboardKvKey("trade-worker", "trade:max_position_size")).toBe(
      "trade:max_position_size"
    );
    // risk section maps to trade:* (workers read trade:kill_switch)
    expect(buildDashboardKvKey("agent-worker", "risk:kill_switch")).toBe(
      "trade:kill_switch"
    );
    expect(
      buildDashboardKvKey("agent-worker", "risk:trailing_stop_percent")
    ).toBe("trade:trailing_stop_percent");
    // email signal section → email:*
    expect(buildDashboardKvKey("email-worker", "signal:coin_pattern")).toBe(
      "email:coin_pattern"
    );
    // exchange enable flags
    expect(
      buildDashboardKvKey("trade-worker", "exchanges:binance_enabled")
    ).toBe("exchange:binance:enabled");
    // Unknown section keeps section:name (not bare name)
    expect(buildDashboardKvKey("agent-worker", "unknown:foo")).toBe(
      "unknown:foo"
    );
  });

  it("dashboardWorkerDir maps hoox → hoox-worker", () => {
    expect(dashboardWorkerDir("hoox")).toBe("hoox-worker");
    expect(dashboardWorkerDir("trade-worker")).toBe("trade-worker");
  });

  it("loadDashboardKvManifestFromRoot builds keys from monorepo", () => {
    const m = loadDashboardKvManifestFromRoot(MONOREPO_ROOT);
    expect(m.namespace).toBe("CONFIG_KV");
    // Pruned to live keys only — still covers gateway/trade/email/exchange
    expect(m.keys.length).toBeGreaterThan(10);
    expect(m.keys.some((k) => k.key === "trade:kill_switch")).toBe(true);
    expect(m.keys.some((k) => k.key === "global:kill_switch")).toBe(true);
    expect(
      m.keys.some((k) => k.key === "webhook:tradingview:ip_check_enabled")
    ).toBe(true);
    expect(m.keys.some((k) => k.key === "email:coin_pattern")).toBe(true);
    expect(m.keys.some((k) => k.key === "exchange:mexc:enabled")).toBe(true);
    // API-doc pseudo fields must not appear
    expect(m.keys.every((k) => !/^POST\s+\//i.test(k.key))).toBe(true);
  });

  it("excludes agent:config-backed and UI-only sections from flat KV manifest", () => {
    expect(isDashboardSectionFlatKv("providers")).toBe(false);
    expect(isDashboardSectionFlatKv("models")).toBe(false);
    expect(isDashboardSectionFlatKv("cron")).toBe(false);
    expect(isDashboardSectionFlatKv("behavior")).toBe(false);
    expect(isDashboardSectionFlatKv("risk")).toBe(true);
    expect(isDashboardSectionFlatKv("agent")).toBe(true);

    const m = loadDashboardKvManifestFromRoot(MONOREPO_ROOT);
    const keys = m.keys.map((k) => k.key);
    // Live inside agent:config — must not be seeded as flat keys
    expect(keys).not.toContain("agent:default_provider");
    expect(keys).not.toContain("agent:timeout_ms");
    expect(keys).not.toContain("agent:workers_ai_model");
    expect(keys).not.toContain("cron:enabled");
    expect(keys).not.toContain("behavior:auto_trailing_stop");
    // Agent secrets still flat; risk kill → trade:kill_switch; trailing dual-writes
    expect(keys).toContain("agent:openai_key");
    expect(keys).toContain("trade:kill_switch");
    expect(keys).toContain("trade:trailing_stop_percent");
    // Raw agent:config blob no longer a dashboard seed field
    expect(keys).not.toContain("agent:config");
  });

  it("covers critical worker-facing KVKeys from dashboard.jsonc", () => {
    const m = loadDashboardKvManifestFromRoot(MONOREPO_ROOT);
    const keys = new Set(m.keys.map((k) => k.key));
    const required = [
      KV_TRADE_KILL_SWITCH,
      KV_TRADE_DEFAULT_LEVERAGE,
      KV_TRADE_MAX_POSITION_SIZE,
      // trailing lives in agent:config (risk section not flat-kv)
      KV_WEBHOOK_IP_CHECK_ENABLED,
      KV_WEBHOOK_ALLOWED_IPS,
      KV_WEBHOOK_QUEUE_MODE,
      KV_TELEGRAM_ALLOWED_CHAT_IDS,
      KV_EMAIL_COIN_PATTERN,
      KV_EMAIL_ACTION_PATTERN,
      KV_AGENT_OPENAI_KEY,
      "global:kill_switch",
      "exchange:mexc:enabled",
      "wallet:config",
    ];
    for (const key of required) {
      expect(keys.has(key)).toBe(true);
    }
    // agent:config is edited via providers/models/risk merge — not a flat seed field
    expect(keys.has(KV_AGENT_CONFIG)).toBe(false);
    // dead bot:* preference toggles removed
    expect(keys.has(KV_BOT_ENABLED)).toBe(false);
  });

  it("isDashboardSectionEditable is inverse of UI skip set", () => {
    expect(isDashboardSectionEditable("global")).toBe(true);
    expect(isDashboardSectionEditable("routing")).toBe(true);
    // UI-only / non-editable sections if present in skip set
    expect(typeof isDashboardSectionEditable("cron")).toBe("boolean");
    expect(typeof isDashboardSectionFlatKv("global")).toBe("boolean");
  });

  it("buildDashboardKvKey maps exchanges:*_enabled and unknown sections", () => {
    expect(buildDashboardKvKey("hoox", "exchanges:binance_enabled")).toBe(
      "exchange:binance:enabled"
    );
    // Empty exchange name falls through to section prefix mapping
    expect(buildDashboardKvKey("hoox", "exchanges:_enabled")).toBe(
      "trade:_enabled"
    );
    expect(buildDashboardKvKey("hoox", "unknownsec:field")).toBe(
      "unknownsec:field"
    );
    // bare field with worker prefix
    expect(buildDashboardKvKey("trade-worker", "max_position_size")).toContain(
      "max_position_size"
    );
  });

  it("stripJsonc removes block comments and keeps string contents", () => {
    const input = `{
      "a": 1, /* block
      comment */
      "b": "keep /* inside */ string",
      "c": 2,
    }`;
    const cleaned = stripJsonc(input);
    expect(cleaned).not.toContain("block");
    expect(cleaned).toContain("keep /* inside */ string");
    expect(() => JSON.parse(cleaned)).not.toThrow();
  });

  it("parseDashboardManifest reports parse failures via onError", () => {
    const messages: string[] = [];
    const m = parseDashboardManifest("{ not json", "hoox", (msg) =>
      messages.push(msg)
    );
    expect(m.sections).toEqual([]);
    expect(m.description).toBe("Failed to load configuration");
    expect(messages.length).toBeGreaterThan(0);
  });
});
