/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Formatters Utility Tests — Time formatting, number formatting.
 *
 * Sources of truth (no local mirror drift):
 *   - formatRelativeTime / formatDuration (ms) → @hoox-sh/hoox-shared/format-time
 *   - formatNumber, formatUptime, formatLatency, formatRequests, formatPercent
 *     → @hoox-sh/hoox-shared formatters
 *
 * Uses Bun test runner.
 */
import { describe, it, expect } from "bun:test";
import {
  formatRelativeTime,
  formatDuration,
} from "@hoox-sh/hoox-shared/format-time";
import {
  formatNumber,
  formatLatency,
  formatRequests,
  formatPercent,
  formatUptime,
  formatDurationCompact,
} from "@hoox-sh/hoox-shared";

// ─── formatRelativeTime (format-time: status bar / reconnection) ─────────────

describe("formatRelativeTime", () => {
  const now = 2000000; // fixed "now" reference for deterministic tests

  it('returns "—" for timestamp 0', () => {
    expect(formatRelativeTime(0, now)).toBe("—");
  });

  it('returns "just now" for future timestamps', () => {
    expect(formatRelativeTime(now + 5000, now)).toBe("just now");
  });

  it('returns "< 1m ago" for less than 60 seconds', () => {
    expect(formatRelativeTime(now - 1000, now)).toBe("< 1m ago");
    expect(formatRelativeTime(now - 59000, now)).toBe("< 1m ago");
  });

  it("returns minutes ago for 1-59 minutes", () => {
    expect(formatRelativeTime(now - 60000, now)).toBe("1m ago");
    expect(formatRelativeTime(now - 120000, now)).toBe("2m ago");
    expect(formatRelativeTime(now - 3540000, now)).toBe("59m ago");
  });

  it("returns hours ago for 1-23 hours", () => {
    expect(formatRelativeTime(now - 3600000, now)).toBe("1h ago");
    expect(formatRelativeTime(now - 7200000, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 82800000, now)).toBe("23h ago");
  });

  it("returns days ago for 1-29 days", () => {
    expect(formatRelativeTime(now - 86400000, now)).toBe("1d ago");
    expect(formatRelativeTime(now - 86400000 * 7, now)).toBe("7d ago");
    expect(formatRelativeTime(now - 86400000 * 29, now)).toBe("29d ago");
  });

  it('returns "> 30d ago" for 30+ days', () => {
    expect(formatRelativeTime(now - 86400000 * 30, now)).toBe("> 30d ago");
    expect(formatRelativeTime(now - 86400000 * 100, now)).toBe("> 30d ago");
  });

  it("uses Date.now() when nowMs is not provided", () => {
    const result = formatRelativeTime(Date.now() - 60000);
    expect(result).toMatch(/^(< 1m|\d+m) ago$/);
  });

  it("handles exactly 60 seconds boundary", () => {
    expect(formatRelativeTime(now - 60000, now)).toBe("1m ago");
  });

  it("handles exactly 60 minutes boundary", () => {
    expect(formatRelativeTime(now - 3600000, now)).toBe("1h ago");
  });

  it("handles exactly 24 hours boundary", () => {
    expect(formatRelativeTime(now - 86400000, now)).toBe("1d ago");
  });

  it("handles exactly 30 days boundary", () => {
    expect(formatRelativeTime(now - 86400000 * 30, now)).toBe("> 30d ago");
  });

  it("handles negative timestamp (future) gracefully", () => {
    expect(formatRelativeTime(now + 1, now)).toBe("just now");
  });
});

// ─── formatDuration (format-time: ms → compact downtime string) ──────────────

describe("formatDuration (ms)", () => {
  it("formats seconds when under 1 minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(30000)).toBe("30s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes with seconds when seconds remain", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(61000)).toBe("1m 1s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(3540000)).toBe("59m");
  });

  it("formats hours when 1+ hour", () => {
    expect(formatDuration(3600000)).toBe("1h");
    expect(formatDuration(3661000)).toBe("1h 1m");
    expect(formatDuration(7200000)).toBe("2h");
    expect(formatDuration(7260000)).toBe("2h 1m");
  });

  it("handles large durations", () => {
    expect(formatDuration(90000000)).toBe("25h");
    expect(formatDuration(91800000)).toBe("25h 30m");
  });

  it("handles milliseconds below 1 second", () => {
    expect(formatDuration(500)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
  });
});

