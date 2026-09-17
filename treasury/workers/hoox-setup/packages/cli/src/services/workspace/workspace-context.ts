/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace context — detect monorepo root, remember it, chdir for commands.
 *
 * So `hx` / `hoox` work from any directory (e.g. ~/Videos) after the monorepo
 * has been discovered once (or HOOX_REPO / ~/.hoox/repo is set).
 */

import { resolve } from "node:path";
import {
  rememberMonorepoRoot,
  resolveHooxRuntimeRoot,
  type RuntimeRootResult,
  type RuntimeRootSource,
} from "@hoox-sh/hoox-shared";

export interface WorkspaceContext {
  /** Absolute monorepo root after resolution, or null. */
  root: string | null;
  source: RuntimeRootSource;
  /** True when process.chdir was called. */
  chdir: boolean;
  /** cwd before any chdir. */
  previousCwd: string;
  /** Full resolution result for doctor / debug. */
  runtime: RuntimeRootResult;
}

/** Last ensureWorkspaceContext() result (for doctor / diagnostics). */
let lastWorkspaceContext: WorkspaceContext | null = null;

/** Snapshot from the most recent ensureWorkspaceContext() call. */
export function getLastWorkspaceContext(): WorkspaceContext | null {
  return lastWorkspaceContext;
}

/**
 * Resolve monorepo root, persist when found from cwd, and chdir into it
 * so relative paths (wrangler.jsonc, workers/, …) work from any directory.
 *
 * Skipped under tests (`BUN_TEST` / `NODE_ENV=test`) unless force is set.
 * Silent by default when HOOX_CLI_SILENT=1 or --json / --quiet in argv.
 */
export function ensureWorkspaceContext(options?: {
  /** Force even in test env. */
  force?: boolean;
  /** Suppress the one-line “using monorepo” notice. */
  quiet?: boolean;
  cwd?: string;
}): WorkspaceContext {
  const previousCwd = resolve(options?.cwd ?? process.cwd());
  const inTest =
    process.env.BUN_TEST === "1" ||
    process.env.NODE_ENV === "test" ||
    typeof process.env.BUN_TEST !== "undefined";

  // In unit tests we still resolve/remember paths when force, but avoid
  // surprising chdir that breaks test isolation.
  const allowChdir = options?.force === true || !inTest;

  const runtime = resolveHooxRuntimeRoot({ cwd: previousCwd });
  const quiet =
    options?.quiet === true ||
    process.env.HOOX_CLI_SILENT === "1" ||
    process.argv.includes("--json") ||
    process.argv.includes("--quiet");

  if (!runtime.root) {
    const empty: WorkspaceContext = {
      root: null,
      source: runtime.source,
      chdir: false,
      previousCwd,
      runtime,
    };
    lastWorkspaceContext = empty;
    return empty;
  }

  // Always refresh remembered path when we discovered a real checkout via
  // cwd or env (user pointed HOOX_REPO at their clone).
  if (runtime.source === "cwd" || runtime.source === "env") {
    rememberMonorepoRoot(runtime.root);
  } else if (runtime.source === "remembered") {
    // Touch timestamp so “last used” stays fresh
    rememberMonorepoRoot(runtime.root);
  }

  // Session env for child processes (wrangler, bun, etc.)
  if (!process.env.HOOX_REPO) {
    process.env.HOOX_REPO = runtime.root;
  }

  let didChdir = false;
  const target = resolve(runtime.root);
  if (allowChdir && resolve(process.cwd()) !== target) {
    process.chdir(target);
    didChdir = true;
    if (!quiet) {
      const label =
        runtime.source === "remembered"
          ? "remembered monorepo"
          : runtime.source === "global"
            ? "global runtime"
            : runtime.source === "env"
              ? "HOOX_REPO"
              : "monorepo";
      process.stderr.write(`hoox: using ${label} at ${target}\n`);
    }
  }

  const ctx: WorkspaceContext = {
    root: target,
    source: runtime.source,
    chdir: didChdir,
    previousCwd,
    runtime,
  };
  lastWorkspaceContext = ctx;
  return ctx;
}
