/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for DbQueryView — registration + source contracts.
 *
 * Isolation strategy:
 *   - No OpenTUI renderer (keeps this suite lightweight).
 *   - CLI is the process-wide test double from test-setup; real SQL
 *     validator coverage lives in services/cli-bridge.test.ts.
 *   - Source-level checks against view-registry.tsx / app.tsx / db-query.tsx.
 */
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import {
  DbQueryView,
  formatCell,
  compareCells,
  sanitizeCellText,
  MAX_VISIBLE_ROWS,
  MAX_HISTORY,
} from "./db-query";
import { validateReadOnlySql } from "../../services/cli-bridge";

const VIEWS_DIR = import.meta.dir;
const TUI_SRC = join(VIEWS_DIR, "../..");

describe("DbQueryView", () => {
  it("is a function component", () => {
    expect(DbQueryView).toBeInstanceOf(Function);
    expect(DbQueryView.name).toBe("DbQueryView");
  });

  it("wires client-side validateReadOnlySql before CLI execution", async () => {
    const src = await Bun.file(join(VIEWS_DIR, "db-query.tsx")).text();
    expect(src).toContain("validateReadOnlySql");
    expect(src).toContain("cliBridge.dbQuery");
    // Must surface validation failure as queryError (UI cannot bypass)
    expect(src).toContain("not read-only");
  });

  it("formats NULL values distinctly in cells (contract)", () => {
    expect(formatCell(null, 20)).toBe("NULL");
    expect(formatCell(undefined, 20)).toBe("NULL");
    expect(formatCell(42, 20)).toBe("42");
    expect(formatCell(true, 20)).toBe("true");
    expect(formatCell(false, 20)).toBe("false");
    expect(formatCell(Number.POSITIVE_INFINITY, 20)).toBe("Infinity");
  });

  it("sanitizes cell text and collapses newlines", () => {
    expect(sanitizeCellText("a\x1bb")).toBe("ab");
    expect(formatCell("line1\nline2", 40)).toBe("line1 line2");
    expect(formatCell("x".repeat(30), 10)).toBe("xxxxxxxxx…");
  });

  it("sorts nulls last and numbers numerically", () => {
    expect(compareCells(null, 1, "asc")).toBe(1);
    expect(compareCells(1, null, "asc")).toBe(-1);
    expect(compareCells(null, null, "asc")).toBe(0);
    expect(compareCells(2, 10, "asc")).toBeLessThan(0);
    expect(compareCells(2, 10, "desc")).toBeGreaterThan(0);
    expect(compareCells("b", "a", "asc")).toBeGreaterThan(0);
    expect(compareCells("b", "a", "desc")).toBeLessThan(0);
  });

  it("rejects write SQL before any CLI call (defence in depth)", () => {
    expect(validateReadOnlySql("DROP TABLE users").readonly).toBe(false);
    expect(validateReadOnlySql("SELECT 1").readonly).toBe(true);
  });

  it("caps visible result rows and history size", () => {
    expect(MAX_VISIBLE_ROWS).toBe(200);
    expect(MAX_HISTORY).toBe(20);
  });

  it("is registered as ViewId db-query in view-registry factory", async () => {
    const registry = await Bun.file(join(TUI_SRC, "view-registry.tsx")).text();
    expect(registry).toContain('id: "db-query"');
    expect(registry).toContain("DbQueryView");
  });

  it("is registered in the command palette (view-registry)", async () => {
    const registry = await Bun.file(join(TUI_SRC, "view-registry.tsx")).text();
    expect(registry).toContain('id: "db-query"');
    expect(registry).toMatch(/db-query[\s\S]{0,160}paletteShortcut:\s*"\^#q"/);
  });

  it("has a sidebar nav item via view-registry short labels", async () => {
    const registry = await Bun.file(join(TUI_SRC, "view-registry.tsx")).text();
    expect(registry).toContain('id: "db-query"');
    expect(registry).toContain("DB QUERY");
    // Sidebar consumes SIDEBAR_ITEMS from the registry (single source of truth)
    const sidebar = await Bun.file(
      join(TUI_SRC, "components/layout/sidebar.tsx")
    ).text();
    expect(sidebar).toContain("SIDEBAR_ITEMS");
  });

  it("uses Ctrl+Alt+Q chord via registry map in app keyboard handler", async () => {
    const registry = await Bun.file(join(TUI_SRC, "view-registry.tsx")).text();
    expect(registry).toContain('id: "db-query"');
    expect(registry).toContain("getCtrlAltViewMap");
    const app = await Bun.file(join(TUI_SRC, "app.tsx")).text();
    expect(app).toContain("getCtrlAltViewMap");
    expect(app).toContain("CTRL_ALT_VIEWS");
    expect(app).toMatch(/key\.ctrl\s*&&\s*key\.alt/);
    expect(app).toContain("CTRL_ALT_VIEWS[name]");
  });

  it("persists query history via TuiStateFiles.dbQueryHistory (max 20)", async () => {
    const src = await Bun.file(join(VIEWS_DIR, "db-query.tsx")).text();
    expect(src).toContain("TuiStateFiles.dbQueryHistory");
    expect(src).toMatch(/MAX_HISTORY\s*=\s*20/);
    const storage = await Bun.file(
      join(TUI_SRC, "services/tui-storage.ts")
    ).text();
    expect(storage).toContain('dbQueryHistory: "db-query-history.json"');
  });
});
