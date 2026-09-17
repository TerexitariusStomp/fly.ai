/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TUI file-backed JSON storage.
 *
 * Bun has no `localStorage` global. Persist small TUI state under
 * `$HOME/.hoox/.tui-state/` (via hoox-path-service) so chat history,
 * query history, and similar UI state survive restarts.
 *
 * Writes are atomic (temp file + rename) to avoid truncated JSON on crash.
 * Paths are constrained under the TUI state directory (no secret material
 * is written here — only UI state).
 */
import { rename, unlink } from "fs/promises";
import { ensureTuiStateDir, resolveTuiStatePath } from "./hoox-path-service";

/** Well-known state file names under `.tui-state/`. */
export const TuiStateFiles = {
  chatHistory: "chat-history.json",
  dbQueryHistory: "db-query-history.json",
} as const;

/**
 * Read a JSON document from the TUI state directory.
 * Returns `fallback` when the file is missing or unreadable.
 */
export async function readJsonState<T>(
  filename: string,
  fallback: T
): Promise<T> {
  try {
    await ensureTuiStateDir();
    const path = resolveTuiStatePath(filename);
    const file = Bun.file(path);
    if (!(await file.exists())) return fallback;
    const parsed = (await file.json()) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON document to the TUI state directory (atomic rename).
 * Failures are silent — persistence is best-effort.
 */
export async function writeJsonState(
  filename: string,
  value: unknown
): Promise<void> {
  let tmpPath: string | null = null;
  try {
    await ensureTuiStateDir();
    const path = resolveTuiStatePath(filename);
    // Unique temp sibling so concurrent writers don't clobber each other.
    tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await Bun.write(tmpPath, JSON.stringify(value, null, 0));
    await rename(tmpPath, path);
    tmpPath = null;
  } catch {
    // Non-fatal: disk full, permissions, path traversal, etc.
    if (tmpPath) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Remove a JSON document from the TUI state directory.
 * Missing files are ignored.
 */
export async function removeJsonState(filename: string): Promise<void> {
  try {
    const path = resolveTuiStatePath(filename);
    await unlink(path);
  } catch {
    // Missing or unreadable — ignore
  }
}
