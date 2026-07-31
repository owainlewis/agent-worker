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
