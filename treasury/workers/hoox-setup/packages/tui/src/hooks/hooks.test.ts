/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook unit tests — renderer ref, global keyboard registration, polling helpers.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "bun:test";
import {
  setRendererRef,
  getRendererRef,
  registerGlobalHandler,
  computePollingBackoff,
  createPollingController,
  POLLING_MAX_BACKOFF_MS,
} from "./index";
import type { KeyEvent } from "./use-keyboard";

describe("renderer-ref", () => {
  afterEach(() => {
    setRendererRef(null);
  });

  it("stores and returns the renderer singleton", () => {
    const fake = {
      id: "renderer",
    } as unknown as import("@opentui/core").CliRenderer;
    setRendererRef(fake);
    expect(getRendererRef()).toBe(fake);
  });

  it("clears when set to null", () => {
    setRendererRef({} as import("@opentui/core").CliRenderer);
    setRendererRef(null);
    expect(getRendererRef()).toBeNull();
  });
});

describe("registerGlobalHandler", () => {
  beforeEach(() => {
    // Ensure no renderer → attach is a no-op; handlers still register
    setRendererRef(null);
  });

  afterEach(() => {
    setRendererRef(null);
  });

  it("registers and unregisters without throwing", () => {
    const calls: string[] = [];
    const unsub = registerGlobalHandler((key: KeyEvent) => {
      calls.push(key.name);
    }, 10);
    expect(typeof unsub).toBe("function");
    unsub();
    expect(calls).toEqual([]);
  });

  it("multiple handlers can register and all unsubscribe cleanly", () => {
    const a = registerGlobalHandler(() => {}, 0);
    const b = registerGlobalHandler(() => {}, 50);
    const c = registerGlobalHandler(() => {}, 100);
    a();
    b();
    c();
  });

  it("dispatches keypresses in priority order when renderer is attached", () => {
    const order: number[] = [];
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const keyInput = {
      on: (event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
        return () => listeners.get(event)?.delete(fn);
      },
      off: (event: string, fn: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(fn);
      },
    };
    setRendererRef({
      keyInput,
    } as unknown as import("@opentui/core").CliRenderer);

    const unsubHigh = registerGlobalHandler(() => {
      order.push(0);
    }, 0);
    const unsubMid = registerGlobalHandler(() => {
      order.push(10);
    }, 10);
    const unsubLow = registerGlobalHandler(() => {
      order.push(50);
    }, 50);

    const handlers = listeners.get("keypress");
    expect(handlers?.size).toBe(1);
    for (const h of handlers ?? []) {
      h({
        name: "a",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
        sequence: "a",
      });
    }
    expect(order).toEqual([0, 10, 50]);

    unsubHigh();
    unsubMid();
    unsubLow();
    // Last unsubscribe detaches key input
    expect(listeners.get("keypress")?.size ?? 0).toBe(0);
  });

  it("snapshot protects against unsubscribe mid-dispatch", () => {
    const seen: string[] = [];
    let unsubB: (() => void) | null = null;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const keyInput = {
      on: (event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
        return () => listeners.get(event)?.delete(fn);
      },
      off: () => {},
    };
    setRendererRef({
      keyInput,
    } as unknown as import("@opentui/core").CliRenderer);

    const unsubA = registerGlobalHandler(() => {
      seen.push("a");
      unsubB?.();
    }, 0);
    unsubB = registerGlobalHandler(() => {
      seen.push("b");
    }, 1);

    for (const h of listeners.get("keypress") ?? []) {
      h({
        name: "x",
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
        sequence: "x",
      });
    }
    // Snapshot ensures b still runs even though unsub mid-dispatch
    expect(seen).toEqual(["a", "b"]);
    unsubA();
  });

  it("attaches when on() returns non-function (off fallback path)", () => {
    let offCalled = false;
    const keyInput = {
      on: () => undefined,
      off: () => {
        offCalled = true;
      },
    };
    setRendererRef({
      keyInput,
    } as unknown as import("@opentui/core").CliRenderer);
    const unsub = registerGlobalHandler(() => {}, 5);
    unsub();
    expect(offCalled).toBe(true);
  });
});

describe("computePollingBackoff", () => {
  it("caps exponential backoff at 16s", () => {
    const base = 1000;
    for (let retry = 0; retry < 10; retry++) {
      const backoff = computePollingBackoff(base, retry);
      expect(backoff).toBeLessThanOrEqual(POLLING_MAX_BACKOFF_MS);
    }
    expect(computePollingBackoff(base, 10)).toBe(POLLING_MAX_BACKOFF_MS);
  });

  it("doubles per retry until cap", () => {
    expect(computePollingBackoff(500, 0)).toBe(500);
    expect(computePollingBackoff(500, 1)).toBe(1000);
    expect(computePollingBackoff(500, 2)).toBe(2000);
    expect(computePollingBackoff(500, 3)).toBe(4000);
  });

  it("respects custom max backoff", () => {
    expect(computePollingBackoff(1000, 5, 3000)).toBe(3000);
  });
});

