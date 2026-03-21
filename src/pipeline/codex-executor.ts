import type { CodeExecutor, ExecutorResult } from "./executor.ts";
import { streamToLines, spawnOrError } from "./executor.ts";
import { log } from "../logger.ts";

export function createCodexExecutor(): CodeExecutor {
  return {
    name: "codex",
    needsWorktree: false,
    async run(prompt: string, cwd: string, timeoutMs: number): Promise<ExecutorResult> {
      log.info("Codex started", { timeoutMs });

      const spawned = spawnOrError(
        ["codex", "exec", "--full-auto", prompt],
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
          log.info("codex", { stream: "stdout", line });
        }),
        streamToLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
          log.info("codex", { stream: "stderr", line });
        }),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const output = (stdout + "\n" + stderr).trim();

      if (timedOut) {
        log.error("Codex timed out", { timeoutMs });
        return { success: false, output, timedOut: true, exitCode: null };
      }

      if (exitCode !== 0) {
        log.error("Codex failed", { exitCode });
      } else {
        log.info("Codex completed successfully");
      }

      return { success: exitCode === 0, output, timedOut: false, exitCode };
    },
  };
}
