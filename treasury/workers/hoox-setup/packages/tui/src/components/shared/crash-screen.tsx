/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/** @jsxImportSource @opentui/react */
/**
 * Crash Screen — rendered when an unhandled error escapes all error boundaries.
 *
 * Displays:
 *   - "Something went wrong" banner
 *   - Error message (first line)
 *   - Three action buttons: [Restart] [Safe Mode] [Report Bug]
 *   - Keyboard: R restart · S safe mode · B report bug
 *
 * Colors use Hoox design tokens via @hoox-sh/hoox-shared.
 */
import { useKeyboard } from "@opentui/react";
import { Colors } from "@hoox-sh/hoox-shared";
import { redactSecretsInText } from "../../services/dev-log";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CrashAction = "restart" | "safe-mode" | "report-bug";

export interface CrashScreenProps {
  /** The error that caused the crash */
  error: Error;
  /** Callback for crash action buttons */
  onAction: (action: CrashAction) => void;
  /** Whether we're in safe mode (affects display) */
  safeMode?: boolean;
}

/** Safe, single-line display text for crash UI (secrets scrubbed, length capped). */
export function formatCrashMessage(error: Error, maxLen = 120): string {
  const first = (error.message || "Unknown error").split("\n")[0] ?? "";
  const scrubbed = redactSecretsInText(first).trim() || "Unknown error";
  return scrubbed.length > maxLen
    ? `${scrubbed.slice(0, maxLen - 1)}…`
    : scrubbed;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CrashScreen({
  error,
  onAction,
  safeMode = false,
}: CrashScreenProps) {
  const messageLine = formatCrashMessage(error);
  const secondRaw = error.message.includes("\n")
    ? error.message.split("\n")[1]
    : undefined;
  const secondLine = secondRaw
    ? redactSecretsInText(secondRaw).slice(0, 80)
    : undefined;

  // Keyboard recovery (mouse optional / TUI_MOUSE=0)
  useKeyboard((key) => {
    const name = String(key.name ?? "").toLowerCase();
    if (name === "r" || name === "1") {
      onAction("restart");
      return;
    }
    if (!safeMode && (name === "s" || name === "2")) {
      onAction("safe-mode");
      return;
    }
    if (name === "b" || name === "3") {
      onAction("report-bug");
    }
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      padding={2}
      gap={2}
      backgroundColor={Colors.background}
    >
      {/* ── Banner ───────────────────────────────────────────────────────── */}
      <box
        flexDirection="column"
        alignItems="center"
        border={true}
        borderStyle="double"
        borderColor={Colors.error}
        padding={2}
        gap={1}
        backgroundColor={Colors.card}
      >
        {/* Title */}
        <text fg={Colors.error} bold>
          ╔══════════════════════════════════════╗
        </text>
        <text fg={Colors.error} bold>
          ║ Something went wrong ║
        </text>
        <text fg={Colors.error} bold>
          ╚══════════════════════════════════════╝
        </text>

        {/* Safe mode indicator */}
        {safeMode && (
          <text fg={Colors.warning} bold>
            (Safe Mode — UI only, no API / CLI / SSE)
          </text>
        )}

        {/* Error message (redacted — never show tokens) */}
        <box paddingTop={1} flexDirection="column" alignItems="center">
          <text fg={Colors.muted}>{messageLine}</text>
          {secondLine ? (
            <text fg={Colors.dim} dim>
              {secondLine}
            </text>
          ) : null}
        </box>
      </box>

      {/* ── Action Buttons ───────────────────────────────────────────────── */}
      <box flexDirection="row" gap={2} paddingTop={1}>
        {/* [Restart] — re-initialize the renderer */}
        <box
          border={true}
          borderStyle="single"
          borderColor={Colors.accent}
          paddingLeft={2}
          paddingRight={2}
        >
          <text
            fg={Colors.accent}
            bg={Colors.card}
            onMouseUp={() => onAction("restart")}
          >
            {"  [Restart]  "}
          </text>
        </box>

        {/* [Safe Mode] — start with minimal config */}
        {!safeMode && (
          <box
            border={true}
            borderStyle="single"
            borderColor={Colors.warning}
            paddingLeft={2}
            paddingRight={2}
          >
            <text
              fg={Colors.warning}
              bg={Colors.card}
              onMouseUp={() => onAction("safe-mode")}
            >
              {"  [Safe Mode]  "}
            </text>
          </box>
        )}

        {/* [Report Bug] — write error to file / console */}
        <box
          border={true}
          borderStyle="single"
          borderColor={Colors.muted}
          paddingLeft={2}
          paddingRight={2}
        >
          <text
            fg={Colors.muted}
            bg={Colors.card}
            onMouseUp={() => onAction("report-bug")}
          >
            {"  [Report Bug]  "}
          </text>
        </box>
      </box>

      <text fg={Colors.dim} dim>
        {safeMode
          ? "Keys: R restart · B report bug"
          : "Keys: R restart · S safe mode · B report bug"}
      </text>
    </box>
  );
}
