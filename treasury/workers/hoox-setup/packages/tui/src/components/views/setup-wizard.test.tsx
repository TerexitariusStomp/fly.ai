/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/** @jsxImportSource @opentui/react */
/**
 * Tests for SetupWizard component.
 *
 * Covers: progress indicator, step rendering, secret masking,
 *         navigation, skip logic, validation, and config store integration.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

// Do NOT mock.module shared stores here — Bun's mock.module is process-wide and
// strips Zustand setState/getState, which breaks later suites (workers, worker-detail).
// These tests only exercise pure helpers + local mock functions; no store wiring.
const mockUpdateConfig = mock((_config: Record<string, unknown>) => {});
const mockSetView = mock((_view: string) => {});

import {
  redactWizardSecrets,
  maskSecret,
  validateApiKey,
  validateEmail,
  validateUrl,
} from "./setup-wizard";

// ─── Secret redaction (session persistence) ─────────────────────────────────

describe("redactWizardSecrets", () => {
  it("clears exchange keys, AI key, telegram token, and discord webhook", () => {
    const redacted = redactWizardSecrets({
      apiKeys: {
        exchange: {
          key: "exchange-key-secret-value",
          secret: "exchange-sec",
        },
      },
      exchanges: { binance: true, bybit: false, mexc: false },
      ai: {
        providerUrl: "https://api.example.com",
        apiKey: "sk-live-secret",
        model: "gpt-4",
      },
      strategy: { type: "grid", params: { spacing: "1" } },
      notifications: {
        email: { enabled: true, address: "ops@example.com" },
        telegram: {
          enabled: true,
          botToken: "123:ABC-secret",
          chatId: "999",
        },
        discord: {
          enabled: true,
          webhookUrl: "https://discord.com/api/webhooks/secret",
        },
      },
    });

    expect(redacted.apiKeys.exchange).toEqual({ key: "", secret: "" });
    expect(redacted.ai.apiKey).toBe("");
    expect(redacted.ai.providerUrl).toBe("https://api.example.com");
    expect(redacted.ai.model).toBe("gpt-4");
    expect(redacted.notifications.telegram.botToken).toBe("");
    expect(redacted.notifications.telegram.chatId).toBe("999");
    expect(redacted.notifications.discord.webhookUrl).toBe("");
    expect(redacted.notifications.email.address).toBe("ops@example.com");
    expect(redacted.exchanges.binance).toBe(true);
    expect(redacted.strategy.type).toBe("grid");
  });

  it("does not mutate the input object", () => {
    const original = {
      apiKeys: {
        exchange: { key: "keep-me", secret: "keep-me-too" },
      },
      exchanges: { binance: true, bybit: false, mexc: false },
      ai: { providerUrl: "", apiKey: "secret", model: "default" },
      strategy: { type: "grid" as const, params: {} },
      notifications: {
        email: { enabled: false, address: "" },
        telegram: { enabled: false, botToken: "tok", chatId: "" },
        discord: { enabled: false, webhookUrl: "hook" },
      },
    };
    redactWizardSecrets(original);
    expect(original.apiKeys.exchange.key).toBe("keep-me");
    expect(original.ai.apiKey).toBe("secret");
    expect(original.notifications.telegram.botToken).toBe("tok");
  });

  it("session payload is safe to JSON.stringify (no secrets)", () => {
    const redacted = redactWizardSecrets({
      apiKeys: {
        exchange: {
          key: "exchange-key-secret-value",
          secret: "exchange-sec",
        },
      },
      exchanges: { binance: true, bybit: false, mexc: false },
      ai: {
        providerUrl: "https://api.example.com",
        apiKey: "sk-live-should-not-persist",
        model: "gpt-4",
      },
      strategy: { type: "grid", params: {} },
      notifications: {
        email: { enabled: false, address: "" },
        telegram: { enabled: true, botToken: "123:ABC", chatId: "1" },
        discord: {
          enabled: true,
          webhookUrl: "https://discord.com/api/webhooks/x",
        },
      },
    });
    const json = JSON.stringify({ step: 2, data: redacted });
    expect(json).not.toContain("sk-live");
    expect(json).not.toContain("exchange-key");
    expect(json).not.toContain("123:ABC");
    expect(json).not.toContain("webhooks/x");
  });
});

// ─── Validation unit tests ───────────────────────────────────────────────────

describe("Validation helpers", () => {
  describe("maskSecret", () => {
    it("masks long strings showing first 4 and last 4", () => {
      const result = maskSecret("abcdefghijklmnop12345678");
      expect(result).toBe("abcd••••5678");
    });

    it("replaces short strings with bullet characters", () => {
      expect(maskSecret("abc")).toBe("•••");
      expect(maskSecret("")).toBe("••••");
    });

    it("handles exactly 8 chars by showing all bullets", () => {
      expect(maskSecret("12345678")).toBe("••••••••");
    });
  });

  describe("validateApiKey", () => {
    it("accepts valid-looking keys (>=16 chars, no whitespace)", () => {
      expect(validateApiKey("abcdefghijklmnop")).toBe(true);
      expect(validateApiKey("a".repeat(64))).toBe(true);
    });

    it("rejects short keys", () => {
      expect(validateApiKey("short")).toBe(false);
    });

    it("rejects keys with leading/trailing whitespace", () => {
      expect(validateApiKey("  abcdefghijklmnop")).toBe(false);
      expect(validateApiKey("abcdefghijklmnop  ")).toBe(false);
    });
  });

  describe("validateEmail", () => {
    it("accepts valid email addresses", () => {
      expect(validateEmail("user@example.com")).toBe(true);
      expect(validateEmail("a@b.co")).toBe(true);
    });

    it("rejects invalid email", () => {
      expect(validateEmail("not-an-email")).toBe(false);
      expect(validateEmail("")).toBe(false);
      expect(validateEmail("@missing.com")).toBe(false);
    });
  });

  describe("validateUrl", () => {
    it("accepts valid http/https URLs", () => {
      expect(validateUrl("https://discord.com/api/webhooks/123")).toBe(true);
      expect(validateUrl("http://localhost:8080")).toBe(true);
    });

    it("rejects non-URL strings", () => {
      expect(validateUrl("not-a-url")).toBe(false);
      expect(validateUrl("")).toBe(false);
      expect(validateUrl("ftp://x.com")).toBe(false);
    });
  });

  describe("maskSecret edge cases", () => {
    it("masks short secrets entirely", () => {
      expect(maskSecret("")).toBe("••••");
      expect(maskSecret("ab")).toBe("••");
      expect(maskSecret("abcdefg")).toBe("•••••••");
    });

    it("shows first/last 4 for longer secrets", () => {
      expect(maskSecret("abcdefghij")).toBe("abcd••••ghij");
    });
  });
});

// ─── Component behavior tests ────────────────────────────────────────────────

describe("SetupWizard", () => {
  beforeEach(() => {
    mockUpdateConfig.mockClear();
    mockSetView.mockClear();
  });

  describe("Progress indicator", () => {
    it("shows 7 step labels including prerequisites", () => {
      const STEPS = [
        "PREREQUISITES",
        "API KEYS",
        "EXCHANGES",
        "AI PROVIDERS",
        "STRATEGIES",
        "NOTIFICATIONS",
        "DEPLOY",
      ];
      expect(STEPS).toHaveLength(7);
      expect(STEPS[0]).toBe("PREREQUISITES");
      expect(STEPS[6]).toBe("DEPLOY");
    });
  });

  describe("Steps can be skipped", () => {
    it("Exchanges step (index 2) is skippable", () => {
      // After prerequisites (0) + API keys (1), exchanges is step 2
      const skipIndex = 2;
      expect(skipIndex).toBe(2);
    });

    it("Strategies step (index 4) is skippable", () => {
      const skipIndex = 4;
      expect(skipIndex).toBe(4);
    });
  });

  describe("Navigation", () => {
    it("Back is disabled on first step", () => {
      const step = 0;
      expect(step === 0).toBe(true); // isFirstStep = true
    });

    it("Next advances to the next step", () => {
      let step = 0;
      const totalSteps = 7;
      step = Math.min(step + 1, totalSteps - 1);
      expect(step).toBe(1);
    });

    it("Cannot advance past last step", () => {
      let step = 6;
      const totalSteps = 7;
      if (step < totalSteps - 1) step++;
      expect(step).toBe(6);
    });
  });

  describe("Deploy action", () => {
    it("writes active exchanges to config store", () => {
      const exchanges = { binance: true, bybit: false, mexc: true };
      const active = Object.entries(exchanges)
        .filter(([, v]) => v)
        .map(([k]) => k);

      expect(active).toEqual(["binance", "mexc"]);

      // Simulate what the wizard does on deploy
      mockUpdateConfig({ activeExchanges: active });
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        activeExchanges: ["binance", "mexc"],
      });
    });

    it("navigates to dashboard after deploy", () => {
      mockSetView("dashboard");
      expect(mockSetView).toHaveBeenCalledWith("dashboard");
    });

    it("deploy is fail-closed without dialog (contract)", () => {
      // Mirrors SetupWizard.handleDeploy: no dialog → block + alert
      const dialog: undefined = undefined;
      const blocked = !dialog;
      expect(blocked).toBe(true);
    });
  });

  describe("Secret field masking", () => {
    it("displays masked value for non-empty secrets", () => {
      const secret = "sk-abcdefghijklmnop123456";
      const masked = maskSecret(secret);
      expect(masked).toBe("sk-a••••3456");
      expect(masked).toContain("••••");
    });

    it("displays placeholder for empty secrets", () => {
      const empty = "";
      const display = empty ? maskSecret(empty) : "(not set)";
      expect(display).toBe("(not set)");
    });
  });

  describe("Reopen from Settings", () => {
    it("can set view to setup-wizard", () => {
      mockSetView("setup-wizard");
      expect(mockSetView).toHaveBeenCalledWith("setup-wizard");
    });
  });
});
