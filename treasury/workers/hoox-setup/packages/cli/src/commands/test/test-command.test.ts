/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Command } from "commander";
import { registerTestCommand, runStep, printSummary } from "./test-command.js";
import type { TestSummary } from "./test-command.js";
import { ExitCode } from "../../utils/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalSpawn = Bun.spawn;

/** Create a mock Bun.spawn that returns the given exit code and output. */
function mockSpawn(exitCode: number, stdout = "", stderr = "") {
  return mock(() => ({
    exited: Promise.resolve(exitCode),
    stdout: new Blob([stdout]),
    stderr: new Blob([stderr]),
  }));
}

/** Capture stdout for assertion. */
function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const writeMock = mock((chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  process.stdout.write = writeMock as unknown as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

/** Create a fresh Commander program with global --json / --quiet options. */
function makeProgram(): Command {
  const program = new Command();
  program.name("hoox");
  program.option("--json", "");
  program.option("--quiet", "");
  return program;
}

// ---------------------------------------------------------------------------
// runStep
// ---------------------------------------------------------------------------

describe("runStep", () => {
  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  it("returns success when exit code is 0", async () => {
    (Bun as any).spawn = mockSpawn(0, "all tests passed");
    const result = await runStep(["bun", "test"]);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("all tests passed");
  });

  it("returns failure when exit code is non-zero", async () => {
    (Bun as any).spawn = mockSpawn(1, "", "3 tests failed");
    const result = await runStep(["bun", "test"]);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBe("3 tests failed");
  });

  it("captures both stdout and stderr", async () => {
    (Bun as any).spawn = mockSpawn(0, "stdout text", "stderr text");
    const result = await runStep(["echo", "hello"]);
    expect(result.output).toBe("stdout text");
    expect(result.error).toBe("stderr text");
  });

  it("records duration", async () => {
    (Bun as any).spawn = mockSpawn(0);
    const result = await runStep(["bun", "test"]);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("returns the command string", async () => {
    (Bun as any).spawn = mockSpawn(0);
    const result = await runStep([
      "vitest",
      "run",
      "--config",
      "vite.config.ts",
    ]);
    expect(result.command).toBe("vitest run --config vite.config.ts");
  });

  it("handles spawn errors gracefully", async () => {
    (Bun as any).spawn = mock(() => {
      throw new Error("ENOENT: no such file");
    });
    const result = await runStep(["nonexistent"]);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------

describe("printSummary", () => {
  let capture: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    capture = captureStdout();
  });

  afterEach(() => {
    capture.restore();
  });

  const passingSummary: TestSummary = {
    total: 4,
    passed: 4,
    failed: 0,
    results: [
      {
        step: "Lint",
        command: "bun run lint",
        success: true,
        exitCode: 0,
        duration: 1200,
      },
      {
        step: "TypeCheck",
        command: "bun run typecheck",
        success: true,
        exitCode: 0,
        duration: 3400,
      },
      {
        step: "Unit Tests",
        command: "bun test --coverage",
        success: true,
        exitCode: 0,
        duration: 8900,
      },
      {
        step: "Integration Tests",
        command: "vitest run...",
        success: true,
        exitCode: 0,
        duration: 15000,
      },
    ],
  };

  const failingSummary: TestSummary = {
    total: 2,
    passed: 1,
    failed: 1,
    results: [
      {
        step: "Lint",
        command: "bun run lint",
        success: true,
        exitCode: 0,
        duration: 500,
      },
      {
        step: "TypeCheck",
        command: "bun run typecheck",
        success: false,
        exitCode: 2,
        duration: 800,
        error: "TS2322: type error",
      },
    ],
  };

  it("prints a table for human output", () => {
    printSummary(passingSummary, {});
    const out = capture.output();
    expect(out).toContain("All 4 steps passed");
    expect(out).toContain("Lint");
    expect(out).toContain("passed");
  });

  it("shows failure count when some steps fail", () => {
    printSummary(failingSummary, {});
    const out = capture.output();
    expect(out).toContain("1/2 passed");
    expect(out).toContain("TypeCheck");
    expect(out).toContain("failed");
  });

  it("outputs JSON when json=true", () => {
    printSummary(passingSummary, { json: true });
    const out = capture.output();
    const parsed = JSON.parse(out);
    expect(parsed.total).toBe(4);
    expect(parsed.passed).toBe(4);
    expect(parsed.failed).toBe(0);
    expect(parsed.results).toHaveLength(4);
  });

  it("outputs nothing when quiet=true", () => {
    printSummary(passingSummary, { quiet: true });
    expect(capture.output()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// registerTestCommand — structure verification
// ---------------------------------------------------------------------------

describe("registerTestCommand", () => {
  it("registers test command with all subcommands", () => {
    const program = makeProgram();
    registerTestCommand(program);

    const testCmd = program.commands.find((c) => c.name() === "test");
    expect(testCmd).toBeDefined();
    expect(testCmd?.description()).toContain("Run tests");

    const subNames = testCmd?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toContain("all");
    expect(subNames).toContain("unit");
    expect(subNames).toContain("integration");
    expect(subNames).toContain("worker");
  });

  it("all subcommand has --json option", () => {
    const program = makeProgram();
    registerTestCommand(program);

    const testCmd = program.commands.find((c) => c.name() === "test");
    const allCmd = testCmd?.commands.find((c) => c.name() === "all");
    expect(allCmd).toBeDefined();

    // Commander stores options; verify --json is registered
    const optionNames = allCmd?.options.map((o) => o.long) ?? [];
    expect(optionNames).toContain("--json");
  });

  it("unit subcommand has --coverage option", () => {
    const program = makeProgram();
    registerTestCommand(program);

    const testCmd = program.commands.find((c) => c.name() === "test");
    const unitCmd = testCmd?.commands.find((c) => c.name() === "unit");
    expect(unitCmd).toBeDefined();

    const optionNames = unitCmd?.options.map((o) => o.long) ?? [];
    expect(optionNames).toContain("--coverage");
  });

  it("integration subcommand has --coverage option", () => {
    const program = makeProgram();
    registerTestCommand(program);

    const testCmd = program.commands.find((c) => c.name() === "test");
    const intCmd = testCmd?.commands.find((c) => c.name() === "integration");
    expect(intCmd).toBeDefined();

    const optionNames = intCmd?.options.map((o) => o.long) ?? [];
    expect(optionNames).toContain("--coverage");
  });

  it("worker subcommand requires a name argument and has --coverage option", () => {
    const program = makeProgram();
    registerTestCommand(program);

    const testCmd = program.commands.find((c) => c.name() === "test");
    const workerCmd = testCmd?.commands.find((c) => c.name() === "worker");
    expect(workerCmd).toBeDefined();

    // Verify it expects a required argument
    const args = workerCmd?.registeredArguments ?? [];
    expect(args.length).toBeGreaterThan(0);

    const optionNames = workerCmd?.options.map((o) => o.long) ?? [];
    expect(optionNames).toContain("--coverage");
  });

  it("all subcommand runs pipeline steps and stops on first failure", async () => {
    const program = makeProgram();
    registerTestCommand(program);

    // First lint passes, typecheck fails → should stop after 2 steps
    let callCount = 0;
    const mockSpawnFn = mock((args: string[]) => {
      callCount++;
      const cmd = args.join(" ");
      // Lint passes (call 1), TypeCheck fails (call 2)
      const exitCode = cmd.includes("lint") ? 0 : 1;
      const stderr = cmd.includes("lint") ? "" : "TS2322: type error";
      return {
        exited: Promise.resolve(exitCode),
        stdout: new Blob([]),
        stderr: new Blob([stderr]),
      };
    });
    (Bun as any).spawn = mockSpawnFn;

    // Suppress spinner output by running without tty-like env
    await program.parseAsync(["test", "all"], {
      from: "user",
    });

    // Should only run 2 steps (lint + typecheck) before stopping
    expect(callCount).toBe(2);
    expect(process.exitCode).toBe(ExitCode.ERROR);

    (Bun as any).spawn = originalSpawn;
  });

  it("all subcommand succeeds when every pipeline step passes", async () => {
    process.exitCode = 0;
    const program = makeProgram();
    registerTestCommand(program);

    (Bun as any).spawn = mockSpawn(0, "ok");
    try {
      await program.parseAsync(["test", "all"], { from: "user" });
      expect(process.exitCode).toBe(0);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("unit subcommand runs bun test and reports success", async () => {
    process.exitCode = 0;
    const program = makeProgram();
    registerTestCommand(program);

    let lastArgs: string[] | undefined;
    (Bun as any).spawn = mock((args: string[]) => {
      lastArgs = args;
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([]),
        stderr: new Blob([]),
      };
    });
    try {
      await program.parseAsync(["test", "unit", "--coverage"], {
        from: "user",
      });
      expect(lastArgs).toEqual(["bun", "test", "--coverage"]);
      expect(process.exitCode).toBe(0);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("unit subcommand sets exitCode on failure", async () => {
    process.exitCode = 0;
    const program = makeProgram();
    registerTestCommand(program);
    (Bun as any).spawn = mockSpawn(1, "", "fail");
    try {
      await program.parseAsync(["test", "unit"], { from: "user" });
      expect(process.exitCode).toBe(ExitCode.ERROR);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("integration subcommand runs vitest with optional coverage", async () => {
    process.exitCode = 0;
    const program = makeProgram();
    registerTestCommand(program);

    let lastArgs: string[] | undefined;
    (Bun as any).spawn = mock((args: string[]) => {
      lastArgs = args;
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([]),
        stderr: new Blob([]),
      };
    });
    try {
      await program.parseAsync(["test", "integration", "--coverage"], {
        from: "user",
      });
      expect(lastArgs?.[0]).toBe("vitest");
      expect(lastArgs).toContain("--coverage");
      expect(process.exitCode).toBe(0);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("integration subcommand sets exitCode on failure", async () => {
    process.exitCode = 0;
    const program = makeProgram();
    registerTestCommand(program);
    (Bun as any).spawn = mockSpawn(2);
    try {
      await program.parseAsync(["test", "integration"], { from: "user" });
      expect(process.exitCode).toBe(ExitCode.ERROR);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("worker subcommand rejects unknown worker", async () => {
    process.exitCode = 0;
    const { ConfigService } =
      await import("../../services/config/config-service.js");
    const origLoad = ConfigService.prototype.load;
    const origGet = ConfigService.prototype.getWorker;
    ConfigService.prototype.load = mock(
      async () => ({})
    ) as unknown as typeof origLoad;
    ConfigService.prototype.getWorker = mock(() => undefined) as typeof origGet;

    const program = makeProgram();
    registerTestCommand(program);
    try {
      await program.parseAsync(["test", "worker", "nope"], { from: "user" });
      expect(process.exitCode).toBe(ExitCode.INVALID_USAGE);
    } finally {
      ConfigService.prototype.load = origLoad;
      ConfigService.prototype.getWorker = origGet;
    }
  });

  it("worker subcommand runs bun test in worker dir", async () => {
    process.exitCode = 0;
    const { ConfigService } =
      await import("../../services/config/config-service.js");
    const origLoad = ConfigService.prototype.load;
    const origGet = ConfigService.prototype.getWorker;
    ConfigService.prototype.load = mock(
      async () => ({})
    ) as unknown as typeof origLoad;
    ConfigService.prototype.getWorker = mock(() => ({
      enabled: true,
      path: "workers/hoox",
    })) as typeof origGet;

    let spawnOpts: { cwd?: string } | undefined;
    let lastArgs: string[] | undefined;
    (Bun as any).spawn = mock((args: string[], opts?: { cwd?: string }) => {
      lastArgs = args;
      spawnOpts = opts;
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([]),
        stderr: new Blob([]),
      };
    });

    const program = makeProgram();
    registerTestCommand(program);
    try {
      await program.parseAsync(["test", "worker", "hoox", "--coverage"], {
        from: "user",
      });
      expect(lastArgs).toEqual(["bun", "test", "--coverage"]);
      expect(spawnOpts?.cwd).toContain("workers/hoox");
      expect(process.exitCode).toBe(0);
    } finally {
      ConfigService.prototype.load = origLoad;
      ConfigService.prototype.getWorker = origGet;
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("worker subcommand sets exitCode when tests fail", async () => {
    process.exitCode = 0;
    const { ConfigService } =
      await import("../../services/config/config-service.js");
    const origLoad = ConfigService.prototype.load;
    const origGet = ConfigService.prototype.getWorker;
    ConfigService.prototype.load = mock(
      async () => ({})
    ) as unknown as typeof origLoad;
    ConfigService.prototype.getWorker = mock(() => ({
      enabled: true,
      path: "workers/hoox",
    })) as typeof origGet;
    (Bun as any).spawn = mockSpawn(1);

    const program = makeProgram();
    registerTestCommand(program);
    try {
      await program.parseAsync(["test", "worker", "hoox"], { from: "user" });
      expect(process.exitCode).toBe(ExitCode.ERROR);
    } finally {
      ConfigService.prototype.load = origLoad;
      ConfigService.prototype.getWorker = origGet;
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("live subcommand runs tests/live with jobs=1", async () => {
    process.exitCode = 0;
    let lastArgs: string[] | undefined;
    (Bun as any).spawn = mock((args: string[]) => {
      lastArgs = args;
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([]),
        stderr: new Blob([]),
      };
    });

    const program = makeProgram();
    registerTestCommand(program);
    try {
      await program.parseAsync(["test", "live", "--service", "d1"], {
        from: "user",
      });
      expect(lastArgs).toEqual([
        "bun",
        "test",
        "tests/live/d1.test.ts",
        "--jobs",
        "1",
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("live subcommand sets exitCode on failure", async () => {
    process.exitCode = 0;
    (Bun as any).spawn = mockSpawn(1);
    const program = makeProgram();
    registerTestCommand(program);
    try {
      await program.parseAsync(["test", "live"], { from: "user" });
      expect(process.exitCode).toBe(ExitCode.ERROR);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });

  it("unit subcommand handles spawn throw (runWithInherit catch)", async () => {
    process.exitCode = 0;
    (Bun as any).spawn = mock(() => {
      throw new Error("spawn failed hard");
    });
    const program = makeProgram();
    registerTestCommand(program);
    try {
      await program.parseAsync(["test", "unit"], { from: "user" });
      expect(process.exitCode).toBe(ExitCode.ERROR);
    } finally {
      (Bun as any).spawn = originalSpawn;
    }
  });
});
