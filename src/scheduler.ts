import type { Config } from "./config.ts";
import type { Ticket, TicketProvider } from "./providers/types.ts";
import { executePipeline } from "./pipeline/pipeline.ts";
import { createExecutor, type CodeExecutor } from "./pipeline/executor.ts";
import { buildTaskVars } from "./pipeline/interpolate.ts";
import { log } from "./logger.ts";

function lastNLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

export type ProcessTicketResult =
  | { outcome: "failed" }
  | { outcome: "code_review"; ticketId: string; branch: string };

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

  const executor = options.executor ?? createExecutor(config.executor.type);

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
        "## Agent Worker — In Code Review",
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
        "## Agent Worker Failure",
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
