/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared network-layer test doubles for TUI unit tests.
 *
 * Installed once from `test-setup.ts` so `service-store` (and any view that
 * triggers fetchWorkers / SSE) never hits a real API. Controllable via
 * exported state + mocks — no per-file mock.module for api-client / sse.
 */
import { mock } from "bun:test";

/** Fixture workers returned by the default hooxFetch mock. */
export let mockApiData: unknown[] = [];
/** When true, hooxFetch throws. */
export let mockApiShouldFail = false;
export let mockApiErrorMessage = "Network error";

/** Per-subscription SSE entry (supports abort removing the callback). */
export interface SseSubscriptionEntry {
  path: string;
  callback: (data: unknown) => void;
  aborted: boolean;
  abort: () => void;
}

/** Active SSE subscriptions registered by subscribeSSE mock. */
export let sseSubscriptions: SseSubscriptionEntry[] = [];

/** @deprecated Prefer `sseSubscriptions` — flat callback list for emitSseEvent. */
export let sseCallbacks: Array<(data: unknown) => void> = [];

/** Optional delay (ms) applied before hooxFetch resolves/rejects (race tests). */
export let mockApiDelayMs = 0;

export const hooxFetchMock = mock(async (_path: string) => {
  if (mockApiDelayMs > 0) {
    await new Promise((r) => setTimeout(r, mockApiDelayMs));
  }
  if (mockApiShouldFail) {
    throw new Error(mockApiErrorMessage);
  }
  return mockApiData;
});

function pushSubscription(
  path: string,
  callback: (data: unknown) => void
): { abort: () => void } {
  const entry: SseSubscriptionEntry = {
    path,
    callback,
    aborted: false,
    abort: () => {
      entry.aborted = true;
      sseSubscriptions = sseSubscriptions.filter((s) => s !== entry);
      sseCallbacks = sseCallbacks.filter((cb) => cb !== callback);
    },
  };
  sseSubscriptions.push(entry);
  sseCallbacks.push(callback);
  return { abort: entry.abort };
}

export const subscribeSSEMock = mock(
  async <T>(path: string, callback: (data: T) => void) => {
    return pushSubscription(path, callback as (data: unknown) => void);
  }
);

export function resetNetworkDoubles(): void {
  mockApiData = [];
  mockApiShouldFail = false;
  mockApiErrorMessage = "Network error";
  mockApiDelayMs = 0;
  sseSubscriptions = [];
  sseCallbacks = [];
  hooxFetchMock.mockClear();
  subscribeSSEMock.mockClear();
  hooxFetchMock.mockImplementation(async (_path: string) => {
    if (mockApiDelayMs > 0) {
      await new Promise((r) => setTimeout(r, mockApiDelayMs));
    }
    if (mockApiShouldFail) {
      throw new Error(mockApiErrorMessage);
    }
    return mockApiData;
  });
  subscribeSSEMock.mockImplementation(
    async <T>(path: string, callback: (data: T) => void) => {
      return pushSubscription(path, callback as (data: unknown) => void);
    }
  );
}

export function setMockApiData(data: unknown[]): void {
  mockApiData = data;
}

export function setMockApiFailure(
  fail: boolean,
  message = "Network error"
): void {
  mockApiShouldFail = fail;
  mockApiErrorMessage = message;
}

/** Set artificial latency for hooxFetch (race / ordering tests). */
export function setMockApiDelay(ms: number): void {
  mockApiDelayMs = Math.max(0, ms);
}

/**
 * Push an SSE event to active (non-aborted) callbacks.
 * Optionally filter by path prefix (e.g. "/v1/trades").
 */
export function emitSseEvent(data: unknown, pathFilter?: string): void {
  const targets = pathFilter
    ? sseSubscriptions.filter((s) => s.path.includes(pathFilter) && !s.aborted)
    : sseSubscriptions.filter((s) => !s.aborted);
  for (const sub of targets) {
    sub.callback(data);
  }
}

/** Abort every open SSE mock subscription (test isolation helper). */
export function abortAllSseSubscriptions(): void {
  for (const sub of [...sseSubscriptions]) {
    sub.abort();
  }
}
