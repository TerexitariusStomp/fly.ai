/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for AiChatView — export surface, history sanitization, caps.
 * Persistence uses file-backed tui-storage (see tui-storage.test.ts);
 * full render/SSE coverage is out of scope for this unit file.
 */
import { describe, it, expect } from "bun:test";
import {
  AiChatView,
  sanitizeChatMessage,
  MAX_STORED_MESSAGES,
  MAX_MESSAGE_CHARS,
} from "./ai-chat";
import { TuiStateFiles } from "../../services/tui-storage";

describe("AiChatView", () => {
  it("is a function component", () => {
    expect(AiChatView).toBeInstanceOf(Function);
    expect(AiChatView.name).toBe("AiChatView");
  });

  it("runs in environments without localStorage", () => {
    // Regression: CLEAR HISTORY used bare localStorage and threw ReferenceError
    expect(typeof globalThis.localStorage).toBe("undefined");
  });

  it("persists history under the chat-history state file", () => {
    expect(TuiStateFiles.chatHistory).toBe("chat-history.json");
  });

  it("caps stored messages and message body size", () => {
    expect(MAX_STORED_MESSAGES).toBe(100);
    expect(MAX_MESSAGE_CHARS).toBe(8_000);
  });
});

describe("sanitizeChatMessage", () => {
  it("redacts bearer tokens from user content before persist", () => {
    const out = sanitizeChatMessage({
      role: "user",
      content: "Use Authorization: Bearer sk-super-secret-value-here please",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(out.content).not.toContain("sk-super-secret");
    expect(out.content.toLowerCase()).toContain("redacted");
    expect(out.role).toBe("user");
  });

  it("redacts HOOX_API_TOKEN-style assignments", () => {
    const out = sanitizeChatMessage({
      role: "user",
      content: "export HOOX_API_TOKEN=my-cleartext-token-12345",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(out.content).not.toContain("my-cleartext-token");
    expect(out.content).toContain("HOOX_API_TOKEN=[redacted]");
  });

  it("truncates oversized message bodies", () => {
    const out = sanitizeChatMessage({
      role: "assistant",
      content: "x".repeat(MAX_MESSAGE_CHARS + 500),
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(out.content.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(out.content.endsWith("…")).toBe(true);
  });

  it("preserves short non-secret messages", () => {
    const out = sanitizeChatMessage({
      role: "assistant",
      content: "Hello, how can I help?",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(out.content).toBe("Hello, how can I help?");
  });
});
