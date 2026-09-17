/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fail-closed toast helpers.
 *
 * `@opentui-ui/toast@0.0.5` peers on old OpenTUI and often installs a nested
 * `@opentui/core` that re-registers env vars (e.g. OPENTUI_FORCE_WCWIDTH)
 * with a conflicting schema — that hard-crashes `hoox-tui` on global install.
 *
 * We therefore never import `@opentui-ui/toast` at module load. Helpers are
 * pure no-ops (return a stub id). Connection/auth UX uses the status bar
 * and service-store alerts instead.
 */
import { Colors } from "@hoox-sh/hoox-shared";

// ── Types ──────────────────────────────────────────────────────────────────

/** Options that can be passed to any toast helper */
export interface ToastOptions {
  /** Additional description text below the message */
  description?: string;
  /** Auto-dismiss duration in ms (overrides the helper's default) */
  duration?: number;
  /** Whether the toast can be manually dismissed (default: true) */
  dismissible?: boolean;
  /** Action button with label and click handler */
  action?: { label: string; onClick: () => void };
  /** Show a close button on the toast (default: false) */
  closeButton?: boolean;
  /** Optional id when updating an existing toast */
  id?: ToastId;
}

/** Returned toast ID for programmatic control */
export type ToastId = string | number;

// Keep style tokens referenced so callers/tests can still import Colors path
// and so future re-enable of a compatible toast lib has defaults ready.
void Colors;

let toastSeq = 0;
function nextId(): ToastId {
  toastSeq += 1;
  return `toast-noop-${toastSeq}`;
}

// ── Toast helper functions (no-op, fail-closed) ────────────────────────────

/**
 * Show a success toast notification.
 * Currently a no-op (see module doc) — status bar / alerts carry feedback.
 */
export function toastSuccess(
  _message: string,
  _options?: ToastOptions
): ToastId {
  return nextId();
}

/**
 * Show an error toast notification.
 * Currently a no-op (see module doc).
 */
export function toastError(_message: string, _options?: ToastOptions): ToastId {
  return nextId();
}

/**
 * Show a warning toast notification.
 * Currently a no-op (see module doc).
 */
export function toastWarning(
  _message: string,
  _options?: ToastOptions
): ToastId {
  return nextId();
}

/**
 * Show an info toast notification.
 * Currently a no-op (see module doc).
 */
export function toastInfo(_message: string, _options?: ToastOptions): ToastId {
  return nextId();
}

/**
 * Show a persistent loading toast notification.
 * Currently a no-op (see module doc).
 */
export function toastLoading(
  _message: string,
  _options?: Omit<ToastOptions, "duration">
): ToastId {
  return nextId();
}

/**
 * Dismiss a specific toast or all toasts (no-op).
 */
export function dismissToast(_id?: ToastId): void {
  // no-op
}

// ── Clipboard copy feedback ────────────────────────────────────────────────

const COPY_PREVIEW_MAX = 48;

/** Pure message for “copied” toast (testable). */
export function messageCopiedToClipboard(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Copied to clipboard";
  if (oneLine.length <= COPY_PREVIEW_MAX) {
    return `Copied: “${oneLine}”`;
  }
  return `Copied: “${oneLine.slice(0, COPY_PREVIEW_MAX - 1)}…”`;
}

/** Toast after successful clipboard write (selection auto-copy, etc.). */
export function toastCopiedToClipboard(text: string): ToastId {
  const lines = text.split("\n").filter((l) => l.length > 0).length;
  return toastSuccess(messageCopiedToClipboard(text), {
    description: lines > 1 ? `${lines} lines` : undefined,
    duration: 2500,
  });
}

/** Toast when clipboard write fails. */
export function toastCopyFailed(error: string): ToastId {
  return toastError("Copy failed", {
    description: error,
    duration: 5000,
  });
}
