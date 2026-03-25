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

  test("completeJob with review:true sets history status to review", () => {
    const state = createWorkerState();
    state.setActiveJob({ id: "abc", identifier: "ENG-2", title: "PR Task", branch: "b", stage: "post-hook", startedAt: Date.now() - 1000, logLines: [] });
    state.completeJob({ success: true, prUrl: "https://github.com/org/repo/pull/42", review: true });
    expect(state.getSnapshot().history[0]!.status).toBe("review");
    expect(state.getSnapshot().history[0]!.prUrl).toBe("https://github.com/org/repo/pull/42");
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
