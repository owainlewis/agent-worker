import type { Logger } from "./logger.ts";
import type { Config } from "./config.ts";
import type { Ticket, TicketProvider } from "./providers/types.ts";
import { executePipeline } from "./pipeline/pipeline.ts";
import { createExecutor, type CodeExecutor } from "./pipeline/executor.ts";

function lastNLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * SAM-481 cross-repo work-stealing — resolve the worktree base path for a
 * specific ticket. Three resolution paths in priority order:
 *
 *   1. Legacy single-path config (`repo.path` set): always returns that path.
 *      Backward compat for daemons that haven't opted into per-label routing.
 *
 *   2. Per-label routing (`repo.path_by_label` set): walks the ticket's labels,
 *      returns the first one that maps to a configured path. If no label
 *      matches, falls back to `repo.default_path` if set.
 *
 *   3. No match (`path_by_label` set, no matching label, no `default_path`):
 *      returns `null`. Caller (processTicket) treats this as "skip this ticket"
 *      — better to skip than to ship from the wrong repo.
 *
 * Returns the absolute path string, or null if the ticket cannot be safely
 * routed. The caller must handle the null case explicitly.
 */
export function resolveRepoCwd(ticket: Ticket, config: Config): string | null {
  // Path 1: legacy single-path config.
  if (config.repo.path) return config.repo.path;

  // Path 2: per-label routing.
  if (config.repo.path_by_label) {
    for (const label of ticket.labels) {
      const path = config.repo.path_by_label[label];
      if (path) return path;
    }
    // Path 3: no matching label — try default, else null.
    return config.repo.default_path ?? null;
  }

  // Defensive: schema validation should prevent reaching here. But if it does,
  // fail-explicit rather than silently picking a path.
  return null;
}

export async function processTicket(options: {
  ticket: Ticket;
  provider: TicketProvider;
  config: Config;
  logger: Logger;
  executor?: CodeExecutor;
}): Promise<void> {
  const { ticket, provider, config, logger } = options;

  // SAM-481: resolve the per-ticket worktree path BEFORE claiming. If we can't
  // route the ticket, refuse the claim entirely — Linear flips it to `failed`
  // (Canceled) with a comment explaining the missing label.
  const repoCwd = resolveRepoCwd(ticket, config);
  if (!repoCwd) {
    logger.warn(
      "Refusing to claim ticket — no repo path could be resolved from labels",
      {
        ticketId: ticket.identifier,
        ticketLabels: ticket.labels,
        configuredLabels: config.repo.path_by_label
          ? Object.keys(config.repo.path_by_label)
          : [],
      },
    );
    try {
      await provider.transitionStatus(ticket.id, config.linear.statuses.failed);
      await provider.postComment(
        ticket.id,
        [
          "## Agent Worker — Cannot Route",
          "",
          "This daemon is configured with `repo.path_by_label` but the ticket has no label that maps to a configured worktree, and no `default_path` is set.",
          "",
          `**Ticket labels:** ${ticket.labels.join(", ") || "(none)"}`,
          `**Configured label-to-path map:** ${
            config.repo.path_by_label
              ? Object.keys(config.repo.path_by_label).join(", ")
              : "(none)"
          }`,
          "",
          "Add a `repo:<name>` label that the daemon's config covers, or set `repo.default_path` so unmatched tickets fall back to a known worktree.",
        ].join("\n"),
      );
    } catch (err) {
      logger.error("Failed to mark unrouteable ticket as failed", {
        ticketId: ticket.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Claim the ticket
  try {
    await provider.transitionStatus(
      ticket.id,
      config.linear.statuses.in_progress,
    );
    logger.info("Ticket claimed", {
      ticketId: ticket.identifier,
      projectId: ticket.projectId,
      repoCwd,
    });
  } catch (err) {
    logger.warn("Failed to claim ticket", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // SAM-400: pass the configured inactivity watchdog window to the executor
  // factory. The factory is invoked here (per-ticket) rather than once at
  // daemon startup so reconfiguring `watchdog_inactivity_seconds` mid-day
  // (after a future hot-reload, or just by restarting the daemon between
  // ticks) takes effect without code changes.
  const executor =
    options.executor ??
    createExecutor(config.executor.type, {
      watchdogInactivityMs: config.executor.watchdog_inactivity_seconds * 1000,
    });

  // Run pipeline with retries
  let lastResult: Awaited<ReturnType<typeof executePipeline>> | undefined;

  for (let attempt = 0; attempt <= config.executor.retries; attempt++) {
    if (attempt > 0) {
      logger.warn("Retrying pipeline", {
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
        repoCwd,
        executor,
        timeoutMs: config.executor.timeout_seconds * 1000,
        promptPrefix: config.executor.prompt_prefix,
        logger,
      });

      if (lastResult.success) break;
    } catch (err) {
      logger.error("Pipeline threw unexpected error", {
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
        ...(output
          ? ["", "**Output (last 50 lines):**", "```", output, "```"]
          : []),
      ].join("\n");
      await provider.postComment(ticket.id, comment);

      logger.info("Ticket completed", { ticketId: ticket.identifier });
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
      logger.error("Ticket failed", {
        ticketId: ticket.identifier,
        stage: lastResult?.stage,
      });
    }
  } catch (err) {
    logger.error("Failed to update ticket status", {
      ticketId: ticket.identifier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
