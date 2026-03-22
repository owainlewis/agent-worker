/** @module src/scheduler — Claims tickets, runs the executor pipeline with retries, and updates ticket status based on outcome. */

import type { Config } from "./config.ts";
import type { Ticket, TicketProvider } from "./providers/types.ts";
import { executePipeline } from "./pipeline/pipeline.ts";
import { createExecutor, type CodeExecutor } from "./pipeline/executor.ts";
import { buildTaskVars } from "./pipeline/interpolate.ts";
import { log } from "./logger.ts";

/**
 * Returns the last N lines of a string.
 * Used to truncate long output in ticket comments so they stay readable.
 *
 * @param text - The full text to truncate.
 * @param n - Maximum number of lines to keep from the end.
 * @returns The last `n` lines joined by newlines.
 */
function lastNLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * Outcome of processing a ticket through the pipeline.
 *
 * - `"failed"` — The ticket could not be processed (claim failed, pipeline
 *   exhausted retries, or status update failed).
 * - `"code_review"` — The ticket was successfully processed and moved to
 *   code review status. Includes the ticket ID and branch name.
 */
export type ProcessTicketResult =
  | { outcome: "failed" }
  | { outcome: "code_review"; ticketId: string; branch: string };

/**
 * Claims a ticket, runs the pipeline with configurable retries, updates the ticket
 * status, and posts a summary comment.
 *
 * On success, moves the ticket to "code_review" status and posts the last 50 lines
 * of executor output. On failure after all retries, moves to "failed" status and
 * posts error details. If claiming the ticket or updating its final status throws,
 * the function returns `{ outcome: "failed" }` without re-throwing.
 *
 * @param options.ticket - The ticket to process.
 * @param options.provider - Provider for status transitions and comments.
 * @param options.config - Full application config (executor settings, hooks, statuses).
 * @param options.executor - Optional executor override (defaults to `config.executor.type`).
 * @returns A {@link ProcessTicketResult} indicating whether the ticket reached code review or failed.
 * @throws Never — all errors are caught and result in `{ outcome: "failed" }`.
 */
export async function processTicket(options: {
  ticket: Ticket;
  provider: TicketProvider;
  config: Config;
  executor?: CodeExecutor;
}): Promise<ProcessTicketResult> {
  const { ticket, provider, config } = options;

  // Claim the ticket
  try {
    await provider.transitionStatus(ticket.id, config.provider.statuses.in_progress);
    log.info("Ticket claimed", { ticketId: ticket.identifier });
  } catch (err) {
    log.warn("Failed to claim ticket", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: "failed" };
  }

  const executor = options.executor ?? createExecutor(config.executor);

  // Run pipeline with retries
  let lastResult: Awaited<ReturnType<typeof executePipeline>> | undefined;

  for (let attempt = 0; attempt <= config.executor.retries; attempt++) {
    if (attempt > 0) {
      log.warn("Retrying pipeline", {
        ticketId: ticket.identifier,
        attempt,
        maxRetries: config.executor.retries,
      });
    }

    try {
      lastResult = await executePipeline({
        ticket,
        preHooks: config.hooks.pre,
        postHooks: config.hooks.post,
        repoCwd: config.repo.path,
        executor,
        timeoutMs: config.executor.timeout_seconds * 1000,
        customPrompt: config.prompts.implement,
      });

      if (lastResult.success) break;
    } catch (err) {
      log.error("Pipeline threw unexpected error", {
        ticketId: ticket.identifier,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      lastResult = {
        success: false,
        stage: "executor" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Update final status
  try {
    if (lastResult?.success) {
      await provider.transitionStatus(ticket.id, config.provider.statuses.code_review);

      const output = lastNLines(lastResult.output ?? "", 50);
      const comment = [
        "## agent-worker: In Code Review",
        "",
        "Task completed. Awaiting code review.",
        ...(output ? ["", "**Output (last 50 lines):**", "```", output, "```"] : []),
      ].join("\n");
      await provider.postComment(ticket.id, comment);

      log.info("Ticket in code review", { ticketId: ticket.identifier });
      const branch = buildTaskVars(ticket).branch;
      return { outcome: "code_review", ticketId: ticket.id, branch };
    } else {
      await provider.transitionStatus(ticket.id, config.provider.statuses.failed);

      const errorOutput = lastNLines(lastResult?.error ?? "Unknown error", 50);
      const comment = [
        "## agent-worker: Task Failed",
        "",
        `**Stage:** ${lastResult?.stage ?? "unknown"}`,
        "**Error:**",
        "```",
        errorOutput,
        "```",
      ].join("\n");

      await provider.postComment(ticket.id, comment);
      log.error("Ticket failed", {
        ticketId: ticket.identifier,
        stage: lastResult?.stage,
      });
      return { outcome: "failed" };
    }
  } catch (err) {
    log.error("Failed to update ticket status", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: "failed" };
  }
}
