<!--
  Copyright (c) 2026 HOOX · jango-blockchained (hoox-sh)
  SPDX-License-Identifier: CC-BY-4.0
-->

# Dashboard screenshot / GIF manifest

Captured 2026-08-16 (local) from the Next.js dashboard at
`workers/dashboard`.

```bash
cd /home/jango/Git/hoox/workers/dashboard
AUTH_TYPE=none NODE_ENV=development bun run dev --port 3000
```

**Auth:** middleware documents `AUTH_TYPE=none` as a development-only bypass
(`src/middleware.ts`, `src/lib/config.ts` `assertProductionAuthConfigured`).
No credentials were invented or submitted to production. Login stills use the
empty form, typed dummy values (`admin` / `wrong-password`), and a Playwright
route that returns `{ "error": "Invalid credentials" }` so the error chrome
renders.

**First-run gate:** dashboard layout redirects to `/dashboard/setup` until
`localStorage.hoox_setup_completed === "true"`. Page stills (except the setup
wizard set) stamp that flag via Playwright `addInitScript`. Setup stills /
`dashboard-setup.gif` leave it unset.

**Tooling:** Python Playwright 1.61 + Chromium
`~/.cache/ms-playwright/chromium-1234`. Viewport **1440×900** desktop
(`deviceScaleFactor=2` → 2880×1800 CSS pixels) and **390×844** mobile
(`-mobile` suffix). Dark theme (`color_scheme=dark`). Full-page PNGs. Next.js
dev overlay (`nextjs-portal`) hidden on stills. GIFs from Playwright WebM →
ffmpeg (`fps=6`, scale 960, 64-color palette, loop).

Empty / fetch-failed chrome is expected — backend worker APIs were not fully
wired for this local Next process. Worker health tiles that read `CONFIG_KV`
did resolve (10/10 healthy on overview). No secrets or live session cookies
appear in any still.

---

## Routes → files

| File                      | Route                        | Notes                                                                                |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `login.png`               | `/login`                     | Empty Hoox Gateway form (placeholders only).                                         |
| `login-filled.png`        | `/login`                     | Username `admin`, dummy password typed, submit enabled.                              |
| `login-error.png`         | `/login`                     | Invalid-credentials alert + invalid field chrome.                                    |
| `login-mobile.png`        | `/login`                     | Same empty form at 390×844.                                                          |
| `overview.png`            | `/dashboard`                 | Command Center. Metrics/charts failed to fetch; AI health + worker matrix populated. |
| `overview-mobile.png`     | `/dashboard`                 | Full-page mobile home (sidebar collapsed).                                           |
| `overview-mobile-nav.png` | `/dashboard`                 | Mobile viewport with sidebar trigger opened.                                         |
| `positions.png`           | `/dashboard/positions`       | Empty book + “Could not load positions” empty/error state.                           |
| `signal-flow.png`         | `/dashboard/signal-flow`     | Pipeline chrome; live health tiles mostly empty/degraded.                            |
| `analytics.png`           | `/dashboard/analytics`       | Empty-state cards (“No trade metrics yet”, AE query failed banner).                  |
| `logs.png`                | `/dashboard/logs`            | Logs viewer chrome; empty/error stream.                                              |
| `signals.png`             | `/dashboard/signals`         | Signals table chrome; fetch failed / empty.                                          |
| `notifications.png`       | `/dashboard/notifications`   | Notification tester + recent list chrome.                                            |
| `reports.png`             | `/dashboard/reports`         | Reports list empty/error.                                                            |
| `database.png`            | `/dashboard/database`        | Database Explorer schema (Signals columns); row fetch failed.                        |
| `agent.png`               | `/dashboard/agent`           | Agent overview.                                                                      |
| `agent-chat.png`          | `/dashboard/agent/chat`      | Empty chat (“Start a conversation”).                                                 |
| `agent-vision.png`        | `/dashboard/agent/vision`    | Vision upload chrome.                                                                |
| `agent-reasoning.png`     | `/dashboard/agent/reasoning` | Reasoning panel chrome.                                                              |
| `agent-models.png`        | `/dashboard/agent/models`    | Model config chrome.                                                                 |
| `agent-risk.png`          | `/dashboard/agent/risk`      | Risk parameters chrome.                                                              |
| `agent-usage.png`         | `/dashboard/agent/usage`     | Usage chart/table chrome.                                                            |
| `settings.png`            | `/dashboard/settings`        | Per-worker settings (Gateway kill switch, webhook allowlist IPs).                    |
| `setup.png`               | `/dashboard/setup`           | Canonical setup page = wizard welcome + infrastructure list.                         |
| `404.png`                 | `/this-page-does-not-exist`  | App `not-found.tsx`.                                                                 |

`/` only redirects to `/dashboard` (no distinct chrome).

---

## Setup wizard stills

Driven live on `/dashboard/setup` (Start setup / Next / Continue anyway).

| File                | Step      | Notes                                                                   |
| ------------------- | --------- | ----------------------------------------------------------------------- |
| `setup-welcome.png` | 1 Welcome | Same view as `setup.png` (welcome + infra).                             |
| `setup-workers.png` | 2 Workers | Housekeeping fetch error (`Failed to parse URL from [object Request]`). |
| `setup-secrets.png` | 3 Secrets | Tall mesh/user secrets catalog.                                         |
| `setup-webhook.png` | 4 Webhook | TradingView webhook step.                                               |
| `setup-done.png`    | 5 Done    | Finish chrome.                                                          |

---

## GIFs (`docs/images/gifs/`)

| File                  | What                                                                                                              | Size    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| `dashboard-nav.gif`   | Sidebar clicks: Overview → Positions → Signal Flow → Analytics → Logs → Signals → Settings. ~11 s, 960×600, loop. | ~1.0 MB |
| `dashboard-setup.gif` | Setup wizard advancing through steps (welcome → workers → …). ~7.5 s, 960×600, loop.                              | ~1.0 MB |

GIFs were recorded before the Next overlay was hidden, so a collapsed
“1 Issue” Next.js badge can appear in a corner. Stills hide that overlay.

---

## Failures / limitations

1. **Local APIs.** Positions, analytics, logs, signals, reports, and several
   overview cards show empty or “Failed to fetch” chrome. That is the real
   local layout, not a crop failure.
2. **Login motion.** Framer Motion on `/login` starts at `opacity: 0`. Stills
   wait/force the card visible. GIFs were not re-recorded after that fix.
3. **First-run redirect.** Without `hoox_setup_completed`, every dashboard
   URL replaces to `/dashboard/setup`. Docs stills stamp the flag except the
   wizard set.
4. **Settings still** shows a TradingView IP allowlist (public ranges), not
   secrets.
5. **Housekeeping URL bug** is visible on the Workers wizard step
   (`Failed to parse URL from [object Request]`) — left as-is.
6. Capture scripts lived under `/tmp/hoox-capture-dashboard.py` and
   `/tmp/hoox-recapture*.py` (not in the repo).

No token or password values are readable in any still (login password field
is masked). Dummy username `admin` is the form placeholder / typed label only.
