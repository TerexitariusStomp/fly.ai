/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect } from "react";
import {
  Colors,
  AlertSeverityColor,
  useServiceStore,
  useUIStore,
} from "@hoox-sh/hoox-shared";
import type { AlertSeverity } from "@hoox-sh/hoox-shared";
import { useViewKeyboard } from "../../../hooks/shell-overlay";

/** Severity label prefix */
const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "INFO",
  warning: "WARN",
  error: "ERR",
  critical: "CRIT",
};

/** Maximum alerts shown in the panel */
const MAX_VISIBLE_ALERTS = 50;

/**
 * Format a timestamp (ms) to HH:MM:SS for alert display.
 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return [
    d.getHours().toString().padStart(2, "0"),
    d.getMinutes().toString().padStart(2, "0"),
    d.getSeconds().toString().padStart(2, "0"),
  ].join(":");
}

/**
 * AlertsPanel — scrollable list of recent alerts, newest first.
 * Each alert row shows: [SEV] HH:MM:SS — message
 * Color-coded by severity.
 *
 * Keyboard (when Dashboard is active):
 *   ↑↓     — move selection
 *   Enter / Space — acknowledge selected
 *   x / Delete  — dismiss (remove) selected
 */
function AlertsPanel() {
  const alerts = useServiceStore((s) => s.alerts);
  const activeView = useUIStore((s) => s.activeView);
  const isActive = activeView === "dashboard";
  const [scrollOffset, setScrollOffset] = useState(0);

  // Newest first, limited
  const sortedAlerts = useMemo(() => {
    return [...alerts]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_VISIBLE_ALERTS);
  }, [alerts]);

  // Clamp selection when the alert list shrinks (ack/dismiss/race)
  useEffect(() => {
    setScrollOffset((o) => Math.min(o, Math.max(0, sortedAlerts.length - 1)));
  }, [sortedAlerts.length]);

  useViewKeyboard((key) => {
    if (!isActive) return;
    const name = String(key.name ?? "").toLowerCase();

    if (name === "up") {
      setScrollOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (name === "down") {
      setScrollOffset((o) =>
        Math.min(Math.max(0, sortedAlerts.length - 1), o + 1)
      );
      return;
    }

    const selected = sortedAlerts[scrollOffset];
    if (!selected) return;

    if (name === "return" || name === "enter" || name === "space") {
      useServiceStore.getState().acknowledgeAlert(selected.id);
      return;
    }
    if (name === "x" || name === "delete" || name === "backspace") {
      useServiceStore.getState().dismissAlert(selected.id);
      setScrollOffset((o) =>
        Math.max(0, o - (o > 0 && o >= sortedAlerts.length - 1 ? 1 : 0))
      );
    }
  });

  return (
    <box flexDirection="column">
      {/* Section label */}
      <box>
        <text fg={Colors.foreground} bold dim>
          ALERTS
        </text>
      </box>

      {sortedAlerts.length === 0 ? (
        <box paddingTop={1}>
          <text fg={Colors.muted} dim>
            No alerts
          </text>
        </box>
      ) : (
        <scrollbox
          width="100%"
          height={8}
          border={true}
          borderStyle="single"
          borderColor={Colors.border}
          paddingX={1}
          paddingY={0}
        >
          {sortedAlerts.map((alert, i) => {
            const color = AlertSeverityColor[alert.severity];
            const label = SEVERITY_LABEL[alert.severity];
            const isCritical = alert.severity === "critical";
            const isSelected = i === scrollOffset;

            return (
              <box
                key={alert.id}
                flexDirection="row"
                gap={1}
                backgroundColor={isSelected ? Colors.card : undefined}
              >
                {/* Severity badge */}
                <text fg={color} bold={isCritical} dim={!isCritical}>
                  [{label}]
                </text>

                {/* Timestamp */}
                <text fg={Colors.muted} dim>
                  {formatTime(alert.timestamp)}
                </text>

                {/* Divider */}
                <text fg={Colors.dim} dim>
                  —
                </text>

                {/* Message */}
                <text fg={color} bold={isCritical} dim={alert.acknowledged}>
                  {alert.message.length > 60
                    ? alert.message.slice(0, 57) + "…"
                    : alert.message}
                </text>

                {/* Acknowledged marker */}
                {alert.acknowledged && (
                  <text fg={Colors.dim} dim>
                    ✓
                  </text>
                )}
              </box>
            );
          })}
        </scrollbox>
      )}

      {/* Scroll / action hint */}
      {sortedAlerts.length > 0 && (
        <box>
          <text fg={Colors.dim} dim>
            ↑↓ · Enter:ack · x:dismiss · {scrollOffset + 1}/
            {sortedAlerts.length}
          </text>
        </box>
      )}
    </box>
  );
}

export { AlertsPanel };
