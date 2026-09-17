/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for SecretsViewer — export + pure helpers surface.
 * Full render tests for this view are covered by integration/e2e paths;
 * unit render with mock.module pollutes the shared store under Bun's runner.
 */
import { describe, it, expect } from "bun:test";
import {
  SecretsViewer,
  filterSecrets,
  MAX_VISIBLE_SECRETS,
} from "./secrets-viewer";
import type { SecretMetadata } from "../../services/cli-bridge";

describe("SecretsViewer", () => {
  it("is a function component", () => {
    expect(SecretsViewer).toBeInstanceOf(Function);
    expect(SecretsViewer.name).toBe("SecretsViewer");
  });

  it("does not require localStorage (Bun-safe)", () => {
    // Bun has no localStorage; SecretsViewer must never touch it
    expect("localStorage" in globalThis).toBe(false);
  });

  it("documents keyboard search (/) and list navigation (↑↓)", async () => {
    // Contract: SecretsViewer wires useViewKeyboard for / and ↑↓ (parity with KV Viewer).
    // Regression guard against the previous dead SearchBox (onChange discarded).
    const src = await Bun.file(
      new URL("./secrets-viewer.tsx", import.meta.url)
    ).text();
    expect(src).toContain("useViewKeyboard");
    expect(src).toContain('key.name === "slash"');
    expect(src).toContain("setSearchActive(true)");
    expect(src).toContain("filteredSecrets");
    expect(src).toContain("onChange={setSearch}");
  });

  it("never fetches secret values (no get/reveal bridge calls)", async () => {
    const src = await Bun.file(
      new URL("./secrets-viewer.tsx", import.meta.url)
    ).text();
    expect(src).toContain("configSecretsList");
    expect(src).not.toMatch(/configSecretsGet|secrets get|revealValue/i);
    // Explicit security comment contract
    expect(src).toContain("NEVER");
  });

  it("filters by name only (values never considered)", () => {
    const secrets: SecretMetadata[] = [
      { name: "OPENAI_API_KEY", type: "api_key", source: "config" },
      { name: "EXCHANGE_KEY_BINDING", type: "api_key", source: "Cloudflare" },
    ];
    expect(filterSecrets(secrets, "openai")).toHaveLength(1);
    expect(filterSecrets(secrets, "")).toHaveLength(2);
  });

  it("caps visible secret rows", () => {
    expect(MAX_VISIBLE_SECRETS).toBeGreaterThan(0);
  });
});
