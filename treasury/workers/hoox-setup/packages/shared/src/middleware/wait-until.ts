/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production helpers around ExecutionContext / DurableObjectState.waitUntil.
 *
 * Floating / rejected background promises are a common Workers footgun:
 * the isolate may exit before work finishes, and rejections can go unhandled.
 * Always pass promises through these helpers (or await them).
 *
 * Never destructure `waitUntil` off `ctx` — it loses `this` and throws
 * "Illegal invocation" at runtime.
 *
 * Accepts any object with waitUntil so the same helper works for both
 * fetch ExecutionContext and DurableObjectState (DO lifecycle).
 */

/** Minimal surface shared by ExecutionContext and DurableObjectState. */
export type WaitUntilHost = {
  waitUntil(promise: Promise<unknown>): void;
};

/**
 * Schedule background work that must not affect the HTTP response.
 * Captures rejections so they never become unhandled promise rejections.
 */
export function safeWaitUntil(
  ctx: WaitUntilHost,
  promise: Promise<unknown>,
  onError?: (err: unknown) => void
): void {
  ctx.waitUntil(
    promise.catch((err: unknown) => {
      onError?.(err);
      console.error(
        JSON.stringify({
          message: "waitUntil background task failed",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    })
  );
}

/**
 * Fan-out multiple independent background tasks via a single waitUntil.
 * Uses allSettled so one failure does not cancel siblings.
 */
export function waitUntilAll(
  ctx: WaitUntilHost,
  promises: ReadonlyArray<Promise<unknown>>,
  onError?: (err: unknown) => void
): void {
  if (promises.length === 0) return;
  safeWaitUntil(
    ctx,
    Promise.allSettled(promises).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          onError?.(result.reason);
          console.error(
            JSON.stringify({
              message: "waitUntilAll background task failed",
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            })
          );
        }
      }
    }),
    onError
  );
}
