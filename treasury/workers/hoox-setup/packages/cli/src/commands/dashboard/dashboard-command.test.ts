/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Command } from "commander";
import {
  registerDashboardCommand,
  withGlobalFlags,
} from "./dashboard-command.js";

describe("withGlobalFlags", () => {
  it("forwards json, quiet, yes, and --no-color when set", () => {
    const program = new Command()
      .option("--json")
      .option("--quiet")
      .option("--yes")
      .option("--no-color");
    // Populate opts via a silent parse of flags only
    program.parse(
      ["node", "hoox", "--json", "--quiet", "--yes", "--no-color"],
      {
        from: "node",
      }
    );
    expect(withGlobalFlags(program, ["dev", "dashboard"])).toEqual([
      "--json",
      "--quiet",
      "--yes",
      "--no-color",
      "dev",
      "dashboard",
    ]);
  });

  it("returns args unchanged when no global flags are set", () => {
    const program = new Command()
      .option("--json")
      .option("--quiet")
      .option("--yes")
      .option("--no-color");
    program.parse(["node", "hoox"], { from: "node" });
    expect(withGlobalFlags(program, ["deploy", "dashboard"])).toEqual([
      "deploy",
      "dashboard",
    ]);
  });
});

describe("registerDashboardCommand", () => {
  beforeEach(() => {
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it("registers dashboard command with dev and deploy subcommands", () => {
    const program = new Command();
    registerDashboardCommand(program);

    const dashboard = program.commands.find((c) => c.name() === "dashboard");
    expect(dashboard).toBeDefined();
    const subNames = dashboard!.commands.map((c) => c.name()).sort();
    expect(subNames).toEqual(["deploy", "dev"]);
  });

  it("does NOT register the old 'update-urls' subcommand", () => {
    const program = new Command();
    registerDashboardCommand(program);

    const dashboard = program.commands.find((c) => c.name() === "dashboard")!;
    const updateUrls = dashboard.commands.find(
      (c) => c.name() === "update-urls"
    );
    expect(updateUrls).toBeUndefined();
  });

  it("forwards dashboard dev to 'dev dashboard'", async () => {
    const program = new Command()
      .name("hoox-test")
      .exitOverride(() => {})
      .option("--json")
      .option("--quiet")
      .option("--yes")
      .option("--no-color");

    let received: string[] = [];
    program
      .command("dev")
      .argument("[target]")
      .action((target: string) => {
        received = ["dev", target];
      });

    registerDashboardCommand(program);
    await program.parseAsync(["dashboard", "dev"], { from: "user" });
    expect(received).toEqual(["dev", "dashboard"]);
  });

  it("forwards dashboard deploy with --rebuild and --auto", async () => {
    const program = new Command()
      .name("hoox-test")
      .exitOverride(() => {})
      .option("--json")
      .option("--quiet")
      .option("--yes")
      .option("--no-color");

    let received: string[] = [];
    program
      .command("deploy")
      .argument("[target]")
      .option("--rebuild")
      .option("--auto")
      .action((target: string, opts: { rebuild?: boolean; auto?: boolean }) => {
        received = ["deploy", target];
        if (opts.rebuild) received.push("--rebuild");
        if (opts.auto) received.push("--auto");
      });

    registerDashboardCommand(program);
    await program.parseAsync(["dashboard", "deploy", "--rebuild", "--auto"], {
      from: "user",
    });
    expect(received).toEqual(["deploy", "dashboard", "--rebuild", "--auto"]);
  });

  it("deploy without flags only forwards deploy dashboard", async () => {
    const program = new Command()
      .name("hoox-test")
      .exitOverride(() => {})
      .option("--json")
      .option("--quiet")
      .option("--yes")
      .option("--no-color");

    let received: string[] = [];
    program
      .command("deploy")
      .argument("[target]")
      .option("--rebuild")
      .option("--auto")
      .action((target: string, opts: { rebuild?: boolean; auto?: boolean }) => {
        received = ["deploy", target];
        if (opts.rebuild) received.push("--rebuild");
        if (opts.auto) received.push("--auto");
      });

    registerDashboardCommand(program);
    await program.parseAsync(["dashboard", "deploy"], { from: "user" });
    expect(received).toEqual(["deploy", "dashboard"]);
  });
});
