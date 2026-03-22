/** @module src/feedback/feedback-handler — Processes actionable review feedback by dispatching it to the code executor */

import type { Config } from "../config.ts";
import type { Ticket, TicketProvider } from "../providers/types.ts";
import type { CodeExecutor } from "../pipeline/executor.ts";
import type { PullRequest, ScmProvider } from "../scm/types.ts";
import type { FeedbackEvent } from "./comment-filter.ts";
import type { PRTracker } from "./tracking.ts";
import { createWorktree, removeWorktree } from "../pipeline/pipeline.ts";
import { buildTaskVars, interpolate } from "../pipeline/interpolate.ts";
import { runHooks } from "../pipeline/hook-runner.ts";
import { log } from "../logger.ts";

/**
 * Resolves the HEAD commit SHA in the given working directory.
 * Falls back to the repo path if the worktree is not available.
 * @param cwd - Working directory (worktree path or repo path).
 * @returns The commit SHA string, or `"unknown"` if it cannot be determined.
 */
async function getHeadSha(cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const output = await new Response(proc.stdout).text();
    return output.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Best-effort helper to add a reaction to a comment via the SCM provider.
 * Only acts on "issue" or "review" comment types; skips "ticket".
 */
async function bestEffortReaction(
  scm: ScmProvider,
  commentId: string,
  commentType: "issue" | "review" | "ticket",
  reaction: string,
  prNumber?: number,
): Promise<void> {
  if (commentType === "ticket") return;
  try {
    await scm.addCommentReaction(Number(commentId), commentType, reaction, prNumber);
  } catch (err) {
    log.warn("Failed to add reaction (best-effort)", {
      commentId,
      commentType,
      reaction,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort helper to reply to a comment via the SCM provider.
 * Only acts on "issue" or "review" comment types; skips "ticket".
 */
async function bestEffortReply(
  scm: ScmProvider,
  prNumber: number,
  commentId: string,
  commentType: "issue" | "review" | "ticket",
  body: string,
): Promise<void> {
  if (commentType === "ticket") return;
  try {
    await scm.replyToComment(prNumber, Number(commentId), commentType, body);
  } catch (err) {
    log.warn("Failed to reply to comment (best-effort)", {
      prNumber,
      commentId,
      commentType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Processes a single actionable feedback comment by dispatching it to the code executor.
 *
 * Creates a worktree (if the executor requires one) on the existing PR branch,
 * constructs a feedback prompt from the comment body, and runs the executor.
 * On success, post-hooks are executed, reactions and a commit SHA reply are posted,
 * and a summary comment is posted to the ticket. On failure, an error reaction/reply
 * and an error comment are posted. The PR tracker's `lastCommentCheck` timestamp is
 * always updated after processing.
 *
 * @param options - Processing options.
 * @param options.ticket - The ticket associated with the PR.
 * @param options.comment - The actionable feedback event to address.
 * @param options.pr - The pull request metadata (number, url, branch, state).
 * @param options.config - Full application configuration.
 * @param options.provider - Ticket provider used for posting result comments.
 * @param options.scm - SCM provider used for reactions and comment replies.
 * @param options.prTracker - PR tracker used to update the last comment check timestamp.
 * @param options.executor - Optional executor override. If omitted, one is created from `config.executor.type`.
 * @returns Resolves when processing is complete (success or failure).
 */
export async function processFeedback(options: {
  ticket: Ticket;
  comment: FeedbackEvent;
  pr: PullRequest;
  config: Config;
  provider: TicketProvider;
  scm: ScmProvider;
  prTracker: PRTracker;
  executor?: CodeExecutor;
}): Promise<void> {
  const { ticket, comment, pr, config, provider, scm, prTracker } = options;

  let executor = options.executor;
  if (!executor) {
    const { createExecutor } = await import("../pipeline/executor.ts");
    executor = createExecutor(config.executor);
  }

  const vars = buildTaskVars(ticket);
  const useWorktree = executor.needsWorktree;
  let effectiveCwd = config.repo.path;
  let worktreePath: string | null = null;

  if (useWorktree) {
    try {
      worktreePath = await createWorktree(config.repo.path, vars.branch, {
        createBranch: false,
      });
      effectiveCwd = worktreePath;
    } catch (err) {
      log.error("Failed to create worktree for feedback", {
        ticketId: ticket.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  vars.worktree = effectiveCwd;

  try {
    // Mark comment as being processed with "eyes" reaction
    await bestEffortReaction(scm, comment.commentId, comment.commentType, "eyes", pr.number);

    const parts: string[] = [];
    if (config.prompts.feedback) {
      parts.push(interpolate(config.prompts.feedback, vars));
      parts.push("");
    }
    parts.push(`Review feedback on PR #${pr.number}:`);
    parts.push("");
    parts.push(comment.body.replace(/^\/agent\s*/i, ""));
    parts.push("");
    parts.push("Address this feedback by pushing additional commits to the current branch.");
    const prompt = parts.join("\n");

    log.info("Processing feedback", {
      ticketId: ticket.identifier,
      prNumber: pr.number,
      commentId: comment.commentId,
    });

    const execResult = await executor.run(prompt, effectiveCwd, config.executor.timeout_seconds * 1000);

    if (execResult.success) {
      if (config.hooks.post.length > 0) {
        const postResult = await runHooks(config.hooks.post, effectiveCwd, vars);
        if (!postResult.success) {
          log.error("Post-hooks failed during feedback", {
            ticketId: ticket.identifier,
            command: postResult.failedCommand,
          });
        }
      }

      // Get commit SHA for reply
      const sha = await getHeadSha(effectiveCwd);

      // Add success reaction and reply on SCM
      await bestEffortReaction(scm, comment.commentId, comment.commentType, "+1", pr.number);
      await bestEffortReply(scm, pr.number, comment.commentId, comment.commentType, `Addressed in commit \`${sha}\`.`);

      await provider.postComment(ticket.id, [
        "## agent-worker: Feedback Addressed",
        "",
        `Addressed review feedback on [PR #${pr.number}](${pr.url}).`,
      ].join("\n"));

      log.info("Feedback processed successfully", { ticketId: ticket.identifier });
    } else {
      const errorSummary = execResult.output.slice(-500);

      // Add failure reaction and reply on SCM
      await bestEffortReaction(scm, comment.commentId, comment.commentType, "-1", pr.number);
      await bestEffortReply(scm, pr.number, comment.commentId, comment.commentType, [
        "Failed to address this feedback.",
        "",
        "**Error:**",
        "```",
        execResult.output.slice(-1000),
        "```",
      ].join("\n"));

      log.error("Executor failed during feedback processing", {
        ticketId: ticket.identifier,
        error: errorSummary,
      });

      await provider.postComment(ticket.id, [
        "## agent-worker: Feedback Processing Failed",
        "",
        `Failed to address review feedback on [PR #${pr.number}](${pr.url}).`,
        "",
        "**Error:**",
        "```",
        execResult.output.slice(-1000),
        "```",
      ].join("\n"));
    }

    const tracked = prTracker.get(ticket.id);
    if (tracked) {
      prTracker.track({ ...tracked, lastCommentCheck: new Date().toISOString() });
    }
  } finally {
    if (worktreePath) {
      await removeWorktree(config.repo.path, worktreePath, vars.branch);
    }
  }
}
