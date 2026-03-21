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

export async function createWorktree(
  repoPath: string,
  branch: string,
  logger: Logger,
  options?: { createBranch?: boolean },
): Promise<string> {
  const worktreePath = join(tmpdir(), `agent-worker-${branch}`);
  const createBranch = options?.createBranch !== false;
  const cmd = createBranch
    ? `git worktree add -b ${branch} ${worktreePath} main`
    : `git worktree add ${worktreePath} ${branch}`;
  logger.info("Creating worktree", { worktreePath, branch, createBranch });

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

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  logger: Logger
): Promise<void> {
  logger.info("Removing worktree", { worktreePath });

  const proc = Bun.spawn(["sh", "-c", `git worktree remove --force ${worktreePath}`], {
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
    logger.warn("Failed to remove worktree", { worktreePath, error: stderr.trim() });
    return;
  }

  // Delete the branch we created so subsequent runs don't fail with "branch already exists"
  const deleteProc = Bun.spawn(["sh", "-c", `git branch -D ${branch}`], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [deleteExitCode, __, deleteStderr] = await Promise.all([
    deleteProc.exited,
    new Response(deleteProc.stdout).text(),
    new Response(deleteProc.stderr).text(),
  ]);

  if (deleteExitCode !== 0) {
    logger.warn("Failed to delete branch", { branch, error: deleteStderr.trim() });
  }
}

export async function executePipeline(options: {
  ticket: Ticket;
  preHooks: string[];
  postHooks: string[];
  repoCwd: string;
  executor: CodeExecutor;
  timeoutMs: number;
  logger: Logger;
}): Promise<PipelineResult> {
  const { ticket, preHooks, postHooks, repoCwd, executor, timeoutMs, logger } = options;
  const vars = buildTaskVars(ticket);

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
    const prompt = `Ticket: ${ticket.title}\n\n${ticket.description || "No description provided."}`;
    const execResult = await executor.run(prompt, effectiveCwd, timeoutMs, logger);
    if (!execResult.success) {
      const reason = execResult.timedOut
        ? `Timed out after ${timeoutMs}ms`
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
      await removeWorktree(repoCwd, worktreePath, vars.branch, logger);
    }
  }
}
