# Agent-Worker Dashboard UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional web dashboard to the agent-worker process that provides real-time monitoring, job history, and a settings editor — all served by Bun's built-in HTTP server at `localhost:3030`.

**Architecture:** `WorkerState` singleton holds all runtime state and broadcasts SSE events to connected browser clients. The HTTP server (`Bun.serve`) is started in `src/index.ts` when `ui.enabled: true` is set in config. The scheduler and poller are extended with optional callbacks to push state updates; the logger is wrapped per-job to pipe log lines into the SSE stream.

**Tech Stack:** TypeScript, Bun 1.x, Zod v4 (`zod/v4`), vanilla HTML/CSS/JS (no frontend build step), `bun:test` for tests.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/ui/state.ts` | WorkerState types, factory, SSE broadcaster |
| Create | `src/ui/server.ts` | Bun.serve, route dispatch, token auth |
| Modify | `src/config.ts` | Export `ConfigFileSchema` (no env dependency at module level) |
| Create | `src/ui/config-api.ts` | Config read / Zod-validate / write-YAML helpers |
| Create | `src/ui/public/index.html` | Single-page shell, Google Fonts |
| Create | `src/ui/public/style.css` | Mission Control Dark theme, all component styles |
| Create | `src/ui/public/app.js` | SSE client, DOM updates, settings form, YAML preview |
| Modify | `src/config.ts` | Add `UiSchema`; export updated `Config` type |
| Modify | `src/poller.ts` | Add optional `onPollResult` callback |
| Modify | `src/scheduler.ts` | Add optional `workerState` param; emit job events |
| Modify | `src/index.ts` | Wire WorkerState, UI server, poller, scheduler |
| Create | `test/ui-state.test.ts` | WorkerState mutations + SSE emit |
| Create | `test/ui-config-api.test.ts` | Config read/validate/write |
| Create | `test/ui-server.test.ts` | HTTP routes + auth |

---

## Task 1: WorkerState singleton

**Files:**
- Create: `src/ui/state.ts`
- Create: `test/ui-state.test.ts`

- [ ] **Step 1.1: Write the failing tests**

```typescript
// test/ui-state.test.ts
import { describe, test, expect } from "bun:test";
import { createWorkerState } from "../src/ui/state.ts";

