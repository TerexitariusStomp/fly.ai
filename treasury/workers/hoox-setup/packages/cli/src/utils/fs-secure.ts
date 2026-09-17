/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Best-effort restrictive modes for secret material on disk.
 * Failures are ignored (restricted FS, tests, missing path).
 */

import { chmodSync, mkdirSync } from "node:fs";

/** File mode for secret files (.dev.vars, .keys/*.env, .env.local). */
export const SECRET_FILE_MODE = 0o600;

/** Directory mode for secret containers (.keys/). */
export const SECRET_DIR_MODE = 0o700;

export function secureChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // intentionally ignored
  }
}

/** Ensure a directory exists with restrictive mode (for `.keys/`). */
export function ensureSecretDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  } catch {
    // may already exist
  }
  secureChmod(dir, SECRET_DIR_MODE);
}

/** Mark a path as a secret file (owner read/write only). */
export function secureSecretFile(path: string): void {
  secureChmod(path, SECRET_FILE_MODE);
}
