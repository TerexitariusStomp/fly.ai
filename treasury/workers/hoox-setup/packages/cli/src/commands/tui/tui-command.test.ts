/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Command } from "commander";
import { findHooxSetupRoot, getTuiEntryCandidates } from "@hoox-sh/hoox-shared";
import { CLIError } from "../../utils/errors.js";

// ---------------------------------------------------------------------------
// Mock child_process.spawn BEFORE importing tui-command (binds spawn at load)
// ---------------------------------------------------------------------------

const spawnCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
let spawnCloseCode: number | null = 0;
let spawnError: Error | null = null;

mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => {
    spawnCalls.push({ cmd, args, opts });
    const ee = new EventEmitter();
    queueMicrotask(() => {
      if (spawnError) {
        ee.emit("error", spawnError);
      } else {
        ee.emit("close", spawnCloseCode);
      }
    });
    return ee as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  },
}));

const {
  resolveTUIEntry,
  resolveTuiLaunchConfig,
  resolveTuiAuthStatus,
  resolveTuiAuthToken,
  formatTuiAuthBanner,
  assertRemoteAuthReady,
  hasAccessServiceToken,
  registerTUICommand,
} = await import("./tui-command.js");

describe("resolveTUIEntry", () => {
  it("finds a monorepo TUI entry that exists on disk", () => {
    const entry = resolveTUIEntry();
    expect(typeof entry).toBe("string");
    expect(entry.length).toBeGreaterThan(0);
    expect(existsSync(entry)).toBe(true);
    expect(entry).toMatch(/main\.(tsx|js|ts)$/);
  });

  it("prefers packages/tui paths", () => {
    const entry = resolveTUIEntry();
    // In this monorepo we always resolve into packages/tui
    expect(entry.includes("tui")).toBe(true);
  });

  it("resolves under the local setup root when present", () => {
    const root = findHooxSetupRoot(process.cwd());
    if (!root) return; // not running inside monorepo — skip soft
    const candidates = getTuiEntryCandidates(root);
    const entry = resolveTUIEntry();
    expect(
      candidates.some((c) => entry === c || entry.endsWith("main.tsx"))
    ).toBe(true);
    expect(entry.includes(root) || entry.includes("tui")).toBe(true);
  });
});

