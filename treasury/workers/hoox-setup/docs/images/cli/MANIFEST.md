# HOOX CLI image manifest

Captured 2026-08-16 from source CLI **0.13.0**:

```bash
HOOX_CLI_SRC=1 bun packages/cli/bin/hoox.js
```

Prompts in the stills use the `hx` alias. No mutating commands (`deploy`, `secrets put`, `infra delete`, `init`, `onboard`, `setup`) were run.

## How they were captured

- **Stills** — PTY capture of truecolor ANSI (need a TTY; `NO_COLOR` must be unset or the formatter strips color), rendered as a 120-column dark terminal (`#0b0f14`, IBM Plex Mono, orange ◆ / cursor) and screenshotted with Playwright + system Chromium. Short commands are padded to ~40 rows. Longer `--help` dumps grow the image so the full output is visible.
- **GIFs** — charmbracelet `vhs` v0.11.0 + `ttyd` 1.7.7 (installed to `~/.local/bin`; not previously on PATH). JetBrainsMono Nerd Font — IBM Plex Mono came out letter-spaced in VHS. Theme matches the stills (dark `#0b0f14`, indigo / amber / orange cursor).
- VHS `Screenshot` / `Output /abs/path.png` did not work in this vhs build (parser rejects absolute paths; PNG is not a valid `Output` type). Stills therefore use the Playwright path.

## Stills (`docs/images/cli/`)

| File                  | Command                | Notes                                                                                                                                                                   |
| --------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `help.png`            | `hx --help`            | Full dump (~459 lines, **1956×17530**, ~3.3 MB). Root help inlines every group's long description.                                                                      |
| `version.png`         | `hx --version`         | 0.13.0                                                                                                                                                                  |
| `help-init.png`       | `hx init --help`       |                                                                                                                                                                         |
| `help-onboard.png`    | `hx onboard --help`    |                                                                                                                                                                         |
| `help-setup.png`      | `hx setup --help`      |                                                                                                                                                                         |
| `help-clone.png`      | `hx clone --help`      |                                                                                                                                                                         |
| `help-dev.png`        | `hx dev --help`        |                                                                                                                                                                         |
| `help-deploy.png`     | `hx deploy --help`     | Tall (subcommand descriptions)                                                                                                                                          |
| `help-infra.png`      | `hx infra --help`      |                                                                                                                                                                         |
| `help-config.png`     | `hx config --help`     | Tall                                                                                                                                                                    |
| `help-secrets.png`    | `hx secrets --help`    |                                                                                                                                                                         |
| `help-keys.png`       | `hx keys --help`       |                                                                                                                                                                         |
| `help-check.png`      | `hx check --help`      |                                                                                                                                                                         |
| `help-logs.png`       | `hx logs --help`       | Compact                                                                                                                                                                 |
| `help-test.png`       | `hx test --help`       |                                                                                                                                                                         |
| `help-waf.png`        | `hx waf --help`        |                                                                                                                                                                         |
| `help-dashboard.png`  | `hx dashboard --help`  |                                                                                                                                                                         |
| `help-db.png`         | `hx db --help`         |                                                                                                                                                                         |
| `help-monitor.png`    | `hx monitor --help`    |                                                                                                                                                                         |
| `help-workers.png`    | `hx workers --help`    |                                                                                                                                                                         |
| `help-repair.png`     | `hx repair --help`     |                                                                                                                                                                         |
| `help-update.png`     | `hx update --help`     |                                                                                                                                                                         |
| `help-schema.png`     | `hx schema --help`     |                                                                                                                                                                         |
| `help-tui.png`        | `hx tui --help`        |                                                                                                                                                                         |
| `help-doctor.png`     | `hx doctor --help`     |                                                                                                                                                                         |
| `help-tunnel.png`     | `hx tunnel --help`     |                                                                                                                                                                         |
| `help-disclaimer.png` | `hx disclaimer --help` |                                                                                                                                                                         |
| `help-agent.png`      | `hx agent --help`      |                                                                                                                                                                         |
| `help-pyne.png`       | `hx pyne --help`       |                                                                                                                                                                         |
| `help-trace.png`      | `hx trace --help`      | Tall                                                                                                                                                                    |
| `help-perf.png`       | `hx perf --help`       |                                                                                                                                                                         |
| `help-completion.png` | `hx completion --help` |                                                                                                                                                                         |
| `doctor.png`          | `hx doctor`            | Live, read-only. Completed in a few ms.                                                                                                                                 |
| `check-setup.png`     | `hx check setup`       | Live, read-only. ~32 s. This workspace: config/infra/db OK; some worker secrets missing (real state, not redacted).                                                     |
| `check-health.png`    | `hx check health`      | Live, read-only. All 10 workers healthy. Clack spinner frames collapsed via xterm-headless. First summary table box-drawing is a bit ragged; the worker table is clean. |

All 30 requested command-group `--help` stills plus `--help`, `--version`, and the three safe live commands succeeded.

## GIFs (`docs/images/gifs/`)

| File                   | What it shows                                                                                                  | Size  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ----- |
| `cli-help-tour.gif`    | Types `hx --version`, `hx logs --help`, `hx tui --help`, `hx doctor --help` (clears between). ~7.8 s, 1400×960 | 240 K |
| `cli-doctor.gif`       | Types and runs `hx doctor`. ~3.3 s, 1400×960                                                                   | 111 K |
| `cli-check-health.gif` | Types and runs `hx check health` (spinners + tables). ~7.2 s, 1400×960                                         | 147 K |

No GIF for `onboard` / `init` / `deploy` / `check setup` — those need credentials or run ~30 s+.

## Failures / caveats

- **`help.png` is extremely tall.** Prefer `help-logs.png` / `help-tui.png` / the help-tour GIF in docs pages; keep `help.png` as a full-reference dump.
- **VHS stills** were not used (see above). GIFs required installing `vhs` + `ttyd` locally.
- **`NO_COLOR=1`** in this environment disables CLI color even on a TTY (`isRichMode()`). Captures unset it and set `FORCE_COLOR=3`, `TERM=xterm-256color`, `HOOX_SKIP_WRANGLER_UPDATE=1`.
- **`check-health` first table** (Task/Status/Duration) loses some padding after VT replay; the Worker table is aligned.
- **`check-setup`** reports missing integration secrets on this machine — expected, not a capture failure.
- No `--no-color` stills were needed; color rendered correctly.
