/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/** @jsxImportSource @opentui/react */
/**
 * SelectModal — keyboard-navigable option picker via in-house DialogHandle.
 * Does not depend on @opentui-ui/dialog (nested OpenTUI crash on global install).
 */
import type { DialogHandle } from "./dialog";
import { showChoice } from "./dialog";

// ── Types ──────────────────────────────────────────────────────────────────

/** A single selectable option */
export interface SelectOption {
  /** Unique key for the option */
  key: string;
  /** Display label shown in the list */
  label: string;
  /** Optional description rendered dimmed below or beside the label */
  description?: string;
}

/** Options for the SelectModal */
export interface SelectModalOptions {
  /** Title displayed at the top of the modal (bold, accent-colored) */
  title: string;
  /** Array of selectable options */
  options: SelectOption[];
  /** Whether clicking outside the modal dismisses it (default: true) */
  closeOnClickOutside?: boolean;
}

/**
 * Show a modal select dialog with keyboard navigation.
 * Returns the selected option's `key`, or `undefined` if dismissed.
 */
export async function showSelectModal(
  dialog: DialogHandle,
  opts: SelectModalOptions
): Promise<string | undefined> {
  return showChoice(dialog, {
    title: opts.title,
    choices: opts.options,
    closeOnClickOutside: opts.closeOnClickOutside ?? true,
  });
}
