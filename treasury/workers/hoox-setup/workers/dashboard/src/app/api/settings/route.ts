/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { DashboardEnv } from "@/lib/env";
import { z } from "zod";
import {
  AGENT_CONFIG_KV_KEY,
  applyAgentConfigFieldUpdates,
  expandAgentConfigToFieldMap,
  isAgentConfigEmbeddedField,
  kvGetMany,
  kvPutMany,
  parseAgentConfigJson,
  serializeAgentConfigForKv,
} from "@hoox-sh/hoox-shared";
import {
  buildKVKey,
  formFieldKeysFromKvKey,
  isFlatKvSectionKey,
  stripWorkerPrefix,
  workerForKVKey,
  READ_PREFIXES,
  PREFIX_TO_WORKER,
} from "@/lib/settings/prefixes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AllSettings = Record<
  string,
  Record<string, string | number | boolean | undefined>
>;

// ── Zod schemas ────────────────────────────────────────────────────────

// A single setting value: string, number, or boolean (matches the
// SettingField.default type in lib/settings/types.ts). Nested objects
// and arrays are NOT supported at this boundary — the JSON string fields
// (e.g. agent-worker "config") carry those as serialized strings.
const SettingValueSchema = z.union([z.string(), z.number(), z.boolean()]);

// Single-field POST: { worker, key, value }
const SingleUpdateSchema = z.object({
  worker: z.string().min(1),
  key: z.string().min(1),
  value: SettingValueSchema,
});

// Batched POST: { settings: { [worker]: { [key]: value } } }
const BatchedUpdateSchema = z.object({
  settings: z.record(
    z.string().min(1),
    z.record(z.string().min(1), SettingValueSchema)
  ),
});

// ── Shared helpers (use the prefixes module — no inline maps here) ─────

async function listSettingsFromKV(env: DashboardEnv): Promise<AllSettings> {
  // Parallelize prefix lists, then parallelize all key gets — sequential
  // list+get loops dominate settings page latency under many CONFIG_KV keys.
  const lists = await Promise.all(
    READ_PREFIXES.map((prefix) => env.CONFIG_KV.list({ prefix }))
  );
  const keyNames = lists.flatMap((list) => list.keys.map((k) => k.name));
  // Bulk KV get (up to 100 keys/op) via shared helper — lower latency + subrequests
  const values = await kvGetMany(env.CONFIG_KV, keyNames);

  const settings: Record<string, unknown> = {};
  for (let i = 0; i < keyNames.length; i++) {
    const name = keyNames[i]!;
    const value = values[i];
    if (value == null) continue;
    try {
      settings[name] = JSON.parse(value);
    } catch {
      // Store the raw string if not valid JSON (legacy values)
      settings[name] = value;
    }
  }

  const normalized: AllSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    const primaryWorker = workerForKVKey(key);
    const cleanKey = primaryWorker
      ? stripWorkerPrefix(key, primaryWorker)
      : key;

    // Expand agent:config JSON into providers:*/models:*/risk:* field keys
    if (key === AGENT_CONFIG_KV_KEY || cleanKey === "config") {
      const raw =
        typeof value === "string"
          ? value
          : value && typeof value === "object"
            ? JSON.stringify(value)
            : null;
      const cfg =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : parseAgentConfigJson(raw);
      const expanded = expandAgentConfigToFieldMap(cfg);
      const bucket = (normalized["agent-worker"] ??= {});
      for (const fk of Object.keys(expanded)) {
        const fv = expanded[fk];
        if (
          typeof fv === "string" ||
          typeof fv === "number" ||
          typeof fv === "boolean"
        ) {
          bucket[fk] = fv;
        }
      }
      // Also keep raw config string for the agent:config field itself
      if (typeof value === "string") {
        bucket["config"] = value;
      } else if (value && typeof value === "object") {
        bucket["config"] = JSON.stringify(value);
      }
      continue;
    }

    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }

    // Map KV keys to form field keys (composite + bare) across owning workers
    // (e.g. trade:kill_switch → trade-worker + agent-worker risk:kill_switch).
    const formKeys = formFieldKeysFromKvKey(key);
    if (formKeys.length === 0) {
      if (primaryWorker) {
        (normalized[primaryWorker] ??= {})[cleanKey] = value;
      }
      continue;
    }
    for (const { worker, fieldKey } of formKeys) {
      (normalized[worker] ??= {})[fieldKey] = value;
    }
  }
  return normalized;
}

async function listSettingsFromD1Service(
  env: DashboardEnv
): Promise<AllSettings> {
  if (!env.D1_SERVICE) {
    throw new Error("D1 service binding not available");
  }
  const res = await env.D1_SERVICE.fetch(
    new Request("http://d1-worker.internal/api/settings", { method: "GET" })
  );
  if (!res.ok) {
    throw new Error(`D1 settings endpoint returned ${res.status}`);
  }
  const data = (await res.json()) as { settings?: AllSettings };
  return data.settings ?? {};
}

