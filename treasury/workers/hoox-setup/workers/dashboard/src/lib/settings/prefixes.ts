/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

// workers/dashboard/src/lib/settings/prefixes.ts
//
// Single source of truth for KV key prefix <-> worker mappings.
// Shared between:
//   - src/app/api/settings/route.ts (server: read/write CONFIG_KV)
//   - src/lib/settings/loader.ts (client: parse dashboard.jsonc manifests)
//   - src/components/dashboard/settings-form.tsx (client: build KV key strings)
//
// Keep in sync with packages/shared/src/dashboard-manifest.ts
// (DASHBOARD_WORKER_PREFIX / DASHBOARD_SECTION_PREFIX / DASHBOARD_FIELD_KV_OVERRIDES).

/**
 * Map of worker name -> default KV key prefix.
 * Used when the client sends a key without a section prefix (e.g. just
 * "kill_switch" for hoox). With a prefix (e.g. "webhook:tradingview_ip_check_enabled")
 * the SECTION_PREFIX_MAP takes precedence.
 */
export const WORKER_PREFIX_MAP = {
  hoox: "global:",
  "trade-worker": "trade:",
  "agent-worker": "agent:",
  "telegram-worker": "bot:",
  "d1-worker": "database:",
  "email-worker": "email:",
  "web3-wallet-worker": "wallet:",
  "analytics-worker": "ai:",
  "report-worker": "report:",
  "pyne-worker": "pyne:",
} as const;

/**
 * Map of section id (from dashboard.jsonc) -> KV key prefix.
 * Multiple sections can map to the same prefix (e.g. risk → trade:).
 */
export const SECTION_PREFIX_MAP = {
  global: "global:",
  webhook: "webhook:",
  routing: "routing:",
  /** Gateway notify allowlist (telegram:allowed_chat_ids via field override). */
  notify: "telegram:",
  /** @deprecated Prefer webhook for TradingView IP settings; kept for legacy forms. */
  security: "webhook:",
  trade: "trade:",
  agent: "agent:",
  bot: "bot:",
  /** Telegram AI summary prefs (bot:*) — avoid analytics `ai:` namespace. */
  bot_ai: "bot:",
  email: "email:",
  /** Email worker dashboard section for signal parse patterns. */
  signal: "email:",
  database: "database:",
  retention: "retention:",
  cron: "cron:",
  behavior: "behavior:",
  /** Agent risk UI → trade:* keys workers actually read. */
  risk: "trade:",
  exchanges: "trade:",
  fees: "trade:",
  providers: "agent:",
  models: "agent:",
  /** Analytics Engine (analytics-worker) — not gateway global: */
  ai: "ai:",
  tracking: "ai:",
  query: "ai:",
  /** Report worker sections */
  report: "report:",
  schedule: "report:",
  rendering: "report:",
  storage: "report:",
  delivery: "report:",
  endpoints: "report:",
  /** Web3 wallet */
  wallet: "wallet:",
  dex: "wallet:",
  wallet_security: "wallet:",
  /** PYNE edge evaluate worker settings */
  pyne: "pyne:",
  /** Alert webhook section on pyne-worker dashboard.jsonc */
  pyne_alerts: "pyne:",
} as const;

/**
 * Composite field keys → exact CONFIG_KV keys (mirrors packages/shared
 * DASHBOARD_FIELD_KV_OVERRIDES). Keep both maps in sync.
 */
export const FIELD_KV_OVERRIDES: Record<string, string> = {
  "webhook:tradingview_ip_check_enabled":
    "webhook:tradingview:ip_check_enabled",
  "webhook:tradingview_allowed_ips": "webhook:tradingview:allowed_ips",
  "webhook:queue_mode": "webhook:queue_mode",
  "notify:allowed_chat_ids": "telegram:allowed_chat_ids",
  "exchanges:binance_enabled": "exchange:binance:enabled",
  "exchanges:mexc_enabled": "exchange:mexc:enabled",
  "exchanges:bybit_enabled": "exchange:bybit:enabled",
  /** Web3 single document config (not flat wallet:slippage_* keys). */
  "wallet:config": "wallet:config",
};

/** Reverse map of FIELD_KV_OVERRIDES for GET rehydration. */
export const KV_TO_FIELD_OVERRIDES: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_KV_OVERRIDES).map(([field, kv]) => [kv, field])
);

/**
 * Sections that must not be written as flat CONFIG_KV keys
 * (mirrors packages/shared DASHBOARD_SECTIONS_NOT_FLAT_KV).
 * providers/models are handled via agent:config merge in the settings API.
 */
