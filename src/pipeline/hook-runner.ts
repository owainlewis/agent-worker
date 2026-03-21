import { interpolate, type TaskVars } from "./interpolate.ts";
import { log } from "../logger.ts";

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
): Promise<HookResult> {
  for (const raw of commands) {
    const command = interpolate(raw, vars);
    log.info("Running hook", { command });

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

    log.debug("Hook output", { command, stdout, stderr });

    if (exitCode !== 0) {
      const output = (stderr || stdout).trim();
      log.error("Hook failed", { command, exitCode, output });
      return { success: false, failedCommand: command, exitCode, output };
    }
  }

  return { success: true };
}