describe("createPollingController", () => {
  /** Flush microtasks after advancing fake timers (Bun has no advanceTimersByTimeAsync). */
  async function advance(ms: number): Promise<void> {
    jest.advanceTimersByTime(ms);
    // Drain promise chains scheduled by timer callbacks
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("invokes callback immediately when immediate=true", async () => {
    let calls = 0;
    const ctrl = createPollingController({
      getCallback: () => async () => {
        calls++;
      },
      getIntervalMs: () => 1000,
      immediate: true,
    });
    ctrl.start();
    // Let the microtask from the immediate poll resolve
    await Promise.resolve();
    expect(calls).toBe(1);
    ctrl.stop();
  });

  it("defers first poll when immediate=false", async () => {
    let calls = 0;
    const ctrl = createPollingController({
      getCallback: () => async () => {
        calls++;
      },
      getIntervalMs: () => 500,
      immediate: false,
    });
    ctrl.start();
    await Promise.resolve();
    expect(calls).toBe(0);
    await advance(500);
    expect(calls).toBe(1);
    ctrl.stop();
  });

  it("increments retry count on failure and resets on success", async () => {
    let shouldFail = true;
    const ctrl = createPollingController({
      getCallback: () => async () => {
        if (shouldFail) throw new Error("boom");
      },
      getIntervalMs: () => 100,
      immediate: true,
    });
    ctrl.start();
    await Promise.resolve();
    expect(ctrl.getRetryCount()).toBe(1);

    // Next scheduled poll after backoff 100 * 2^1 = 200
    shouldFail = false;
    await advance(200);
    expect(ctrl.getRetryCount()).toBe(0);
    ctrl.stop();
  });

  it("stop prevents further polls after pending timeout", async () => {
    let calls = 0;
    const ctrl = createPollingController({
      getCallback: () => async () => {
        calls++;
      },
      getIntervalMs: () => 1000,
      immediate: true,
    });
    ctrl.start();
    await Promise.resolve();
    expect(calls).toBe(1);
    ctrl.stop();
    await advance(10_000);
    expect(calls).toBe(1);
  });

  it("reads fresh interval on each iteration", async () => {
    let interval = 100;
    let calls = 0;
    const ctrl = createPollingController({
      getCallback: () => async () => {
        calls++;
      },
      getIntervalMs: () => interval,
      immediate: true,
    });
    ctrl.start();
    await Promise.resolve();
    expect(calls).toBe(1);
    interval = 250;
    // Next poll was scheduled at previous interval (100); after it runs,
    // subsequent delay uses the new interval.
    await advance(100);
    expect(calls).toBe(2);
    await advance(249);
    expect(calls).toBe(2);
    await advance(1);
    expect(calls).toBe(3);
    ctrl.stop();
  });

  it("stop during in-flight callback does not schedule next poll", async () => {
    let resolveCb!: () => void;
    let calls = 0;
    const ctrl = createPollingController({
      getCallback: () => () =>
        new Promise<void>((resolve) => {
          calls++;
          resolveCb = resolve;
        }),
      getIntervalMs: () => 100,
      immediate: true,
    });
    ctrl.start();
    await Promise.resolve();
    expect(calls).toBe(1);
    ctrl.stop();
    resolveCb();
    await Promise.resolve();
    await advance(1000);
    expect(calls).toBe(1);
  });
});

describe("useServiceData", () => {
  afterEach(async () => {
    const { __setServiceStoreHookForTests } =
      await import("./use-service-data");
    __setServiceStoreHookForTests(null);
  });

  it("applies the selector via the store hook", async () => {
    const { useServiceData, __setServiceStoreHookForTests } =
      await import("./use-service-data");
    const { useServiceStore } = await import("@hoox-sh/hoox-shared");
    const snapshot = useServiceStore.getState();

    __setServiceStoreHookForTests((selector) => selector(snapshot));

    const status = useServiceData((s) => s.connectionStatus);
    expect(status).toBe(snapshot.connectionStatus);

    const workers = useServiceData((s) => s.workers);
    expect(workers).toBe(snapshot.workers);
  });

  it("restores real store hook after null reset", async () => {
    const { useServiceData, __setServiceStoreHookForTests } =
      await import("./use-service-data");
    __setServiceStoreHookForTests((() => "injected") as never);
    expect(useServiceData((() => "x") as never) as unknown).toBe("injected");
    __setServiceStoreHookForTests(null);
    // Real hook throws outside React — proves restore happened
    expect(() => useServiceData((s) => s.connectionStatus)).toThrow();
  });

  it("is re-exported from hooks index", async () => {
    const mod = await import("./index");
    expect(typeof mod.useServiceData).toBe("function");
  });
});