async function putToKV(
  env: DashboardEnv,
  kvKey: string,
  value: unknown
): Promise<void> {
  await env.CONFIG_KV.put(kvKey, JSON.stringify(value));
}

async function postToD1Service(
  env: DashboardEnv,
  worker: string,
  kvKey: string,
  value: unknown
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!env.D1_SERVICE) {
    return {
      ok: false,
      status: 500,
      error: "D1 service binding not available",
    };
  }
  const res = await env.D1_SERVICE.fetch(
    new Request("http://d1-worker.internal/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker, key: kvKey, value }),
    })
  );
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: res.status, error: error.error };
  }
  return { ok: true, status: 200 };
}

// ── Route handlers ─────────────────────────────────────────────────────

export async function GET(
  _request: NextRequest,
  _context: { params: Promise<Record<string, unknown>> }
) {
  try {
    const env = getCloudflareContext().env as DashboardEnv;
    if (env.CONFIG_KV) {
      const settings = await listSettingsFromKV(env);
      return NextResponse.json({ settings });
    }
    const settings = await listSettingsFromD1Service(env);
    return NextResponse.json({ settings });
  } catch (e) {
    console.error("Failed to fetch settings:", e);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/settings — accepts two shapes:
 *
 *   1. Single update (backward-compat):
 *      { worker: "hoox", key: "kill_switch", value: true }
 *
 *   2. Batched update (preferred):
 *      { settings: { "hoox": { "kill_switch": true, ... }, "trade-worker": { ... } } }
 *
 * The batched form lets the form send all field changes in a single round-trip
 * (30+ fields × N workers = much faster + simpler error handling).
 *
 * Worker name in the batched shape is the canonical worker name (e.g. "hoox"),
 * NOT the URL-safe variant.
 */
export async function POST(
  request: NextRequest,
  _context: { params: Promise<Record<string, unknown>> }
) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Try batched shape first (preferred)
  const batched = BatchedUpdateSchema.safeParse(raw);
  if (batched.success) {
    return handleBatchedUpdate(batched.data.settings);
  }

  // Fall back to single-field shape (backward compat)
  const single = SingleUpdateSchema.safeParse(raw);
  if (single.success) {
    return handleSingleUpdate(single.data);
  }

  return NextResponse.json(
    {
      error: "Invalid request body",
      singleErrors: single.error.issues,
      batchedErrors: batched.error.issues,
    },
    { status: 400 }
  );
}

async function readAgentConfigRaw(env: DashboardEnv): Promise<string | null> {
  if (env.CONFIG_KV) {
    return env.CONFIG_KV.get(AGENT_CONFIG_KV_KEY);
  }
  return null;
}

async function writeAgentConfigEmbedded(
  env: DashboardEnv,
  updates: Record<string, string | number | boolean>
): Promise<{ kvKey: string }> {
  const raw = await readAgentConfigRaw(env);
  const current = parseAgentConfigJson(raw);
  const next = applyAgentConfigFieldUpdates(current, updates);
  const payload = serializeAgentConfigForKv(next);
  if (env.CONFIG_KV) {
    // Store as raw JSON string (agent-worker JSON.parse's the value)
    await env.CONFIG_KV.put(AGENT_CONFIG_KV_KEY, payload);
  } else {
    await postToD1Service(env, "agent-worker", AGENT_CONFIG_KV_KEY, payload);
  }
  return { kvKey: AGENT_CONFIG_KV_KEY };
}

async function handleSingleUpdate(input: z.infer<typeof SingleUpdateSchema>) {
  const env = getCloudflareContext().env as DashboardEnv;

  // providers/models/risk numerics → merge into agent:config
  if (isAgentConfigEmbeddedField(input.key)) {
    try {
      const dualWriteFlat =
        input.key === "risk:max_daily_drawdown_percent" ||
        input.key === "risk:trailing_stop_percent";

      // RMW agent:config then dual-write flat risk key in parallel when needed
      if (env.CONFIG_KV && dualWriteFlat) {
        const raw = await readAgentConfigRaw(env);
        const current = parseAgentConfigJson(raw);
        const next = applyAgentConfigFieldUpdates(current, {
          [input.key]: input.value,
        });
        const payload = serializeAgentConfigForKv(next);
        const flatKey = buildKVKey(input.worker, input.key);
        await kvPutMany(env.CONFIG_KV, [
          { key: AGENT_CONFIG_KV_KEY, value: payload },
          { key: flatKey, value: JSON.stringify(input.value) },
        ]);
        return NextResponse.json({
          success: true,
          worker: input.worker,
          key: input.key,
          value: input.value,
          kvKey: AGENT_CONFIG_KV_KEY,
        });
      }

      const { kvKey } = await writeAgentConfigEmbedded(env, {
        [input.key]: input.value,
      });
      return NextResponse.json({
        success: true,
        worker: input.worker,
        key: input.key,
        value: input.value,
        kvKey,
      });
    } catch (err) {
      console.error("settings POST agent:config error:", err);
      return NextResponse.json(
        { error: "Failed to save agent:config field" },
        { status: 500 }
      );
    }
  }

  if (!isFlatKvSectionKey(input.key)) {
    return NextResponse.json(
      {
        error:
          "This setting is not a flat CONFIG_KV key (cron/behavior are not wired).",
        key: input.key,
      },
      { status: 400 }
    );
  }
  const kvKey = buildKVKey(input.worker, input.key);

  try {
    if (env.CONFIG_KV) {
      await putToKV(env, kvKey, input.value);
      return NextResponse.json({
        success: true,
        worker: input.worker,
        key: input.key,
        value: input.value,
        kvKey,
      });
    }
    const result = await postToD1Service(env, input.worker, kvKey, input.value);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "D1 service error" },
        { status: result.status }
      );
    }
    return NextResponse.json({
      success: true,
      worker: input.worker,
      key: input.key,
      value: input.value,
      kvKey,
    });
  } catch (err) {
    console.error("settings POST error:", err);
    return NextResponse.json(
      { error: "Failed to save setting" },
      { status: 500 }
    );
  }
}

