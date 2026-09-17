/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getRememberedMonorepoRoot,
  rememberMonorepoRoot,
} from "@hoox-sh/hoox-shared";
import { ensureWorkspaceContext } from "./workspace-context.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hoox-ws-"));
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  writeFileSync(
    join(root, "packages", "cli", "package.json"),
    JSON.stringify({ name: "@hoox-sh/hoox-cli" })
  );
  writeFileSync(join(root, "wrangler.jsonc.example"), "{}\n");
  mkdirSync(join(root, "workers"), { recursive: true });
  return root;
}

describe("ensureWorkspaceContext", () => {
  const temps: string[] = [];
  const origHome = process.env.HOOX_HOME;
  const origRepo = process.env.HOOX_REPO;
  const origCwd = process.cwd();

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), "hoox-home-"));
    temps.push(home);
    process.env.HOOX_HOME = home;
    delete process.env.HOOX_REPO;
  });

  afterEach(() => {
    try {
      process.chdir(origCwd);
    } catch {
      /* ignore */
    }
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

  it("detects monorepo from cwd, remembers it, and chdirs with force", () => {
    const root = makeRepo();
    temps.push(root);
    const outside = mkdtempSync(join(tmpdir(), "videos-"));
    temps.push(outside);

    // First: run from inside monorepo
    process.chdir(join(root, "workers"));
    const ctx = ensureWorkspaceContext({ force: true, quiet: true });
    expect(ctx.root).toBe(root);
    expect(ctx.source).toBe("cwd");
    expect(ctx.chdir).toBe(true);
    expect(process.cwd()).toBe(root);
    expect(getRememberedMonorepoRoot()).toBe(root);
    expect(process.env.HOOX_REPO).toBe(root);

    // Second: from unrelated dir, use remembered path
    process.chdir(outside);
    delete process.env.HOOX_REPO;
    const again = ensureWorkspaceContext({ force: true, quiet: true });
    expect(again.source).toBe("remembered");
    expect(again.root).toBe(root);
    expect(again.chdir).toBe(true);
    expect(process.cwd()).toBe(root);
  });

  it("returns null when no monorepo is known", () => {
    const outside = mkdtempSync(join(tmpdir(), "nowhere-"));
    temps.push(outside);
    process.chdir(outside);
    const ctx = ensureWorkspaceContext({ force: true, quiet: true });
    expect(ctx.root).toBeNull();
    expect(ctx.source).toBe("none");
    expect(ctx.chdir).toBe(false);
  });

  it("rememberMonorepoRoot rejects non-repos", () => {
    const d = mkdtempSync(join(tmpdir(), "not-repo-"));
    temps.push(d);
    expect(rememberMonorepoRoot(d)).toBe(false);
  });
});
