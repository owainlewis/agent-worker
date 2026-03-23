import type { Logger } from "./logger.ts";
import type { Config } from "./config.ts";
import type { Ticket, TicketProvider } from "./providers/types.ts";
import { executePipeline } from "./pipeline/pipeline.ts";
import { createExecutor, type CodeExecutor } from "./pipeline/executor.ts";
import type { WorkerState } from "./ui/state.ts";

function lastNLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

export async function processTicket(options: {
  ticket: Ticket;
  provider: TicketProvider;
  config: Config;
  logger: Logger;
  executor?: CodeExecutor;
  workerState?: WorkerState;
}): Promise<void> {
  const { ticket, provider, config, logger, workerState } = options;

  // Claim the ticket
  try {
    await provider.transitionStatus(ticket.id, config.linear.statuses.in_progress);
    logger.info("Ticket claimed", { ticketId: ticket.identifier });
  } catch (err) {
    logger.warn("Failed to claim ticket", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  workerState?.setActiveJob({
    id: ticket.id,
    identifier: ticket.identifier,
    title: ticket.title,
    branch: `agent/task-${ticket.identifier}`,
    stage: "pre-hook",
    startedAt: Date.now(),
    logLines: [],
  });

  const executor = options.executor ?? createExecutor(config.executor.type);

  const jobLogger: Logger = {
    debug: (msg, ctx?) => { logger.debug(msg, ctx); workerState?.appendLog(`[debug] ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
    info:  (msg, ctx?) => { logger.info(msg, ctx);  workerState?.appendLog(`[info]  ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
    warn:  (msg, ctx?) => { logger.warn(msg, ctx);  workerState?.appendLog(`[warn]  ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
    error: (msg, ctx?) => { logger.error(msg, ctx); workerState?.appendLog(`[error] ${msg}${ctx?.line ? ` ${ctx.line}` : ""}`); },
  };

  // Run pipeline with retries
  let lastResult: Awaited<ReturnType<typeof executePipeline>> | undefined;

  for (let attempt = 0; attempt <= config.executor.retries; attempt++) {
    if (attempt > 0) {
      jobLogger.warn("Retrying pipeline", {
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
        logger: jobLogger,
      });

      if (lastResult.success) break;
    } catch (err) {
      jobLogger.error("Pipeline threw unexpected error", {
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
      await provider.transitionStatus(ticket.id, config.linear.statuses.done);

      const output = lastNLines(lastResult.output ?? "", 50);
      const comment = [
        "## Agent Worker Completed",
        "",
        "Task completed successfully.",
        ...(output ? ["", "**Output (last 50 lines):**", "```", output, "```"] : []),
      ].join("\n");
      await provider.postComment(ticket.id, comment);

      jobLogger.info("Ticket completed", { ticketId: ticket.identifier });

      const prUrlMatch = lastResult.output?.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      if (prUrlMatch) {
        workerState?.completeJob({ success: true, prUrl: prUrlMatch[0], review: true });
      } else {
        workerState?.completeJob({ success: true });
      }
    } else {
      await provider.transitionStatus(ticket.id, config.linear.statuses.failed);

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
      jobLogger.error("Ticket failed", {
        ticketId: ticket.identifier,
        stage: lastResult?.stage,
      });

      workerState?.completeJob({ success: false });
    }
  } catch (err) {
    jobLogger.error("Failed to update ticket status", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    workerState?.errorJob(err instanceof Error ? err.message : String(err));
  }
}
