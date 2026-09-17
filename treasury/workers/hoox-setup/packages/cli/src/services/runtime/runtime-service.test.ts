/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for global runtime resolution and ensureGlobalRuntime bootstrap.
 * Filesystem uses real temp dirs; git/bun install go through mocked Bun.spawn.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HOOX_RUNTIME_REPO,
  DEFAULT_HOOX_SETUP_REPO,
  ensureGlobalRuntime,
  getRuntimeStatus,
} from "./runtime-service.js";

const realSpawn = Bun.spawn;

type MockSpawnResult = {
  stdout: Blob;
  stderr: Blob;
  exited: Promise<number>;
};

function spawnResult(
  exitCode: number,
  stdout = "",
  stderr = ""
): MockSpawnResult {
  return {
    stdout: new Blob([stdout]),
    stderr: new Blob([stderr]),
    exited: Promise.resolve(exitCode),
  };
}

let spawnQueue: Array<MockSpawnResult | (() => MockSpawnResult)> = [];
let spawnCalls: string[][] = [];

function installSpawnMock(): void {
  const spawnMock = mock((cmd: string[]) => {
    spawnCalls.push([...cmd]);
    const next = spawnQueue.shift();
    if (!next) return spawnResult(1, "", "unexpected spawn");
    return typeof next === "function" ? next() : next;
  });
  (Bun as Record<string, unknown>).spawn = spawnMock;
}

function writeSetupRoot(root: string): void {
  writeFileSync(join(root, "wrangler.jsonc"), "{}\n");
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  writeFileSync(
    join(root, "packages", "cli", "package.json"),
    JSON.stringify({ name: "cli" })
  );
}

function writeTuiEntry(root: string, file = "main.tsx"): string {
  mkdirSync(join(root, "packages", "tui", "src"), { recursive: true });
  const path = join(root, "packages", "tui", "src", file);
  writeFileSync(path, "// tui\n");
  return path;
}

describe("runtime-service constants", () => {
  it("exports default runtime repo URL and deprecated alias", () => {
    expect(DEFAULT_HOOX_RUNTIME_REPO).toContain("github.com/hoox-sh/hoox");
    expect(DEFAULT_HOOX_SETUP_REPO).toBe(DEFAULT_HOOX_RUNTIME_REPO);
  });
});

describe("getRuntimeStatus", () => {
  const temps: string[] = [];
  const origHome = process.env.HOOX_HOME;
  const origRepo = process.env.HOOX_REPO;

  afterEach(() => {
    if (origHome !== undefined) process.env.HOOX_HOME = origHome;
    else delete process.env.HOOX_HOME;
    if (origRepo !== undefined) process.env.HOOX_REPO = origRepo;
    else delete process.env.HOOX_REPO;
    for (const t of temps) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    temps.length = 0;
  });

  it("reports missing global runtime outside a setup repo", () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    temps.push(base, outside);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;

    const status = getRuntimeStatus(outside);
    expect(status.hooxHome).toBe(base);
    expect(status.repoPath).toBe(join(base, "repo"));
    expect(status.isSetupRoot).toBe(false);
    expect(status.runtime.source).toBe("none");
    expect(status.tuiEntry).toBeNull();
    expect(status.repoPresent).toBe(false);
  });

  it("finds TUI entry when HOOX_REPO points at a setup root", () => {
    const root = mkdtempSync(join(tmpdir(), "setup-"));
    temps.push(root);
    writeSetupRoot(root);
    const main = writeTuiEntry(root);

    process.env.HOOX_REPO = root;
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    temps.push(outside);

    const status = getRuntimeStatus(outside);
    expect(status.runtime.source).toBe("env");
    expect(status.runtime.root).toBe(root);
    expect(status.tuiEntry).toBe(main);
  });

  it("returns null tuiEntry when runtime root has no TUI files", () => {
    const root = mkdtempSync(join(tmpdir(), "setup-no-tui-"));
    temps.push(root);
    writeSetupRoot(root);
    process.env.HOOX_REPO = root;
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    temps.push(outside);

    const status = getRuntimeStatus(outside);
    expect(status.runtime.root).toBe(root);
    expect(status.tuiEntry).toBeNull();
  });

  it("marks repoPresent when global repo path exists", () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;
    mkdirSync(join(base, "repo"), { recursive: true });

    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    temps.push(outside);
    const status = getRuntimeStatus(outside);
    expect(status.repoPresent).toBe(true);
    expect(status.isSetupRoot).toBe(false);
  });
});

