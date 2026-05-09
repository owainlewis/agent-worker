import { join } from "path";
import { tmpdir } from "os";
import type { Logger } from "../logger.ts";
import type { Ticket } from "../providers/types.ts";
import type { CodeExecutor } from "./executor.ts";
import { buildTaskVars } from "./interpolate.ts";
import { runHooks } from "./hook-runner.ts";

export type PipelineResult = {
  success: boolean;
  stage?: "pre-hook" | "executor" | "post-hook";
  error?: string;
  output?: string;
};

async function createWorktree(
  repoPath: string,
  branch: string,
  logger: Logger,
): Promise<string> {
  const worktreePath = join(tmpdir(), `agent-worker-${branch}`);
  const cmd = `git worktree add -b ${branch} ${worktreePath} main`;
  logger.info("Creating worktree", { worktreePath, branch });

  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, _, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${stderr.trim()}`);
  }

  return worktreePath;
}

async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  logger: Logger,
): Promise<void> {
  logger.info("Removing worktree", { worktreePath });

  const proc = Bun.spawn(
    ["sh", "-c", `git worktree remove --force ${worktreePath}`],
    {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [exitCode, _, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    logger.warn("Failed to remove worktree", {
      worktreePath,
      error: stderr.trim(),
    });
  }
}

export async function executePipeline(options: {
  ticket: Ticket;
  preHooks: string[];
  postHooks: string[];
  repoCwd: string;
  executor: CodeExecutor;
  timeoutMs: number;
  promptPrefix?: string;
  logger: Logger;
}): Promise<PipelineResult> {
  const {
    ticket,
    preHooks,
    postHooks,
    repoCwd,
    executor,
    timeoutMs,
    promptPrefix,
    logger,
  } = options;
  // SAM-481: pass repoCwd into TaskVars so hooks can interpolate {repo_cwd}.
  // Critical for per-ticket worktree routing — pull-main.sh needs the SOURCE
  // repo path (e.g. /Users/.../studio-os), not the temp worktree path.
  const vars = buildTaskVars(ticket, "", repoCwd);

  const useWorktree = executor.needsWorktree;
  let effectiveCwd = repoCwd;
  let worktreePath: string | null = null;

  // Create an isolated worktree if the executor needs one (e.g. Claude).
  // Codex manages its own worktrees internally so we skip this.
  if (useWorktree) {
    try {
      worktreePath = await createWorktree(repoCwd, vars.branch, logger);
      effectiveCwd = worktreePath;
    } catch (err) {
      return {
        success: false,
        stage: "pre-hook",
        error: `Worktree creation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  vars.worktree = effectiveCwd;

  try {
    // Pre-hooks
    if (preHooks.length > 0) {
      const preResult = await runHooks(preHooks, effectiveCwd, vars, logger);
      if (!preResult.success) {
        return {
          success: false,
          stage: "pre-hook",
          error: `Command "${preResult.failedCommand}" exited with code ${preResult.exitCode}: ${preResult.output}`,
        };
      }
    }

    // Code executor
    const generatedPrompt = `Linear ticket: ${ticket.identifier}\nTitle: ${ticket.title}\n\n${ticket.description || "No description provided."}`;
    const prompt = promptPrefix
      ? `${promptPrefix.trimEnd()}\n\n${generatedPrompt}`
      : generatedPrompt;
    // SAM-400: pass the ticket identifier so the inactivity watchdog can
    // include it in the structured `watchdog_kill` log entry — required
    // by the SAM-400 acceptance criteria so log consumers can attribute
    // a kill to the specific ticket that hung.
    const execResult = await executor.run(
      prompt,
      effectiveCwd,
      timeoutMs,
      logger,
      { ticketIdentifier: ticket.identifier },
    );
    if (!execResult.success) {
      // SAM-400: distinguish watchdog kill from hard timeout in the Linear
      // failure comment — operators triaging a Canceled ticket need to know
      // whether the executor produced no output for long enough to trip the
      // inactivity watchdog (likely a hung session, retry-safe) versus
      // hitting the wall-clock timeout (work was happening but ran long).
      const reason = execResult.timedOut
        ? `Timed out after ${timeoutMs}ms`
        : execResult.watchdogKilled
          ? `Killed by inactivity watchdog (no stdout/stderr activity for too long — see watchdog_kill log entry)`
          : `Exited with code ${execResult.exitCode}`;
      return {
        success: false,
        stage: "executor",
        error: `${reason}: ${execResult.output.slice(-2000)}`,
      };
    }

    // Post-hooks
    if (postHooks.length > 0) {
      const postResult = await runHooks(postHooks, effectiveCwd, vars, logger);
      if (!postResult.success) {
        return {
          success: false,
          stage: "post-hook",
          error: `Command "${postResult.failedCommand}" exited with code ${postResult.exitCode}: ${postResult.output}`,
        };
      }
    }

    return { success: true, output: execResult.output };
  } finally {
    if (worktreePath) {
      await removeWorktree(repoCwd, worktreePath, logger);
    }
  }
}