async function handleBatchedUpdate(
  settings: Record<string, Record<string, string | number | boolean>>
) {
  const env = getCloudflareContext().env as DashboardEnv;
  const writes: Array<{
    worker: string;
    key: string;
    kvKey: string;
    value: unknown;
  }> = [];

  const skipped: string[] = [];
  const agentConfigUpdates: Record<string, string | number | boolean> = {};

  for (const [worker, fields] of Object.entries(settings)) {
    for (const [key, value] of Object.entries(fields)) {
      if (isAgentConfigEmbeddedField(key)) {
        agentConfigUpdates[key] = value;
        // Dual-write risk trade:* keys alongside agent:config
        if (
          key === "risk:max_daily_drawdown_percent" ||
          key === "risk:trailing_stop_percent"
        ) {
          writes.push({
            worker,
            key,
            kvKey: buildKVKey(worker, key),
            value,
          });
        }
        continue;
      }
      if (!isFlatKvSectionKey(key)) {
        skipped.push(`${worker}.${key}`);
        continue;
      }
      writes.push({ worker, key, kvKey: buildKVKey(worker, key), value });
    }
  }

  try {
    // Read-modify-write agent:config once, then bulk-put it with flat keys
    let agentPayload: string | null = null;
    if (Object.keys(agentConfigUpdates).length > 0) {
      const raw = await readAgentConfigRaw(env);
      const current = parseAgentConfigJson(raw);
      const next = applyAgentConfigFieldUpdates(current, agentConfigUpdates);
      agentPayload = serializeAgentConfigForKv(next);
    }
    const agentWritten = agentPayload != null ? 1 : 0;

    if (writes.length === 0 && agentWritten === 0) {
      return NextResponse.json({
        success: true,
        written: 0,
        skipped,
        note:
          skipped.length > 0
            ? "Skipped unwired sections (cron/behavior)"
            : undefined,
      });
    }

    if (env.CONFIG_KV) {
      // Single parallel bulk put for agent:config + all flat keys
      await kvPutMany(env.CONFIG_KV, [
        ...(agentPayload != null
          ? [{ key: AGENT_CONFIG_KV_KEY, value: agentPayload }]
          : []),
        ...writes.map((w) => ({
          key: w.kvKey,
          value: JSON.stringify(w.value),
        })),
      ]);
    } else {
      // D1 fallback is sequential because the d1-worker API takes one key at a time
      if (agentPayload != null) {
        const agentResult = await postToD1Service(
          env,
          "agent-worker",
          AGENT_CONFIG_KV_KEY,
          agentPayload
        );
        if (!agentResult.ok) {
          return NextResponse.json(
            {
              error: `Failed to save agent:config: ${agentResult.error ?? "unknown"}`,
              written: 0,
            },
            { status: agentResult.status }
          );
        }
      }
      for (const w of writes) {
        const result = await postToD1Service(env, w.worker, w.kvKey, w.value);
        if (!result.ok) {
          return NextResponse.json(
            {
              error: `Failed to save ${w.worker}.${w.key}: ${result.error ?? "unknown"}`,
              written: writes.indexOf(w) + agentWritten,
            },
            { status: result.status }
          );
        }
      }
    }
    return NextResponse.json({
      success: true,
      written: writes.length + agentWritten,
      skipped: skipped.length > 0 ? skipped : undefined,
    });
  } catch (err) {
    console.error("settings batched POST error:", err);
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}

// Re-export the prefix map so existing tests that imported it from this
// module continue to work. (Removed in a follow-up if all callers migrate.)
export { PREFIX_TO_WORKER as PREFIX_TO_WORKER_LEGACY };
