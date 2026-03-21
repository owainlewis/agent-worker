import type { CodeExecutor, ExecutorResult } from "./executor.ts";
import { streamToLines, spawnOrError } from "./executor.ts";
import { log } from "../logger.ts";

export function createPiExecutor(): CodeExecutor {
  return {
    name: "pi",
    needsWorktree: true,
    async run(prompt: string, cwd: string, timeoutMs: number): Promise<ExecutorResult> {
      log.info("pi started", { timeoutMs });

      const spawned = spawnOrError(
        ["pi", "-p", prompt, "--no-session"],
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
          log.info("pi", { stream: "stdout", line });
        }),
        streamToLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
          log.info("pi", { stream: "stderr", line });
        }),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const output = (stdout + "\n" + stderr).trim();

      if (timedOut) {
        log.error("pi timed out", { timeoutMs });
        return { success: false, output, timedOut: true, exitCode: null };
      }

      if (exitCode !== 0) {
        log.error("pi failed", { exitCode });
      } else {
        log.info("pi completed successfully");
      }

      return { success: exitCode === 0, output, timedOut: false, exitCode };
    },
  };
}