// ─── Shared number / uptime / latency formatters ─────────────────────────────

describe("formatNumber (shared)", () => {
  it("formats thousands with K suffix", () => {
    expect(formatNumber(1500)).toBe("1.5K");
    expect(formatNumber(2000)).toBe("2.0K");
    expect(formatNumber(999000)).toBe("999.0K");
  });

  it("formats millions with M suffix", () => {
    expect(formatNumber(1500000)).toBe("1.5M");
    expect(formatNumber(2000000)).toBe("2.0M");
  });

  it("returns locale string for numbers under 1000", () => {
    expect(formatNumber(500)).toBe((500).toLocaleString());
    expect(formatNumber(0)).toBe((0).toLocaleString());
    expect(formatNumber(999)).toBe((999).toLocaleString());
  });

  it("handles non-finite", () => {
    expect(formatNumber(NaN)).toBe("—");
    expect(formatNumber(Infinity)).toBe("—");
  });
});

describe("formatUptime / formatDurationCompact (seconds)", () => {
  it("formats seconds", () => {
    expect(formatDurationCompact(0)).toBe("0s");
    expect(formatDurationCompact(30)).toBe("30s");
    expect(formatDurationCompact(59)).toBe("59s");
  });

  it("formats minutes", () => {
    expect(formatDurationCompact(60)).toBe("1m");
    expect(formatDurationCompact(90)).toBe("1m");
    expect(formatDurationCompact(3599)).toBe("59m");
  });

  it("formats hours with minutes", () => {
    expect(formatDurationCompact(3600)).toBe("1h 0m");
    expect(formatDurationCompact(3661)).toBe("1h 1m");
    expect(formatDurationCompact(7200)).toBe("2h 0m");
  });

  it("formats days with hours", () => {
    expect(formatDurationCompact(86400)).toBe("1d 0h");
    expect(formatDurationCompact(90000)).toBe("1d 1h");
    expect(formatDurationCompact(172800)).toBe("2d 0h");
  });

  it("formatUptime delegates to full formatDuration (seconds)", () => {
    // formatUptime uses multi-part formatDuration (d/h/m/s)
    expect(formatUptime(125)).toBe("2m 5s");
    expect(formatUptime(3661)).toBe("1h 1m 1s");
  });
});

describe("formatLatency", () => {
  it("formats sub-millisecond latency", () => {
    expect(formatLatency(0)).toBe("<1ms");
    expect(formatLatency(0.5)).toBe("<1ms");
  });

  it("formats millisecond latency", () => {
    expect(formatLatency(1)).toBe("1ms");
    expect(formatLatency(45)).toBe("45ms");
    expect(formatLatency(500)).toBe("500ms");
    expect(formatLatency(999)).toBe("999ms");
  });

  it("formats second-level latency", () => {
    expect(formatLatency(1000)).toBe("1.0s");
    expect(formatLatency(2500)).toBe("2.5s");
    expect(formatLatency(15000)).toBe("15.0s");
  });

  it("handles non-finite", () => {
    expect(formatLatency(NaN)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("formats percentages with sign prefix", () => {
    expect(formatPercent(50, 1)).toBe("+50.0%");
    expect(formatPercent(99.9, 1)).toBe("+99.9%");
    expect(formatPercent(0, 1)).toBe("+0.0%");
    expect(formatPercent(-12.5, 1)).toBe("-12.5%");
  });

  it("handles non-finite", () => {
    expect(formatPercent(NaN)).toBe("—");
  });
});

describe("formatRequests", () => {
  it("formats via formatNumber", () => {
    expect(formatRequests(0)).toBe((0).toLocaleString());
    expect(formatRequests(42)).toBe((42).toLocaleString());
    expect(formatRequests(999)).toBe((999).toLocaleString());
    expect(formatRequests(1000)).toBe("1.0K");
    expect(formatRequests(1500)).toBe("1.5K");
    expect(formatRequests(1000000)).toBe("1.0M");
  });
});
