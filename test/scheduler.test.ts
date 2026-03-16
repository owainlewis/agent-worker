import { describe, test, expect } from "bun:test";
import { processTicket } from "../src/scheduler.ts";
import type { Ticket, TicketProvider } from "../src/providers/types.ts";
import type { Config } from "../src/config.ts";
import type { Logger } from "../src/logger.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ticket: Ticket = {
  id: "uuid-1",
  identifier: "ENG-100",
  title: "Test ticket",
  description: "Do something",
};

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    apiKey: "test-key",
    linear: {
      project_id: "proj-1",
      poll_interval_seconds: 10,
      statuses: {
        ready: "Todo",
        in_progress: "In Progress",
        done: "Done",
        failed: "Canceled",
      },
    },
    repo: { path: "/tmp" },
    hooks: { pre: [], post: [] },
    claude: { timeout_seconds: 5, retries: 0 },
    log: { level: "info" },
    ...overrides,
  };
}

describe("processTicket", () => {
  test("skips processing when claim fails", async () => {
    const transitions: string[] = [];

    const provider: TicketProvider = {
      fetchReadyTickets: async () => [],
      transitionStatus: async (_id, status) => {
        if (status === "In Progress") throw new Error("Already claimed");
        transitions.push(status);
      },
      postComment: async () => {},
    };

    await processTicket({
      ticket,
      provider,
      config: makeConfig(),
      logger: noopLogger,
    });

    // Should not have transitioned to done or failed
    expect(transitions).toEqual([]);
  });

  test("transitions to failed when pipeline fails", async () => {
    const transitions: string[] = [];
    const comments: string[] = [];

    const provider: TicketProvider = {
      fetchReadyTickets: async () => [],
      transitionStatus: async (_id, status) => {
        transitions.push(status);
      },
      postComment: async (_id, body) => {
        comments.push(body);
      },
    };

    // pre-hook will fail, causing pipeline failure
    await processTicket({
      ticket,
      provider,
      config: makeConfig({ hooks: { pre: ["exit 1"], post: [] } }),
      logger: noopLogger,
    });

    expect(transitions).toContain("In Progress");
    expect(transitions).toContain("Canceled");
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("Agent Worker Failure");
    expect(comments[0]).toContain("pre-hook");
  });
});
