/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import { Command } from "commander";
import {
  registerFastpathCommand,
  formatMs,
  formatTableAsText,
  parseTimeRange,
  parseTimeOrThrow,
} from "./fastpath-command.js";
import { FastPathService } from "./fastpath-service.js";
import { ObservabilityReader } from "../../../services/perf/observability-reader.js";
import type { FastPathReport } from "./types.js";
import { ExitCode } from "../../../utils/errors.js";

function sampleReport(over: Partial<FastPathReport> = {}): FastPathReport {
  return {
    iterations: 2,
    successful: 2,
    failed: 0,
    degraded: false,
    total: {
      service: "total",
      count: 2,
      p50: 10,
      p95: 20,
      p99: 25,
      mean: 12,
      min: 8,
      max: 25,
    },
    hops: [
      {
        service: "hoox",
        count: 2,
        p50: 3,
        p95: 5,
        p99: 6,
        mean: 4,
        min: 2,
        max: 6,
      },
    ],
    bottleneck: "hoox",
    duration_ms: 100,
    window: { from: Date.now() - 1000, to: Date.now() },
    ...over,
  };
}

describe("formatMs / formatTableAsText / parseTime*", () => {
  it("formatMs covers zero, sub-1, sub-10, and large values", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(0.4)).toBe("0.4ms");
    expect(formatMs(3.2)).toBe("3.2ms");
    expect(formatMs(42.6)).toBe("43ms");
  });

  it("formatTableAsText joins columns", () => {
    const text = formatTableAsText(
      [{ A: "1", B: "2" }, { A: "x" }],
      ["A", "B"]
    );
    expect(text).toContain("1  2");
    expect(text).toContain("x  ");
  });

  it("parseTimeOrThrow accepts relative units", () => {
    const before = Date.now();
    const t = parseTimeOrThrow("30m", "from");
    expect(t).toBeLessThanOrEqual(before - 29 * 60_000);
    expect(t).toBeGreaterThan(before - 31 * 60_000);
  });

  it("parseTimeOrThrow accepts ISO-8601", () => {
    const t = parseTimeOrThrow("2026-01-01T00:00:00.000Z", "from");
    expect(t).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("parseTimeOrThrow rejects garbage", () => {
    expect(() => parseTimeOrThrow("not-a-time", "from")).toThrow(
      /Invalid from/
    );
  });

  it("parseTimeRange defaults from to 1h ago and to to now", () => {
    const before = Date.now();
    const { from, to } = parseTimeRange(undefined, undefined);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(from).toBeLessThan(to);
    expect(to - from).toBeGreaterThan(59 * 60_000);
  });

  it("parseTimeRange honors explicit from/to", () => {
    const { from, to } = parseTimeRange("1h", "30m");
    expect(from).toBeLessThan(to);
  });
});

