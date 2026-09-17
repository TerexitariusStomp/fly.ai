/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "bun:test";
import { formatRepairTime } from "./auto-repair-panel";

describe("formatRepairTime", () => {
  it("formats as HH:MM:SS with zero padding", () => {
    // Use local Date so test is timezone-stable for the chosen components
    const d = new Date(2026, 0, 1, 9, 5, 7);
    const out = formatRepairTime(d.getTime());
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(out).toBe(
      [
        d.getHours().toString().padStart(2, "0"),
        d.getMinutes().toString().padStart(2, "0"),
        d.getSeconds().toString().padStart(2, "0"),
      ].join(":")
    );
  });
});
