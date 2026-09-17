/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/** @jsxImportSource @opentui/react */
/**
 * ActionBar Component — Footer bar with action buttons
 * and unsaved changes counter.
 */
import { Colors } from "@hoox-sh/hoox-shared";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActionBarProps {
  unsavedCount: number;
  hasSelectedFile: boolean;
  hasErrors: boolean;
  onSave: () => void;
  onValidate: () => void;
  onDiff: () => void;
  onFormat: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ActionBar({
  unsavedCount,
  hasSelectedFile,
  hasErrors,
  onSave,
  onValidate,
  onDiff,
  onFormat,
}: ActionBarProps) {
  const disabledColor = Colors.dim;
  const enabledColor = Colors.foreground;
  const accentColor = Colors.accent;
  // Fail-closed UX: cannot click Save when local syntax errors exist.
  const canSave = hasSelectedFile && unsavedCount > 0 && !hasErrors;

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Action buttons */}
      <box flexDirection="row" gap={2}>
        <text
          fg={canSave ? accentColor : disabledColor}
          bold={canSave}
          dim={!canSave}
          onMouseUp={canSave ? onSave : undefined}
        >
          [Save]
        </text>
        <text
          fg={hasSelectedFile ? accentColor : disabledColor}
          bold={hasSelectedFile}
          dim={!hasSelectedFile}
          onMouseUp={onValidate}
        >
          [Validate]
        </text>
        <text
          fg={
            hasSelectedFile && unsavedCount > 0 ? enabledColor : disabledColor
          }
          dim={!hasSelectedFile || unsavedCount === 0}
          onMouseUp={onDiff}
        >
          [Diff]
        </text>
        <text
          fg={hasSelectedFile ? enabledColor : disabledColor}
          dim={!hasSelectedFile}
          onMouseUp={onFormat}
        >
          [Format]
        </text>
      </box>

      {/* Unsaved changes counter */}
      <box flexDirection="row" gap={1}>
        {unsavedCount > 0 && (
          <text fg={Colors.warning} bold>
            ⚡ {unsavedCount} unsaved change{unsavedCount > 1 ? "s" : ""}
          </text>
        )}
        {unsavedCount === 0 && hasSelectedFile && (
          <text fg={Colors.success} dim>
            ✓ Saved
          </text>
        )}
      </box>
    </box>
  );
}
