/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useServiceData — Thin typed wrapper over Zustand useServiceStore.
 *
 * Usage: useServiceData(s => s.workers)
 *        useServiceData(s => s.connectionStatus)
 */
import { useServiceStore } from "@hoox-sh/hoox-shared";

export type ServiceStoreState = ReturnType<typeof useServiceStore.getState>;
export type ServiceStoreSelector<T> = (state: ServiceStoreState) => T;

/**
 * Store hook used by {@link useServiceData}. Production points at
 * `useServiceStore`; unit tests may swap this for a pure selector runner
 * via {@link __setServiceStoreHookForTests}.
 */
let storeHook: <T>(selector: ServiceStoreSelector<T>) => T =
  useServiceStore as <T>(selector: ServiceStoreSelector<T>) => T;

/** @internal Test-only seam — pass `null` to restore the real Zustand hook. */
export function __setServiceStoreHookForTests(
  hook: (<T>(selector: ServiceStoreSelector<T>) => T) | null
): void {
  storeHook =
    hook ?? (useServiceStore as <T>(selector: ServiceStoreSelector<T>) => T);
}

export function useServiceData<T>(selector: ServiceStoreSelector<T>): T {
  return storeHook(selector);
}
