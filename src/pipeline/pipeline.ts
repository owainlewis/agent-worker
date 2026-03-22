/**
 * @module src/pipeline/pipeline — Pipeline orchestration for worktree lifecycle, hooks, and executor invocation.
 */
import { join } from "path";
import { tmpdir } from "os";
import type { Ticket } from "../providers/types.ts";
import type { CodeExecutor } from "./executor.ts";
import { buildTaskVars, interpolate } from "./interpolate.ts";
import { runHooks } from "./hook-runner.ts";
import { log } from "../logger.ts";

export type PipelineResult = {
  /** Whether the full pipeline completed without errors. */
  success: boolean;
  /** Pipeline stage that failed, if applicable. */
  stage?: "pre-hook" | "executor" | "post-hook";
  /** Human-readable error description on failure. */
  error?: string;
  /** Executor output text on success. */
  output?: string;
};

/**
 * Creates an isolated git worktree in the temp directory.
 * Defaults to creating a new branch from main.
 * @param repoPath - Path to the git repository.
 * @param branch - Name for the worktree branch.
 * @param options.createBranch - Whether to create a new branch (default `true`).
 * @returns Absolute path to the worktree directory.
 * @throws Error if git worktree add fails.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  options?: { createBranch?: boolean },
): Promise<string> {
  const worktreePath = join(tmpdir(), `agent-worker-${branch}`);
  const createBranch = options?.createBranch !== false;
  const cmd = createBranch
    ? `git worktree add -b ${branch} ${worktreePath} main`
    : `git worktree add ${worktreePath} ${branch}`;
  log.info("Creating worktree", { worktreePath, branch, createBranch });

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

/**
 * Removes a git worktree and deletes the associated branch.
 * Logs warnings on failure but does not throw.
 * @param repoPath - Path to the git repository.
 * @param worktreePath - Absolute path to the worktree directory.
 * @param branch - Branch name to delete after removal.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  log.info("Removing worktree", { worktreePath });

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
    log.warn("Failed to remove worktree", { worktreePath, error: stderr.trim() });
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
    log.warn("Failed to delete branch", { branch, error: deleteStderr.trim() });
  }
}

/**
 * Orchestrates the full pipeline lifecycle for a ticket: optionally creates a worktree,
 * runs pre-hooks sequentially, invokes the code executor with the ticket prompt,
 * runs post-hooks sequentially, and cleans up the worktree in a finally block.
 * @param options.ticket - The ticket to process.
 * @param options.preHooks - Shell commands to run before the executor.
 * @param options.postHooks - Shell commands to run after the executor.
 * @param options.repoCwd - Working directory of the git repository.
 * @param options.executor - The code executor to invoke.
 * @param options.timeoutMs - Maximum execution time in milliseconds.
 * @param options.customPrompt - Optional custom prompt to prepend before the ticket context.
 * @returns PipelineResult indicating success or failure details.
 */
export async function executePipeline(options: {
  ticket: Ticket;
  preHooks: string[];
  postHooks: string[];
  repoCwd: string;
  executor: CodeExecutor;
  timeoutMs: number;
  customPrompt?: string;
}): Promise<PipelineResult> {
  const { ticket, preHooks, postHooks, repoCwd, executor, timeoutMs, customPrompt } = options;
  const vars = buildTaskVars(ticket);

  const useWorktree = executor.needsWorktree;
  let effectiveCwd = repoCwd;
  let worktreePath: string | null = null;

  // Create an isolated worktree if the executor needs one (e.g. Claude).
  // Codex manages its own worktrees internally so we skip this.
  if (useWorktree) {
    try {
      worktreePath = await createWorktree(repoCwd, vars.branch);
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
      const preResult = await runHooks(preHooks, effectiveCwd, vars);
      if (!preResult.success) {
        return {
          success: false,
          stage: "pre-hook",
          error: `Command "${preResult.failedCommand}" exited with code ${preResult.exitCode}: ${preResult.output}`,
        };
      }
    }

    // Code executor
    const customPart = customPrompt
      ? interpolate(customPrompt, vars) + "\n\n"
      : "";
    const prompt = `${customPart}Ticket: ${ticket.title}\n\n${ticket.description || "No description provided."}`;
    const execResult = await executor.run(prompt, effectiveCwd, timeoutMs);
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
      const postResult = await runHooks(postHooks, effectiveCwd, vars);
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
      await removeWorktree(repoCwd, worktreePath, vars.branch);
    }
  }
}
