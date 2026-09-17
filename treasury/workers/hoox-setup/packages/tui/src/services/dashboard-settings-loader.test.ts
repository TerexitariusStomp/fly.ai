/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for loadDashboardSettingsManifests — thin runtime-root wrapper.
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadDashboardSettingsManifests } from "./dashboard-settings-loader";

describe("loadDashboardSettingsManifests", () => {
  it("loads manifests from an explicit monorepo root", () => {
    // packages/tui → monorepo root (…/hoox)
    const monorepoRoot = join(import.meta.dir, "..", "..", "..", "..");
    const manifests = loadDashboardSettingsManifests(monorepoRoot);
    expect(Array.isArray(manifests)).toBe(true);
    // Real checkout has worker dashboard.jsonc files
    expect(manifests.length).toBeGreaterThan(0);
    for (const m of manifests) {
      expect(typeof m.worker).toBe("string");
      expect(m.worker.length).toBeGreaterThan(0);
      expect(Array.isArray(m.sections)).toBe(true);
    }
  });

  it("returns empty list when workers dir is missing", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "hoox-dash-loader-"));
    try {
      const manifests = loadDashboardSettingsManifests(emptyRoot);
      expect(manifests).toEqual([]);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("accepts null runtimeRoot and still resolves via fallback root", () => {
    // null → resolveHooxRuntimeRoot or packages/tui walk-up fallback
    const manifests = loadDashboardSettingsManifests(null);
    expect(Array.isArray(manifests)).toBe(true);
  });

  it("accepts undefined runtimeRoot (default argument path)", () => {
    const manifests = loadDashboardSettingsManifests();
    expect(Array.isArray(manifests)).toBe(true);
  });
});
