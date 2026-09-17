/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell overlay helpers — command palette / quit modal ownership of keys.
 * View-local keyboard handlers should no-op while an overlay is open so
 * typing in the palette (or confirming quit) does not fire view shortcuts.
 */
import { useKeyboard } from "@opentui/react";
import { useUIStore } from "@hoox-sh/hoox-shared";
import { isHooxDialogOpen } from "../components/ui/dialog-state";

/** True when palette, UI modal, or in-house DialogProvider owns the keyboard. */
export function isShellOverlayOpen(): boolean {
  const s = useUIStore.getState();
  return Boolean(s.commandPaletteOpen || s.modal || isHooxDialogOpen());
}

/** Key shape from OpenTUI; fields optional at the type boundary. */
export type ViewKeyEvent = {
  name?: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
  /** Some OpenTUI builds expose the raw character as `raw`. */
  raw?: string;
};

/**
 * View-scoped keyboard hook: skips the handler while shell overlays are open.
 * Drop-in for `@opentui/react` `useKeyboard` in primary views.
 */
export function useViewKeyboard(handler: (key: ViewKeyEvent) => void): void {
  useKeyboard((key) => {
    if (isShellOverlayOpen()) return;
    handler(key as ViewKeyEvent);
  });
}
