import type { CodeExecutor, ExecutorFactoryOptions } from "./executor.ts";
import { runStreamingProcess } from "./streaming-executor.ts";

export function createClaudeExecutor(
  opts: ExecutorFactoryOptions = {},
): CodeExecutor {
  return {
    name: "claude",
    needsWorktree: true,
    async run(prompt, cwd, timeoutMs, logger, extras) {
      logger.info("Claude Code started", { timeoutMs });

      const result = await runStreamingProcess({
        argv: [
          "claude",
          "--print",
          "--dangerously-skip-permissions",
          "-p",
          prompt,
        ],
        cwd,
        timeoutMs,
        watchdogInactivityMs: opts.watchdogInactivityMs ?? 0,
        logger,
        executorName: "claude",
        ticketIdentifier: extras?.ticketIdentifier,
      });

      if (result.timedOut) {
        logger.error("Claude Code timed out", { timeoutMs });
      } else if (result.watchdogKilled) {
        logger.error("Claude Code killed by inactivity watchdog", {
          inactivityMs: opts.watchdogInactivityMs ?? 0,
        });
      } else if (result.exitCode !== 0) {
        logger.error("Claude Code failed", { exitCode: result.exitCode });
      } else {
        logger.info("Claude Code completed successfully");
      }

      return result;
    },
  };
}