describe("resolveTuiLaunchConfig", () => {
  const ORIGINAL_API_URL = process.env.HOOX_API_URL;

  beforeEach(() => {
    delete process.env.HOOX_API_URL;
  });

  afterEach(() => {
    if (ORIGINAL_API_URL === undefined) delete process.env.HOOX_API_URL;
    else process.env.HOOX_API_URL = ORIGINAL_API_URL;
  });

  it("defaults to local mode on localhost:8787", () => {
    const cfg = resolveTuiLaunchConfig({});
    expect(cfg.tuiMode).toBe("local");
    expect(cfg.apiBase).toBe("http://localhost:8787");
    expect(cfg.source).toBe("local-default");
  });

  it("uses HOOX_API_URL in local mode when set", () => {
    process.env.HOOX_API_URL = "http://127.0.0.1:9999";
    const cfg = resolveTuiLaunchConfig({});
    expect(cfg.tuiMode).toBe("local");
    expect(cfg.apiBase).toBe("http://127.0.0.1:9999");
    expect(cfg.source).toBe("local-default");
  });

  it("uses --api-url as remote mode and strips trailing slashes", () => {
    const cfg = resolveTuiLaunchConfig({
      apiUrl: "https://hoox.example.com///",
    });
    expect(cfg.tuiMode).toBe("remote");
    expect(cfg.apiBase).toBe("https://hoox.example.com");
    expect(cfg.source).toBe("api-url");
  });

  it("--api-url takes precedence over --remote", () => {
    const cfg = resolveTuiLaunchConfig(
      { apiUrl: "https://explicit.example.com", remote: true },
      () => "https://should-not-be-used.workers.dev"
    );
    expect(cfg.tuiMode).toBe("remote");
    expect(cfg.apiBase).toBe("https://explicit.example.com");
    expect(cfg.source).toBe("api-url");
  });

  it("resolves --remote via gateway URL helper", () => {
    const cfg = resolveTuiLaunchConfig(
      { remote: true },
      () => "https://hoox.cryptolinx.workers.dev/"
    );
    expect(cfg.tuiMode).toBe("remote");
    expect(cfg.apiBase).toBe("https://hoox.cryptolinx.workers.dev");
    expect(cfg.source).toBe("remote-gateway");
  });

  it("throws CLIError when --remote cannot resolve a gateway", () => {
    expect(() =>
      resolveTuiLaunchConfig({ remote: true }, () => {
        throw new Error("no creds");
      })
    ).toThrow(CLIError);

    try {
      resolveTuiLaunchConfig({ remote: true }, () => {
        throw new Error("no creds");
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CLIError);
      expect((err as CLIError).message).toContain("HOOX_GATEWAY_URL");
      expect((err as CLIError).message).toContain("--api-url");
    }
  });
});

describe("resolveTuiAuthStatus / token", () => {
  const ORIGINAL = process.env.HOOX_API_TOKEN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.HOOX_API_TOKEN;
    else process.env.HOOX_API_TOKEN = ORIGINAL;
  });

  it("prefers --token over env", () => {
    process.env.HOOX_API_TOKEN = "from-env";
    const status = resolveTuiAuthStatus({ token: "from-flag" });
    expect(status).toEqual({ hasToken: true, source: "flag" });
    expect(resolveTuiAuthToken({ token: "from-flag" })).toBe("from-flag");
  });

  it("reads env when no flag", () => {
    process.env.HOOX_API_TOKEN = "from-env";
    const status = resolveTuiAuthStatus({});
    expect(status).toEqual({ hasToken: true, source: "env" });
    expect(resolveTuiAuthToken({})).toBe("from-env");
  });

  it("reports none when empty", () => {
    delete process.env.HOOX_API_TOKEN;
    expect(resolveTuiAuthStatus({})).toEqual({
      hasToken: false,
      source: "none",
    });
    expect(resolveTuiAuthToken({})).toBe("");
  });

  it("banner never embeds the secret", () => {
    const banner = formatTuiAuthBanner(
      { hasToken: true, source: "env" },
      "remote"
    );
    expect(banner).toContain("set");
    expect(banner).not.toContain("from-env");
    expect(
      formatTuiAuthBanner({ hasToken: false, source: "none" }, "remote")
    ).toContain("missing");
  });
});

describe("assertRemoteAuthReady / hasAccessServiceToken", () => {
  const ORIGINAL_ID = process.env.CF_ACCESS_CLIENT_ID;
  const ORIGINAL_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

  afterEach(() => {
    if (ORIGINAL_ID === undefined) delete process.env.CF_ACCESS_CLIENT_ID;
    else process.env.CF_ACCESS_CLIENT_ID = ORIGINAL_ID;
    if (ORIGINAL_SECRET === undefined)
      delete process.env.CF_ACCESS_CLIENT_SECRET;
    else process.env.CF_ACCESS_CLIENT_SECRET = ORIGINAL_SECRET;
  });

  it("allows local mode without credentials", () => {
    const gate = assertRemoteAuthReady({
      tuiMode: "local",
      hasToken: false,
    });
    expect(gate.ok).toBe(true);
  });

  it("blocks remote without token, access, or allow-insecure", () => {
    const gate = assertRemoteAuthReady({
      tuiMode: "remote",
      hasToken: false,
      hasAccess: false,
      allowInsecure: false,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.reason).toContain("fail-closed");
      expect(gate.reason).toContain("HOOX_API_TOKEN");
      expect(gate.reason).toContain("--allow-insecure");
    }
  });

  it("allows remote with Bearer", () => {
    expect(
      assertRemoteAuthReady({
        tuiMode: "remote",
        hasToken: true,
      })
    ).toEqual({ ok: true, method: "bearer" });
  });

  it("allows remote with Access service token", () => {
    expect(
      assertRemoteAuthReady({
        tuiMode: "remote",
        hasToken: false,
        hasAccess: true,
      })
    ).toEqual({ ok: true, method: "access" });
  });

  it("allows remote with --allow-insecure", () => {
    expect(
      assertRemoteAuthReady({
        tuiMode: "remote",
        hasToken: false,
        allowInsecure: true,
      })
    ).toEqual({ ok: true, method: "allow-insecure" });
  });

  it("hasAccessServiceToken requires both env vars", () => {
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
    expect(hasAccessServiceToken()).toBe(false);

    process.env.CF_ACCESS_CLIENT_ID = "client-id";
    expect(hasAccessServiceToken()).toBe(false);

    process.env.CF_ACCESS_CLIENT_SECRET = "client-secret";
    expect(hasAccessServiceToken()).toBe(true);
  });

  it("hasAccessServiceToken accepts injected env", () => {
    expect(
      hasAccessServiceToken({
        CF_ACCESS_CLIENT_ID: "id",
        CF_ACCESS_CLIENT_SECRET: "sec",
      })
    ).toBe(true);
    expect(hasAccessServiceToken({ CF_ACCESS_CLIENT_ID: "id" })).toBe(false);
  });
});