export const SECTIONS_NOT_FLAT_KV = new Set([
  "providers",
  "models",
  "cron",
  "behavior",
  /** Endpoint catalog is documentation-only in dashboard.jsonc. */
  "endpoints",
]);

/** True when composite field key's section maps to flat CONFIG_KV. */
export function isFlatKvSectionKey(fieldKey: string): boolean {
  if (!fieldKey.includes(":")) return true;
  const section = fieldKey.split(":")[0] ?? "";
  return !SECTIONS_NOT_FLAT_KV.has(section);
}

/**
 * Longest-prefix ownership for CONFIG_KV keys → worker (GET grouping).
 * Order matters: more specific prefixes first.
 */
export const KV_PREFIX_OWNERS: ReadonlyArray<{
  prefix: string;
  worker: string;
}> = [
  { prefix: "webhook:tradingview:", worker: "hoox" },
  { prefix: "webhook:", worker: "hoox" },
  { prefix: "routing:", worker: "hoox" },
  { prefix: "global:", worker: "hoox" },
  { prefix: "telegram:", worker: "hoox" },
  { prefix: "exchange:", worker: "trade-worker" },
  { prefix: "trade:", worker: "trade-worker" },
  { prefix: "agent:", worker: "agent-worker" },
  { prefix: "bot:", worker: "telegram-worker" },
  { prefix: "email:", worker: "email-worker" },
  { prefix: "database:", worker: "d1-worker" },
  { prefix: "retention:", worker: "d1-worker" },
  { prefix: "wallet:", worker: "web3-wallet-worker" },
  { prefix: "ai:", worker: "analytics-worker" },
  { prefix: "report:", worker: "report-worker" },
  { prefix: "pyne:", worker: "pyne-worker" },
  { prefix: "behavior:", worker: "agent-worker" },
  { prefix: "cron:", worker: "agent-worker" },
];

/**
 * Reverse map: default worker prefix -> worker name.
 * Prefer workerForKVKey() for multi-prefix keys.
 */
export const PREFIX_TO_WORKER: Record<string, string> = Object.fromEntries(
  Object.entries(WORKER_PREFIX_MAP).map(([worker, prefix]) => [prefix, worker])
);

/**
 * Prefixes used by the GET endpoint to list CONFIG_KV entries.
 * Must cover every prefix workers write via buildKVKey / FIELD_KV_OVERRIDES.
 */
export const READ_PREFIXES = [
  "global:",
  "webhook:",
  "routing:",
  "trade:",
  "exchange:",
  "agent:",
  "bot:",
  "telegram:",
  "email:",
  "database:",
  "retention:",
  "behavior:",
  "cron:",
  "ai:",
  "report:",
  "wallet:",
  "pyne:",
] as const;

export type WorkerName = keyof typeof WORKER_PREFIX_MAP;

/**
 * Build a CONFIG_KV key from a worker + key. If the key already has a
 * `section:` prefix, the section is mapped to a known prefix; otherwise
 * the worker's default prefix is used.
 */
export function buildKVKey(worker: string, key: string): string {
  const override = FIELD_KV_OVERRIDES[key];
  if (override) return override;

  if (key.includes(":")) {
    const [section, ...rest] = key.split(":");
    const fieldName = rest.join(":");
    if (section === "exchanges" && fieldName.endsWith("_enabled")) {
      const exchange = fieldName.slice(0, -"_enabled".length);
      if (exchange) return `exchange:${exchange}:enabled`;
    }
    const sectionPrefix =
      (SECTION_PREFIX_MAP as Record<string, string>)[section ?? ""] ?? "";
    // Prefer mapped prefix; unknown sections keep section:name (not bare)
    if (sectionPrefix) return `${sectionPrefix}${fieldName}`;
    return `${section}:${fieldName}`;
  }
  const workerPrefix =
    (WORKER_PREFIX_MAP as Record<string, string>)[worker] ?? "";
  return `${workerPrefix}${key}`;
}

/**
 * Identify the worker that owns a given KV key (longest-prefix match).
 * Returns null if no known prefix matches.
 */
export function workerForKVKey(kvKey: string): string | null {
  for (const { prefix, worker } of KV_PREFIX_OWNERS) {
    if (kvKey.startsWith(prefix)) return worker;
  }
  return null;
}

/**
 * Strip the matched KV prefix for form rehydration.
 * Prefer formFieldKeysFromKvKey for UI field keys.
 */