describe("registerFastpathCommand", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.option("--json", "JSON output");
    program.exitOverride(() => {});
    registerFastpathCommand(program);
    process.exitCode = 0;
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = 0;
  });

  it("registers the fastpath subcommand with run/tail/report", () => {
    const fastpath = program.commands.find((c) => c.name() === "fastpath");
    expect(fastpath).toBeDefined();
    const subNames = fastpath!.commands.map((c) => c.name());
    expect(subNames).toContain("run");
    expect(subNames).toContain("tail");
    expect(subNames).toContain("report");
  });

  it("rejects invalid --action values with exit code 2", async () => {
    process.env.WEBHOOK_API_KEY_BINDING = "test-key";
    process.env.HOOX_GATEWAY_URL = "https://test.workers.dev";

    const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
    const run = fastpath.commands.find((c) => c.name() === "run")!;

    process.exitCode = 0;
    try {
      await run.parseAsync(["--action", "INVALID"], { from: "user" });
    } catch {
      // expected
    }
    expect(process.exitCode ?? 0).toBe(2);
  });

  it("rejects --n > 1000 with exit code 2", async () => {
    process.env.WEBHOOK_API_KEY_BINDING = "test-key";
    process.env.HOOX_GATEWAY_URL = "https://test.workers.dev";

    const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
    const run = fastpath.commands.find((c) => c.name() === "run")!;

    process.exitCode = 0;
    try {
      await run.parseAsync(["--n", "5000"], { from: "user" });
    } catch {
      // expected
    }
    expect(process.exitCode ?? 0).toBe(2);
  });

  it("run prints human report and sets exitCode when all fail", async () => {
    const runMock = spyOn(FastPathService.prototype, "run").mockResolvedValue(
      sampleReport({ successful: 0, failed: 2, hops: [], bottleneck: null })
    );
    let stdout = "";
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((c) => {
      stdout += String(c);
      return true;
    }) as typeof process.stdout.write);

    try {
      const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
      const run = fastpath.commands.find((c) => c.name() === "run")!;
      process.exitCode = 0;
      await run.parseAsync(["--api-key", "k", "--n", "2"], { from: "user" });

      expect(stdout).toContain("Total round-trip");
      expect(stdout).toContain("no per-hop data");
      expect(process.exitCode).toBe(ExitCode.ERROR);
    } finally {
      writeSpy.mockRestore();
      runMock.mockRestore();
    }
  });

  it("run emits JSON when --json is set", async () => {
    const runMock = spyOn(FastPathService.prototype, "run").mockResolvedValue(
      sampleReport()
    );
    let stdout = "";
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((c) => {
      stdout += String(c);
      return true;
    }) as typeof process.stdout.write);

    try {
      await program.parseAsync(
        ["fastpath", "run", "--api-key", "k", "--json"],
        { from: "user" }
      );
      expect(stdout).toContain('"iterations"');
      expect(stdout).toContain('"successful"');
    } finally {
      writeSpy.mockRestore();
      runMock.mockRestore();
    }
  });

  it("run with hops and bottleneck renders share", async () => {
    const runMock = spyOn(FastPathService.prototype, "run").mockResolvedValue(
      sampleReport()
    );
    let stdout = "";
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((c) => {
      stdout += String(c);
      return true;
    }) as typeof process.stdout.write);

    try {
      const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
      const run = fastpath.commands.find((c) => c.name() === "run")!;
      await run.parseAsync(
        ["--api-key", "k", "--action", "SHORT", "--symbol", "ETHUSDT"],
        { from: "user" }
      );

      expect(stdout).toContain("Bottleneck");
      expect(stdout).toContain("hoox");
      expect(runMock).toHaveBeenCalled();
      const cfg = runMock.mock.calls[0]![0] as {
        action?: string;
        symbol?: string;
      };
      expect(cfg.action).toBe("SHORT");
      expect(cfg.symbol).toBe("ETHUSDT");
    } finally {
      writeSpy.mockRestore();
      runMock.mockRestore();
    }
  });

  it("tail rejects duration > 600", async () => {
    const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
    const tail = fastpath.commands.find((c) => c.name() === "tail")!;
    process.exitCode = 0;
    try {
      await tail.parseAsync(["--duration", "999"], { from: "user" });
    } catch {
      // expected
    }
    expect(process.exitCode ?? 0).toBe(2);
  });

  it("report prints empty message when no hops", async () => {
    const readMock = spyOn(
      ObservabilityReader.prototype,
      "readProbeEvents"
    ).mockResolvedValue({ hops: [], degraded: false });
    let stdout = "";
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((c) => {
      stdout += String(c);
      return true;
    }) as typeof process.stdout.write);

    const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
    const report = fastpath.commands.find((c) => c.name() === "report")!;
    await report.parseAsync(["--from", "1h"], { from: "user" });

    writeSpy.mockRestore();
    readMock.mockRestore();
    expect(stdout).toContain("No probe events found");
  });

  it("report prints table when hops exist", async () => {
    const readMock = spyOn(
      ObservabilityReader.prototype,
      "readProbeEvents"
    ).mockResolvedValue({
      hops: [{ service: "hoox", samples: [1, 2, 3], count: 3 }],
      degraded: false,
    });
    let stdout = "";
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((c) => {
      stdout += String(c);
      return true;
    }) as typeof process.stdout.write);

    const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
    const report = fastpath.commands.find((c) => c.name() === "report")!;
    await report.parseAsync([], { from: "user" });

    writeSpy.mockRestore();
    readMock.mockRestore();
    expect(stdout).toContain("hoox");
  });

  it("report emits JSON when --json is set", async () => {
    const readMock = spyOn(
      ObservabilityReader.prototype,
      "readProbeEvents"
    ).mockResolvedValue({ hops: [], degraded: true });
    let stdout = "";
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(((c) => {
      stdout += String(c);
      return true;
    }) as typeof process.stdout.write);

    await program.parseAsync(["fastpath", "report", "--json"], {
      from: "user",
    });

    writeSpy.mockRestore();
    readMock.mockRestore();
    const parsed = JSON.parse(stdout.trim()) as { degraded: boolean };
    expect(parsed.degraded).toBe(true);
  });

  it("report rejects invalid --from", async () => {
    const fastpath = program.commands.find((c) => c.name() === "fastpath")!;
    const report = fastpath.commands.find((c) => c.name() === "report")!;
    process.exitCode = 0;
    try {
      await report.parseAsync(["--from", "bogus"], { from: "user" });
    } catch {
      // expected
    }
    expect(process.exitCode ?? 0).toBe(2);
  });
});
