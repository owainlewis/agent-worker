import { describe, test, expect } from "bun:test";
import { createPoller } from "../src/poller.ts";
import type { Ticket, TicketProvider } from "../src/providers/types.ts";
import type { Logger } from "../src/logger.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testTicket: Ticket = {
  id: "uuid-1",
  identifier: "ENG-100",
  title: "Test",
  description: undefined,
};

describe("createPoller", () => {
  test("calls onTicket when tickets are found", async () => {
    const received: Ticket[] = [];
    let callCount = 0;

    const provider: TicketProvider = {
      fetchReadyTickets: async () => {
        callCount++;
        if (callCount <= 1) return [testTicket];
        return [];
      },
      transitionStatus: async () => {},
      postComment: async () => {},
    };

    const poller = createPoller({
      provider,
      intervalMs: 10,
      logger: noopLogger,
      onTicket: async (t) => {
        received.push(t);
        poller.stop();
      },
    });

    await poller.start();
    expect(received.length).toBe(1);
    expect(received[0]!.identifier).toBe("ENG-100");
  });

  test("continues polling when no tickets found", async () => {
    let pollCount = 0;

    const provider: TicketProvider = {
      fetchReadyTickets: async () => {
        pollCount++;
        if (pollCount >= 3) poller.stop();
        return [];
      },
      transitionStatus: async () => {},
      postComment: async () => {},
    };

    const poller = createPoller({
      provider,
      intervalMs: 10,
      logger: noopLogger,
      onTicket: async () => {},
    });

    await poller.start();
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  test("survives provider errors", async () => {
    let callCount = 0;

    const provider: TicketProvider = {
      fetchReadyTickets: async () => {
        callCount++;
        if (callCount === 1) throw new Error("Network error");
        if (callCount >= 3) poller.stop();
        return [];
      },
      transitionStatus: async () => {},
      postComment: async () => {},
    };

    const poller = createPoller({
      provider,
      intervalMs: 10,
      logger: noopLogger,
      onTicket: async () => {},
    });

    await poller.start();
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test("logs poll count and uptime on each cycle", async () => {
    const infoMessages: string[] = [];
    const capturingLogger: Logger = {
      debug: () => {},
      info: (msg: string) => { infoMessages.push(msg); },
      warn: () => {},
      error: () => {},
    };
    let pollCount = 0;

    const provider: TicketProvider = {
      fetchReadyTickets: async () => {
        pollCount++;
        if (pollCount >= 2) poller.stop();
        return [];
      },
      transitionStatus: async () => {},
      postComment: async () => {},
    };

    const poller = createPoller({
      provider,
      intervalMs: 10,
      logger: capturingLogger,
      onTicket: async () => {},
    });

    await poller.start();

    expect(infoMessages.length).toBeGreaterThanOrEqual(2);
    expect(infoMessages[0]).toMatch(/^Poll #1 \(uptime: \d+s\) — checking for tickets\.\.\.$/);
    expect(infoMessages[1]).toMatch(/^Poll #2 \(uptime: \d+[ms ]*\d*s?\) — checking for tickets\.\.\.$/);
  });

  test("stops when stop() is called", async () => {
    let pollCount = 0;

    const provider: TicketProvider = {
      fetchReadyTickets: async () => {
        pollCount++;
        return [];
      },
      transitionStatus: async () => {},
      postComment: async () => {},
    };

    const poller = createPoller({
      provider,
      intervalMs: 10,
      logger: noopLogger,
      onTicket: async () => {},
    });

    setTimeout(() => poller.stop(), 50);
    await poller.start();
    expect(pollCount).toBeGreaterThan(0);
  });
});
