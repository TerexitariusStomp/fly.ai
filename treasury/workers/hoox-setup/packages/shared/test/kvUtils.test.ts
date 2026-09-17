/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for KV utility functions
 * Run with: bun test packages/shared/test/kvUtils.test.ts
 */

import { describe, test, expect, mock } from "bun:test";
import {
  logKvTimestamp,
  headersToObject,
  kvGetMany,
  kvGetManyAsRecord,
  kvPutMany,
} from "../src/kvUtils";
import type { KVNamespace } from "@cloudflare/workers-types";

type MockFn = ReturnType<typeof mock>;

interface MockKv {
  get: MockFn & ((key: string) => Promise<string | null>);
  put: MockFn &
    ((
      key: string,
      value: string,
      options?: { expirationTtl?: number }
    ) => Promise<void>);
  _store: Map<string, string>;
}

/**
 * Creates a mock KV namespace for testing KV utility functions.
 * Backed by an in-memory store with tracked put/get operations.
 * Returns a combined type that satisfies both test assertions and KVNamespace compatibility.
 */
function createMockKv(options?: { bulk?: boolean }): MockKv {
  const store = new Map<string, string>();
  const useBulk = options?.bulk === true;
  return {
    get: mock(
      (
        key: string | string[]
      ): Promise<string | null | Map<string, string | null>> => {
        // Native bulk API path: get(string[]) => Map
        if (Array.isArray(key)) {
          if (!useBulk) {
            // Simulate older / single-key-only bindings
            throw new TypeError("KV bulk get not supported in this mock");
          }
          const map = new Map<string, string | null>();
          for (const k of key) {
            map.set(k, store.get(k) ?? null);
          }
          return Promise.resolve(map);
        }
        return Promise.resolve(store.get(key) ?? null);
      }
    ) as MockKv["get"],
    put: mock(
      (
        key: string,
        value: string,
        _options?: { expirationTtl?: number }
      ): Promise<void> => {
        store.set(key, value);
        return Promise.resolve();
      }
    ) as MockKv["put"],
    _store: store,
  };
}

describe("KV Utilities", () => {
  describe("logKvTimestamp", () => {
    test("writes to KV with correct key format", async () => {
      const kv = createMockKv();
      const env = { REPORT_KV: kv as unknown as KVNamespace };

      await logKvTimestamp(env, "test-prefix");

      // Verify put was called
      expect(kv.put.mock.calls.length).toBe(1);

      // Key format should be: {prefix}_{ISO timestamp}
      const putCall = kv.put.mock.calls[0];
      if (!putCall) throw new Error("expected KV put call");
      const putKey = putCall[0] as string;
      expect(putKey).toStartWith("test-prefix_");

      // Value should be a valid ISO timestamp
      const putValue = putCall[1] as string;
      expect(() => new Date(putValue)).not.toThrow();
      expect(new Date(putValue).toISOString()).toBe(putValue);
    });

    test("uses default prefix 'timestamp' when not specified", async () => {
      const kv = createMockKv();
      const env = { REPORT_KV: kv as unknown as KVNamespace };

      await logKvTimestamp(env);

      // Should use default prefix "timestamp"
      const putCall = kv.put.mock.calls[0];
      if (!putCall) throw new Error("expected KV put call");
      const putKey = putCall[0] as string;
      expect(putKey).toStartWith("timestamp_");
    });

    test("handles KV put errors gracefully", async () => {
      const errorKv = {
        get: mock(() => Promise.resolve(null)),
        put: mock(() => Promise.reject(new Error("KV write failed"))),
      };
      const env = { REPORT_KV: errorKv as unknown as KVNamespace };

      // Should not throw despite put rejection
      await expect(logKvTimestamp(env, "error-test")).resolves.toBeUndefined();

      // Verify put was attempted
      expect(errorKv.put.mock.calls.length).toBe(1);
    });
  });

  describe("headersToObject", () => {
    test("converts Headers to plain object", () => {
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-Custom-Header": "test-value",
        Authorization: "Bearer token123",
      });

      const obj = headersToObject(headers);

      // Headers are normalized to lowercase by the Headers API
      expect(obj["content-type"]).toBe("application/json");
      expect(obj["x-custom-header"]).toBe("test-value");
      expect(obj["authorization"]).toBe("Bearer token123");
    });

    test("handles null input (returns {})", () => {
      const obj = headersToObject(null);
      expect(obj).toEqual({});
    });

    test("handles undefined input (returns {})", () => {
      const obj = headersToObject(undefined);
      expect(obj).toEqual({});
    });

    test("handles empty Headers object", () => {
      const headers = new Headers();
      const obj = headersToObject(headers);
      expect(obj).toEqual({});
    });

    test("preserves all header entries", () => {
      const headers = new Headers([
        ["X-One", "1"],
        ["X-Two", "2"],
        ["X-Three", "3"],
      ]);

      const obj = headersToObject(headers);

      expect(Object.keys(obj).length).toBe(3);
      expect(obj["x-one"]).toBe("1");
      expect(obj["x-two"]).toBe("2");
      expect(obj["x-three"]).toBe("3");
    });
  });

  describe("kvGetMany / kvPutMany", () => {
    test("kvGetMany returns values in key order (Promise.all fallback)", async () => {
      const kv = createMockKv();
      kv._store.set("a", "1");
      kv._store.set("c", "3");
      const values = await kvGetMany(kv as unknown as KVNamespace, [
        "a",
        "b",
        "c",
      ]);
      expect(values).toEqual(["1", null, "3"]);
      // Fallback: one get per key after bulk attempt fails
      expect(kv.get.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    test("kvGetMany uses native bulk get when Map is returned", async () => {
      const kv = createMockKv({ bulk: true });
      kv._store.set("a", "1");
      kv._store.set("c", "3");
      const values = await kvGetMany(kv as unknown as KVNamespace, [
        "a",
        "b",
        "c",
      ]);
      expect(values).toEqual(["1", null, "3"]);
      // Single bulk call for ≤100 keys
      expect(kv.get.mock.calls.length).toBe(1);
      expect(Array.isArray(kv.get.mock.calls[0]?.[0])).toBe(true);
    });

    test("kvGetMany returns empty array for empty keys", async () => {
      const kv = createMockKv();
      const values = await kvGetMany(kv as unknown as KVNamespace, []);
      expect(values).toEqual([]);
      expect(kv.get.mock.calls.length).toBe(0);
    });

    test("kvGetManyAsRecord maps keys to values", async () => {
      const kv = createMockKv({ bulk: true });
      kv._store.set("x", "y");
      const record = await kvGetManyAsRecord(kv as unknown as KVNamespace, [
        "x",
        "missing",
      ]);
      expect(record).toEqual({ x: "y", missing: null });
    });

    test("kvPutMany writes all entries in parallel", async () => {
      const kv = createMockKv();
      await kvPutMany(kv as unknown as KVNamespace, [
        { key: "k1", value: "v1" },
        { key: "k2", value: "v2", options: { expirationTtl: 60 } },
      ]);
      expect(kv.put.mock.calls.length).toBe(2);
      expect(kv._store.get("k1")).toBe("v1");
      expect(kv._store.get("k2")).toBe("v2");
    });

    test("kvPutMany is a no-op for empty entries", async () => {
      const kv = createMockKv();
      await kvPutMany(kv as unknown as KVNamespace, []);
      expect(kv.put.mock.calls.length).toBe(0);
    });
  });
});
