/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { NextResponse } from "next/server";
import { resolveTradingViewWebhookUrl } from "@/lib/config";
import { Errors } from "@hoox-sh/hoox-shared/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Public setup metadata for the TradingView webhook step.
 * Returns the resolved gateway webhook URL from HOOX_URL / sibling worker URLs
 * so the wizard never asks operators to invent `[your-prefix]`.
 */
export async function GET() {
  try {
    const resolved = resolveTradingViewWebhookUrl();
    return NextResponse.json({
      success: true,
      webhookUrl: resolved.url,
      gatewayUrl: resolved.gatewayUrl,
      subdomainPrefix: resolved.subdomainPrefix,
      resolved: resolved.resolved,
      path: "/webhook/tradingview",
    });
  } catch (err) {
    return Errors.internal(String(err));
  }
}
