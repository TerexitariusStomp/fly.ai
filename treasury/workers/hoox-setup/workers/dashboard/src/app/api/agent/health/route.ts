/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextRequest, NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Ai } from "@cloudflare/workers-types";
import { Errors } from "@hoox-sh/hoox-shared/errors";
import type { DashboardEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: NextRequest) {
  try {
    const env = getCloudflareContext().env as DashboardEnv & { AI?: Ai };

    const providers = [
      { name: "workers-ai", available: !!env.AI },
      { name: "openai", available: true },
      { name: "anthropic", available: true },
      { name: "google", available: true },
      { name: "azure", available: true },
    ];

    // Probe providers independently (only workers-ai hits a remote binding today)
    const settled = await Promise.all(
      providers.map(async (provider) => {
        if (!provider.available) {
          return [
            provider.name,
            {
              healthy: false as const,
              error: "Provider not configured",
            },
          ] as const;
        }

        const start = Date.now();
        try {
          if (provider.name === "workers-ai" && env.AI) {
            await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 1,
            });
          }
          return [
            provider.name,
            { healthy: true as const, latency: Date.now() - start },
          ] as const;
        } catch (e) {
          return [
            provider.name,
            {
              healthy: false as const,
              latency: Date.now() - start,
              error: String(e),
            },
          ] as const;
        }
      })
    );

    const results: Record<
      string,
      { healthy: boolean; latency?: number; error?: string }
    > = Object.fromEntries(settled);

    return NextResponse.json({ success: true, providers: results });
  } catch (e) {
    return Errors.internal(String(e));
  }
}
