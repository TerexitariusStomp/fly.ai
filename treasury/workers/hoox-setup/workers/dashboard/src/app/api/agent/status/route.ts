/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { Errors } from "@hoox-sh/hoox-shared/errors";
import { kvGetMany } from "@hoox-sh/hoox-shared";
import type { DashboardEnv } from "@/lib/env";
import { agentConfigSchema } from "@/lib/agent-config-schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** KV key format: trade:watermark:{exchange}:{symbol}:{side} */
function parseWatermarkKey(key: string): {
  exchange: string;
  symbol: string;
  side: string;
} | null {
  const parts = key.split(":");
  if (parts.length < 5 || parts[0] !== "trade" || parts[1] !== "watermark") {
    return null;
  }
  const exchange = parts[2];
  const side = parts[parts.length - 1];
  const symbol = parts.slice(3, -1).join(":");
  if (!exchange || !symbol || !side) return null;
  return { exchange, symbol, side: side.toUpperCase() };
}

export async function GET(_request: NextRequest) {
  try {
    const env = getCloudflareContext().env as DashboardEnv;

    if (!env.CONFIG_KV) {
      return NextResponse.json(
        { success: false, error: "CONFIG_KV not available" },
        { status: 500 }
      );
    }

    // Bulk fixed-key gets + list in parallel (kvGetMany uses native bulk get when available)
    const [[killSwitch, configData], stopsList] = await Promise.all([
      kvGetMany(env.CONFIG_KV, ["trade:kill_switch", "agent:config"]),
      env.CONFIG_KV.list({ prefix: "trade:watermark:" }),
    ]);

    let config: unknown = null;
    if (configData) {
      try {
        const raw: unknown = JSON.parse(configData);
        const parsed = agentConfigSchema.safeParse(raw);
        config = parsed.success ? parsed.data : raw;
        if (!parsed.success) {
          console.warn("agent/status: Invalid agent config schema");
        }
      } catch {
        console.warn("agent/status: agent:config is not valid JSON");
      }
    }

    // Bulk watermark reads (native KV bulk get when available)
    const stopKeys = stopsList.keys.map((entry) => entry.name);
    const stopValues = await kvGetMany(env.CONFIG_KV, stopKeys);
    const stops = stopKeys.map((name, i) => {
      const parsedKey = parseWatermarkKey(name);
      const value = stopValues[i];
      const watermark =
        value != null && value !== "" ? Number.parseFloat(value) : null;
      return {
        key: name,
        exchange: parsedKey?.exchange ?? "unknown",
        symbol: parsedKey?.symbol ?? name,
        side: parsedKey?.side ?? "UNKNOWN",
        watermark:
          watermark != null && Number.isFinite(watermark) ? watermark : null,
      };
    });

    return NextResponse.json({
      success: true,
      status: {
        killSwitch: killSwitch === "true",
        config,
        activeStops: stops.length,
        stops,
        lastCheck: new Date().toISOString(),
      },
    });
  } catch (e) {
    return Errors.internal(String(e));
  }
}