export function stripWorkerPrefix(kvKey: string, worker: string): string {
  // Prefer longest matching prefix from owners for this worker
  for (const { prefix, worker: owner } of KV_PREFIX_OWNERS) {
    if (owner === worker && kvKey.startsWith(prefix)) {
      return kvKey.substring(prefix.length);
    }
  }
  const prefix = (WORKER_PREFIX_MAP as Record<string, string>)[worker] ?? "";
  if (prefix && kvKey.startsWith(prefix)) {
    return kvKey.substring(prefix.length);
  }
  return kvKey;
}

/**
 * Trade keys that also appear on agent-worker risk UI (risk: → trade:).
 * GET dual-assigns these so agent form rehydrates correctly.
 */
export const TRADE_RISK_FIELD_NAMES = new Set([
  "kill_switch",
  "max_daily_drawdown_percent",
  "trailing_stop_percent",
  "take_profit_percent",
  "default_leverage",
  "max_position_size",
]);

/**
 * Map a CONFIG_KV key to form field keys for one or more workers.
 * Returns composite `section:field` keys where known, plus bare field names
 * so loadMergedSettings rawKey matching still works.
 */
export function formFieldKeysFromKvKey(
  kvKey: string
): Array<{ worker: string; fieldKey: string }> {
  const out: Array<{ worker: string; fieldKey: string }> = [];

  const overrideField = KV_TO_FIELD_OVERRIDES[kvKey];
  if (overrideField) {
    const worker = workerForKVKey(kvKey) ?? "hoox";
    out.push({ worker, fieldKey: overrideField });
    // bare name for loadMergedSettings rawKey path
    const bare = overrideField.includes(":")
      ? (overrideField.split(":").slice(1).join(":") ?? overrideField)
      : overrideField;
    out.push({ worker, fieldKey: bare });
  }

  // exchange:NAME:enabled → exchanges:NAME_enabled on trade-worker
  const exchangeEnabled = /^exchange:([a-z0-9_-]+):enabled$/i.exec(kvKey);
  if (exchangeEnabled?.[1]) {
    const name = exchangeEnabled[1];
    out.push({
      worker: "trade-worker",
      fieldKey: `exchanges:${name}_enabled`,
    });
    out.push({ worker: "trade-worker", fieldKey: `${name}_enabled` });
  }

  const worker = workerForKVKey(kvKey);
  if (!worker) return dedupeFormKeys(out);

  const stripped = stripWorkerPrefix(kvKey, worker);

  // Infer section:field from known section prefixes when possible
  for (const [section, prefix] of Object.entries(SECTION_PREFIX_MAP)) {
    if (
      prefix &&
      kvKey.startsWith(prefix) &&
      !SECTIONS_NOT_FLAT_KV.has(section)
    ) {
      // Skip reverse of generic security→webhook (ambiguous)
      if (section === "security") continue;
      // Prefer canonical section names for dual-mapped prefixes
      if (prefix === "trade:" && section !== "trade" && section !== "risk")
        continue;
      if (prefix === "ai:" && section !== "ai" && section !== "tracking")
        continue;
      if (
        prefix === "report:" &&
        section !== "schedule" &&
        section !== "rendering" &&
        section !== "storage" &&
        section !== "delivery" &&
        section !== "report"
      )
        continue;
      if (
        prefix === "wallet:" &&
        section !== "wallet" &&
        section !== "dex" &&
        section !== "wallet_security"
      )
        continue;
      if (prefix === "email:" && section !== "signal" && section !== "email")
        continue;
      if (prefix === "telegram:" && section !== "notify") continue;

      const fieldName = kvKey.substring(prefix.length);
      // Nested webhook:tradingview:* already handled by overrides
      if (fieldName.includes(":")) continue;
      out.push({ worker, fieldKey: `${section}:${fieldName}` });
    }
  }

  out.push({ worker, fieldKey: stripped });

  // Dual-assign trade risk keys onto agent-worker risk UI
  if (worker === "trade-worker" && TRADE_RISK_FIELD_NAMES.has(stripped)) {
    out.push({ worker: "agent-worker", fieldKey: `risk:${stripped}` });
    out.push({ worker: "agent-worker", fieldKey: stripped });
  }

  return dedupeFormKeys(out);
}

function dedupeFormKeys(
  entries: Array<{ worker: string; fieldKey: string }>
): Array<{ worker: string; fieldKey: string }> {
  const seen = new Set<string>();
  const out: Array<{ worker: string; fieldKey: string }> = [];
  for (const e of entries) {
    const id = `${e.worker}\0${e.fieldKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}