describe("createWorkerState", () => {
  test("initial status is idle", () => {
    const state = createWorkerState();
    expect(state.getSnapshot().workerStatus).toBe("idle");
  });

  test("setWorkerStatus updates snapshot and broadcasts event", () => {
    const state = createWorkerState();
    const events: unknown[] = [];
    state.subscribe((e) => events.push(e));
    state.setWorkerStatus("running");
    expect(state.getSnapshot().workerStatus).toBe("running");
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("worker_status");
  });

  test("setActiveJob stores job and broadcasts job_start", () => {
    const state = createWorkerState();
    const events: unknown[] = [];
    state.subscribe((e) => events.push(e));
    state.setActiveJob({ id: "abc", identifier: "ENG-1", title: "Test", branch: "agent/task-ENG-1", stage: "pre-hook", startedAt: Date.now(), logLines: [] });
    expect(state.getSnapshot().activeJob?.identifier).toBe("ENG-1");
    expect((events[0] as { type: string }).type).toBe("job_start");
  });

  test("appendLog adds line to activeJob and broadcasts job_log", () => {
    const state = createWorkerState();
    state.setActiveJob({ id: "abc", identifier: "ENG-1", title: "Test", branch: "agent/task-ENG-1", stage: "pre-hook", startedAt: Date.now(), logLines: [] });
    const events: unknown[] = [];
    state.subscribe((e) => events.push(e));
    state.appendLog("hello");
    expect(state.getSnapshot().activeJob?.logLines).toContain("hello");
    expect((events[0] as { type: string }).type).toBe("job_log");
  });

  test("setJobStage updates stage and broadcasts job_stage", () => {
    const state = createWorkerState();
    state.setActiveJob({ id: "abc", identifier: "ENG-1", title: "Test", branch: "b", stage: "pre-hook", startedAt: Date.now(), logLines: [] });
    const events: unknown[] = [];
    state.subscribe((e) => events.push(e));
    state.setJobStage("executor");
    expect(state.getSnapshot().activeJob?.stage).toBe("executor");
    expect((events[0] as { type: string }).type).toBe("job_stage");
  });

  test("completeJob clears activeJob, adds to history (max 50), broadcasts job_end + history_add", () => {
    const state = createWorkerState();
    state.setActiveJob({ id: "abc", identifier: "ENG-1", title: "Test", branch: "b", stage: "post-hook", startedAt: Date.now() - 1000, logLines: [] });
    const events: unknown[] = [];
    state.subscribe((e) => events.push(e));
    state.completeJob({ success: true, prUrl: "https://github.com/org/repo/pull/1" });
    expect(state.getSnapshot().activeJob).toBeNull();
    expect(state.getSnapshot().history).toHaveLength(1);
    expect(state.getSnapshot().history[0]!.status).toBe("done");
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("job_end");
    expect(types).toContain("history_add");
  });

  test("completeJob caps history at 50 entries", () => {
    const state = createWorkerState();
    for (let i = 0; i < 55; i++) {
      state.setActiveJob({ id: `id-${i}`, identifier: `ENG-${i}`, title: `T${i}`, branch: "b", stage: "executor", startedAt: Date.now(), logLines: [] });
      state.completeJob({ success: true });
    }
    expect(state.getSnapshot().history.length).toBeLessThanOrEqual(50);
  });

  test("errorJob broadcasts job_error and adds failed history row", () => {
    const state = createWorkerState();
    state.setActiveJob({ id: "abc", identifier: "ENG-1", title: "Test", branch: "b", stage: "executor", startedAt: Date.now(), logLines: [] });
    const events: unknown[] = [];
    state.subscribe((e) => events.push(e));
    state.errorJob("subprocess crashed");
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("job_error");
    expect(types).toContain("history_add");
    expect(state.getSnapshot().history[0]!.status).toBe("failed");
  });

  test("setPendingTickets updates snapshot and broadcasts pending_tickets event", () => {
    const state = createWorkerState();
    const events: unknown[] = [];
    state.subscribe((e) => events.push(e));
    const tickets = [{ id: "1", identifier: "ENG-5", title: "Do thing", description: undefined }];
    state.setPendingTickets(tickets);
    expect(state.getSnapshot().pendingTickets).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("pending_tickets");
  });

  test("unsubscribe removes listener", () => {
    const state = createWorkerState();
    const events: unknown[] = [];
    const unsub = state.subscribe((e) => events.push(e));
    unsub();
    state.setWorkerStatus("running");
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/ui-state.test.ts 2>&1 | head -20
```
Expected: `Cannot find module '../src/ui/state.ts'`

- [ ] **Step 1.3: Create `src/ui/state.ts`**

```typescript
// src/ui/state.ts
import type { Ticket } from "../providers/types.ts";

export type WorkerStatus = "idle" | "running" | "stopped";
export type JobStage = "pre-hook" | "executor" | "post-hook";
export type JobStatus = "done" | "failed" | "review";
// "review" = agent completed successfully and a PR was opened; the card waits for human dismissal

export interface ActiveJob {
  id: string;
  identifier: string;
  title: string;
  branch: string;
  stage: JobStage;
  startedAt: number;
  logLines: string[];
}

export interface JobHistoryRow {
  id: string;
  identifier: string;
  title: string;
  status: JobStatus;
  durationMs: number;
  prUrl?: string;
  completedAt: number;
}

export type UiEvent =
  | { type: "worker_status"; status: WorkerStatus }
  | { type: "job_start"; job: ActiveJob }
  | { type: "job_log"; line: string }
  | { type: "job_stage"; stage: JobStage }
  | { type: "job_end"; success: boolean; prUrl?: string }
  | { type: "job_error"; error: string }
  | { type: "history_add"; row: JobHistoryRow }
  | { type: "pending_tickets"; count: number }
  | { type: "config_update" };

export interface WorkerStateSnapshot {
  workerStatus: WorkerStatus;
  activeJob: ActiveJob | null;
  pendingTickets: Ticket[];
  history: JobHistoryRow[];
  ticketsProcessed: number;
  totalDurationMs: number;
}

export interface WorkerState {
  getSnapshot(): WorkerStateSnapshot;
  subscribe(listener: (event: UiEvent) => void): () => void;
  setWorkerStatus(status: WorkerStatus): void;
  setActiveJob(job: ActiveJob): void;
  setJobStage(stage: JobStage): void;
  appendLog(line: string): void;
  completeJob(opts: { success: boolean; prUrl?: string; review?: boolean }): void;
  errorJob(error: string): void;
  dismissJob(): void;
  setPendingTickets(tickets: Ticket[]): void;
  notifyConfigUpdate(): void;
}

export function createWorkerState(): WorkerState {
  const listeners = new Set<(event: UiEvent) => void>();
  let workerStatus: WorkerStatus = "idle";
  let activeJob: ActiveJob | null = null;
  const pendingTickets: Ticket[] = [];
  const history: JobHistoryRow[] = [];
  let ticketsProcessed = 0;
  let totalDurationMs = 0;

  function broadcast(event: UiEvent) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* ignore listener errors */ }
    }
  }

  return {
    getSnapshot() {
      return {
        workerStatus,
        activeJob: activeJob ? { ...activeJob, logLines: [...activeJob.logLines] } : null,
        pendingTickets: [...pendingTickets],
        history: [...history],
        ticketsProcessed,
        totalDurationMs,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setWorkerStatus(status) {
      workerStatus = status;
      broadcast({ type: "worker_status", status });
    },

    setActiveJob(job) {
      activeJob = { ...job };
      broadcast({ type: "job_start", job: { ...job } });
    },

    setJobStage(stage) {
      if (activeJob) {
        activeJob.stage = stage;
        broadcast({ type: "job_stage", stage });
      }
    },

    appendLog(line) {
      if (activeJob) {
        activeJob.logLines.push(line);
        broadcast({ type: "job_log", line });
      }
    },

    completeJob({ success, prUrl, review }) {
      if (!activeJob) return;
      const durationMs = Date.now() - activeJob.startedAt;
      // "review" status = success + PR opened; card stays visible until dismissed
      const status: JobStatus = !success ? "failed" : (review ? "review" : "done");
      const row: JobHistoryRow = {
        id: activeJob.id,
        identifier: activeJob.identifier,
        title: activeJob.title,
        status,
        durationMs,
        prUrl,
        completedAt: Date.now(),
      };
      // Keep last 50
      history.unshift(row);
      if (history.length > 50) history.splice(50);
      ticketsProcessed++;
      totalDurationMs += durationMs;
      broadcast({ type: "job_end", success, prUrl });
      broadcast({ type: "history_add", row });
      activeJob = null;
    },

    errorJob(error) {
      if (!activeJob) return;
      const durationMs = Date.now() - activeJob.startedAt;
      const row: JobHistoryRow = {
        id: activeJob.id,
        identifier: activeJob.identifier,
        title: activeJob.title,
        status: "failed",
        durationMs,
        completedAt: Date.now(),
      };
      history.unshift(row);
      if (history.length > 50) history.splice(50);
      ticketsProcessed++;
      totalDurationMs += durationMs;
      broadcast({ type: "job_error", error });
      broadcast({ type: "history_add", row });
      activeJob = null;
    },

    dismissJob() {
      activeJob = null;
      // Broadcast so SSE clients clear the card immediately
      broadcast({ type: "job_end", success: true });
    },

    setPendingTickets(tickets) {
      pendingTickets.splice(0, pendingTickets.length, ...tickets);
      broadcast({ type: "pending_tickets", count: tickets.length });
    },

    notifyConfigUpdate() {
      broadcast({ type: "config_update" });
    },
  };
}
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/ui-state.test.ts
```
Expected: all tests pass

- [ ] **Step 1.5: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/ui/state.ts test/ui-state.test.ts && git commit -m "feat(ui): WorkerState singleton with SSE broadcaster"
```

---

## Task 2: Config schema — add `ui` section

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 2.1: Write the failing tests** (add to bottom of `test/config.test.ts`)

```typescript
// Add inside the describe("loadConfig") block in test/config.test.ts

test("parses ui section with all fields", () => {
  const yaml = `
linear:
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
ui:
  enabled: true
  port: 4000
  host: "0.0.0.0"
  token: "secret"
`;
  const config = loadConfig(writeConfig(yaml));
  expect(config.ui?.enabled).toBe(true);
  expect(config.ui?.port).toBe(4000);
  expect(config.ui?.host).toBe("0.0.0.0");
  expect(config.ui?.token).toBe("secret");
});

test("ui section defaults port to 3030 and host to 127.0.0.1", () => {
  const yaml = `
linear:
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
ui:
  enabled: true
`;
  const config = loadConfig(writeConfig(yaml));
  expect(config.ui?.port).toBe(3030);
  expect(config.ui?.host).toBe("127.0.0.1");
  expect(config.ui?.token).toBeUndefined();
});

test("ui section is optional — omitting it leaves ui undefined", () => {
  const yaml = `
linear:
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;
  const config = loadConfig(writeConfig(yaml));
  expect(config.ui).toBeUndefined();
});
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/config.test.ts 2>&1 | tail -20
```
Expected: new tests fail with assertion errors

- [ ] **Step 2.3: Export `ConfigFileSchema` from `src/config.ts` and add `UiSchema`**

`ConfigFileSchema` itself has no env-var dependencies (only `loadConfig` does). Export it so `config-api.ts` can import it directly, avoiding schema duplication and drift.

Add `export` to the `ConfigFileSchema` declaration:
```typescript
export const ConfigFileSchema = z.object({ ... }); // was: const ConfigFileSchema
```

Also add `export type ConfigJson = z.infer<typeof ConfigFileSchema>;`

Add this before `ConfigFileSchema`:
```typescript
const UiSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().positive().default(3030),
  host: z.string().default("127.0.0.1"),
  token: z.string().optional(),
});
```

Change `ConfigFileSchema` to include:
```typescript
const ConfigFileSchema = z.object({
  linear: LinearSchema,
  repo: RepoSchema,
  hooks: HooksSchema,
  executor: ExecutorSchema,
  log: LogSchema,
  ui: UiSchema.optional(),
});
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/config.test.ts
```
Expected: all tests pass

- [ ] **Step 2.5: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/config.ts test/config.test.ts && git commit -m "feat(ui): add optional ui config section (port, host, token)"
```

