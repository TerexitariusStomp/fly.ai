/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration Tests — Navigation, view switching, keyboard shortcuts.
 *
 * Tests the full navigation flow via the UI store + view-registry helpers:
 *   - View transitions via setView (all 16 views)
 *   - Keyboard shortcut maps (Ctrl+digit + Ctrl+Alt chords)
 *   - Focus routing across views
 *   - Command palette integration
 *   - Back navigation
 *
 * Uses Bun test runner. Pure store-level integration (no rendering).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { useUIStore } from "@hoox-sh/hoox-shared/stores/ui-store";
import { useServiceStore } from "@hoox-sh/hoox-shared/stores/service-store";
import type { ViewId } from "@hoox-sh/hoox-shared";
import {
  getViewShortcutMap,
  getCtrlAltViewMap,
  getViewPaletteCommands,
  VIEW_REGISTRY,
} from "../../src/view-registry";
import { ALL_VIEW_IDS } from "../../src/test-utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetStores() {
  useUIStore.setState({
    activeView: "dashboard",
    sidebarExpanded: true,
    modal: null,
    commandPaletteOpen: false,
    previousView: null,
  });
  useServiceStore.setState({
    workers: [],
    connectionStatus: "offline",
  });
}

/** Simulate a Ctrl+digit keyboard shortcut via registry map */
function dispatchDigitShortcut(key: string) {
  const view = getViewShortcutMap()[key];
  if (view) {
    useUIStore.getState().setView(view);
  }
}

/** Simulate Ctrl+Alt+letter chord */
function dispatchCtrlAlt(letter: string) {
  const view = getCtrlAltViewMap()[letter];
  if (view) {
    useUIStore.getState().setView(view);
  }
}

function dispatchCtrlB() {
  useUIStore.getState().toggleSidebar();
}

function dispatchCtrlP() {
  useUIStore.getState().openPalette();
}

