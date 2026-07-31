# Agent-Worker Dashboard UI — Design Spec

**Date:** 2026-03-23
**Status:** Revised — v2

---

## Overview

A built-in web dashboard served by the agent-worker process itself. Provides real-time monitoring of the poll loop and active jobs, plus full configuration editing — so operators never need to edit YAML by hand or tail a log file.

---

## Architecture

### Serving

A lightweight HTTP server embedded in the agent-worker process (Bun's built-in `Bun.serve()`), started alongside the poll loop when a `ui` section is present in config. No separate process, no external dependencies.

```
agent-worker process
├── poller.ts          (existing)
├── scheduler.ts       (existing)
└── ui/
    ├── server.ts      Bun.serve — static files + API routes
    ├── state.ts       WorkerState singleton (in-memory)
    └── public/
        ├── index.html
        ├── app.js
        └── style.css
```

### State

A `WorkerState` singleton holds:
- Worker status: `idle | running | stopped`
- Active job (if any): id, title, branch, stage, start time, log lines
- Job history: last 50 completed jobs (status, duration, PR link)
- Config: current parsed config object

All state is in-memory and ephemeral. On restart the history is empty. The config on disk is the source of truth; the UI reads and writes it via the API.

### Real-time updates

Server-Sent Events (SSE) on `GET /api/events`. The server pushes a JSON event on every state change:
- `worker_status` — idle/running/stopped
- `job_start` — new active job
- `job_log` — single log line appended
- `job_stage` — stage transition (pre-hooks → agent → post-hooks)
- `job_end` — job completed (success/failure/review)
- `job_error` — agent subprocess crashed or hook threw; includes error message; triggers Failed state
- `history_add` — new row in history table
- `config_update` — config reloaded

No polling from the client. One persistent SSE connection drives all UI updates. On every SSE reconnect (including after a dropped connection), the client **must** call `GET /api/state` to re-sync before resuming event processing — events missed during the gap are not replayed.

---

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serve `index.html` |
| `GET` | `/public/*` | Serve static assets (`app.js`, `style.css`) |
| `GET` | `/api/state` | Full current state (initial load + SSE reconnect re-sync) |
| `GET` | `/api/events` | SSE stream |
| `POST` | `/api/worker/start` | Start the poll loop |
| `POST` | `/api/worker/stop` | Gracefully stop after current job |
| `POST` | `/api/job/cancel` | Cancel the active job |
| `POST` | `/api/job/dismiss` | Dismiss a "Ready for Review" job card (clears active job slot, does not affect the PR or ticket) |
| `GET` | `/api/config` | Return current config as structured JSON |
| `PUT` | `/api/config` | Accept structured JSON, validate with Zod, write YAML to disk. Returns `200 {ok: true}` on success or `400 {ok: false, errors: ZodError[]}` on validation failure. Config takes effect on the **next** poll cycle; the running worker is not hot-reloaded. |

**Security note:** All mutating routes (`POST`, `PUT`) check an optional `X-UI-Token` header when `ui.token` is set in config. If the token is configured and the header is missing or wrong, the server returns `401`. If `ui.host` is set to anything other than `127.0.0.1` or `::1`, the server logs a startup warning: "UI server bound to non-localhost address — consider setting ui.token for access control."

---

## Frontend

### Stack

Vanilla HTML + CSS + JS. No build step, no framework. Served as static files from `ui/public/`. This keeps the binary footprint small and avoids npm dependencies for the UI.

### Aesthetic — Mission Control Dark

- **Background:** `#0a0a0f` near-black with subtle grid texture
- **Surface:** `#111118` cards with `1px` borders at `#1e1e2e`
- **Active accent:** `#00e87a` electric green (running state)
- **Review accent:** `#a78bfa` purple (ready-for-review state)
- **Error accent:** `#ff4757` red
- **Fonts:** Syne (headings), Figtree (numerals, `tabular-nums`), JetBrains Mono (logs/code), DM Sans (UI labels). Loaded from Google Fonts CDN in `index.html`. Offline deployments can self-host the font files and update the `@import` URL.

### Layout

Sidebar navigation (fixed left, 220px) + main content area.

**Sidebar sections:**
1. Monitor (default view)
2. Settings

**Monitor view panels:**
- **Stat bar** (top): Tickets processed (session), avg duration, active job (0 or 1), pending tickets — Figtree numerals
- **Active Job card**: ticket id + title, branch pill, 3-stage progress bar (Pre-hooks → Agent → Post-hooks), live log stream (JetBrains Mono, scrolling), elapsed timer, Cancel button
- **Queue panel**: list of tickets currently in the `ready` status, populated from the poller's most recent poll results (cached in `WorkerState.pendingTickets`; refreshed each poll cycle)
- **History table**: last 50 jobs — id, title, status badge, duration, PR link, timestamp

**Settings view panels:**
- **Linear** section: Project ID, poll interval (stepper), 4 status name inputs (Ready/In Progress/Done/Failed) in a 2×2 grid
- **Executor** section: Type select (Claude Code / Codex), timeout stepper, retry dot selector (0–3 dots — click a dot to set the retry count; filled dots = enabled retries), repo path
- **Post-hooks** section: list builder with add/remove rows, variable chips `{id} {title} {raw_title} {branch}`
- **Pre-hooks** section: same list builder
- **Logging** section: log file path input
- **"View YAML" toggle**: reveals read-only YAML preview generated from current form values
- **Save** button: POSTs structured JSON to `/api/config`

### Job States

| State | Card appearance |
|-------|----------------|
| Running | Green border glow, green "● Running" pill, animated log stream |
| Ready for Review | Purple border glow, purple "✓ Ready for Review" pill, "↗ Open PR" + "Dismiss" action buttons |
| Failed | Red border glow, red "✗ Failed" pill, error message visible in log |
| Idle | Dim card, "Waiting for tickets…" message |

---

## Config Changes

Add optional `ui` section to the YAML schema:

```yaml
ui:
  enabled: true
  port: 3030           # default: 3030
  host: "127.0.0.1"   # default: localhost only; non-localhost binding logs a security warning
  token: "secret123"  # optional; if set, all mutating API calls require X-UI-Token header
```

If `ui` section is absent, the server does not start (zero overhead for headless deployments).

---

## File Structure (new files)

```
src/
└── ui/
    ├── server.ts       Bun.serve setup, route dispatch
    ├── state.ts        WorkerState singleton + SSE broadcaster
    ├── config-api.ts   Config read/write/validate endpoints
    └── public/
        ├── index.html  Single-page shell
        ├── app.js      SSE client, DOM updates, settings form logic
        └── style.css   All styles (CSS variables, layout, components)
```

Integration point: `src/index.ts` — after loading config, if `config.ui?.enabled`, call `startUiServer(config, workerState)` before starting the poller.

---

## Out of Scope

- Full authentication system (optional token is provided; full auth/session management is out of scope)
- Persistent job history across restarts
- Multi-worker aggregation view
- Mobile layout