---

## Task 3: Config API — read / validate / write

**Files:**
- Create: `src/ui/config-api.ts`
- Create: `test/ui-config-api.test.ts`

- [ ] **Step 3.1: Write the failing tests**

```typescript
// test/ui-config-api.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readConfigFile, writeConfigFile } from "../src/ui/config-api.ts";

let tmpDir: string;
const VALID_YAML = `
linear:
  project_id: "proj-123"
  poll_interval_seconds: 60
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
executor:
  type: claude
  timeout_seconds: 300
  retries: 0
hooks:
  pre: []
  post:
    - "git add -A"
    - "git commit -m '{id}'"
log:
  level: info
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-api-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe("readConfigFile", () => {
  test("returns structured JSON from valid YAML", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const result = readConfigFile(path);
    expect(result.linear.project_id).toBe("proj-123");
    expect(result.executor.type).toBe("claude");
    expect(result.hooks.post).toHaveLength(2);
  });
});

describe("writeConfigFile", () => {
  test("writes valid JSON as YAML and round-trips correctly", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const original = readConfigFile(path);
    original.linear.poll_interval_seconds = 120;
    writeConfigFile(path, original);
    const updated = readConfigFile(path);
    expect(updated.linear.poll_interval_seconds).toBe(120);
  });

  test("throws ZodError for invalid config (bad executor type)", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const config = readConfigFile(path);
    (config.executor as { type: string }).type = "invalid-executor";
    expect(() => writeConfigFile(path, config)).toThrow();
  });

  test("throws ZodError for retries > 3", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const config = readConfigFile(path);
    config.executor.retries = 5;
    expect(() => writeConfigFile(path, config)).toThrow();
  });
});
```

- [ ] **Step 3.2: Run tests to confirm they fail**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/ui-config-api.test.ts 2>&1 | head -10
```
Expected: `Cannot find module '../src/ui/config-api.ts'`

