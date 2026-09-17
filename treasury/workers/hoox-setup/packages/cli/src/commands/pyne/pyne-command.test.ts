/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `hoox pyne` — helpers + command actions.
 * Network (fetch) and Bun.spawn are mocked; filesystem uses temp dirs.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  buildPyneRequestUrl,
  loadDevVars,
  normalizeBaseUrl,
  registerPyneCommand,
  resolveApiKey,
  resolvePyneBaseUrl,
} from "./pyne-command.js";
import { CLIError } from "../../utils/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const realSpawn = Bun.spawn;
const origFetch = globalThis.fetch;

function captureStreams(): {
  stdout: () => string;
  stderr: () => string;
  restore: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Buffer) => {
    out.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Buffer) => {
    err.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

function makeProgram(): Command {
  const program = new Command();
  program.name("hoox");
  program.option("--json", "JSON output");
  program.option("--quiet", "Quiet");
  program.exitOverride();
  registerPyneCommand(program);
  return program;
}

async function runPyne(
  args: string[],
  program?: Command
): Promise<ReturnType<typeof captureStreams>> {
  const prog = program ?? makeProgram();
  const cap = captureStreams();
  try {
    await prog.parseAsync(["node", "hoox", "pyne", ...args], { from: "node" });
  } catch {
    // Commander may throw on help/exitOverride; ignore for action tests
  }
  return cap;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("normalizeBaseUrl / buildPyneRequestUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://x.example///")).toBe("https://x.example");
    expect(normalizeBaseUrl("https://x.example")).toBe("https://x.example");
  });

  it("joins path with origin and optional base pathname", () => {
    expect(buildPyneRequestUrl("https://pyne.example", "/health")).toBe(
      "https://pyne.example/health"
    );
    expect(buildPyneRequestUrl("https://pyne.example/", "health")).toBe(
      "https://pyne.example/health"
    );
    expect(buildPyneRequestUrl("https://pyne.example/v1/", "/run")).toBe(
      "https://pyne.example/v1/run"
    );
  });

  it("rejects invalid URL", () => {
    expect(() => buildPyneRequestUrl("not a url", "/x")).toThrow(CLIError);
    expect(() => buildPyneRequestUrl("not a url", "/x")).toThrow(/Invalid/i);
  });

  it("rejects non-http schemes", () => {
    expect(() => buildPyneRequestUrl("file:///tmp", "/x")).toThrow(
      /http\(s\)/i
    );
    expect(() => buildPyneRequestUrl("ftp://host", "/x")).toThrow(CLIError);
  });
});

