import type { Logger } from "../logger.ts";
import { streamToLines, type ExecutorResult } from "./executor.ts";
import { createWatchdog } from "./watchdog.ts";

/**
 * Shared spawn-and-stream-with-watchdog helper for the Claude and Codex
 * executors. Both binaries are invoked the same way: spawn with piped
 * stdout/stderr, fan-line-deliveries to the logger, enforce a hard wall-clock
 * timeout, and (SAM-400) kill on inactivity if the watchdog is enabled.
 *
 * Keeping this in one place ensures the two executors stay in sync — every
 * silent-hang protection added here applies to both transparently.
 */
export interface StreamingProcessOptions {
  /** argv passed verbatim to Bun.spawn. e.g. ["claude","--print","-p", prompt] */
  argv: string[];
  cwd: string;
  /** Hard wall-clock timeout (kills the child unconditionally when reached). */
  timeoutMs: number;
  /** Inactivity watchdog window. 0 disables the watchdog. */
  watchdogInactivityMs: number;
  logger: Logger;
  /** Used as the log key per output line and in the kill event. e.g. "claude" */
  executorName: string;
  /** Linear ticket identifier — included in the watchdog_kill structured log. */
  ticketIdentifier?: string;
}

export async function runStreamingProcess(
  opts: StreamingProcessOptions,
): Promise<ExecutorResult> {
  const {
    argv,
    cwd,
    timeoutMs,
    watchdogInactivityMs,
    logger,
    executorName,
    ticketIdentifier,
  } = opts;

  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  let watchdogKilled = false;

  // Hard wall-clock timer — final safety net. Fires regardless of whether
  // the watchdog also caught the process; whichever fires first wins.
  const hardTimer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const watchdog = createWatchdog({
    inactivityMs: watchdogInactivityMs,
    onTimeout: () => {
      watchdogKilled = true;
      // Structured log entry per SAM-400 acceptance criteria. The message
      // string is "watchdog_kill" so `grep watchdog_kill` matches both the
      // message and the event field — explicit field names below remain
      // the authoritative source for log consumers.
      logger.warn("watchdog_kill", {
        event: "watchdog_kill",
        ticket: ticketIdentifier ?? "",
        executor: executorName,
        inactivity_seconds: Math.round(watchdogInactivityMs / 1000),
      });
      proc.kill();
    },
  });

  const touch = () => watchdog.touch();

  const [stdout, stderr] = await Promise.all([
    streamToLines(
      proc.stdout as ReadableStream<Uint8Array>,
      (line) => logger.info(executorName, { stream: "stdout", line }),
      touch,
    ),
    streamToLines(
      proc.stderr as ReadableStream<Uint8Array>,
      (line) => logger.info(executorName, { stream: "stderr", line }),
      touch,
    ),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(hardTimer);
  watchdog.cancel();

  const output = (stdout + "\n" + stderr).trim();

  return {
    success: exitCode === 0 && !timedOut && !watchdogKilled,
    output,
    timedOut,
    exitCode: timedOut || watchdogKilled ? null : exitCode,
    watchdogKilled,
  };
}