- [ ] **Step 3.3: Create `src/ui/config-api.ts`**

```typescript
// src/ui/config-api.ts
import { readFileSync, writeFileSync } from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
// Import the shared schema from config.ts — single source of truth, no drift.
// Note: importing config.ts is safe here because ConfigFileSchema itself has
// no env-var side effects; only loadConfig() reads process.env.
import { ConfigFileSchema, type ConfigJson } from "../config.ts";
export type { ConfigJson };

export function readConfigFile(filePath: string): ConfigJson {
  const text = readFileSync(filePath, "utf-8");
  const raw = parseYaml(text) as Record<string, unknown>;
  return ConfigFileSchema.parse(raw);
}

export function writeConfigFile(filePath: string, config: unknown): void {
  // Validate before writing — throws ZodError on invalid input
  const validated = ConfigFileSchema.parse(config);
  const yamlText = stringifyYaml(validated);
  writeFileSync(filePath, yamlText, "utf-8");
}
```

- [ ] **Step 3.4: Run tests to confirm they pass**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/ui-config-api.test.ts
```
Expected: all tests pass

- [ ] **Step 3.5: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/ui/config-api.ts test/ui-config-api.test.ts && git commit -m "feat(ui): config read/validate/write API"
```

---

## Task 4: HTTP server

**Files:**
- Create: `src/ui/server.ts`
- Create: `test/ui-server.test.ts`

- [ ] **Step 4.1: Write the failing tests**

```typescript
// test/ui-server.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createWorkerState } from "../src/ui/state.ts";
import { startUiServer } from "../src/ui/server.ts";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const VALID_YAML = `
linear:
  project_id: "proj-123"
  poll_interval_seconds: 60
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;

let server: { stop(): void };
let configPath: string;
let tmpDir: string;
const PORT = 13031; // use non-default port to avoid conflicts

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ui-server-test-"));
  configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, VALID_YAML);
});

afterEach(() => {
  server?.stop();
  rmSync(tmpDir, { recursive: true });
});

