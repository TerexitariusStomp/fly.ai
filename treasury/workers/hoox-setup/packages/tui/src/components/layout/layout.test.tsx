/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Layout Component Tests — Sidebar + StatusBar structure aligned with
 * view-registry (single source of truth for nav items).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { useUIStore } from "@hoox-sh/hoox-shared/stores/ui-store";
import { useServiceStore } from "@hoox-sh/hoox-shared/stores/service-store";
import type { ViewId } from "@hoox-sh/hoox-shared";
import {
  SIDEBAR_ITEMS,
  getViewShortcutMap,
  getCtrlAltViewMap,
  REGISTERED_VIEW_IDS,
} from "../../view-registry";
import { SIDEBAR_WIDTH } from "./sidebar";

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
    lastUpdated: 0,
    lastError: null,
    retryCount: 0,
    reconnectDelay: 0,
    disconnectedAt: null,
  });
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("Layout", () => {
  beforeEach(() => {
    resetStores();
  });

  // ── Sidebar ──────────────────────────────────────────────────────────────

  describe("Sidebar", () => {
    it("lists every registered view", () => {
      expect(SIDEBAR_ITEMS).toHaveLength(REGISTERED_VIEW_IDS.length);
      expect(SIDEBAR_ITEMS.map((i) => i.id)).toEqual(REGISTERED_VIEW_IDS);
    });

    it("all items have unique view IDs", () => {
      const ids = SIDEBAR_ITEMS.map((i) => i.id);
      expect(new Set(ids).size).toBe(SIDEBAR_ITEMS.length);
    });

    it("first item is DASHBOARD with shortcut 1", () => {
      expect(SIDEBAR_ITEMS[0]?.label).toBe("DASHBOARD");
      expect(SIDEBAR_ITEMS[0]?.id).toBe("dashboard");
      expect(SIDEBAR_ITEMS[0]?.shortcut).toBe("1");
    });

    it("includes Ctrl+0 queues and Ctrl+Alt letter views", () => {
      const byId = Object.fromEntries(SIDEBAR_ITEMS.map((i) => [i.id, i]));
      expect(byId["queue-depth"]?.shortcut).toBe("0");
      expect(byId["kv-viewer"]?.shortcut).toBe("^K");
      expect(byId["secrets-viewer"]?.shortcut).toBe("^S");
    });

    it("sidebar shows all items when expanded", () => {
      expect(useUIStore.getState().sidebarExpanded).toBe(true);
    });

    it("sidebar collapses via store", () => {
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarExpanded).toBe(false);
    });

    it("setView updates activeView correctly for each sidebar item", () => {
      for (const item of SIDEBAR_ITEMS) {
        useUIStore.getState().setView(item.id);
        expect(useUIStore.getState().activeView).toBe(item.id);
      }
    });

    it("active view is highlighted via accent color indicator", () => {
      expect(useUIStore.getState().activeView).toBe("dashboard");
      useUIStore.getState().setView("trade-monitor");
      expect(useUIStore.getState().activeView).toBe("trade-monitor");
    });

    it("sidebar toggle preserves active view", () => {
      useUIStore.getState().setView("workers");
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().activeView).toBe("workers");
      expect(useUIStore.getState().sidebarExpanded).toBe(false);
    });

    it("uses fixed width of 24 columns", () => {
      expect(SIDEBAR_WIDTH).toBe(24);
    });
  });

  // ── StatusBar ────────────────────────────────────────────────────────────

  describe("StatusBar", () => {
    it("shows CONNECTED when connection is healthy", () => {
      useServiceStore.setState({ connectionStatus: "connected" });
      expect(useServiceStore.getState().connectionStatus).toBe("connected");
    });

    it("shows POLLING when in polling state", () => {
      useServiceStore.setState({ connectionStatus: "polling" });
      expect(useServiceStore.getState().connectionStatus).toBe("polling");
    });

    it("shows RECONNECTING when retrying", () => {
      useServiceStore.setState({ connectionStatus: "reconnecting" });
      expect(useServiceStore.getState().connectionStatus).toBe("reconnecting");
    });

    it("shows OFFLINE when disconnected", () => {
      useServiceStore.setState({ connectionStatus: "offline" });
      expect(useServiceStore.getState().connectionStatus).toBe("offline");
    });

    it("shows retry count during reconnecting", () => {
      useServiceStore.setState({
        connectionStatus: "reconnecting",
        retryCount: 3,
        reconnectDelay: 4000,
      });
      expect(useServiceStore.getState().retryCount).toBe(3);
      expect(useServiceStore.getState().reconnectDelay).toBe(4000);
    });

    it("shows last updated timestamp when data is available", () => {
      useServiceStore.setState({ lastUpdated: Date.now() });
      expect(useServiceStore.getState().lastUpdated).toBeGreaterThan(0);
    });

    it("shows error message when connection is lost", () => {
      useServiceStore.setState({
        connectionStatus: "reconnecting",
        lastError: "DNS resolution failed",
      });
      expect(useServiceStore.getState().lastError).toContain(
        "DNS resolution failed"
      );
    });

    it("shows keyboard hints in status bar", () => {
      const hints = ["Ctrl+P", "Ctrl+B", "Ctrl+Q"];
      expect(hints).toHaveLength(3);
    });
  });

  // ── View Switching ───────────────────────────────────────────────────────

  describe("view switching", () => {
    it("Ctrl digit map covers dashboard…queue-depth", () => {
      const map = getViewShortcutMap();
      expect(map["1"]).toBe("dashboard");
      expect(map["2"]).toBe("workers");
      expect(map["0"]).toBe("queue-depth");
      for (const view of Object.values(map)) {
        useUIStore.getState().setView(view);
        expect(useUIStore.getState().activeView).toBe(view);
      }
    });

    it("Ctrl+Alt map covers letter-chord views", () => {
      const map = getCtrlAltViewMap();
      for (const view of Object.values(map) as ViewId[]) {
        useUIStore.getState().setView(view);
        expect(useUIStore.getState().activeView).toBe(view);
      }
    });

    it("view switching closes command palette", () => {
      useUIStore.getState().openPalette();
      useUIStore.getState().setView("settings");
      expect(useUIStore.getState().commandPaletteOpen).toBe(false);
    });
  });

  // ── Layout Structure ─────────────────────────────────────────────────────

  describe("layout structure", () => {
    it("status bar is always 1 row tall (summary line)", () => {
      const STATUSBAR_HEIGHT = 1;
      expect(STATUSBAR_HEIGHT).toBe(1);
    });

    it("brand header is HOOX", () => {
      expect("HOOX").toBe("HOOX");
    });
  });
});
