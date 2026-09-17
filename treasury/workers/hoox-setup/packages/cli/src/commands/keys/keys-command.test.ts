/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerKeysCommand } from "./keys-command.js";

describe("registerKeysCommand (top-level, in-process)", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hoox-keys-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers generate and list subcommands", () => {
    const program = new Command();
    registerKeysCommand(program);
    const keys = program.commands.find((c) => c.name() === "keys");
    expect(keys).toBeDefined();
    const sub = keys!.commands.map((c) => c.name()).sort();
    expect(sub).toEqual(["generate", "list"]);
  });

  it("generates key files in-process without spawning hoox", async () => {
    const program = new Command();
    program.exitOverride();
    registerKeysCommand(program);

    // Minimal worker dirs so .dev.vars merge can write
    const { mkdirSync } = await import("node:fs");
    for (const dir of [
      "workers/hoox-worker",
      "workers/trade-worker",
      "workers/agent-worker",
      "workers/dashboard",
      "workers/d1-worker",
      "workers/analytics-worker",
      "workers/report-worker",
      "workers/email-worker",
      "workers/web3-wallet-worker",
      "workers/telegram-worker",
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    await program.parseAsync(["keys", "generate"], { from: "user" });

    const internal = Bun.file(".keys/internal_key_binding.env");
    expect(await internal.exists()).toBe(true);
    const text = await internal.text();
    expect(text).toMatch(/^INTERNAL_KEY_BINDING=[0-9a-f]{64}\n$/);

    // Mesh keys must land in .dev.vars so secrets sync --system can read them
    const tradeDev = await Bun.file("workers/trade-worker/.dev.vars").text();
    expect(tradeDev).toContain("API_SERVICE_KEY_BINDING=");
    expect(tradeDev).toContain("TELEGRAM_INTERNAL_KEY_BINDING=");
    const hooxDev = await Bun.file("workers/hoox-worker/.dev.vars").text();
    expect(hooxDev).toContain("WEBHOOK_API_KEY_BINDING=");
  });

  it("lists keys after generate", async () => {
    const program = new Command();
    program.exitOverride();
    registerKeysCommand(program);

    await program.parseAsync(["keys", "generate"], { from: "user" });

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      await program.parseAsync(["keys", "list"], { from: "user" });
    } finally {
      process.stdout.write = origWrite;
    }

    const out = chunks.join("");
    expect(out).toContain("INTERNAL_KEY_BINDING");
    expect(out).toContain("****");
  });
});
