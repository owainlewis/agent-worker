import { LinearClient } from "@linear/sdk";
import type { Ticket, TicketComment, TicketProvider } from "./types.ts";
import type { LinearProviderConfig } from "../config.ts";
import { log } from "../logger.ts";

const INITIAL_DELAY_MS = 1000;
const JITTER_MS = 500;
const MAX_DELAY_MS = 60000;
const MAX_BACKOFF_RETRIES = 5;

async function withBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_BACKOFF_RETRIES
): Promise<T> {
  let delay = INITIAL_DELAY_MS;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRateLimit =
        (err instanceof Error && err.message.toLowerCase().includes("ratelimit")) ||
        (err instanceof Error && err.message.includes("429"));

      if (!isRateLimit || attempt === maxRetries) throw err;

      log.debug("Rate limited, backing off", { component: "linear", attempt, delayMs: delay + Math.random() * JITTER_MS });
      const jitter = Math.random() * JITTER_MS;
      await Bun.sleep(delay + jitter);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
  throw new Error("Unreachable");
}

export function createLinearProvider(config: LinearProviderConfig): TicketProvider {
  const logger = log.child("linear");
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY environment variable is required for Linear provider");
  }

  const client = new LinearClient({ apiKey });
  const stateCache = new Map<string, { id: string; name: string }[]>();

  async function getTeamStates(teamId: string): Promise<{ id: string; name: string }[]> {
    if (stateCache.has(teamId)) return stateCache.get(teamId)!;
    logger.debug("Fetching team states", { teamId });
    const team = await withBackoff(() => client.team(teamId));
    const states = await withBackoff(() => team.states());
    const nodes = states.nodes.map((s) => ({ id: s.id, name: s.name }));
    stateCache.set(teamId, nodes);
    logger.debug("Cached team states", { teamId, count: nodes.length });
    return nodes;
  }

  return {
    async fetchReadyTickets(): Promise<Ticket[]> {
      logger.debug("Fetching ready tickets", { projectId: config.project_id, status: config.statuses.ready });
      const issues = await withBackoff(() =>
        client.issues({
          filter: {
            project: { id: { eq: config.project_id } },
            state: { name: { eq: config.statuses.ready } },
          },
        })
      );

      const tickets = issues.nodes.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
      }));
      logger.debug("Fetched ready tickets", { count: tickets.length });
      return tickets;
    },

    async fetchTicketsByStatus(statusName: string): Promise<Ticket[]> {
      logger.debug("Fetching tickets by status", { projectId: config.project_id, status: statusName });
      const issues = await withBackoff(() =>
        client.issues({
          filter: {
            project: { id: { eq: config.project_id } },
            state: { name: { eq: statusName } },
          },
        })
      );

      const tickets = issues.nodes.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
      }));
      logger.debug("Fetched tickets by status", { status: statusName, count: tickets.length });
      return tickets;
    },

    async transitionStatus(ticketId: string, statusName: string): Promise<void> {
      logger.debug("Transitioning ticket status", { ticketId, to: statusName });
      const issue = await withBackoff(() => client.issue(ticketId));
      const team = await issue.team;
      if (!team) throw new Error(`No team found for issue ${ticketId}`);

      const states = await getTeamStates(team.id);
      const target = states.find((s) => s.name === statusName);
      if (!target) throw new Error(`Status "${statusName}" not found on team`);

      await withBackoff(() => client.updateIssue(ticketId, { stateId: target.id }));
      logger.debug("Ticket status transitioned", { ticketId, to: statusName });
    },

    async postComment(ticketId: string, body: string): Promise<void> {
      logger.debug("Posting comment", { ticketId, bodyLength: body.length });
      await withBackoff(() =>
        client.createComment({ issueId: ticketId, body })
      );
    },

    async fetchComments(ticketId: string, since?: string): Promise<TicketComment[]> {
      logger.debug("Fetching comments", { ticketId, since });
      const issue = await withBackoff(() => client.issue(ticketId));
      const connection = await withBackoff(() => issue.comments());
      const comments = connection.nodes;

      let results = comments.map((c) => ({
        id: c.id,
        author: c.body ?? "unknown",
        body: c.body,
        createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
      }));

      if (since) {
        const sinceDate = new Date(since);
        results = results.filter((c) => new Date(c.createdAt) > sinceDate);
      }

      logger.debug("Fetched comments", { ticketId, total: comments.length, filtered: results.length });
      return results;
    },
  };
}