function dispatchEscape() {
  const state = useUIStore.getState();
  if (state.commandPaletteOpen) {
    useUIStore.getState().closePalette();
  } else if (state.previousView) {
    useUIStore.getState().goBack();
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("Navigation Integration", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("view switching", () => {
    it("starts on dashboard", () => {
      expect(useUIStore.getState().activeView).toBe("dashboard");
    });

    it("switches to all Ctrl+digit views via shortcuts", () => {
      for (const [key, view] of Object.entries(getViewShortcutMap())) {
        dispatchDigitShortcut(key);
        expect(useUIStore.getState().activeView).toBe(view);
      }
    });

    it("switches to all Ctrl+Alt chord views", () => {
      for (const [letter, view] of Object.entries(getCtrlAltViewMap())) {
        dispatchCtrlAlt(letter);
        expect(useUIStore.getState().activeView).toBe(view);
      }
    });

    it("tracks navigation history for back support", () => {
      dispatchDigitShortcut("2"); // workers
      expect(useUIStore.getState().previousView).toBe("dashboard");

      dispatchDigitShortcut("4"); // trade-monitor
      expect(useUIStore.getState().previousView).toBe("workers");
    });

    it("goBack returns to previous view", () => {
      dispatchDigitShortcut("2");
      dispatchDigitShortcut("4");
      useUIStore.getState().goBack();

      expect(useUIStore.getState().activeView).toBe("workers");
      expect(useUIStore.getState().previousView).toBeNull();
    });

    it("double goBack after single navigation has no effect", () => {
      dispatchDigitShortcut("9");
      useUIStore.getState().goBack();

      expect(useUIStore.getState().activeView).toBe("dashboard");
      useUIStore.getState().goBack();
      expect(useUIStore.getState().activeView).toBe("dashboard");
    });

    it("switching to same view does not change history", () => {
      useUIStore.getState().setView("dashboard");
      expect(useUIStore.getState().previousView).toBeNull();
    });
  });

  describe("keyboard shortcuts", () => {
    it("Ctrl+1 through Ctrl+0 switch digit-bound views", () => {
      const map = getViewShortcutMap();
      for (const [key, view] of Object.entries(map)) {
        dispatchDigitShortcut(key);
        expect(useUIStore.getState().activeView).toBe(view);
      }
      expect(Object.keys(map)).toHaveLength(10);
    });

    it("Ctrl+B toggles sidebar", () => {
      expect(useUIStore.getState().sidebarExpanded).toBe(true);
      dispatchCtrlB();
      expect(useUIStore.getState().sidebarExpanded).toBe(false);
      dispatchCtrlB();
      expect(useUIStore.getState().sidebarExpanded).toBe(true);
    });

    it("Ctrl+P opens command palette", () => {
      dispatchCtrlP();
      expect(useUIStore.getState().commandPaletteOpen).toBe(true);
    });

    it("Escape closes command palette when open", () => {
      dispatchCtrlP();
      dispatchEscape();
      expect(useUIStore.getState().commandPaletteOpen).toBe(false);
    });

    it("view switching auto-closes command palette", () => {
      dispatchCtrlP();
      dispatchDigitShortcut("5");
      expect(useUIStore.getState().commandPaletteOpen).toBe(false);
    });
  });

  describe("focus routing", () => {
    it("each of 16 views can be activated independently", () => {
      for (const view of ALL_VIEW_IDS) {
        useUIStore.getState().setView(view);
        expect(useUIStore.getState().activeView).toBe(view);
      }
    });

    it("sidebar expand/collapse maintains active view", () => {
      useUIStore.getState().setView("trade-monitor");
      dispatchCtrlB();
      expect(useUIStore.getState().activeView).toBe("trade-monitor");
      dispatchCtrlB();
      expect(useUIStore.getState().activeView).toBe("trade-monitor");
    });

    it("modal overlay does not change active view", () => {
      useUIStore.getState().setView("logs-viewer");
      useUIStore.getState().showModal({ type: "alert", title: "Test" });
      expect(useUIStore.getState().activeView).toBe("logs-viewer");
      useUIStore.getState().dismissModal();
      expect(useUIStore.getState().activeView).toBe("logs-viewer");
    });

    it("back navigation restores correct focus", () => {
      useUIStore.getState().setView("workers");
      useUIStore.getState().setView("service-manager");
      useUIStore.getState().goBack();
      expect(useUIStore.getState().activeView).toBe("workers");
    });
  });

  describe("rapid transitions", () => {
    it("handles rapid sequential view switches across all 16", () => {
      for (const view of ALL_VIEW_IDS) {
        useUIStore.getState().setView(view);
      }
      const lastView = ALL_VIEW_IDS[ALL_VIEW_IDS.length - 1];
      if (lastView === undefined) {
        throw new Error("ALL_VIEW_IDS is empty");
      }
      expect(useUIStore.getState().activeView).toBe(lastView);
    });

    it("handles rapid sidebar toggles", () => {
      for (let i = 0; i < 10; i++) {
        dispatchCtrlB();
      }
      expect(useUIStore.getState().sidebarExpanded).toBe(true);
    });

    it("handles rapid palette open/close", () => {
      for (let i = 0; i < 5; i++) {
        dispatchCtrlP();
        dispatchEscape();
      }
      expect(useUIStore.getState().commandPaletteOpen).toBe(false);
    });

    it("state remains consistent after rapid mixed operations", () => {
      dispatchDigitShortcut("3");
      dispatchCtrlB();
      dispatchCtrlP();
      dispatchDigitShortcut("7");
      dispatchCtrlB();
      expect(useUIStore.getState().commandPaletteOpen).toBe(false);
      expect(useUIStore.getState().activeView).toBe("config-editor");
    });
  });

  describe("view registry completeness", () => {
    it("all 16 views are defined and reachable", () => {
      expect(ALL_VIEW_IDS).toHaveLength(16);
      expect(VIEW_REGISTRY).toHaveLength(16);
    });

    it("digit shortcuts map 1:1 without collision", () => {
      const map = getViewShortcutMap();
      expect(Object.keys(map).length).toBe(10);
      expect(new Set(Object.values(map)).size).toBe(10);
    });

    it("Ctrl+Alt chords map uniquely", () => {
      const map = getCtrlAltViewMap();
      expect(Object.keys(map).length).toBe(6);
      expect(new Set(Object.values(map)).size).toBe(6);
    });

    it("palette view commands cover every ViewId", () => {
      const ids = new Set(getViewPaletteCommands().map((c) => c.id));
      for (const view of ALL_VIEW_IDS) {
        expect(ids.has(view)).toBe(true);
      }
    });

    it("each view ID has a valid type", () => {
      for (const view of ALL_VIEW_IDS) {
        expect(typeof view).toBe("string");
        expect(view.length).toBeGreaterThan(0);
      }
    });
  });

  describe("store isolation", () => {
    it("UI state changes do not affect service state", () => {
      useServiceStore.setState({ connectionStatus: "connected" });

      dispatchDigitShortcut("5");
      dispatchCtrlB();

      expect(useServiceStore.getState().connectionStatus).toBe("connected");
    });

    it("service state changes do not affect UI state", () => {
      useUIStore.getState().setView("workers");

      useServiceStore.setState({ connectionStatus: "polling" });

      expect(useUIStore.getState().activeView).toBe("workers");
    });
  });
});
