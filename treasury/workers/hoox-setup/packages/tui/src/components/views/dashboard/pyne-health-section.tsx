/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import { Colors, WorkerStatusColor } from "@hoox-sh/hoox-shared";
import { StatusDot } from "../../shared/status-dot";
import { cliBridge } from "../../../services/cli-bridge";
import type { PyneHealthResult } from "../../../services/cli-bridge";

const POLL_MS = 30_000;

function statusToDot(
  status: PyneHealthResult["status"]
): "operational" | "degraded" | "down" {
  if (status === "healthy") return "operational";
  if (status === "degraded") return "degraded";
  return "down";
}

/**
 * Compact PYNE edge evaluate health row for the TUI dashboard.
 * Polls `hoox pyne health` via the CLI bridge.
 */
export function PyneHealthSection() {
  const [result, setResult] = useState<PyneHealthResult | null>(null);
  const [loading, setLoading] = useState(true);

  // Poll with cancel-on-unmount and skip overlapping probes
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let inFlight = false;

    const refresh = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const gen = ++generation;
      try {
        const res = await cliBridge.pyneHealthCheck();
        if (cancelled || gen !== generation) return;
        if (res.data) {
          setResult(res.data);
        } else {
          setResult({
            worker: "pyne-worker",
            url: "",
            status: "down",
            error: res.stderr || "probe failed",
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        if (cancelled || gen !== generation) return;
        setResult({
          worker: "pyne-worker",
          url: "",
          status: "down",
          error: err instanceof Error ? err.message : "probe failed",
          timestamp: new Date().toISOString(),
        });
      } finally {
        inFlight = false;
        if (!cancelled && gen === generation) setLoading(false);
      }
    };

    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const status = result?.status ?? "down";
  const dot = statusToDot(status);
  const color = WorkerStatusColor[dot];
  // Never surface raw probe payloads that might embed tokens in free text
  const errMsg = result?.error
    ? result.error.length > 40
      ? result.error.slice(0, 37) + "…"
      : result.error
    : null;

  return (
    <box flexDirection="column" gap={0} paddingTop={1}>
      <text fg={Colors.muted} dim>
        PYNE EDGE
      </text>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <StatusDot status={dot} pulse={status === "healthy"} />
        <text fg={Colors.foreground} bold>
          pyne-worker
        </text>
        <text fg={color}>{loading ? "…" : status.toUpperCase()}</text>
        {result?.latencyMs != null ? (
          <text fg={Colors.muted} dim>
            {result.latencyMs}ms
          </text>
        ) : null}
        {errMsg ? (
          <text fg={Colors.error} dim>
            {errMsg}
          </text>
        ) : null}
      </box>
    </box>
  );
}