describe("ensureGlobalRuntime", () => {
  const temps: string[] = [];
  const origHome = process.env.HOOX_HOME;
  const origRepo = process.env.HOOX_REPO;

  beforeEach(() => {
    spawnQueue = [];
    spawnCalls = [];
    installSpawnMock();
  });

  afterEach(() => {
    (Bun as Record<string, unknown>).spawn = realSpawn;
    mock.restore();
    if (origHome !== undefined) process.env.HOOX_HOME = origHome;
    else delete process.env.HOOX_HOME;
    if (origRepo !== undefined) process.env.HOOX_REPO = origRepo;
    else delete process.env.HOOX_REPO;
    for (const t of temps) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    temps.length = 0;
  });

  it("clones missing runtime and skips install when skipInstall is set", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;

    const logs: string[] = [];
    spawnQueue.push(() => {
      // Simulate successful git clone by creating a valid setup root
      const repo = join(base, "repo");
      mkdirSync(repo, { recursive: true });
      writeSetupRoot(repo);
      writeTuiEntry(repo);
      return spawnResult(0, "Cloning into 'repo'...\n");
    });

    const result = await ensureGlobalRuntime({
      skipInstall: true,
      onLog: (m) => logs.push(m),
    });

    expect(result.cloned).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.repoPath).toBe(join(base, "repo"));
    expect(result.tuiEntry).toContain("main.tsx");
    expect(spawnCalls[0]?.slice(0, 3)).toEqual(["git", "clone", "--depth"]);
    expect(logs.some((l) => l.includes("Cloning"))).toBe(true);
  });

  it("uses custom repoUrl for git clone", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;

    spawnQueue.push(() => {
      const repo = join(base, "repo");
      mkdirSync(repo, { recursive: true });
      writeSetupRoot(repo);
      return spawnResult(0);
    });

    await ensureGlobalRuntime({
      repoUrl: "https://example.com/hoox.git",
      skipInstall: true,
    });

    expect(spawnCalls[0]).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "https://example.com/hoox.git",
      join(base, "repo"),
    ]);
  });

  it("throws when git clone fails", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;

    spawnQueue.push(spawnResult(128, "", "fatal: repository not found"));

    await expect(ensureGlobalRuntime({ skipInstall: true })).rejects.toThrow(
      /git clone failed/
    );
  });

  it("throws when path exists but is not a Hoox monorepo", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;
    mkdirSync(join(base, "repo"), { recursive: true });
    writeFileSync(join(base, "repo", "README.md"), "not a monorepo\n");

    await expect(ensureGlobalRuntime({ skipInstall: true })).rejects.toThrow(
      /not a Hoox monorepo/
    );
  });

  it("removes broken symlink then clones", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;

    const missingTarget = join(base, "gone-target");
    const repoPath = join(base, "repo");
    symlinkSync(missingTarget, repoPath);

    const logs: string[] = [];
    spawnQueue.push(() => {
      mkdirSync(repoPath, { recursive: true });
      writeSetupRoot(repoPath);
      return spawnResult(0);
    });

    const result = await ensureGlobalRuntime({
      skipInstall: true,
      onLog: (m) => logs.push(m),
    });

    expect(result.cloned).toBe(true);
    expect(logs.some((l) => l.includes("broken runtime symlink"))).toBe(true);
  });

  it("logs already present when setup root exists and skips install", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetupRoot(repo);
    writeTuiEntry(repo);
    // Present node_modules so needsInstall is false
    mkdirSync(join(repo, "node_modules"), { recursive: true });

    const logs: string[] = [];
    const result = await ensureGlobalRuntime({
      skipInstall: true,
      onLog: (m) => logs.push(m),
    });

    expect(result.cloned).toBe(false);
    expect(result.installed).toBe(false);
    expect(logs.some((l) => l.includes("already present"))).toBe(true);
    expect(spawnCalls.length).toBe(0);
  });

  it("runs bun install when node_modules is missing after existing root", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetupRoot(repo);
    writeTuiEntry(repo);
    // no node_modules

    const logs: string[] = [];
    spawnQueue.push(spawnResult(0, "Done\n"));

    const result = await ensureGlobalRuntime({
      skipInstall: false,
      onLog: (m) => logs.push(m),
    });

    expect(result.cloned).toBe(false);
    expect(result.installed).toBe(true);
    expect(spawnCalls[0]).toEqual(["bun", "install"]);
    expect(logs.some((l) => l.includes("bun install"))).toBe(true);
  });

  it("throws when bun install fails", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetupRoot(repo);

    spawnQueue.push(spawnResult(1, "", "error: lockfile"));

    await expect(ensureGlobalRuntime({ skipInstall: false })).rejects.toThrow(
      /bun install failed/
    );
  });

  it("installs after fresh clone when skipInstall is false", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;

    spawnQueue.push(() => {
      const repo = join(base, "repo");
      mkdirSync(repo, { recursive: true });
      writeSetupRoot(repo);
      writeTuiEntry(repo);
      return spawnResult(0);
    });
    spawnQueue.push(spawnResult(0));

    const result = await ensureGlobalRuntime({ skipInstall: false });
    expect(result.cloned).toBe(true);
    expect(result.installed).toBe(true);
    expect(spawnCalls.length).toBe(2);
    expect(spawnCalls[1]).toEqual(["bun", "install"]);
  });

  it("installs when tui package.json exists but tui node_modules missing", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetupRoot(repo);
    writeTuiEntry(repo);
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    mkdirSync(join(repo, "packages", "tui"), { recursive: true });
    writeFileSync(
      join(repo, "packages", "tui", "package.json"),
      JSON.stringify({ name: "tui" })
    );
    // no packages/tui/node_modules and no node_modules/@opentui

    spawnQueue.push(spawnResult(0));
    const result = await ensureGlobalRuntime({ skipInstall: false });
    expect(result.installed).toBe(true);
  });

  it("skips install when root node_modules and @opentui exist", async () => {
    const base = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(base);
    process.env.HOOX_HOME = base;
    delete process.env.HOOX_REPO;
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    writeSetupRoot(repo);
    writeTuiEntry(repo);
    mkdirSync(join(repo, "node_modules", "@opentui"), { recursive: true });
    mkdirSync(join(repo, "packages", "tui"), { recursive: true });
    writeFileSync(
      join(repo, "packages", "tui", "package.json"),
      JSON.stringify({ name: "tui" })
    );

    const result = await ensureGlobalRuntime({ skipInstall: false });
    expect(result.installed).toBe(false);
    expect(spawnCalls.length).toBe(0);
  });
});
