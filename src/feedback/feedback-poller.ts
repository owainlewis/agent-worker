import type { Config } from "../config.ts";
import type { TicketProvider } from "../providers/types.ts";
import type { ScmProvider } from "../scm/types.ts";
import type { PRTracker } from "./tracking.ts";
import { findActionableComments, type FeedbackEvent } from "./comment-filter.ts";
import { processFeedback } from "./feedback-handler.ts";
import { log } from "../logger.ts";

export function createFeedbackPoller(options: {
  provider: TicketProvider;
  scm: ScmProvider;
  prTracker: PRTracker;
  config: Config;
}): { start: () => Promise<void>; stop: () => void } {
  const { provider, scm, prTracker, config } = options;

  const codeReviewStatus = config.provider.statuses.code_review;
  const verificationStatus = config.provider.statuses.verification;
  const prefix = config.feedback.comment_prefix;
  const intervalMs = config.feedback.poll_interval_seconds * 1000;

  let isRunning = false;
  let wakeSleep: (() => void) | null = null;

  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
    });
  }

  async function processActionableFeedback(
    ticket: Awaited<ReturnType<TicketProvider["fetchTicketsByStatus"]>>[number],
    comment: FeedbackEvent,
  ): Promise<void> {
    const tracked = prTracker.get(ticket.id);
    if (!tracked) return;

    const pr = {
      number: tracked.prNumber,
      url: "",
      branch: tracked.branch,
      state: "open" as const,
    };

    await processFeedback({
      ticket,
      comment,
      pr,
      config,
      provider,
      prTracker,
    });
  }

  return {
    async start() {
      isRunning = true;
      log.info("Feedback poller started", {
        pollInterval: config.feedback.poll_interval_seconds,
        commentPrefix: prefix,
      });

      while (isRunning) {
        try {
          const tickets = await provider.fetchTicketsByStatus(codeReviewStatus);

          for (const ticket of tickets) {
            const tracked = prTracker.get(ticket.id);

            if (!tracked) {
              // Discover PR by branch name
              const branch = `agent/task-${ticket.identifier}`;
              try {
                const pr = await scm.findPullRequest(branch);
                if (pr) {
                  prTracker.track({
                    ticketId: ticket.id,
                    ticketIdentifier: ticket.identifier,
                    prNumber: pr.number,
                    branch,
                    lastCommentCheck: new Date().toISOString(),
                  });
                  log.info("Tracking PR for ticket", {
                    ticketId: ticket.identifier,
                    prNumber: pr.number,
                  });
                }
              } catch (err) {
                log.debug("Failed to find PR for ticket", {
                  ticketId: ticket.identifier,
                  branch,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              continue;
            }

            // Check if PR is merged
            try {
              const merged = await scm.isPRMerged(tracked.prNumber);
              if (merged) {
                await provider.transitionStatus(ticket.id, verificationStatus);
                await provider.postComment(ticket.id, [
                  "## Agent Worker — PR Merged",
                  "",
                  `PR #${tracked.prNumber} has been merged.`,
                ].join("\n"));
                log.info("PR merged, ticket moved to verification", {
                  ticketId: ticket.identifier,
                  prNumber: tracked.prNumber,
                });
                prTracker.untrack(ticket.id);
                continue;
              }
            } catch (err) {
              log.debug("Failed to check PR merge status", {
                ticketId: ticket.identifier,
                prNumber: tracked.prNumber,
                error: err instanceof Error ? err.message : String(err),
              });
            }

            // Fetch new PR comments
            let actionableComments: FeedbackEvent[] = [];
            try {
              const prComments = await scm.getPRComments(tracked.prNumber, tracked.lastCommentCheck);
              actionableComments = actionableComments.concat(
                findActionableComments(prComments, prefix).map((c) => ({ ...c, source: "pr" as const }))
              );
            } catch (err) {
              log.debug("Failed to fetch PR comments", {
                ticketId: ticket.identifier,
                prNumber: tracked.prNumber,
                error: err instanceof Error ? err.message : String(err),
              });
            }

            // Fetch new ticket comments
            try {
              const ticketComments = await provider.fetchComments(ticket.id, tracked.lastCommentCheck);
              actionableComments = actionableComments.concat(
                findActionableComments(ticketComments, prefix).map((c) => ({ ...c, source: "ticket" as const }))
              );
            } catch (err) {
              log.debug("Failed to fetch ticket comments", {
                ticketId: ticket.identifier,
                error: err instanceof Error ? err.message : String(err),
              });
            }

            if (actionableComments.length > 0) {
              log.info("Actionable feedback found", {
                ticketId: ticket.identifier,
                count: actionableComments.length,
              });
              for (const comment of actionableComments) {
                await processActionableFeedback(ticket, comment);
              }
            }

            // Update lastCommentCheck regardless
            const updated = prTracker.get(ticket.id);
            if (updated) {
              prTracker.track({ ...updated, lastCommentCheck: new Date().toISOString() });
            }
          }
        } catch (err) {
          log.error("Feedback poll cycle failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (!isRunning) break;
        await interruptibleSleep(intervalMs);
      }

      log.info("Feedback poller stopped");
    },

    stop() {
      isRunning = false;
      wakeSleep?.();
    },
  };
}
