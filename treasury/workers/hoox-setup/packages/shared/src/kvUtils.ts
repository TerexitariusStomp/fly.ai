/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utility functions for KV operations
 * Shared across workers that need KV timestamp logging and parallel I/O
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import { toError } from "./errors";

/**
 * Interface for environments with a KVNamespace binding
 */
export interface EnvWithKV {
  REPORT_KV: KVNamespace;
  [key: string]: unknown;
}

/**
 * Logs a timestamp to KV
 * @param env - Environment with KV binding
 * @param prefix - Optional prefix for the key
 * @returns Promise that resolves when the operation completes
 */
export async function logKvTimestamp(
  env: EnvWithKV,
  prefix: string = "timestamp"
): Promise<void> {
  const timestamp = new Date().toISOString();
  const key = `${prefix}_${timestamp}`;
  try {
    await env.REPORT_KV.put(key, timestamp);
  } catch (error) {
    console.error(
      `Failed to log timestamp to KV: ${toError(error, "Unknown error")}`
    );
  }
}

/**
 * Max keys per Workers KV bulk read (platform limit).
 * @see https://developers.cloudflare.com/kv/api/read-key-value-pairs/
 */
export const KV_BULK_GET_MAX_KEYS = 100;

type BulkKvGet = (
  keys: string[]
) => Promise<Map<string, string | null> | string | null>;

/**
 * Attempt one bulk KV get for `chunk`. Returns ordered values when the
 * runtime returns a Map; otherwise `null` so callers can fall back.
 */
async function tryBulkGetChunk(
  kv: KVNamespace,
  chunk: readonly string[]
): Promise<Array<string | null> | null> {
  try {
    const result = await (kv.get as BulkKvGet)([...chunk]);
    if (!(result instanceof Map)) {
      return null;
    }
    return chunk.map((key) => result.get(key) ?? null);
  } catch {
    return null;
  }
}

/**
 * Parallel / bulk KV gets — prefer over sequential `await kv.get` loops.
 * Order of returned values matches `keys`.
 *
 * Uses native `kv.get(string[])` bulk reads (up to 100 keys per call) when
 * available. Bulk reads count as a single operation against the Workers
 * subrequest limit and avoid simultaneous-connection pressure.
 * Falls back to `Promise.all` of individual gets for mocks / older runtimes.
 */
export async function kvGetMany(
  kv: KVNamespace,
  keys: readonly string[]
): Promise<Array<string | null>> {
  if (keys.length === 0) return [];

  const out: Array<string | null> = new Array(keys.length);
  let offset = 0;

  while (offset < keys.length) {
    const chunk = keys.slice(offset, offset + KV_BULK_GET_MAX_KEYS);
    const bulk = await tryBulkGetChunk(kv, chunk);
    if (bulk === null) {
      // Bulk unsupported (test mock / old runtime) — finish with parallel singles.
      const rest = await Promise.all(
        keys.slice(offset).map((key) => kv.get(key))
      );
      for (let i = 0; i < rest.length; i++) {
        out[offset + i] = rest[i] ?? null;
      }
      return out;
    }
    for (let i = 0; i < bulk.length; i++) {
      out[offset + i] = bulk[i] ?? null;
    }
    offset += chunk.length;
  }

  return out;
}

/**
 * Parallel KV gets as a record keyed by the original key names.
 */
export async function kvGetManyAsRecord(
  kv: KVNamespace,
  keys: readonly string[]
): Promise<Record<string, string | null>> {
  const values = await kvGetMany(kv, keys);
  const out: Record<string, string | null> = {};
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]!] = values[i] ?? null;
  }
  return out;
}

export interface KvPutEntry {
  key: string;
  value: string;
  options?: {
    expirationTtl?: number;
    expiration?: number;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Parallel KV puts — prefer over sequential `await kv.put` loops
 * when writes are independent (no read-modify-write races).
 */
export async function kvPutMany(
  kv: KVNamespace,
  entries: readonly KvPutEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  await Promise.all(
    entries.map((entry) => kv.put(entry.key, entry.value, entry.options))
  );
}

/**
 * Helper function to convert Headers to a plain object
 * @param headers - The Headers object to convert
 * @returns Plain object representation of headers
 */
export function headersToObject(
  headers: Headers | null | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  // Safely iterate through headers
  try {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } catch (error) {
    console.error(
      `Error converting headers to object: ${toError(error, "Unknown error")}`
    );
  }

  return result;
}