describe("resolveApiKey", () => {
  const envKeys = ["PYNE_API_KEY", "API_KEY"] as const;
  const orig: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      orig[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  it("prefers explicit flag", () => {
    process.env.PYNE_API_KEY = "from-env";
    expect(resolveApiKey("  flag-key  ")).toBe("flag-key");
  });

  it("uses PYNE_API_KEY then API_KEY env", () => {
    process.env.PYNE_API_KEY = " pyne ";
    expect(resolveApiKey()).toBe("pyne");
    delete process.env.PYNE_API_KEY;
    process.env.API_KEY = "api";
    expect(resolveApiKey()).toBe("api");
  });

  it("reads .dev.vars when workerDir provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyne-vars-"));
    try {
      writeFileSync(
        join(dir, ".dev.vars"),
        [
          "# comment",
          "",
          "API_KEY=from-file",
          "OTHER='quoted'",
          'PYNE_API_KEY="unused-because-api-key-first"',
          "NOEQ",
        ].join("\n")
      );
      expect(resolveApiKey(undefined, dir)).toBe("from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when nothing available", () => {
    expect(resolveApiKey()).toBeNull();
  });
});

describe("loadDevVars", () => {
  it("parses quoted values and skips comments/duplicates", () => {
    const dir = mkdtempSync(join(tmpdir(), "devvars-"));
    try {
      writeFileSync(
        join(dir, ".dev.vars"),
        'FOO="bar"\n# c\nFOO=ignored\nBAZ=qux\n'
      );
      const vars = loadDevVars(dir);
      expect(vars.FOO).toBe("bar");
      expect(vars.BAZ).toBe("qux");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to cwd .dev.vars", () => {
    const root = mkdtempSync(join(tmpdir(), "devvars-cwd-"));
    const worker = join(root, "worker");
    mkdirSync(worker);
    const orig = process.cwd();
    try {
      process.chdir(root);
      writeFileSync(join(root, ".dev.vars"), "PYNE_API_KEY=cwd-key\n");
      const vars = loadDevVars(worker);
      expect(vars.PYNE_API_KEY).toBe("cwd-key");
    } finally {
      process.chdir(orig);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolvePyneBaseUrl", () => {
  const envKeys = [
    "PYNE_WORKER_URL",
    "HOOX_PYNE_URL",
    "CLOUDFLARE_ACCOUNT_ID",
  ] as const;
  const orig: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      orig[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  it("uses explicit URL trimmed without trailing slash", async () => {
    expect(await resolvePyneBaseUrl("  https://custom.example///  ")).toBe(
      "https://custom.example"
    );
  });

  it("uses PYNE_WORKER_URL env", async () => {
    process.env.PYNE_WORKER_URL = "https://env.example/";
    expect(await resolvePyneBaseUrl()).toBe("https://env.example");
  });

  it("uses HOOX_PYNE_URL when PYNE_WORKER_URL unset", async () => {
    process.env.HOOX_PYNE_URL = "https://hoox-env.example";
    expect(await resolvePyneBaseUrl()).toBe("https://hoox-env.example");
  });

  it("falls back to default workers.dev host", async () => {
    // Config load may succeed or fail depending on cwd; either way we get a URL
    const url = await resolvePyneBaseUrl();
    expect(url).toMatch(/^https:\/\/pyne-worker\./);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerPyneCommand", () => {
  let program: Command;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerPyneCommand(program);
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit called with ${code}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it("registers the top-level pyne command", () => {
    const pyne = program.commands.find((c) => c.name() === "pyne");
    expect(pyne).toBeDefined();
    const summary =
      (pyne as Command & { summary?: () => string }).summary?.() ??
      pyne?.description() ??
      "";
    expect(summary || "").toMatch(/PYNE|pyne|Pine/i);
  });

  it("attaches core subcommands", () => {
    const pyne = program.commands.find((c) => c.name() === "pyne");
    const subNames = pyne?.commands.map((s) => s.name()) ?? [];
    expect(subNames).toContain("health");
    expect(subNames).toContain("run");
    expect(subNames).toContain("scripts");
    expect(subNames).toContain("cron");
    expect(subNames).toContain("ingest");
    expect(subNames).toContain("sync-vendor");
    expect(subNames).toContain("deploy");
    expect(subNames).toContain("feed");
  });

  it("run requires a script-path argument", () => {
    const pyne = program.commands.find((c) => c.name() === "pyne")!;
    const run = pyne.commands.find((s) => s.name() === "run")!;
    expect(run.registeredArguments.length).toBeGreaterThan(0);
    expect(run.registeredArguments[0]?.required).toBe(true);
  });

  it("scripts has list/get/deploy/delete", () => {
    const pyne = program.commands.find((c) => c.name() === "pyne")!;
    const scripts = pyne.commands.find((s) => s.name() === "scripts")!;
    const names = scripts.commands.map((c) => c.name());
    expect(names).toContain("list");
    expect(names).toContain("get");
    expect(names).toContain("deploy");
    expect(names).toContain("delete");
  });

  it("health accepts --url option", () => {
    const pyne = program.commands.find((c) => c.name() === "pyne")!;
    const health = pyne.commands.find((s) => s.name() === "health")!;
    const flags = health.options.map((o) => o.long ?? o.short);
    expect(flags).toContain("--url");
  });
});

// ---------------------------------------------------------------------------
// Command actions
// ---------------------------------------------------------------------------

describe("pyne command actions", () => {
  const temps: string[] = [];
  let origCwd: string;
  let tmpDir: string;
  let spawnCalls: string[][] = [];
  let spawnExitCode = 0;

  function setupPyneWorkerDir(): string {
    const dir = join(tmpDir, "workers", "pyne-worker");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "sync_vendor.sh"), "#!/bin/sh\n");
    writeFileSync(join(dir, ".dev.vars"), "API_KEY=dev-key\n");
    return dir;
  }

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "hoox-pyne-"));
    temps.push(tmpDir);
    process.chdir(tmpDir);
    // Bun ignores `process.exitCode = undefined` — must set 0 explicitly.
    process.exitCode = 0;
    spawnCalls = [];
    spawnExitCode = 0;
    (Bun as Record<string, unknown>).spawn = mock((cmd: string[]) => {
      spawnCalls.push([...cmd]);
      return {
        exited: Promise.resolve(spawnExitCode),
        stdout: new Blob([""]),
        stderr: new Blob([""]),
      };
    });
    globalThis.fetch = origFetch;
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.exitCode = 0;
    (Bun as Record<string, unknown>).spawn = realSpawn;
    globalThis.fetch = origFetch;
    mock.restore();
    for (const t of temps.splice(0)) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // -- health ---------------------------------------------------------------

  it("health reports healthy on 200 JSON", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://pyne.test/health");
      return okJson({ status: "ok" });
    }) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "health",
          "--url",
          "https://pyne.test",
        ],
        { from: "node" }
      );
      const json = JSON.parse(cap.stdout()) as {
        status: string;
        httpStatus: number;
        worker: string;
      };
      expect(json.status).toBe("healthy");
      expect(json.httpStatus).toBe(200);
      expect(json.worker).toBe("pyne-worker");
    } finally {
      cap.restore();
    }
  });

  it("health reports degraded on 4xx and sets exitCode", async () => {
    globalThis.fetch = mock(async () =>
      okJson({ error: "unauthorized" }, 401)
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "health",
          "--url",
          "https://pyne.test",
        ],
        { from: "node" }
      );
      const json = JSON.parse(cap.stdout()) as { status: string };
      expect(json.status).toBe("degraded");
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it("health reports down on 5xx", async () => {
    globalThis.fetch = mock(async () =>
      textResponse("boom", 503)
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "health",
          "--url",
          "https://pyne.test",
        ],
        { from: "node" }
      );
      const json = JSON.parse(cap.stdout()) as { status: string };
      expect(json.status).toBe("down");
    } finally {
      cap.restore();
    }
  });

  it("health human mode prints success line", async () => {
    globalThis.fetch = mock(async () =>
      okJson({ ok: true })
    ) as unknown as typeof fetch;

    const cap = await runPyne(["health", "--url", "https://pyne.test"]);
    try {
      expect(cap.stdout()).toMatch(/pyne-worker ok/i);
    } finally {
      cap.restore();
    }
  });

  it("health JSON error path when fetch throws", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "health",
          "--url",
          "https://pyne.test",
        ],
        { from: "node" }
      );
      const json = JSON.parse(cap.stdout()) as {
        status: string;
        error: string;
      };
      expect(json.status).toBe("down");
      expect(json.error).toMatch(/network down/);
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it("health human mode rethrows CLIError on fetch failure", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const cap = await runPyne(["health", "--url", "https://pyne.test"]);
    try {
      expect(process.exitCode).toBe(1);
      expect(cap.stderr() + cap.stdout()).toMatch(
        /health failed|ECONNREFUSED/i
      );
    } finally {
      cap.restore();
    }
  });

  // -- run ------------------------------------------------------------------

  it("run fails without API key", async () => {
    setupPyneWorkerDir();
    // Remove key from .dev.vars
    writeFileSync(join(tmpDir, "workers/pyne-worker/.dev.vars"), "");
    writeFileSync(join(tmpDir, "strat.pine"), "// pine\n");

    const cap = await runPyne([
      "run",
      "strat.pine",
      "--url",
      "https://pyne.test",
    ]);
    try {
      expect(process.exitCode).toBe(2);
      expect(cap.stderr() + cap.stdout()).toMatch(/API key required/i);
    } finally {
      cap.restore();
    }
  });

  it("run fails when script file missing", async () => {
    setupPyneWorkerDir();
    const cap = await runPyne([
      "run",
      "missing.pine",
      "--url",
      "https://pyne.test",
      "--api-key",
      "k",
    ]);
    try {
      expect(process.exitCode).toBe(1);
      expect(cap.stderr() + cap.stdout()).toMatch(/Script not found/i);
    } finally {
      cap.restore();
    }
  });

  it("run posts script file body", async () => {
    setupPyneWorkerDir();
    writeFileSync(join(tmpDir, "strat.pine"), "strategy()\n");

    let capturedBody: unknown;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://pyne.test/run");
        expect(init?.method).toBe("POST");
        capturedBody = JSON.parse(String(init?.body));
        capturedHeaders = new Headers(init?.headers);
        return okJson({ result: "ok" });
      }
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "run",
          "strat.pine",
          "--url",
          "https://pyne.test",
          "--api-key",
          "secret-key",
          "--mode",
          "compile",
        ],
        { from: "node" }
      );
      expect(capturedHeaders?.get("X-API-Key")).toBe("secret-key");
      expect(capturedBody).toEqual({
        mode: "compile",
        script: "strategy()\n",
      });
      const json = JSON.parse(cap.stdout()) as { result: string };
      expect(json.result).toBe("ok");
    } finally {
      cap.restore();
    }
  });

  it("run with --script-id skips file body", async () => {
    setupPyneWorkerDir();
    let capturedBody: unknown;
    globalThis.fetch = mock(
      async (_i: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return okJson({ ok: true });
      }
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "run",
          "ignored.pine",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
          "--script-id",
          "deployed-1",
        ],
        { from: "node" }
      );
      expect(capturedBody).toEqual({
        mode: "auto",
        script_id: "deployed-1",
      });
    } finally {
      cap.restore();
    }
  });

  it("run sets exitCode on non-ok response", async () => {
    setupPyneWorkerDir();
    writeFileSync(join(tmpDir, "s.pine"), "x");
    globalThis.fetch = mock(async () =>
      okJson({ error: "bad" }, 400)
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "run",
          "s.pine",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
    }
  });

  // -- scripts --------------------------------------------------------------

  it("scripts list requires api key", async () => {
    setupPyneWorkerDir();
    writeFileSync(join(tmpDir, "workers/pyne-worker/.dev.vars"), "");
    const cap = await runPyne([
      "scripts",
      "list",
      "--url",
      "https://pyne.test",
    ]);
    try {
      expect(process.exitCode).toBe(2);
    } finally {
      cap.restore();
    }
  });

  it("scripts list fetches /scripts", async () => {
    setupPyneWorkerDir();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://pyne.test/scripts");
      return okJson({ scripts: ["a"] });
    }) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "scripts",
          "list",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(JSON.parse(cap.stdout())).toEqual({ scripts: ["a"] });
    } finally {
      cap.restore();
    }
  });

  it("scripts get encodes id in path", async () => {
    setupPyneWorkerDir();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://pyne.test/scripts/my%2Fid");
      return okJson({ id: "my/id" });
    }) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "scripts",
          "get",
          "my/id",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(JSON.parse(cap.stdout()).id).toBe("my/id");
    } finally {
      cap.restore();
    }
  });

  it("scripts deploy posts file and derives script_id", async () => {
    setupPyneWorkerDir();
    writeFileSync(join(tmpDir, "my strategy.pine"), "pine code");
    let body: unknown;
    globalThis.fetch = mock(
      async (_i: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        body = JSON.parse(String(init?.body));
        return okJson({ ok: true });
      }
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "scripts",
          "deploy",
          "my strategy.pine",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(body).toEqual({
        script_id: "my_strategy",
        script: "pine code",
      });
    } finally {
      cap.restore();
    }
  });

  it("scripts deploy fails when file missing", async () => {
    setupPyneWorkerDir();
    const cap = await runPyne([
      "scripts",
      "deploy",
      "nope.pine",
      "--url",
      "https://pyne.test",
      "--api-key",
      "k",
    ]);
    try {
      expect(process.exitCode).toBe(1);
      expect(cap.stderr() + cap.stdout()).toMatch(/Script not found/i);
    } finally {
      cap.restore();
    }
  });

  it("scripts delete uses DELETE method", async () => {
    setupPyneWorkerDir();
    let method = "";
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        method = init?.method ?? "GET";
        expect(String(input)).toBe("https://pyne.test/scripts/sid1");
        return okJson({ deleted: true });
      }
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "scripts",
          "delete",
          "sid1",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(method).toBe("DELETE");
    } finally {
      cap.restore();
    }
  });

  it("scripts delete human mode prints success", async () => {
    setupPyneWorkerDir();
    globalThis.fetch = mock(async () =>
      okJson({ ok: true })
    ) as unknown as typeof fetch;
    const cap = await runPyne([
      "scripts",
      "delete",
      "sid1",
      "--url",
      "https://pyne.test",
      "--api-key",
      "k",
    ]);
    try {
      expect(cap.stdout()).toMatch(/Deleted script_id=sid1/i);
    } finally {
      cap.restore();
    }
  });

  // -- cron / feed ----------------------------------------------------------

  it("cron jobs lists jobs", async () => {
    setupPyneWorkerDir();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://pyne.test/cron/jobs");
      return okJson({ jobs: [] });
    }) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "cron",
          "jobs",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(JSON.parse(cap.stdout())).toEqual({ jobs: [] });
    } finally {
      cap.restore();
    }
  });

  it("cron run posts to /cron/run", async () => {
    setupPyneWorkerDir();
    let method = "";
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        method = init?.method ?? "GET";
        expect(String(input)).toBe("https://pyne.test/cron/run");
        return okJson({ triggered: true });
      }
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "cron",
          "run",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(method).toBe("POST");
    } finally {
      cap.restore();
    }
  });

  it("feed refresh posts to /feed/refresh", async () => {
    setupPyneWorkerDir();
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://pyne.test/feed/refresh");
        expect(init?.method).toBe("POST");
        return okJson({ refreshed: true });
      }
    ) as unknown as typeof fetch;

    const program = makeProgram();
    const cap = captureStreams();
    try {
      await program.parseAsync(
        [
          "node",
          "hoox",
          "--json",
          "pyne",
          "feed",
          "refresh",
          "--url",
          "https://pyne.test",
          "--api-key",
          "k",
        ],
        { from: "node" }
      );
      expect(JSON.parse(cap.stdout()).refreshed).toBe(true);
    } finally {
      cap.restore();
    }
  });

  // -- requirePyneDir / spawn commands --------------------------------------

  it("authenticated commands fail when pyne-worker dir missing", async () => {
    // tmpDir has no workers/pyne-worker
    const cap = await runPyne([
      "scripts",
      "list",
      "--url",
      "https://pyne.test",
      "--api-key",
      "k",
    ]);
    try {
      expect(process.exitCode).toBe(1);
      expect(cap.stderr() + cap.stdout()).toMatch(
        /pyne-worker directory not found/i
      );
    } finally {
      cap.restore();
    }
  });

  it("sync-vendor fails when script missing", async () => {
    const dir = join(tmpDir, "workers", "pyne-worker");
    mkdirSync(dir, { recursive: true });
    // no scripts/sync_vendor.sh
    const cap = await runPyne(["sync-vendor"]);
    try {
      expect(process.exitCode).toBe(1);
      expect(cap.stderr() + cap.stdout()).toMatch(/sync_vendor\.sh not found/i);
    } finally {
      cap.restore();
    }
  });

  it("sync-vendor spawns bash script", async () => {
    setupPyneWorkerDir();
    spawnExitCode = 0;
    const cap = await runPyne(["sync-vendor"]);
    try {
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0]?.[0]).toBe("bash");
      expect(spawnCalls[0]?.[1]).toContain("sync_vendor.sh");
      expect(process.exitCode).toBe(0);
    } finally {
      cap.restore();
    }
  });

  it("deploy --skip-sync only runs wrangler", async () => {
    setupPyneWorkerDir();
    spawnExitCode = 0;
    const cap = await runPyne(["deploy", "--skip-sync"]);
    try {
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0]).toEqual(["bunx", "wrangler", "deploy"]);
    } finally {
      cap.restore();
    }
  });

  it("deploy runs sync then wrangler", async () => {
    setupPyneWorkerDir();
    spawnExitCode = 0;
    const cap = await runPyne(["deploy"]);
    try {
      expect(spawnCalls.length).toBe(2);
      expect(spawnCalls[0]?.[0]).toBe("bash");
      expect(spawnCalls[1]).toEqual(["bunx", "wrangler", "deploy"]);
    } finally {
      cap.restore();
    }
  });

  it("deploy aborts wrangler when sync fails", async () => {
    setupPyneWorkerDir();
    let n = 0;
    (Bun as Record<string, unknown>).spawn = mock((cmd: string[]) => {
      spawnCalls.push([...cmd]);
      n++;
      return {
        exited: Promise.resolve(n === 1 ? 7 : 0),
        stdout: new Blob([""]),
        stderr: new Blob([""]),
      };
    });
    const cap = await runPyne(["deploy"]);
    try {
      expect(spawnCalls.length).toBe(1);
      expect(process.exitCode).toBe(7);
    } finally {
      cap.restore();
    }
  });

  it("ingest spawns python fetch_and_ingest", async () => {
    setupPyneWorkerDir();
    const cap = await runPyne(["ingest"]);
    try {
      expect(spawnCalls[0]?.[0]).toBe("python3");
      expect(spawnCalls[0]?.[1]).toBe("scripts/fetch_and_ingest.py");
    } finally {
      cap.restore();
    }
  });
});
