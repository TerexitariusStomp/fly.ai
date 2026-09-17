<!--
  Copyright (c) 2026 HOOX · jango-blockchained (hoox-sh)
  SPDX-License-Identifier: CC-BY-4.0
-->

# TUI screenshot / GIF manifest

Captured 2026-08-16 (local) from the OpenTUI app:

```bash
cd /home/jango/Git/hoox
TUI_MOUSE=0 TUI_FPS=15 bun run --cwd packages/tui src/main.tsx
```

**Tooling:** charmbracelet `vhs` v0.10.0 + `ttyd` 1.7.7 (installed to `~/.local/bin` for this session; not committed). Chromium 151 screenshots the ttyd terminal. ImageMagick `convert` assembled looping GIFs. Tape files lived under `/tmp/hoox-vhs/` and are not in the repo.

**Terminal:** 1280×800 px, JetBrainsMono Nerd Font 14px, Hoox dark theme (`#050508` / `#E8E8F0`). GIFs resized to 1200×750, 8 frames, delay 80–85 cs, looping.

**How each still was taken:** write `~/.hoox/.tui-state/session.json` `activeView` (and `.wizard-session.json` `step` for wizard steps), launch the TUI in vhs, sleep 5–12 s, `Screenshot`. The user session was restored afterward. No secrets were written into session files.

**Keyboard notes:** vhs accepts `Ctrl+P`, `Right`, `Escape`. It does **not** parse `Ctrl+1`…`Ctrl+0` (digit not a valid vhs control arg). View stills therefore use session restore, not live Ctrl+digit. Command palette and wizard Next (→) were driven live.

Empty / offline UI is expected — no live Cloudflare account was required. A local mesh on `localhost:8787` was intermittently reachable, so some stills say `[CONNECTED]` and others `[OFFLINE]`.

---

## Primary views (`packages/tui/src/types.ts` `ALL_VIEWS`)

