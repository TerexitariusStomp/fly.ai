/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, mock } from "bun:test";
import { safeWaitUntil, waitUntilAll } from "../../src/middleware/wait-until";

function createCtx(): {
  ctx: ExecutionContext;
  waited: Promise<unknown>[];
} {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waited };
}

describe("safeWaitUntil", () => {
  it("registers the promise with waitUntil", async () => {
    const { ctx, waited } = createCtx();
    let done = false;
    safeWaitUntil(
      ctx,
      Promise.resolve().then(() => {
        done = true;
      })
    );
    expect(waited.length).toBe(1);
    await waited[0];
    expect(done).toBe(true);
  });

  it("swallows rejections and invokes onError", async () => {
    const { ctx, waited } = createCtx();
    const onError = mock(() => {});
    safeWaitUntil(ctx, Promise.reject(new Error("bg fail")), onError);
    await waited[0];
    expect(onError.mock.calls.length).toBe(1);
  });
});

describe("waitUntilAll", () => {
  it("is a no-op for empty arrays", () => {
    const { ctx, waited } = createCtx();
    waitUntilAll(ctx, []);
    expect(waited.length).toBe(0);
  });

  it("runs all tasks and reports rejections", async () => {
    const { ctx, waited } = createCtx();
    const onError = mock(() => {});
    let a = false;
    waitUntilAll(
      ctx,
      [
        Promise.resolve().then(() => {
          a = true;
        }),
        Promise.reject(new Error("one failed")),
      ],
      onError
    );
    await waited[0];
    expect(a).toBe(true);
    expect(onError.mock.calls.length).toBe(1);
  });
});