describe("GET /api/state", () => {
  test("returns 200 with snapshot JSON", async () => {
    const state = createWorkerState();
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/state`);
    expect(res.status).toBe(200);
    const body = await res.json() as { workerStatus: string };
    expect(body.workerStatus).toBe("idle");
  });
});

describe("GET /api/config", () => {
  test("returns 200 with structured config", async () => {
    const state = createWorkerState();
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json() as { linear: { project_id: string } };
    expect(body.linear.project_id).toBe("proj-123");
  });
});

describe("PUT /api/config", () => {
  test("returns 200 and persists change", async () => {
    const state = createWorkerState();
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1" });
    const current = await fetch(`http://127.0.0.1:${PORT}/api/config`).then((r) => r.json()) as Record<string, unknown>;
    (current as { linear: { poll_interval_seconds: number } }).linear.poll_interval_seconds = 90;
    const res = await fetch(`http://127.0.0.1:${PORT}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current),
    });
    expect(res.status).toBe(200);
    const check = await fetch(`http://127.0.0.1:${PORT}/api/config`).then((r) => r.json()) as { linear: { poll_interval_seconds: number } };
    expect(check.linear.poll_interval_seconds).toBe(90);
  });

  test("returns 400 for invalid config", async () => {
    const state = createWorkerState();
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bad: "config" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe("POST /api/job/dismiss", () => {
  test("returns 200 and clears activeJob", async () => {
    const state = createWorkerState();
    state.setActiveJob({ id: "x", identifier: "ENG-1", title: "T", branch: "b", stage: "executor", startedAt: Date.now(), logLines: [] });
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/job/dismiss`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(state.getSnapshot().activeJob).toBeNull();
  });
});

describe("GET /api/events SSE delivery", () => {
  test("delivers events pushed to WorkerState over the SSE stream", async () => {
    const state = createWorkerState();
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1" });

    const received: string[] = [];
    const res = await fetch(`http://127.0.0.1:${PORT}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read the stream in a background task while we push events
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const readTask = (async () => {
      // Read up to 3 chunks then stop
      for (let i = 0; i < 3; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        received.push(decoder.decode(value));
      }
      reader.cancel();
    })();

    // Give the connection time to establish, then push a state change
    await new Promise((r) => setTimeout(r, 50));
    state.setWorkerStatus("running");
    await new Promise((r) => setTimeout(r, 50));

    await readTask;

    // At least one chunk should be the worker_status event
    const allText = received.join("");
    expect(allText).toContain("worker_status");
  });
});

describe("token auth", () => {
  test("PUT /api/config returns 401 when token required but missing", async () => {
    const state = createWorkerState();
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1", token: "secret" });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("PUT /api/config succeeds with correct token", async () => {
    const state = createWorkerState();
    server = startUiServer({ state, configPath, port: PORT, host: "127.0.0.1", token: "secret" });
    const current = await fetch(`http://127.0.0.1:${PORT}/api/config`, {
      headers: { "X-UI-Token": "secret" },
    }).then((r) => r.json()) as Record<string, unknown>;
    const res = await fetch(`http://127.0.0.1:${PORT}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-UI-Token": "secret" },
      body: JSON.stringify(current),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 4.2: Run tests to confirm they fail**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/ui-server.test.ts 2>&1 | head -10
```
Expected: `Cannot find module '../src/ui/server.ts'`

- [ ] **Step 4.3: Create `src/ui/server.ts`**

```typescript
// src/ui/server.ts
import { join } from "path";
import type { WorkerState, UiEvent } from "./state.ts";
import { readConfigFile, writeConfigFile } from "./config-api.ts";

const PUBLIC_DIR = join(import.meta.dir, "public");

export interface UiServerOptions {
  state: WorkerState;
  configPath: string;
  port?: number;
  host?: string;
  token?: string;
  controls?: {
    startWorker?: () => void;
    stopWorker?: () => void;
    cancelJob?: () => void;
  };
}

function isMutating(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
}

function checkAuth(req: Request, token?: string): Response | null {
  if (!token) return null;
  if (isMutating(req.method)) {
    if (req.headers.get("X-UI-Token") !== token) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return null;
}

export function startUiServer(options: UiServerOptions): { stop(): void } {
  const { state, configPath, port = 3030, host = "127.0.0.1", token, controls } = options;

  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.warn(`[ui] WARNING: UI server bound to ${host} — consider setting ui.token for access control`);
  }

  // SSE clients: each connected browser registers a controller to push chunks into.
  // We subscribe once to WorkerState and fan out to all connected clients.
  const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const unsubscribe = state.subscribe((event) => {
    const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const ctrl of sseControllers) {
      try { ctrl.enqueue(chunk); } catch { sseControllers.delete(ctrl); }
    }
  });

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Auth check for mutating routes
      const authError = checkAuth(req, token);
      if (authError) return authError;

      // Static files
      if (pathname === "/" || pathname === "/index.html") {
        const file = Bun.file(join(PUBLIC_DIR, "index.html"));
        return new Response(file);
      }
      if (pathname.startsWith("/public/")) {
        const file = Bun.file(join(PUBLIC_DIR, pathname.slice("/public/".length)));
        return new Response(file);
      }

      // API routes
      if (pathname === "/api/state" && req.method === "GET") {
        return Response.json(state.getSnapshot());
      }

      if (pathname === "/api/events" && req.method === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sseControllers.add(controller);
            // Initial heartbeat so the browser's EventSource confirms the connection
            controller.enqueue(encoder.encode(`: connected\n\n`));
          },
          cancel(controller) {
            sseControllers.delete(controller as ReadableStreamDefaultController<Uint8Array>);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      if (pathname === "/api/config" && req.method === "GET") {
        try {
          const config = readConfigFile(configPath);
          return Response.json(config);
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      }

      if (pathname === "/api/config" && req.method === "PUT") {
        try {
          const body = await req.json() as unknown;
          writeConfigFile(configPath, body);
          state.notifyConfigUpdate();
          return Response.json({ ok: true });
        } catch (err) {
          // Return Zod issues array if available, otherwise string
          const errors = (err instanceof Error && "issues" in err)
            ? (err as { issues: unknown[] }).issues
            : [String(err)];
          return Response.json({ ok: false, errors }, { status: 400 });
        }
      }

      if (pathname === "/api/worker/start" && req.method === "POST") {
        controls?.startWorker?.();
        return Response.json({ ok: true });
      }

      if (pathname === "/api/worker/stop" && req.method === "POST") {
        controls?.stopWorker?.();
        return Response.json({ ok: true });
      }

      if (pathname === "/api/job/cancel" && req.method === "POST") {
        controls?.cancelJob?.();
        return Response.json({ ok: true });
      }

      if (pathname === "/api/job/dismiss" && req.method === "POST") {
        state.dismissJob();
        return Response.json({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    stop() {
      unsubscribe();
      server.stop();
    },
  };
}
```

- [ ] **Step 4.4: Create placeholder static files** (so the server can start without crashing)

```bash
mkdir -p /Users/robin/Desktop/agent-worker/src/ui/public
echo '<!doctype html><html><body>Loading...</body></html>' > /Users/robin/Desktop/agent-worker/src/ui/public/index.html
touch /Users/robin/Desktop/agent-worker/src/ui/public/app.js
touch /Users/robin/Desktop/agent-worker/src/ui/public/style.css
```

- [ ] **Step 4.5: Run tests to confirm they pass**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/ui-server.test.ts
```
Expected: all tests pass

- [ ] **Step 4.6: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/ui/server.ts src/ui/public/ test/ui-server.test.ts && git commit -m "feat(ui): HTTP server with SSE, config API, and token auth"
```

---

## Task 5: Poller integration

**Files:**
- Modify: `src/poller.ts`
- Modify: `test/poller.test.ts`

- [ ] **Step 5.1: Write the failing test** (add to `test/poller.test.ts`)

Read the existing file first, then add one test verifying `onPollResult` is called with the discovered tickets:

```typescript
// Add to test/poller.test.ts — inside an appropriate describe block or at the end

test("calls onPollResult with fetched tickets on each cycle", async () => {
  const tickets = [{ id: "1", identifier: "ENG-1", title: "T", description: undefined }];
  const pollResults: unknown[][] = [];
  const poller = createPoller({
    provider: {
      fetchReadyTickets: async () => tickets,
      transitionStatus: async () => {},
      postComment: async () => {},
    },
    intervalMs: 50,
    logger: silentLogger,
    onTicket: async () => {},
    onPollResult: (found) => { pollResults.push(found); },
  });

  const stopPromise = poller.start();
  await new Promise((r) => setTimeout(r, 80));
  poller.stop();
  await stopPromise;

  expect(pollResults.length).toBeGreaterThan(0);
  expect(pollResults[0]).toEqual(tickets);
});
```

Note: check `test/poller.test.ts` for the existing `silentLogger` definition and follow the same pattern.

- [ ] **Step 5.2: Run tests to confirm new test fails**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/poller.test.ts 2>&1 | tail -15
```

- [ ] **Step 5.3: Add `onPollResult` to `src/poller.ts`**

In the `createPoller` options type, add:
```typescript
onPollResult?: (tickets: Ticket[]) => void;
```

In the poll loop, after `const tickets = await options.provider.fetchReadyTickets();`, add:
```typescript
options.onPollResult?.(tickets);
```

- [ ] **Step 5.4: Run tests to confirm they pass**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/poller.test.ts
```
Expected: all tests pass

- [ ] **Step 5.5: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/poller.ts test/poller.test.ts && git commit -m "feat(ui): add onPollResult callback to poller for UI pending-ticket tracking"
```

---

## Task 6: Scheduler integration — emit job events

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `test/scheduler.test.ts`

The scheduler needs to:
1. Call `state.setActiveJob()` when a ticket is claimed
2. Wrap the logger to intercept log lines → `state.appendLog()`
3. Call `state.setJobStage()` at each pipeline phase
4. Call `state.completeJob()` or `state.errorJob()` at the end

The cleanest approach: wrap the logger. A logger wrapper calls `state.appendLog(line)` for every `info` message that has a `line` field (those are executor subprocess lines) plus key milestone messages.

- [ ] **Step 6.1: Write failing tests** (add to `test/scheduler.test.ts`)

Read the existing file first and follow existing patterns. Add:

```typescript
// Add to test/scheduler.test.ts

test("emits job_start and job_end events to workerState on success", async () => {
  const { createWorkerState } = await import("../src/ui/state.ts");
  const state = createWorkerState();
  const events: string[] = [];
  state.subscribe((e) => events.push(e.type));

  await processTicket({
    ticket: { id: "1", identifier: "ENG-1", title: "Test", description: "do it" },
    provider: makeSuccessProvider(),  // use existing helper or define inline
    config: makeConfig(),             // use existing helper or define inline
    logger: silentLogger,
    executor: alwaysSucceedExecutor,  // use existing or define inline
    workerState: state,
  });

  expect(events).toContain("job_start");
  expect(events).toContain("job_end");
});

test("emits job_error when executor fails", async () => {
  const { createWorkerState } = await import("../src/ui/state.ts");
  const state = createWorkerState();
  const events: string[] = [];
  state.subscribe((e) => events.push(e.type));

  await processTicket({
    ticket: { id: "1", identifier: "ENG-1", title: "Test", description: "do it" },
    provider: makeSuccessProvider(),
    config: makeConfig(),
    logger: silentLogger,
    executor: alwaysFailExecutor,
    workerState: state,
  });

  expect(events).toContain("job_start");
  // job_end fires with success:false, not job_error (job_error is for thrown exceptions)
  expect(events).toContain("job_end");
});
```

Note: check `test/scheduler.test.ts` for existing helpers (`makeConfig`, `silentLogger`, etc.) and reuse them. Do not duplicate.

- [ ] **Step 6.2: Run tests to confirm new tests fail**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/scheduler.test.ts 2>&1 | tail -20
```

- [ ] **Step 6.3: Modify `src/scheduler.ts`**

Add `workerState?: WorkerState` to the `processTicket` options type (import from `./ui/state.ts`).

After the successful claim, add:
```typescript
workerState?.setActiveJob({
  id: ticket.id,
  identifier: ticket.identifier,
  title: ticket.title,
  branch: `agent/task-${ticket.identifier}`,
  stage: "pre-hook",
  startedAt: Date.now(),
  logLines: [],
});
```

Wrap the logger for the duration of this ticket's execution:
```typescript
const jobLogger: Logger = {
  debug: (msg, ctx?) => { logger.debug(msg, ctx); workerState?.appendLog(`[debug] ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
  info:  (msg, ctx?) => { logger.info(msg, ctx);  workerState?.appendLog(`[info]  ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
  warn:  (msg, ctx?) => { logger.warn(msg, ctx);  workerState?.appendLog(`[warn]  ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
  error: (msg, ctx?) => { logger.error(msg, ctx); workerState?.appendLog(`[error] ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
};
```

Use `jobLogger` instead of `logger` when calling `executePipeline`.

After the retry loop, replace the final status update:
- On success: detect a PR URL in the last output lines (look for `https://github.com` in `lastResult.output`). If found, call `workerState?.completeJob({ success: true, prUrl, review: true })` — this triggers the purple "Ready for Review" card state. If no PR URL, call `workerState?.completeJob({ success: true })`.
- On failure: call `workerState?.completeJob({ success: false })` before transitioning
- If pipeline threw (catch block): call `workerState?.errorJob(error message)`

Example PR URL detection:
```typescript
const prUrlMatch = lastResult?.output?.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
const prUrl = prUrlMatch?.[0];
workerState?.completeJob({ success: true, prUrl, review: !!prUrl });
```

- [ ] **Step 6.4: Run all tests**

```bash
cd /Users/robin/Desktop/agent-worker && bun test test/scheduler.test.ts test/ui-state.test.ts
```
Expected: all pass

- [ ] **Step 6.5: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/scheduler.ts test/scheduler.test.ts && git commit -m "feat(ui): emit job lifecycle events from scheduler to WorkerState"
```

---

## Task 7: Wire WorkerState into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

No new tests — this is the integration wiring. The existing tests cover the individual components.

- [ ] **Step 7.1: Modify `src/index.ts`**

Import new modules:
```typescript
import { createWorkerState } from "./ui/state.ts";
import { startUiServer } from "./ui/server.ts";
```

After `const logger = createLogger(...)` and before creating the provider, add:
```typescript
const workerState = createWorkerState();

// Declare poller as let so the UI server controls closure can reference it
// before createPoller is called below.
let poller: ReturnType<typeof createPoller>;

let uiServer: { stop(): void } | null = null;
if (config.ui?.enabled) {
  uiServer = startUiServer({
    state: workerState,
    configPath,
    port: config.ui.port,
    host: config.ui.host,
    token: config.ui.token,
    controls: {
      startWorker: () => { poller?.start(); },
      stopWorker:  () => { poller?.stop(); },
      cancelJob:   () => { poller?.stop(); }, // v1: stop accepting new jobs; in-flight job runs to completion
    },
  });
  logger.info("UI dashboard started", {
    url: `http://${config.ui.host}:${config.ui.port}`,
  });
}
```

Then assign the poller (not `const`):
```typescript
poller = createPoller({ ... });
```

Pass `workerState` to the `onTicket` callback in the poller options:
```typescript
onPollResult: (tickets) => { workerState.setPendingTickets(tickets); },
onTicket: async (ticket) => {
  await processTicket({ ticket, provider, config, logger, workerState });
},
```

Update status on start/stop:
- In `poller.start().then(...)` → after start resolves: `workerState.setWorkerStatus("stopped")`
- In SIGINT/SIGTERM handler: `workerState.setWorkerStatus("stopped")`
- Before calling `poller.start()`: `workerState.setWorkerStatus("running")`

Add to cleanup in the signal handlers:
```typescript
uiServer?.stop();
```

- [ ] **Step 7.2: Verify all existing tests still pass**

```bash
cd /Users/robin/Desktop/agent-worker && bun test
```
Expected: all tests pass

- [ ] **Step 7.3: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/index.ts && git commit -m "feat(ui): wire WorkerState and UI server into main process"
```

---

## Task 8: Frontend — HTML, CSS, JS

**Files:**
- Modify: `src/ui/public/index.html`
- Modify: `src/ui/public/style.css`
- Modify: `src/ui/public/app.js`

The design was prototyped in `.superpowers/brainstorm/dashboard-v2.html`. Extract and split it into the three separate files. No new tests — this is UI code.

- [ ] **Step 8.0: Verify the prototype exists**

```bash
ls /Users/robin/Desktop/agent-worker/.superpowers/brainstorm/dashboard-v2.html
```
Expected: file exists. If missing, invoke the `frontend-design` skill to regenerate it using the spec's aesthetic section before proceeding.

- [ ] **Step 8.1: Write `src/ui/public/index.html`**

Extract the HTML skeleton from `dashboard-v2.html`:
- `<head>`: Google Fonts import (Syne, Figtree, JetBrains Mono, DM Sans), `<link rel="stylesheet" href="/public/style.css">`, viewport meta
- `<body>`: sidebar + main content DOM structure, status indicators, stat cards, active job card, queue panel, history table, settings form sections
- End of `<body>`: `<script src="/public/app.js"></script>`

Update all static asset hrefs to use `/public/` prefix.

- [ ] **Step 8.2: Write `src/ui/public/style.css`**

Extract all `<style>` content from `dashboard-v2.html`.

Key CSS variables to verify are present:
```css
:root {
  --bg: #0a0a0f;
  --surface: #111118;
  --border: #1e1e2e;
  --green: #00e87a;
  --purple: #a78bfa;
  --red: #ff4757;
  --text: #e2e8f0;
  --muted: #64748b;
}
```

- [ ] **Step 8.3: Write `src/ui/public/app.js`**

Extract all `<script>` content from `dashboard-v2.html` and update to use the real API:

1. **Initial load**: `fetch('/api/state')` → populate DOM
2. **SSE connection**:
```javascript
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => handleEvent(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    // Re-sync state on reconnect
    fetch('/api/state').then(r => r.json()).then(populateFromSnapshot);
    setTimeout(connectSSE, 2000);
  };
}
connectSSE();
```
3. **Event handlers**: update DOM for each event type (`worker_status`, `job_start`, `job_log`, `job_stage`, `job_end`, `job_error`, `history_add`, `config_update`)
4. **Settings form**: on load, call `GET /api/config` and populate all form fields; on save, serialize form → `PUT /api/config`; "View YAML" toggle calls `jsyaml.dump()` (include CDN link for js-yaml in index.html) or construct YAML manually
5. **Control buttons**: start/stop call `POST /api/worker/start|stop`; cancel calls `POST /api/job/cancel`; dismiss calls `POST /api/job/dismiss`

- [ ] **Step 8.4: Manual smoke test**

```bash
# Start with a real or dummy config
cd /Users/robin/Desktop/agent-worker && LINEAR_API_KEY=test bun run src/index.ts --config agent-worker.example.yaml
```

Open `http://localhost:3030` in the browser and verify:
- Dashboard loads without console errors
- Sidebar navigation switches between Monitor and Settings
- Settings form populates from the config file
- "View YAML" toggle shows generated YAML

- [ ] **Step 8.5: Commit**

```bash
cd /Users/robin/Desktop/agent-worker && git add src/ui/public/ && git commit -m "feat(ui): dashboard frontend — Mission Control Dark theme"
```

---

## Task 9: Run full test suite + final check

- [ ] **Step 9.1: Run all tests**

```bash
cd /Users/robin/Desktop/agent-worker && bun test
```
Expected: all tests pass, no failures

- [ ] **Step 9.2: Build binary to verify it compiles**

```bash
cd /Users/robin/Desktop/agent-worker && bun run build 2>&1 | tail -10
```
Expected: `dist/agent-worker` written with no errors

- [ ] **Step 9.3: Commit if anything was tweaked**

```bash
cd /Users/robin/Desktop/agent-worker && git status
```
Commit any remaining changes.

---

## Acceptance Criteria

- `bun test` passes with no failures
- `bun run build` compiles to binary without errors
- `http://localhost:3030` loads the dashboard when `ui.enabled: true`
- Monitor view updates in real-time when a ticket is processed (SSE)
- Settings form reads and writes the config YAML file
- `ui` section is fully optional — omitting it has zero runtime overhead
