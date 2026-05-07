import { LinearClient } from "@linear/sdk";
import type { Ticket, TicketProvider } from "./types.ts";

const INITIAL_DELAY_MS = 1000;
const JITTER_MS = 500;
const MAX_DELAY_MS = 60000;
const MAX_BACKOFF_RETRIES = 5;

type StatusMap = {
  ready: string;
  in_progress: string;
  done: string;
  failed: string;
};

async function withBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = MAX_BACKOFF_RETRIES,
): Promise<T> {
  let delay = INITIAL_DELAY_MS;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const isRateLimit =
        (err instanceof Error &&
          err.message.toLowerCase().includes("ratelimit")) ||
        (err instanceof Error && err.message.includes("429"));

      if (!isRateLimit || attempt === maxRetries) throw err;

      const jitter = Math.random() * JITTER_MS;
      await Bun.sleep(delay + jitter);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
  throw new Error("Unreachable");
}

export function createLinearProvider(options: {
  apiKey: string;
  /**
   * Single-project mode (legacy). When provided alone, behaves identically to
   * the pre-SAM-481 framework: query one project, return its ready tickets.
   * Mutually exclusive with projectIds — supply one OR the other, not both.
   */
  projectId?: string;
  /**
   * Multi-project mode (SAM-481 cross-repo work-stealing). Ordered list, primary
   * first. The provider queries projects in order and returns the FIRST non-empty
   * result — so a fallback project is only consulted when all higher-priority
   * projects are empty. This matches the user mental model "claude-ia helps with
   * studio-os work only when its own queue is drained, not in parallel."
   */
  projectIds?: string[];
  statuses: StatusMap;
}): TicketProvider {
  // Normalize to a single canonical list. Backward compat: projectId alone →
  // projectIds = [projectId]. Both supplied → reject (caller bug).
  const projectIds: string[] = (() => {
    if (options.projectId && options.projectIds) {
      throw new Error(
        "createLinearProvider: pass either projectId (legacy) or projectIds (multi-project) — not both",
      );
    }
    if (options.projectIds) return options.projectIds;
    if (options.projectId) return [options.projectId];
    throw new Error("createLinearProvider: must pass projectId or projectIds");
  })();

  const client = new LinearClient({ apiKey: options.apiKey });
  const stateCache = new Map<string, { id: string; name: string }[]>();

  async function getTeamStates(
    teamId: string,
  ): Promise<{ id: string; name: string }[]> {
    if (stateCache.has(teamId)) return stateCache.get(teamId)!;
    const team = await client.team(teamId);
    const states = await team.states();
    const nodes = states.nodes.map((s) => ({ id: s.id, name: s.name }));
    stateCache.set(teamId, nodes);
    return nodes;
  }

  /**
   * Fetch ready tickets from a single project. Internal helper used by
   * fetchReadyTickets to walk the projectIds list in priority order. The
   * Linear SDK returns Issue objects whose `labels` field is an async
   * connection — we resolve it client-side to populate Ticket.labels.
   */
  async function fetchFromProject(projectId: string): Promise<Ticket[]> {
    const issues = await withBackoff(() =>
      client.issues({
        filter: {
          project: { id: { eq: projectId } },
          state: { name: { eq: options.statuses.ready } },
        },
      }),
    );

    // Resolve labels for each issue. Linear's SDK exposes labels as an async
    // connection; we await per-issue. For the typical poll volume (10s of
    // tickets max in a primary-empty case) the round-trip cost is negligible.
    const tickets: Ticket[] = [];
    for (const issue of issues.nodes) {
      const labelConnection = await issue.labels();
      const labels = labelConnection.nodes.map((l) => l.name);
      tickets.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        labels,
        projectId,
      });
    }
    return tickets;
  }

  return {
    async fetchReadyTickets(): Promise<Ticket[]> {
      // Walk projectIds in priority order. Return tickets from the FIRST
      // non-empty project — a fallback queue is only consulted when all
      // higher-priority queues are empty. This is the core SAM-481 contract.
      for (const pid of projectIds) {
        const tickets = await fetchFromProject(pid);
        if (tickets.length > 0) return tickets;
      }
      return [];
    },

    async transitionStatus(
      ticketId: string,
      statusName: string,
    ): Promise<void> {
      const issue = await withBackoff(() => client.issue(ticketId));
      const team = await issue.team;
      if (!team) throw new Error(`No team found for issue ${ticketId}`);

      const states = await getTeamStates(team.id);
      const target = states.find((s) => s.name === statusName);
      if (!target) throw new Error(`Status "${statusName}" not found on team`);

      await withBackoff(() =>
        client.updateIssue(ticketId, { stateId: target.id }),
      );
    },

    async postComment(ticketId: string, body: string): Promise<void> {
      await withBackoff(() =>
        client.createComment({ issueId: ticketId, body }),
      );
    },
  };
}
