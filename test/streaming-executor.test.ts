import { describe, test, expect } from "bun:test";
import { runStreamingProcess } from "../src/pipeline/streaming-executor.ts";
import type { Logger } from "../src/logger.ts";

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ctx?: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const logger: Logger = {
    debug: (msg, ctx) => logs.push({ level: "debug", msg, ctx }),
    info: (msg, ctx) => logs.push({ level: "info", msg, ctx }),
    warn: (msg, ctx) => logs.push({ level: "warn", msg, ctx }),
    error: (msg, ctx) => logs.push({ level: "error", msg, ctx }),
  };
  return { logger, logs };
}

describe("runStreamingProcess (SAM-400 inactivity watchdog)", () => {
  test("kills hung process when inactivity threshold elapses", async () => {
    // sleep 5 produces zero stdout/stderr for 5s. Watchdog set to 200ms
    // should kill it well before the hard timeout (10s) or the natural
    // 5s sleep completion.
    const { logger, logs } = makeCapturingLogger();
    const before = Date.now();
    const result = await runStreamingProcess({
      argv: ["sleep", "5"],
      cwd: "/tmp",
      timeoutMs: 10_000,
      watchdogInactivityMs: 200,
      logger,
      executorName: "test",
      ticketIdentifier: "TEST-1",
    });
    const elapsed = Date.now() - before;

    expect(result.watchdogKilled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    // Should kill within ~1s (200ms threshold + a little spawn/teardown
    // overhead), nowhere near the 5s sleep or 10s hard timeout.
    expect(elapsed).toBeLessThan(2000);

    // Structured kill log entry per SAM-400 acceptance criteria.
    const killLog = logs.find((l) => l.msg === "watchdog_kill");
    expect(killLog).toBeDefined();
    expect(killLog?.ctx?.event).toBe("watchdog_kill");
    expect(killLog?.ctx?.ticket).toBe("TEST-1");
    expect(killLog?.ctx?.executor).toBe("test");
    expect(killLog?.ctx?.inactivity_seconds).toBe(0); // 200ms rounds to 0s
  });

  test("does not kill a process that produces output regularly", async () => {
    // Print one line every 50ms for 250ms (5 lines). With watchdog = 500ms,
    // every chunk arrives well within the inactivity window.
    const { logger, logs } = makeCapturingLogger();
    const result = await runStreamingProcess({
      argv: [
        "sh",
        "-c",
        "for i in 1 2 3 4 5; do echo line-$i; sleep 0.05; done",
      ],
      cwd: "/tmp",
      timeoutMs: 10_000,
      watchdogInactivityMs: 500,
      logger,
      executorName: "test",
      ticketIdentifier: "TEST-2",
    });

    expect(result.success).toBe(true);
    expect(result.watchdogKilled).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("line-5");

    // No kill event logged.
    expect(logs.find((l) => l.msg === "watchdog_kill")).toBeUndefined();
  });

  test("watchdog disabled when inactivityMs=0 — sleep completes naturally", async () => {
    // sleep 0.3 produces no output but completes in 300ms. With watchdog
    // disabled (0), the process should run to completion successfully.
    const { logger, logs } = makeCapturingLogger();
    const result = await runStreamingProcess({
      argv: ["sleep", "0.3"],
      cwd: "/tmp",
      timeoutMs: 10_000,
      watchdogInactivityMs: 0,
      logger,
      executorName: "test",
      ticketIdentifier: "TEST-3",
    });

    expect(result.success).toBe(true);
    expect(result.watchdogKilled).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(logs.find((l) => l.msg === "watchdog_kill")).toBeUndefined();
  });

  test("hard timeout still fires when watchdog is disabled", async () => {
    // sleep 10 with hard timeout of 200ms — neither produces output nor
    // returns; the hard timer should kill it.
    const { logger } = makeCapturingLogger();
    const result = await runStreamingProcess({
      argv: ["sleep", "10"],
      cwd: "/tmp",
      timeoutMs: 200,
      watchdogInactivityMs: 0,
      logger,
      executorName: "test",
      ticketIdentifier: "TEST-4",
    });

    expect(result.timedOut).toBe(true);
    expect(result.watchdogKilled).toBe(false);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  test("partial output (no newline) still counts as activity", async () => {
    // Print bytes without a trailing newline, sleep, print more bytes, sleep,
    // then a newline. Each printf chunk should touch the watchdog even though
    // no full line is assembled until the very end. Threshold 800ms is well
    // larger than the spawn+printf gap (~tens of ms) but well smaller than
    // the cumulative process duration (~600ms total) — so the test only
    // passes if chunk-level (not line-level) activity is what resets it.
    const { logger, logs } = makeCapturingLogger();
    const result = await runStreamingProcess({
      argv: [
        "sh",
        "-c",
        "printf 'a'; sleep 0.3; printf 'b'; sleep 0.3; printf 'c\\n'",
      ],
      cwd: "/tmp",
      timeoutMs: 10_000,
      watchdogInactivityMs: 800,
      logger,
      executorName: "test",
      ticketIdentifier: "TEST-5",
    });

    expect(result.success).toBe(true);
    expect(result.watchdogKilled).toBe(false);
    expect(result.output).toContain("abc");
    expect(logs.find((l) => l.msg === "watchdog_kill")).toBeUndefined();
  });

  test("ticketIdentifier defaults to empty string in kill log when not provided", async () => {
    const { logger, logs } = makeCapturingLogger();
    await runStreamingProcess({
      argv: ["sleep", "5"],
      cwd: "/tmp",
      timeoutMs: 10_000,
      watchdogInactivityMs: 100,
      logger,
      executorName: "test",
      // ticketIdentifier intentionally omitted
    });

    const killLog = logs.find((l) => l.msg === "watchdog_kill");
    expect(killLog).toBeDefined();
    expect(killLog?.ctx?.ticket).toBe("");
  });

  test("inactivity_seconds in log matches configured threshold (rounded)", async () => {
    const { logger, logs } = makeCapturingLogger();
    await runStreamingProcess({
      argv: ["sleep", "5"],
      cwd: "/tmp",
      timeoutMs: 10_000,
      watchdogInactivityMs: 1500, // 1.5s → rounds to 2s
      logger,
      executorName: "test",
      ticketIdentifier: "TEST-7",
    });

    const killLog = logs.find((l) => l.msg === "watchdog_kill");
    expect(killLog?.ctx?.inactivity_seconds).toBe(2);
  });
});
