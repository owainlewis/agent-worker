import type { Logger } from "../logger.ts";

export type ExecutorResult = {
  success: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number | null;
};

export async function runClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logger: Logger
): Promise<ExecutorResult> {
  logger.info("Claude Code started", { timeoutMs });

  const proc = Bun.spawn(["claude", "--print", "--dangerously-skip-permissions", "-p", prompt], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const output = (stdout + "\n" + stderr).trim();

  if (timedOut) {
    logger.error("Claude Code timed out", { timeoutMs });
    return { success: false, output, timedOut: true, exitCode: null };
  }

  if (exitCode !== 0) {
    logger.error("Claude Code failed", { exitCode });
  } else {
    logger.info("Claude Code completed successfully");
  }

  logger.debug("Claude Code output", { output: output.slice(0, 2000) });

  return { success: exitCode === 0, output, timedOut: false, exitCode };
}
