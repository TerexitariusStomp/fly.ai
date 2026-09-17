/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { ENV_KEYS, getEnvVar } from "@/lib/config";
import { Errors } from "@hoox-sh/hoox-shared/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Catalog names checked for sync status.
 * Aligned with setup wizard + CLI SYSTEM_SECRET_NAMES + common integrations.
 */
const ALL_SECRETS = [
  // Mesh / system
  "INTERNAL_KEY_BINDING",
  "AGENT_INTERNAL_KEY",
  "WEBHOOK_API_KEY_BINDING",
  "TELEGRAM_INTERNAL_KEY_BINDING",
  "SESSION_SECRET",
  "TRADE_INTERNAL_KEY",
  "API_SERVICE_KEY_BINDING",
  // Exchanges (unified — venue chosen by routing/signal)
  "EXCHANGE_KEY_BINDING",
  "EXCHANGE_SECRET_BINDING",
  "EXCHANGE_TESTNET_KEY_BINDING",
  "EXCHANGE_TESTNET_SECRET_BINDING",
  // Notifications / other
  "TG_BOT_TOKEN_BINDING",
  "WALLET_PK_SECRET",
  "WALLET_MNEMONIC_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "EMAIL_USER_BINDING",
  "EMAIL_PASS_BINDING",
  // PYNE edge evaluate
  "API_KEY",
  "ALERT_WEBHOOK_URL",
  "PYNE_API_KEY",
];

const INTERNAL_KEY_SECRETS = [
  "INTERNAL_KEY_BINDING",
  "AGENT_INTERNAL_KEY",
  "API_SERVICE_KEY_BINDING",
  "TELEGRAM_INTERNAL_KEY_BINDING",
  "TRADE_INTERNAL_KEY",
  "WEBHOOK_API_KEY_BINDING",
  "SESSION_SECRET",
];

/**
 * Logical worker script names to probe for Worker secrets.
 * Matches root wrangler.jsonc worker keys / deploy names.
 */
const WORKER_SCRIPT_NAMES = [
  "hoox",
  "agent-worker",
  "trade-worker",
  "dashboard",
  "telegram-worker",
  "d1-worker",
  "analytics-worker",
  "email-worker",
  "web3-wallet-worker",
  "report-worker",
  "pyne-worker",
] as const;

/** Canonical CLI snippets returned to the UI. */
const CLI_HINTS = {
  automateMesh: "hoox keys generate && hoox secrets sync --system",
  syncSystem: "hoox secrets sync --system",
  set: "hoox secrets set <worker> <secretName>",
  list: "hoox secrets list",
} as const;

async function getCloudflareAccountId(): Promise<string | null> {
  return getEnvVar(ENV_KEYS.cloudflare.accountId) || null;
}

async function getCloudflareApiToken(): Promise<string | null> {
  return getEnvVar(ENV_KEYS.cloudflare.apiToken) || null;
}

async function getCloudflareSecretStoreId(): Promise<string | null> {
  return getEnvVar(ENV_KEYS.cloudflare.secretStoreId) || null;
}

/**
 * List secret *names* on a Worker (values never returned by CF API).
 * Failures return empty set so one offline worker does not blank the UI.
 */
async function listWorkerSecretNames(
  accountId: string,
  apiToken: string,
  scriptName: string
): Promise<Set<string>> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );
    if (!response.ok) return new Set();
    const data = (await response.json()) as {
      success?: boolean;
      result?: Array<{ name?: string } | string>;
    };
    if (!data.success || !Array.isArray(data.result)) return new Set();
    const names = new Set<string>();
    for (const item of data.result) {
      if (typeof item === "string") names.add(item);
      else if (item && typeof item.name === "string") names.add(item.name);
    }
    return names;
  } catch {
    return new Set();
  }
}

async function listSecretsStoreNames(
  accountId: string,
  apiToken: string,
  storeId: string
): Promise<Set<string>> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/secrets_store/stores/${storeId}/secrets`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );
    const data = (await response.json()) as {
      success: boolean;
      result?: { name: string }[];
    };
    const names = new Set<string>();
    if (data.success && data.result) {
      for (const s of data.result) names.add(s.name);
    }
    return names;
  } catch {
    // Secrets Store optional — continue with Worker secret probes
    return new Set();
  }
}

export async function GET() {
  try {
    // Independent env lookups — resolve in parallel
    const [accountId, apiToken, storeId] = await Promise.all([
      getCloudflareAccountId(),
      getCloudflareApiToken(),
      getCloudflareSecretStoreId(),
    ]);

    if (!apiToken || !accountId) {
      return Errors.internal(
        "Cloudflare credentials not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN)"
      );
    }

    // 1) Optional Secrets Store + 2) Worker-level secrets in parallel
    //    Mesh keys live on workers; dashboard used to only check Secrets Store
    //    and falsely reported WEBHOOK / API_SERVICE_KEY as missing after sync.
    const [storeNames, workerResults] = await Promise.all([
      storeId
        ? listSecretsStoreNames(accountId, apiToken, storeId)
        : Promise.resolve(new Set<string>()),
      Promise.all(
        WORKER_SCRIPT_NAMES.map((name) =>
          listWorkerSecretNames(accountId, apiToken, name)
        )
      ),
    ]);

    const availableNames = new Set<string>(storeNames);
    for (const names of workerResults) {
      for (const n of names) availableNames.add(n);
    }

    // 3) Process env on the dashboard isolate (local dev / OpenNext bindings)
    const syncedSecrets = ALL_SECRETS.map((name) => ({
      name,
      synced: availableNames.has(name) || !!getEnvVar(name),
    }));

    return NextResponse.json({
      success: true,
      secrets: syncedSecrets,
      internalKeys: INTERNAL_KEY_SECRETS.map((name) => ({
        name,
        synced: availableNames.has(name) || !!getEnvVar(name),
      })),
      cli: CLI_HINTS,
      sources: {
        secretsStore: Boolean(storeId),
        workerSecrets: true,
      },
    });
  } catch (err) {
    return Errors.internal(String(err));
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { action?: string };
    const { action } = body;

    // Dashboard never writes secrets; guide operators to the CLI.
    if (
      action === "sync-to-pages" ||
      action === "sync-all-internal-keys" ||
      action === "automate-mesh" ||
      action === "hint"
    ) {
      return NextResponse.json({
        success: true,
        message:
          "Mesh keys: run `hoox keys generate && hoox secrets sync --system` from the monorepo. Integration secrets: `hoox secrets set <worker> <name>` (interactive). Never paste live secrets into the dashboard.",
        cli: CLI_HINTS,
        command: CLI_HINTS.automateMesh,
      });
    }

    return Errors.badRequest("Unknown action");
  } catch (err) {
    return Errors.internal(String(err));
  }
}
