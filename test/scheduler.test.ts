import { describe, test, expect, beforeEach } from "bun:test";
import { processTicket } from "../src/scheduler.ts";
import { initLogger } from "../src/logger.ts";
import type { Ticket, TicketProvider, TicketComment } from "../src/providers/types.ts";
import type { CodeExecutor } from "../src/pipeline/executor.ts";
import type { Config } from "../src/config.ts";

beforeEach(() => {
  initLogger({ level: "error" });
});

const ticket: Ticket = {
  id: "uuid-1",
  identifier: "ENG-100",
  title: "Test ticket",
  description: "Do something",
};

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    provider: {
      type: "linear",
      project_id: "proj-1",
      poll_interval_seconds: 10,
      statuses: {
        ready: "Todo",
        in_progress: "In Progress",
        code_review: "Code Review",
        verification: "Verification",
        failed: "Canceled",
      },
    },
    repo: { path: "/tmp" },
    hooks: { pre: [], post: [] },
    executor: { type: "claude", dangerously_skip_permissions: true, timeout_seconds: 5, retries: 0 },
    log: { level: "info", redact: [] },
    scm: { type: "github", owner: "myorg", repo: "myrepo" },
    feedback: { comment_prefix: "/agent", poll_interval_seconds: 120 },
    ...overrides,
  };
}

function makeProvider(overrides?: Partial<TicketProvider>): {
  provider: TicketProvider;
  transitions: string[];
  comments: string[];
} {
  const transitions: string[] = [];
  const comments: string[] = [];
  return {
    transitions,
    comments,
    provider: {
      fetchReadyTickets: async () => [],
      fetchTicketsByStatus: async () => [],
      transitionStatus: async (_id, status) => {
        transitions.push(status);
      },
      postComment: async (_id, body) => {
        comments.push(body);
      },
      fetchComments: async () => [],
      ...overrides,
    },
  };
}

function mockExecutor(result: Partial<{ success: boolean; output: string }>): CodeExecutor {
  return {
    name: "mock",
    needsWorktree: false,
    run: async () => ({
      success: result.success ?? true,
      output: result.output ?? "mock output",
      timedOut: false,
      exitCode: result.success === false ? 1 : 0,
    }),
  };
}

describe("processTicket", () => {
  test("skips processing when claim fails", async () => {
    const { provider, transitions } = makeProvider({
      transitionStatus: async (_id, status) => {
        if (status === "In Progress") throw new Error("Already claimed");
        transitions.push(status);
      },
    });

    await processTicket({
      ticket,
      provider,
      config: makeConfig(),
      executor: mockExecutor({ success: true }),
    });

    expect(transitions).toEqual([]);
  });

  test("transitions to failed when pipeline fails", async () => {
    const { provider, transitions, comments } = makeProvider();

    await processTicket({
      ticket,
      provider,
      config: makeConfig({ hooks: { pre: ["exit 1"], post: [] } }),
      executor: mockExecutor({ success: true }),
    });

    expect(transitions).toContain("In Progress");
    expect(transitions).toContain("Canceled");
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("agent-worker: Task Failed");
    expect(comments[0]).toContain("pre-hook");
  });

  test("transitions to code_review and returns branch on success", async () => {
    const { provider, transitions, comments } = makeProvider();

    const result = await processTicket({
      ticket,
      provider,
      config: makeConfig(),
      executor: mockExecutor({ success: true, output: "all done" }),
    });

    expect(result.outcome).toBe("code_review");
    if (result.outcome === "code_review") {
      expect(result.ticketId).toBe("uuid-1");
      expect(result.branch).toBe("agent/task-ENG-100");
    }
    expect(transitions).toContain("In Progress");
    expect(transitions).toContain("Code Review");
    expect(transitions).not.toContain("Canceled");
    expect(comments[0]).toContain("In Code Review");
    expect(comments[0]).toContain("all done");
  });

  test("executor is called during pipeline execution", async () => {
    let executorCallCount = 0;
    const { provider } = makeProvider();

    const countingExecutor: CodeExecutor = {
      name: "mock",
      needsWorktree: false,
      run: async () => {
        executorCallCount++;
        return { success: true, output: "ok", timedOut: false, exitCode: 0 };
      },
    };

    await processTicket({
      ticket,
      provider,
      config: makeConfig(),
      executor: countingExecutor,
    });

    expect(executorCallCount).toBe(1);
  });

  test("retries executor on failure and succeeds on second attempt", async () => {
    let callCount = 0;
    const { provider, transitions } = makeProvider();

    const flakyExecutor: CodeExecutor = {
      name: "mock",
      needsWorktree: false,
      run: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: false, output: "transient error", timedOut: false, exitCode: 1 };
        }
        return { success: true, output: "recovered", timedOut: false, exitCode: 0 };
      },
    };

    await processTicket({
      ticket,
      provider,
      config: makeConfig({ executor: { type: "claude", dangerously_skip_permissions: true, timeout_seconds: 5, retries: 1 } }),
      executor: flakyExecutor,
    });

    expect(callCount).toBe(2);
    expect(transitions).toContain("Code Review");
    expect(transitions).not.toContain("Canceled");
  });

  test("transitions to failed after all retries exhausted", async () => {
    let callCount = 0;
    const { provider, transitions, comments } = makeProvider();

    const alwaysFailingExecutor: CodeExecutor = {
      name: "mock",
      needsWorktree: false,
      run: async () => {
        callCount++;
        return { success: false, output: "always fails", timedOut: false, exitCode: 1 };
      },
    };

    await processTicket({
      ticket,
      provider,
      config: makeConfig({ executor: { type: "claude", dangerously_skip_permissions: true, timeout_seconds: 5, retries: 2 } }),
      executor: alwaysFailingExecutor,
    });

    expect(callCount).toBe(3);
    expect(transitions).toContain("Canceled");
    expect(transitions).not.toContain("Code Review");
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("agent-worker: Task Failed");
  });
});
