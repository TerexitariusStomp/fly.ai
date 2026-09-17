/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBatch, Message } from "@cloudflare/workers-types";

export interface QueueHandlerOptions<T> {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Array of delay times in seconds for exponential backoff */
  backoffDelays: number[];
  /** Handler function called for each message */
  onMessage: (message: T, attemptNumber: number) => Promise<unknown> | unknown;
  /** Called when a message fails and will be retried */
  onRetry?: (
    message: T,
    attemptNumber: number,
    error: string,
    delaySeconds: number
  ) => void | Promise<void>;
  /** Called when message is moved to DLQ (max retries exceeded) */
  onDLQ?: (
    message: T,
    attemptNumber: number,
    error: string
  ) => void | Promise<void>;
  /** Logger function for debugging */
  logger?: {
    info(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
  };
  /**
   * Max number of messages to process concurrently within a batch.
   * Defaults to 1 (serial) for back-compat. Values < 1 are treated as 1.
   */
  concurrency?: number;
}

/**
 * Process items with a bounded worker pool. Preserves per-item error isolation
 * when `fn` catches internally; failures in `fn` reject the returned promise.
 */
async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  const limit = Math.min(Math.max(1, concurrency), items.length);
  if (limit === 1) {
    for (const item of items) {
      await fn(item);
    }
    return;
  }

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
}

/**
 * Creates a reusable queue handler with retry + exponential backoff logic.
 *
 * Usage:
 * ```typescript
 * const handler = createQueueHandler({
 *   maxRetries: 5,
 *   backoffDelays: [0, 30, 60, 300, 900],
 *   concurrency: 4, // optional; default 1 (serial)
 *   onMessage: async (msg) => {
 *     await executeTask(msg);
 *   },
 *   onDLQ: async (msg, attempts, error) => {
 *     await logFailedTask(msg, error);
 *   }
 * });
 *
 * export default {
 *   async queue(batch, env, ctx) {
 *     return await handler(batch);
 *   }
 * };
 * ```
 */
export function createQueueHandler<T>(options: QueueHandlerOptions<T>) {
  const {
    maxRetries,
    backoffDelays,
    onMessage,
    onRetry,
    onDLQ,
    logger,
    concurrency: concurrencyOpt,
  } = options;

  const concurrency =
    typeof concurrencyOpt === "number" &&
    Number.isFinite(concurrencyOpt) &&
    concurrencyOpt >= 1
      ? Math.floor(concurrencyOpt)
      : 1;

  async function processMessage(msg: Message<T>): Promise<void> {
    const attemptNumber = msg.attempts || 0;
    const logId = `[${msg.id}]`;

    try {
      logger?.info(
        `${logId} Processing message (attempt ${attemptNumber + 1})`
      );
      await onMessage(msg.body, attemptNumber);
      logger?.info(`${logId} Message processed successfully`);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (attemptNumber < maxRetries) {
        const delaySeconds =
          backoffDelays[attemptNumber] ??
          backoffDelays[backoffDelays.length - 1] ??
          0;

        logger?.info(
          `${logId} Retrying in ${delaySeconds}s (attempt ${attemptNumber + 2}/${maxRetries + 1})`
        );

        await onRetry?.(msg.body, attemptNumber, errorMsg, delaySeconds);
        msg.retry({ delaySeconds });
      } else {
        logger?.error(
          `${logId} Max retries exceeded (${maxRetries + 1} attempts), moving to DLQ`
        );

        await onDLQ?.(msg.body, attemptNumber, errorMsg);
      }
    }
  }

  return async (batch: MessageBatch<T>): Promise<void> => {
    await mapPool(batch.messages, concurrency, processMessage);
  };
}
