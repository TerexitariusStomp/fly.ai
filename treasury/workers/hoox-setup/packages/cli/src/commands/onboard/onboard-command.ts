/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `hoox onboard` — One-shot full workspace bootstrap.
 *
 * Chains the two steps required to get from a fresh clone to a deployed,
 * operational Hoox workspace:
 *
 *   1. `hoox init`  — collect Cloudflare credentials, select workers, write
 *                     `wrangler.jsonc`, collect integration secrets.
 *   2. `hoox setup` — generate internal keys, apply D1 schema, push secrets
 *                     to Cloudflare, rebuild + deploy the dashboard.
 *
 * Use this if you just cloned the repo and want a working system in one command.
 *
 * EXAMPLES:
 *   hoox onboard                            Interactive (prompts for everything)
 *   hoox onboard --token cfut_... --account xxx  Non-interactive
 *   hoox onboard --preset full              Full preset (all workers)
 *   hoox onboard --skip-dashboard           Skip dashboard rebuild
 *   hoox onboard --skip-db                  Skip D1 schema apply
 *
 * For finer-grained control, run `hoox init` and `hoox setup` separately.
 */

import type { Command } from "commander";
import { runInitCommand, verifyRepoRoot } from "../init/init-command.js";
import { SetupService } from "../../services/setup/index.js";
import {
  getFormatOptions,
  formatError,
  formatSuccess,
} from "../../utils/formatters.js";
import { CLIError, ExitCode } from "../../utils/errors.js";
import { withErrorHandling } from "../../utils/error-handler.js";
import { theme } from "../../utils/theme.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnboardOptions {
  // init flags
  token?: string;
  account?: string;
  secretStore?: string;
  prefix?: string;
  preset?: "minimal" | "standard" | "full";
  acceptRisk?: boolean;
  resume?: boolean;
  // setup flags
  skipKeys?: boolean;
  skipDb?: boolean;
  skipSecrets?: boolean;
  skipDashboard?: boolean;
  database?: string;
  // global
  yes?: boolean;
  json?: boolean;
  quiet?: boolean;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .alias("bootstrap")
    .alias("quickstart")
    .summary("One-shot full workspace bootstrap (init + setup)")
    .description(
      `Bootstrap a fresh Hoox workspace end-to-end in a single command.

This is the recommended entry point for new users. It runs:

  1. hoox init   Collect Cloudflare credentials, select workers, write
                 wrangler.jsonc, collect integration secrets.
  2. hoox setup  Generate internal keys, apply D1 schema, push secrets to
                 Cloudflare, rebuild + deploy the dashboard.

For finer-grained control, run 'hoox init' and 'hoox setup' separately.

NON-INTERACTIVE MODE:
  Pass --token and --account to skip all prompts. The command runs end-to-end
  without further interaction.

OPTIONS:
  --token <token>          Cloudflare API token (init)
  --account <id>           Cloudflare Account ID (init)
  --secret-store <id>      Cloudflare Secret Store ID (init)
  --prefix <prefix>        Subdomain prefix (init, default: cryptolinx)
  --preset <name>          Worker preset: minimal, standard, full (init)
  --accept-risk            Skip risk acknowledgment (init)
  --resume                 Resume init from saved wizard state
  --skip-keys              Skip generating internal keys (setup)
  --skip-db                Skip applying D1 schema (setup)
  --skip-secrets           Skip pushing secrets to Cloudflare (setup)
  --skip-dashboard         Skip rebuilding the dashboard (setup)
  --database <name>        D1 database name (setup, default: trade-data-db)
  -y, --yes                Skip confirmation prompts

EXAMPLES:
  hoox onboard                                      Interactive bootstrap
  hoox onboard --token cfut_xxx --account xxx        Non-interactive
  hoox onboard --preset full --token cfut_xxx --account xxx  Full preset
  hoox onboard --skip-dashboard                     Skip dashboard rebuild
  hoox onboard --resume                             Resume from saved wizard state
`
    )
    .option("--token <token>", "Cloudflare API token (init)")
    .option("--account <id>", "Cloudflare Account ID (init)")
    .option("--secret-store <id>", "Cloudflare Secret Store ID (init)")
    .option(
      "--prefix <prefix>",
      "Subdomain prefix (init, default: cryptolinx)",
      "cryptolinx"
    )
    .option("--preset <name>", "Worker preset: minimal, standard, full (init)")
    .option("--accept-risk", "Skip risk acknowledgment (init)")
    .option("--resume", "Resume init from saved wizard state")
    .option("--skip-keys", "Skip generating internal keys (setup)")
    .option("--skip-db", "Skip applying D1 schema (setup)")
    .option("--skip-secrets", "Skip pushing secrets to Cloudflare (setup)")
    .option("--skip-dashboard", "Skip rebuilding the dashboard (setup)")
    .option(
      "--database <name>",
      "D1 database name (setup, default: trade-data-db)"
    )
    .action(
      withErrorHandling(
        async (options: OnboardOptions, cmd: Command) => {
          const fmt = getFormatOptions(cmd);
          await runOnboard(options, fmt);
        },
        { service: "onboard" }
      )
    );
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runOnboard(
  options: OnboardOptions,
  fmt: { json?: boolean; quiet?: boolean }
): Promise<void> {
  const quiet = fmt.quiet ?? false;
  const isNonInteractive = Boolean(options.token && options.account);

  // Guard: must run from the root of a cloned Hoox repo. `hoox init`
  // (called below) also checks, but we fail fast here with a clear message
  // before printing the Step 1 banner.
  await verifyRepoRoot();

  // ── Step 1: init ──────────────────────────────────────────────────────
  if (!quiet) {
    process.stdout.write(
      theme.heading("\n━━━ Step 1/2: Init (workspace config) ━━━\n")
    );
  }

  const initOpts = {
    token: options.token,
    account: options.account,
    secretStore: options.secretStore,
    prefix: options.prefix,
    preset: options.preset,
    resume: options.resume ?? false,
    acceptRisk: options.acceptRisk,
  };

  await runInitCommand(
    initOpts as Parameters<typeof runInitCommand>[0],
    { json: fmt.json, quiet: fmt.quiet },
    isNonInteractive
  );

  // Init failed — do not run setup (avoids cascading failures / secret wipes)
  if (process.exitCode && process.exitCode !== 0) {
    return;
  }

  // Cancel / risk-decline leave exitCode 0 but never write wrangler.jsonc.
  // Without this gate, onboard would still run setup after "Setup cancelled."
  const configReady = await Bun.file("wrangler.jsonc").exists();
  if (!configReady) {
    if (!quiet) {
      formatError(
        new CLIError(
          "Onboard stopped: workspace config was not written (init cancelled or incomplete).",
          ExitCode.ERROR,
          undefined,
          false,
          "Re-run `hoox onboard` or `hoox init` to finish configuration, then `hoox setup`."
        ),
        fmt
      );
    }
    process.exitCode = ExitCode.ERROR;
    return;
  }

  // Belt-and-suspenders: ensure CF credentials are in env for setup/wrangler
  if (options.token) {
    process.env.CLOUDFLARE_API_TOKEN = options.token;
  }
  if (options.account) {
    process.env.CLOUDFLARE_ACCOUNT_ID = options.account;
  }

  // ── Step 2: setup ─────────────────────────────────────────────────────
  if (!quiet) {
    process.stdout.write(
      theme.heading("\n━━━ Step 2/2: Setup (infrastructure bootstrap) ━━━\n")
    );
  }

  const setupSvc = new SetupService();

  // Same auth gate as `hoox setup` — fail early with actionable next steps
  const authOk = await setupSvc.checkAuth();
  if (!authOk) {
    formatError(
      new CLIError(
        "Not authenticated with Cloudflare. Run 'wrangler login' first.",
        ExitCode.ERROR,
        undefined,
        false,
        "Run `wrangler login` interactively, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID environment variables for CI / non-interactive use."
      ),
      fmt
    );
    process.exitCode = ExitCode.ERROR;
    return;
  }

  const setupOpts = {
    skipKeys: Boolean(options.skipKeys),
    skipDb: Boolean(options.skipDb),
    skipSecrets: Boolean(options.skipSecrets),
    skipDashboard: Boolean(options.skipDashboard),
    database: options.database,
  };

  try {
    const result = await setupSvc.runAll(setupOpts);
    if (result.success) {
      if (!quiet) {
        formatSuccess(
          "Bootstrap complete! Next: `hoox check setup` then `hoox deploy all`",
          fmt
        );
      }
    } else {
      formatError(
        new CLIError(
          "Bootstrap completed with issues. See logs above.",
          ExitCode.ERROR,
          undefined,
          false,
          "Retry with `hoox setup`, diagnose with `hoox check setup`, or run `hoox repair check`."
        ),
        fmt
      );
      process.exitCode = ExitCode.ERROR;
    }
  } catch (e) {
    formatError(
      new CLIError(
        e instanceof Error ? e.message : String(e),
        ExitCode.ERROR,
        undefined,
        false,
        "Retry with `hoox setup`, diagnose with `hoox check setup`, or run `hoox repair check`."
      ),
      fmt
    );
    process.exitCode = ExitCode.ERROR;
  }
}