| File                  | View            | Capture                        | Notes                                                                                                                                                           |
| --------------------- | --------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard.png`       | dashboard       | session `activeView=dashboard` | Connected health grid + leftover network-error alerts. Replaced an earlier fully-offline still with a later connected frame.                                    |
| `workers.png`         | workers         | session                        | 10 worker cards (zeroed metrics).                                                                                                                               |
| `worker-detail.png`   | worker-detail   | session                        | **Empty state:** "Worker Not Found / No worker selected." Could not select a worker first because vhs cannot send Ctrl+2 then Enter reliably as a single still. |
| `trade-monitor.png`   | trade-monitor   | session                        | Empty live feed ("Waiting for live data…").                                                                                                                     |
| `logs-viewer.png`     | logs-viewer     | session                        | Empty stream, filters visible.                                                                                                                                  |
| `service-manager.png` | service-manager | session                        | **Offline this take:** "No workers registered" + schematic PoP map.                                                                                             |
| `config-editor.png`   | config-editor   | session                        | File tree (`config/`, `strategies/`); no file selected.                                                                                                         |
| `setup-wizard.png`    | setup-wizard    | copy of step 01                | Canonical landing = prerequisites. Same bytes as `setup-wizard-step-01-prereqs.png`.                                                                            |
| `settings.png`        | settings        | session                        | Prefs + "Auth none". No tokens.                                                                                                                                 |
| `queue-depth.png`     | queue-depth     | session                        | Heuristic depths (`trade-execution` BACKLOG 100).                                                                                                               |
| `kv-viewer.png`       | kv-viewer       | session, 12 s wait             | **CLI list failed** (`wrangler` / auth). Error panel, no key values. First 6 s take was still "Loading…".                                                       |
| `secrets-viewer.png`  | secrets-viewer  | session                        | **Names + metadata only.** Banner text overlaps (TUI layout). Values explicitly hidden.                                                                         |
| `db-query.png`        | db-query        | session                        | Empty editor, read-only hint.                                                                                                                                   |
| `ai-chat.png`         | ai-chat         | session                        | Empty conversation, model `WORKERS AI (LLAMA 3.1)`.                                                                                                             |
| `edge-topology.png`   | edge-topology   | session                        | Mesh map from `graph-metadata.json`. Some labels overflow at this size.                                                                                         |
| `worker-settings.png` | worker-settings | session, 12 s wait             | Gateway settings from CONFIG_KV. Shows TradingView allowlist **IPs** (not secrets). First 5 s take was still loading.                                           |

---

## Command palette

| File                         | What                                            | Capture                                                  |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `command-palette.png`        | Palette open over dashboard (full command list) | Live `Ctrl+P` after dashboard launch                     |
| `command-palette-logs.png`   | Palette filtered to `logs`                      | Same tape, typed `logs`                                  |
| `command-palette-select.png` | Same filter after `Down`                        | Nearly identical to the logs frame (only one view match) |

---

## Setup wizard steps

Forced via `.wizard-session.json` `{ "step": N }` with redacted/empty form data (no API keys, tokens, or webhooks).

| File                                     | Step | Title                                                  |
| ---------------------------------------- | ---- | ------------------------------------------------------ |
| `setup-wizard-step-01-prereqs.png`       | 0    | Prerequisites (Bun/Git/Wrangler/Docker/CF/repo checks) |
| `setup-wizard-step-02-api-keys.png`      | 1    | API Keys (CLI-only; fields empty)                      |
| `setup-wizard-step-03-exchanges.png`     | 2    | Exchanges (Binance / Bybit / MEXC unchecked)           |
| `setup-wizard-step-04-ai-providers.png`  | 3    | AI Providers (CLI-only; model `default`)               |
| `setup-wizard-step-05-strategies.png`    | 4    | Strategies (`Grid` selected)                           |
| `setup-wizard-step-06-notifications.png` | 5    | Notifications (email / telegram / discord off)         |
| `setup-wizard-step-07-deploy.png`        | 6    | Deploy review (nothing configured)                     |

Step 01 shows wrangler whoami as `Info@inart-designs.de` and CF account "not detected". That is an account identifier, not a token. API token line is `(not set)`.

---

## GIFs (`docs/images/gifs/`)

| File                      | Frames | Size     | How                                                                                                                                                                                                          |
| ------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tui-view-switch.gif`     | 8      | 1200×750 | Stitched stills: dashboard → workers → trade-monitor → logs-viewer → service-manager → setup-wizard → settings → edge-topology. Delay 85 cs. **Not** a live Ctrl+digit cycle (vhs cannot emit those chords). |
| `tui-setup-wizard.gif`    | 8      | 1200×750 | Frame 0 = live tape mid-check ("RUNNING CHECKS…"); frames 1–7 = settled steps 01–07. Live `Right` did advance 1→3 in a separate tape after prereqs finished. Delay 80 cs.                                    |
| `tui-command-palette.gif` | 8      | 1200×750 | Live tape: closed dashboard → `Ctrl+P` → type `logs` → `Down`. Each state held 2 frames. Delay 80 cs.                                                                                                        |

---

## Failures / limitations

1. **No live Ctrl+1…9 / Ctrl+0 / Ctrl+Alt+letter** in vhs tapes. Digit and Alt chords are invalid or unreliable; stills used `session.json`.
2. **`worker-detail.png` is the empty-selection state**, not a populated detail pane.
3. **`kv-viewer.png` is an error state**, not a key listing.
4. **`service-manager.png` was offline** (no worker table) even though `workers.png` had cards — timing / CLI vs HTTP.
5. **Layout overflow** on `edge-topology.png` and the secrets-viewer banner (renderer width, not capture crop).
6. **Intermittent local API** (`localhost:8787`) — mixed CONNECTED / OFFLINE stills.
7. vhs temporary GIFs and tapes remain only in `/tmp/hoox-vhs/` (not committed).

No token or secret values appear in any still. Secrets viewer lists binding **names** only.
