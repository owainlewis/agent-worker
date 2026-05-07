import type { CodeExecutor, ExecutorFactoryOptions } from "./executor.ts";
import { runStreamingProcess } from "./streaming-executor.ts";

export function createCodexExecutor(
  opts: ExecutorFactoryOptions = {},
): CodeExecutor {
  return {
    name: "codex",
    needsWorktree: false,
    async run(prompt, cwd, timeoutMs, logger, extras) {
      logger.info("Codex started", { timeoutMs });

      const result = await runStreamingProcess({
        argv: ["codex", "exec", "--full-auto", prompt],
        cwd,
        timeoutMs,
        watchdogInactivityMs: opts.watchdogInactivityMs ?? 0,
        logger,
        executorName: "codex",
        ticketIdentifier: extras?.ticketIdentifier,
      });

      if (result.timedOut) {
        logger.error("Codex timed out", { timeoutMs });
      } else if (result.watchdogKilled) {
        logger.error("Codex killed by inactivity watchdog", {
          inactivityMs: opts.watchdogInactivityMs ?? 0,
        });
      } else if (result.exitCode !== 0) {
        logger.error("Codex failed", { exitCode: result.exitCode });
      } else {
        logger.info("Codex completed successfully");
      }

      return result;
    },
  };
}
