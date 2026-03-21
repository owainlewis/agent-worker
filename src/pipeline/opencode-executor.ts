import type { CodeExecutor, ExecutorResult } from "./executor.ts";
import { streamToLines, spawnOrError } from "./executor.ts";
import { log } from "../logger.ts";

export function createOpencodeExecutor(): CodeExecutor {
  return {
    name: "opencode",
    needsWorktree: true,
    async run(prompt: string, cwd: string, timeoutMs: number): Promise<ExecutorResult> {
      log.info("opencode started", { timeoutMs });

      const spawned = spawnOrError(
        ["opencode", "-p", prompt],
        { cwd, stdout: "pipe", stderr: "pipe" }
      );

      if ("success" in spawned) return spawned;

      const proc = spawned.proc;

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      const [stdout, stderr] = await Promise.all([
        streamToLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
          log.info("opencode", { stream: "stdout", line });
        }),
        streamToLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
          log.info("opencode", { stream: "stderr", line });
        }),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const output = (stdout + "\n" + stderr).trim();

      if (timedOut) {
        log.error("opencode timed out", { timeoutMs });
        return { success: false, output, timedOut: true, exitCode: null };
      }

      if (exitCode !== 0) {
        log.error("opencode failed", { exitCode });
      } else {
        log.info("opencode completed successfully");
      }

      return { success: exitCode === 0, output, timedOut: false, exitCode };
    },
  };
}