describe("formatTuiAuthBanner local mode", () => {
  it("notes token is optional for local", () => {
    expect(
      formatTuiAuthBanner({ hasToken: false, source: "none" }, "local")
    ).toContain("optional for local");
  });

  it("shows --token source for flag", () => {
    expect(
      formatTuiAuthBanner({ hasToken: true, source: "flag" }, "remote")
    ).toContain("--token");
  });
});

describe("resolveTUIEntry env / prefix candidates", () => {
  const ORIG_ENTRY = process.env.HOOX_TUI_ENTRY;
  const ORIG_NPM = process.env.npm_config_prefix;

  afterEach(() => {
    if (ORIG_ENTRY === undefined) delete process.env.HOOX_TUI_ENTRY;
    else process.env.HOOX_TUI_ENTRY = ORIG_ENTRY;
    if (ORIG_NPM === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = ORIG_NPM;
  });

  it("prefers HOOX_TUI_ENTRY when it points at an existing file", () => {
    const entry = resolveTUIEntry(); // known-good monorepo path
    process.env.HOOX_TUI_ENTRY = entry;
    expect(resolveTUIEntry()).toBe(entry);
  });

  it("includes npm_config_prefix package roots without throwing", () => {
    process.env.npm_config_prefix = "/tmp/nonexistent-npm-prefix-hoox-test";
    // Still resolves via monorepo candidates
    const entry = resolveTUIEntry();
    expect(existsSync(entry)).toBe(true);
  });
});

describe("registerTUICommand", () => {
  const ORIG_TOKEN = process.env.HOOX_API_TOKEN;
  const ORIG_DEBUG = process.env.HOOX_DEBUG;
  const ORIG_TUI_DEBUG = process.env.TUI_DEBUG;
  const ORIG_ID = process.env.CF_ACCESS_CLIENT_ID;
  const ORIG_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

  beforeEach(() => {
    spawnCalls.length = 0;
    spawnCloseCode = 0;
    spawnError = null;
    process.exitCode = 0;
    delete process.env.HOOX_API_TOKEN;
    delete process.env.HOOX_DEBUG;
    delete process.env.TUI_DEBUG;
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
  });

  afterEach(() => {
    if (ORIG_TOKEN === undefined) delete process.env.HOOX_API_TOKEN;
    else process.env.HOOX_API_TOKEN = ORIG_TOKEN;
    if (ORIG_DEBUG === undefined) delete process.env.HOOX_DEBUG;
    else process.env.HOOX_DEBUG = ORIG_DEBUG;
    if (ORIG_TUI_DEBUG === undefined) delete process.env.TUI_DEBUG;
    else process.env.TUI_DEBUG = ORIG_TUI_DEBUG;
    if (ORIG_ID === undefined) delete process.env.CF_ACCESS_CLIENT_ID;
    else process.env.CF_ACCESS_CLIENT_ID = ORIG_ID;
    if (ORIG_SECRET === undefined) delete process.env.CF_ACCESS_CLIENT_SECRET;
    else process.env.CF_ACCESS_CLIENT_SECRET = ORIG_SECRET;
    process.exitCode = 0;
  });

  function makeProgram(): Command {
    const program = new Command().name("hoox-test").exitOverride(() => {});
    registerTUICommand(program);
    return program;
  }

  it("registers tui with expected options", () => {
    const program = makeProgram();
    const tui = program.commands.find((c) => c.name() === "tui");
    expect(tui).toBeDefined();
    const longs = tui!.options.map((o) => o.long);
    expect(longs).toContain("--remote");
    expect(longs).toContain("--api-url");
    expect(longs).toContain("--token");
    expect(longs).toContain("--allow-insecure");
    expect(longs).toContain("--debug");
  });

  it("spawns bun with resolved entry for local mode", async () => {
    const program = makeProgram();
    await program.parseAsync(["tui"], { from: "user" });
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]?.cmd).toBe("bun");
    expect(spawnCalls[0]?.args[0]).toBe("run");
    expect(spawnCalls[0]?.args[1]).toMatch(/main\.(tsx|js|ts)$/);
    const env = (spawnCalls[0]?.opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.HOOX_TUI_MODE).toBe("local");
    expect(env.HOOX_API_URL).toBeTruthy();
  });

  it("forwards --token and --debug into child env", async () => {
    const program = makeProgram();
    await program.parseAsync(
      ["tui", "--token", "secret-tok", "--debug", "--no-mouse", "--fps", "15"],
      { from: "user" }
    );
    expect(spawnCalls.length).toBe(1);
    const env = (spawnCalls[0]?.opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.HOOX_API_TOKEN).toBe("secret-tok");
    expect(env.HOOX_DEBUG).toBe("1");
    expect(env.TUI_DEBUG).toBe("1");
    expect(env.TUI_FPS).toBe("15");
    expect(env.TUI_MOUSE).toBe("0");
  });

  it("blocks remote without credentials", async () => {
    const program = makeProgram();
    await program.parseAsync(
      ["tui", "--api-url", "https://gateway.example.com"],
      { from: "user" }
    );
    expect(spawnCalls.length).toBe(0);
    expect(process.exitCode).not.toBe(0);
  });

  it("allows remote with --allow-insecure", async () => {
    const program = makeProgram();
    await program.parseAsync(
      [
        "tui",
        "--api-url",
        "https://gateway.example.com///",
        "--allow-insecure",
      ],
      { from: "user" }
    );
    expect(spawnCalls.length).toBe(1);
    const env = (spawnCalls[0]?.opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.HOOX_TUI_MODE).toBe("remote");
    expect(env.HOOX_API_URL).toBe("https://gateway.example.com");
  });

  it("allows remote with Access service token env", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "cid";
    process.env.CF_ACCESS_CLIENT_SECRET = "csec";
    const program = makeProgram();
    await program.parseAsync(["tui", "--api-url", "https://gw.example.com"], {
      from: "user",
    });
    expect(spawnCalls.length).toBe(1);
  });

  it("enables debug via HOOX_DEBUG=1 env", async () => {
    process.env.HOOX_DEBUG = "1";
    const program = makeProgram();
    await program.parseAsync(["tui"], { from: "user" });
    const env = (spawnCalls[0]?.opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.HOOX_DEBUG).toBe("1");
  });

  it("handles non-zero child exit without throwing", async () => {
    spawnCloseCode = 7;
    const program = makeProgram();
    await program.parseAsync(["tui"], { from: "user" });
    expect(spawnCalls.length).toBe(1);
  });

  it("handles spawn error", async () => {
    spawnError = new Error("spawn ENOENT");
    const program = makeProgram();
    await program.parseAsync(["tui"], { from: "user" });
    // withErrorHandling sets exitCode on CLIError
    expect(process.exitCode).not.toBe(0);
  });

  it("handles abnormal null exit code", async () => {
    spawnCloseCode = null;
    const program = makeProgram();
    await program.parseAsync(["tui"], { from: "user" });
    expect(process.exitCode).not.toBe(0);
  });
});
