/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  parseJsonBody,
  DEFAULT_MAX_JSON_BODY_BYTES,
} from "../../src/middleware/validate";

const SampleSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
});

describe("parseJsonBody", () => {
  it("parses and validates a valid JSON body", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "abc", amount: 1.5 }),
    });
    const result = await parseJsonBody(request, SampleSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ id: "abc", amount: 1.5 });
    }
  });

  it("rejects invalid JSON", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "{not-json",
    });
    const result = await parseJsonBody(request, SampleSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid JSON");
    }
  });

  it("rejects schema mismatches with path details", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ id: "abc", amount: -1 }),
    });
    const result = await parseJsonBody(request, SampleSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("amount");
    }
  });

  it("rejects oversized Content-Length before reading", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(DEFAULT_MAX_JSON_BODY_BYTES + 1),
      },
      body: "{}",
    });
    const result = await parseJsonBody(request, SampleSchema, {
      maxBytes: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too large");
    }
  });

  it("rejects measured body over maxBytes", async () => {
    const big = "x".repeat(200);
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ id: big, amount: 1 }),
    });
    const result = await parseJsonBody(request, SampleSchema, {
      maxBytes: 50,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("too large");
    }
  });
});
