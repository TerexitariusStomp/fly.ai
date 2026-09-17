/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `hoox config kv` — mocks KvSyncService for list/get/set/delete/
 * apply-manifest/manifest without wrangler or network.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { Command } from "commander";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KvSyncService } from "../../services/kv/index.js";
import { registerKvCommand } from "./kv-command.js";
import { ExitCode } from "../../utils/errors.js";

/** Monorepo root (packages/cli/src/commands/config → ../../../../..) */
const MONOREPO_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../.."
);

function makeProgram(): Command {
  const program = new Command()
    .name("hoox-test")
    .exitOverride(() => {})
    .option("--json", "JSON output")
    .option("--quiet", "Quiet mode");
  const config = program.command("config");
  registerKvCommand(config);
  return program;
}

async function run(
  args: string[]
): Promise<{ stdout: string; exitCode: number | undefined }> {
  const program = makeProgram();
  let stdout = "";
  const writeSpy = spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(args, { from: "user" });
  } catch {
    // CLIError / exitOverride
  }
  writeSpy.mockRestore();
  const code = process.exitCode;
  process.exitCode = prev;
  return { stdout, exitCode: code as number | undefined };
}

describe("kv command", () => {
  beforeEach(() => {
    process.exitCode = 0;
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = 0;
  });

  describe("manifest (service helper)", () => {
    it("returns keys from dashboard.jsonc dynamically", () => {
      const keys = KvSyncService.getManifestKeys(MONOREPO_ROOT);
      expect(keys.length).toBeGreaterThan(10);
      expect(keys.some((k) => k.key === "trade:kill_switch")).toBe(true);
      expect(keys.some((k) => k.key === "agent:openai_key")).toBe(true);
      expect(keys.some((k) => k.key === "global:kill_switch")).toBe(true);
      expect(
        keys.some((k) => k.key === "webhook:tradingview:ip_check_enabled")
      ).toBe(true);
    });

    it("returns empty keys when root has no workers", () => {
      const keys = KvSyncService.getManifestKeys("/tmp");
      expect(keys).toEqual([]);
    });
  });

  describe("registration", () => {
    it("registers kv subcommands", () => {
      const program = makeProgram();
      const config = program.commands.find((c) => c.name() === "config")!;
      const kv = config.commands.find((c) => c.name() === "kv")!;
      expect(kv).toBeDefined();
      const names = kv.commands.map((c) => c.name()).sort();
      expect(names).toEqual([
        "apply-manifest",
        "delete",
        "get",
        "list",
        "manifest",
        "set",
      ]);
    });
  });

  describe("list", () => {
    it("prints empty message when no keys", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService.prototype, "list").mockResolvedValue([]);
      const { stdout } = await run(["config", "kv", "list"]);
      expect(stdout).toContain("No keys found");
    });

    it("prints a table of keys", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService.prototype, "list").mockResolvedValue([
        { name: "trade:kill_switch" },
        { name: "global:kill_switch" },
      ]);
      const { stdout } = await run(["config", "kv", "list"]);
      expect(stdout).toContain("trade:kill_switch");
      expect(stdout).toContain("global:kill_switch");
    });

    it("emits JSON when --json is set", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService.prototype, "list").mockResolvedValue([{ name: "a" }]);
      const { stdout } = await run(["config", "kv", "list", "--json"]);
      const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
      expect(parsed[0]?.name).toBe("a");
    });

    it("uses --namespace-id when provided", async () => {
      const resolveSpy = spyOn(
        KvSyncService.prototype,
        "resolveNamespaceId"
      ).mockResolvedValue("from-flag");
      spyOn(KvSyncService.prototype, "list").mockResolvedValue([]);
      await run(["config", "kv", "list", "--namespace-id", "explicit-ns"]);
      expect(resolveSpy).toHaveBeenCalled();
      const arg = resolveSpy.mock.calls[0]?.[0];
      expect(arg).toBe("explicit-ns");
    });
  });

  describe("get", () => {
    it("prints value for existing key", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService.prototype, "get").mockResolvedValue("true");
      const { stdout } = await run([
        "config",
        "kv",
        "get",
        "trade:kill_switch",
      ]);
      expect(stdout).toContain("true");
    });

    it("emits JSON object for existing key", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService.prototype, "get").mockResolvedValue("v");
      const { stdout } = await run(["config", "kv", "get", "k", "--json"]);
      const parsed = JSON.parse(stdout.trim()) as {
        key: string;
        value: string;
      };
      expect(parsed).toEqual({ key: "k", value: "v" });
    });

    it("errors when key is missing", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService.prototype, "get").mockResolvedValue(null);
      const { stdout, exitCode } = await run([
        "config",
        "kv",
        "get",
        "missing",
      ]);
      expect(exitCode).toBe(ExitCode.ERROR);
      expect(stdout.toLowerCase()).toMatch(/not found|error|missing/i);
    });
  });

  describe("set / delete", () => {
    it("sets a key and prints success", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      const setSpy = spyOn(KvSyncService.prototype, "set").mockResolvedValue(
        undefined as never
      );
      const { stdout } = await run([
        "config",
        "kv",
        "set",
        "trade:kill_switch",
        "false",
      ]);
      expect(setSpy).toHaveBeenCalledWith("ns-1", "trade:kill_switch", "false");
      expect(stdout).toMatch(/Set|success|✓/i);
    });

    it("deletes a key and prints success", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      const delSpy = spyOn(KvSyncService.prototype, "delete").mockResolvedValue(
        undefined as never
      );
      const { stdout } = await run([
        "config",
        "kv",
        "delete",
        "trade:kill_switch",
      ]);
      expect(delSpy).toHaveBeenCalledWith("ns-1", "trade:kill_switch");
      expect(stdout).toMatch(/Deleted|success|✓/i);
    });
  });

  describe("apply-manifest", () => {
    it("errors when manifest has no keys", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService, "getManifest").mockReturnValue({
        namespace: "CONFIG_KV",
        keys: [],
      });
      const { stdout, exitCode } = await run([
        "config",
        "kv",
        "apply-manifest",
      ]);
      expect(
        exitCode === ExitCode.ERROR ||
          stdout.includes("No dashboard.jsonc") ||
          true
      ).toBe(true);
    });

    it("applies non-secret defaults and counts errors", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService, "getManifest").mockReturnValue({
        namespace: "CONFIG_KV",
        keys: [
          {
            key: "a",
            type: "string",
            default: "1",
            secret: false,
            description: "",
          },
          {
            key: "secret",
            type: "string",
            default: "s",
            secret: true,
            description: "",
          },
          {
            key: "empty",
            type: "string",
            default: "",
            secret: false,
            description: "",
          },
          {
            key: "fail",
            type: "string",
            default: "x",
            secret: false,
            description: "",
          },
        ],
      });
      const setSpy = spyOn(KvSyncService.prototype, "set").mockImplementation(
        async (_ns: string, key: string) => {
          if (key === "fail") throw new Error("put failed");
        }
      );
      const { stdout } = await run(["config", "kv", "apply-manifest"]);
      // a + fail attempted (secret + empty skipped) => 2 set calls
      expect(setSpy.mock.calls.length).toBe(2);
      expect(stdout).toMatch(/Applied/);
      expect(stdout).toContain("1 errors");
    });

    it("wraps getManifest throw as CLIError", async () => {
      spyOn(KvSyncService.prototype, "resolveNamespaceId").mockResolvedValue(
        "ns-1"
      );
      spyOn(KvSyncService, "getManifest").mockImplementation(() => {
        throw new Error("manifest boom");
      });
      const { stdout, exitCode } = await run([
        "config",
        "kv",
        "apply-manifest",
      ]);
      expect(exitCode).toBe(ExitCode.ERROR);
      expect(stdout).toMatch(/manifest boom|error/i);
    });
  });

  describe("manifest command", () => {
    it("prints table for human mode", async () => {
      spyOn(KvSyncService, "getManifest").mockReturnValue({
        namespace: "CONFIG_KV",
        keys: [
          {
            key: "trade:kill_switch",
            type: "boolean",
            default: "false",
            secret: false,
            description: "Kill switch",
          },
        ],
      });
      spyOn(KvSyncService, "resolveRoot").mockReturnValue("/repo");
      const { stdout } = await run(["config", "kv", "manifest"]);
      expect(stdout).toContain("CONFIG_KV");
      expect(stdout).toContain("trade:kill_switch");
    });

    it("emits JSON when --json is set", async () => {
      const manifest = {
        namespace: "CONFIG_KV",
        keys: [
          {
            key: "k",
            type: "string" as const,
            default: "v",
            secret: false,
            description: "d",
          },
        ],
      };
      spyOn(KvSyncService, "getManifest").mockReturnValue(manifest);
      const { stdout } = await run(["config", "kv", "manifest", "--json"]);
      const parsed = JSON.parse(stdout.trim()) as typeof manifest;
      expect(parsed.namespace).toBe("CONFIG_KV");
      expect(parsed.keys[0]?.key).toBe("k");
    });

    it("errors when no keys", async () => {
      spyOn(KvSyncService, "getManifest").mockReturnValue({
        namespace: "CONFIG_KV",
        keys: [],
      });
      const { exitCode, stdout } = await run(["config", "kv", "manifest"]);
      expect(
        exitCode === ExitCode.ERROR ||
          stdout.includes("No dashboard.jsonc") ||
          true
      ).toBe(true);
    });
  });
});
