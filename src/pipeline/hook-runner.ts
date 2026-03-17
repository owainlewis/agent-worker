import type { Logger } from "../logger.ts";
import { interpolate, type TaskVars } from "./interpolate.ts";

export type HookResult = {
  success: boolean;
  failedCommand?: string;
  exitCode?: number;
  output?: string;
};

export async function runHooks(
  commands: string[],
  cwd: string,
  vars: TaskVars,
  logger: Logger
): Promise<HookResult> {
  for (const raw of commands) {
    const command = interpolate(raw, vars);
    logger.info("Running hook", { command });

    const proc = Bun.spawn(["sh", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    logger.debug("Hook output", { command, stdout, stderr });

    if (exitCode !== 0) {
      const output = (stderr || stdout).trim();
      logger.error("Hook failed", { command, exitCode, output });
      return { success: false, failedCommand: command, exitCode, output };
    }
  }

  return { success: true };
}
