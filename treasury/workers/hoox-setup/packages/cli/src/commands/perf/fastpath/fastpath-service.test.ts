/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for FastPathService — clamps, auth, aggregation, bottleneck.
 * Mocks sendProbe + ObservabilityReader; no network.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ProbeResult } from "../../../services/perf/probe-sender.js";
import type { ObservabilityReader } from "../../../services/perf/observability-reader.js";
import { CLIError, ExitCode } from "../../../utils/errors.js";

let sendProbeImpl: (req: {
  probe_id: string;
  apiKey: string;
}) => Promise<ProbeResult> = async (req) => ({
  probe_id: req.probe_id,
  status: "ok",
  total_ms: 12.5,
  http_status: 200,
});

mock.module("../../../services/perf/probe-sender.js", () => ({
  sendProbe: (req: { probe_id: string; apiKey: string }) => sendProbeImpl(req),
}));

mock.module("../../../services/perf/endpoint-resolver.js", () => ({
  resolveGatewayUrl: () => "https://test.workers.dev",
}));

function mockObs(
  hops: Array<{ service: string; samples: number[] }> = [],
  degraded = false
): ObservabilityReader {
  return {
    readProbeEvents: async () => ({
      hops: hops.map((h) => ({
        service: h.service,
        samples: h.samples,
        count: h.samples.length,
      })),
      degraded,
    }),
  } as unknown as ObservabilityReader;
}

async function loadService() {
  return import("./fastpath-service.js");
}

describe("FastPathService", () => {
  const prevKey = process.env.WEBHOOK_API_KEY_BINDING;
  const prevHoox = process.env.HOOX_API_KEY;

  beforeEach(() => {
    process.env.WEBHOOK_API_KEY_BINDING = "test-api-key";
    delete process.env.HOOX_API_KEY;
    sendProbeImpl = async (req) => ({
      probe_id: req.probe_id,
      status: "ok",
      total_ms: 12.5,
      http_status: 200,
    });
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.WEBHOOK_API_KEY_BINDING;
    else process.env.WEBHOOK_API_KEY_BINDING = prevKey;
    if (prevHoox === undefined) delete process.env.HOOX_API_KEY;
    else process.env.HOOX_API_KEY = prevHoox;
  });

  it("throws when no API key is available", async () => {
    delete process.env.WEBHOOK_API_KEY_BINDING;
    delete process.env.HOOX_API_KEY;
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    await expect(
      svc.run({ n: 1, observabilityReader: mockObs() })
    ).rejects.toThrow(/API key not provided/);
  });

  it("rejects n outside [1, 1000]", async () => {
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    try {
      await svc.run({ n: 0, apiKey: "k", observabilityReader: mockObs() });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CLIError);
      expect((e as CLIError).code).toBe(ExitCode.INVALID_USAGE);
    }
  });

  it("rejects non-integer concurrency", async () => {
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    await expect(
      svc.run({
        n: 1,
        concurrency: 1.5,
        apiKey: "k",
        observabilityReader: mockObs(),
      })
    ).rejects.toThrow(/concurrency must be an integer/);
  });

  it("rejects timeoutMs below 100", async () => {
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    await expect(
      svc.run({
        n: 1,
        timeoutMs: 50,
        apiKey: "k",
        observabilityReader: mockObs(),
      })
    ).rejects.toThrow(/timeoutMs/);
  });

  it("rejects concurrency above 16", async () => {
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    await expect(
      svc.run({
        n: 1,
        concurrency: 32,
        apiKey: "k",
        observabilityReader: mockObs(),
      })
    ).rejects.toThrow(/concurrency/);
  });

  it("runs probes and aggregates successful totals", async () => {
    sendProbeImpl = async (req) => ({
      probe_id: req.probe_id,
      status: "ok",
      total_ms: 20,
      http_status: 200,
    });
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    const report = await svc.run({
      n: 3,
      concurrency: 2,
      apiKey: "k",
      observabilityReader: mockObs([
        { service: "trade-worker", samples: [5, 6, 7] },
        { service: "hoox", samples: [2, 3, 4] },
      ]),
    });

    expect(report.iterations).toBe(3);
    expect(report.successful).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.total.count).toBe(3);
    expect(report.hops.length).toBe(2);
    expect(report.hops[0]!.service).toBe("hoox");
    expect(report.bottleneck).toBe("trade-worker");
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.window.from).toBeLessThan(report.window.to);
  });

  it("throws on auth_failed probe result", async () => {
    sendProbeImpl = async (req) => ({
      probe_id: req.probe_id,
      status: "auth_failed",
      total_ms: 5,
      http_status: 403,
    });
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    await expect(
      svc.run({ n: 1, apiKey: "bad", observabilityReader: mockObs() })
    ).rejects.toThrow(/Authentication failed/);
  });

  it("counts non-ok non-auth results as failed", async () => {
    sendProbeImpl = async (req) => ({
      probe_id: req.probe_id,
      status: "timeout",
      total_ms: null,
      http_status: null,
    });
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    const report = await svc.run({
      n: 2,
      apiKey: "k",
      observabilityReader: mockObs(),
    });
    expect(report.successful).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.bottleneck).toBeNull();
  });

  it("accepts apiKey from config over env", async () => {
    sendProbeImpl = async (req) => {
      expect(req.apiKey).toBe("explicit-key");
      return {
        probe_id: req.probe_id,
        status: "ok",
        total_ms: 1,
        http_status: 200,
      };
    };
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    await svc.run({
      n: 1,
      apiKey: "explicit-key",
      observabilityReader: mockObs(),
    });
  });

  it("skips hops with p95=0 when choosing bottleneck", async () => {
    sendProbeImpl = async (req) => ({
      probe_id: req.probe_id,
      status: "ok",
      total_ms: 100,
      http_status: 200,
    });
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    const report = await svc.run({
      n: 1,
      apiKey: "k",
      observabilityReader: mockObs([
        { service: "idle", samples: [0] },
        { service: "busy", samples: [40] },
      ]),
    });
    expect(report.bottleneck).toBe("busy");
  });

  it("propagates degraded flag from observability", async () => {
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    const report = await svc.run({
      n: 1,
      apiKey: "k",
      observabilityReader: mockObs([], true),
    });
    expect(report.degraded).toBe(true);
  });

  it("uses defaults for optional fields", async () => {
    sendProbeImpl = async (req) => {
      expect((req as { symbol?: string }).symbol ?? "BTCUSDT").toBeDefined();
      return {
        probe_id: req.probe_id,
        status: "ok",
        total_ms: 8,
        http_status: 200,
      };
    };
    const { FastPathService } = await loadService();
    const svc = new FastPathService();
    const report = await svc.run({
      apiKey: "k",
      observabilityReader: mockObs(),
    });
    expect(report.iterations).toBe(10);
  });
});
