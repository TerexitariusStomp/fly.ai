/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useKeyboard — Priority-ordered keyboard handler hook.
 *
 * Registers a keypress handler with a priority. Higher priority handlers
 * run first. Cleans up on unmount.
 *
 * A **single** renderer keypress subscription is shared by all consumers
 * (avoids N× handlers each re-dispatching the full list — O(n²) fires).
 *
 * Priority convention:
 *   0   — Modal/dialog (highest)
 *   10  — View-local shortcuts
 *   50  — App-global shortcuts
 *   100 — Default/passthrough
 */
import { useEffect, useRef } from "react";
import { getRendererRef } from "./renderer-ref";

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  sequence: string;
}

export interface UseKeyboardOptions {
  priority?: number;
  enabled?: boolean;
}

type KeyHandler = (key: KeyEvent) => void;

interface RegisteredHandler {
  handler: KeyHandler;
  priority: number;
}

const globalHandlers: RegisteredHandler[] = [];

/** One shared keypress subscription for the whole process. */
let keyInputCleanup: (() => void) | null = null;

function sortHandlers(): void {
  globalHandlers.sort((a, b) => a.priority - b.priority);
}

function dispatchKey(key: unknown): void {
  // Snapshot so unsubscribes during dispatch cannot skip handlers
  const snapshot = globalHandlers.slice();
  for (const { handler: h } of snapshot) {
    h(key as KeyEvent);
  }
}

function attachKeyInputIfNeeded(): void {
  if (keyInputCleanup) return;
  const renderer = getRendererRef();
  if (!renderer?.keyInput) return;
  const off = renderer.keyInput.on("keypress", dispatchKey);
  keyInputCleanup =
    typeof off === "function"
      ? off
      : () => {
          // OpenTUI may return void; best-effort detach via off if present
          try {
            (
              renderer.keyInput as { off?: (e: string, fn: unknown) => void }
            ).off?.("keypress", dispatchKey);
          } catch {
            // ignore
          }
        };
}

function detachKeyInputIfIdle(): void {
  if (globalHandlers.length > 0 || !keyInputCleanup) return;
  try {
    keyInputCleanup();
  } catch {
    // already torn down
  }
  keyInputCleanup = null;
}

export function registerGlobalHandler(
  handler: KeyHandler,
  priority = 50
): () => void {
  const entry: RegisteredHandler = { handler, priority };
  globalHandlers.push(entry);
  sortHandlers();
  attachKeyInputIfNeeded();
  return () => {
    const idx = globalHandlers.indexOf(entry);
    if (idx >= 0) globalHandlers.splice(idx, 1);
    detachKeyInputIfIdle();
  };
}

export function useKeyboard(
  handler: KeyHandler,
  options: UseKeyboardOptions = {}
): void {
  const { priority = 10, enabled = true } = options;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;

    const wrapped: KeyHandler = (key) => handlerRef.current(key);
    const entry: RegisteredHandler = { handler: wrapped, priority };
    globalHandlers.push(entry);
    sortHandlers();
    attachKeyInputIfNeeded();

    return () => {
      const idx = globalHandlers.indexOf(entry);
      if (idx >= 0) globalHandlers.splice(idx, 1);
      detachKeyInputIfIdle();
    };
  }, [priority, enabled]);
}
