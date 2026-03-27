/**
 * @module src/providers/github — GitHub Projects v2 ticket provider using GraphQL API for
 * project status management and REST API for issue comments.
 */
import type { Ticket, TicketComment, TicketProvider } from "./types.ts";
import type { GitHubProviderConfig } from "../config.ts";
import { log } from "../logger.ts";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const GITHUB_REST = "https://api.github.com";

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
        (err instanceof Error && err.message.includes("429")) ||
        (err instanceof Error && err.message.toLowerCase().includes("ratelimit")) ||
        (err instanceof Error && err.message.toLowerCase().includes("rate limit"));

      if (!isRateLimit || attempt === maxRetries) throw err;

      log.debug("Rate limited, backing off", { component: "github", attempt, delayMs: delay + Math.random() * JITTER_MS });
      const jitter = Math.random() * JITTER_MS;
      await Bun.sleep(delay + jitter);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
  throw new Error("Unreachable");
}

/** Parsed query filters for client-side filtering of project items. */
interface QueryFilters {
  assignees: string[];
  labels: string[];
}

/**
 * Parses a query string into structured filters.
 * Supports `assignee:login` and `label:name` filters, space-separated.
 * Example: `"assignee:bot-user label:agent label:priority"` →
 *   `{ assignees: ["bot-user"], labels: ["agent", "priority"] }`
 */
function parseQueryFilters(query?: string): QueryFilters {
  const filters: QueryFilters = { assignees: [], labels: [] };
  if (!query) return filters;

  for (const token of query.split(/\s+/)) {
    const [key, ...rest] = token.split(":");
    const value = rest.join(":");
    if (!value) continue;
    if (key === "assignee") filters.assignees.push(value);
    else if (key === "label") filters.labels.push(value);
  }
  return filters;
}

/** Cached project metadata resolved on first API call. */
interface ProjectCache {
  projectId: string;
  fieldId: string;
  optionsByName: Map<string, string>; // status name → option ID
}

/**
 * Encodes a project item node ID and issue number into a composite ticket ID.
 */
function makeTicketId(itemId: string, issueNumber: number): string {
  return `${itemId}:${issueNumber}`;
}

/**
 * Decodes a composite ticket ID into its project item ID and issue number.
 */
function parseTicketId(id: string): { itemId: string; issueNumber: number } {
  const sep = id.indexOf(":");
  if (sep === -1) throw new Error(`Invalid GitHub ticket ID: ${id}`);
  return { itemId: id.slice(0, sep), issueNumber: parseInt(id.slice(sep + 1), 10) };
}

/**
 * Creates a GitHub Projects v2 ticket provider.
 *
 * Uses the GraphQL API for project item queries and status transitions, and
 * the REST API for issue comments. Requires the `GITHUB_TOKEN` environment
 * variable with `repo` and `project` scopes.
 *
 * @param config - Provider configuration including owner, repo, project number, and status mappings.
 * @returns A {@link TicketProvider} instance.
 * @throws Error if `GITHUB_TOKEN` is not set in the environment.
 */
export function createGitHubProvider(config: GitHubProviderConfig): TicketProvider {
  const logger = log.child("github-provider");
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required for GitHub provider");
  }

  const { owner, repo, project_number, owner_type, status_field, query } = config;
  let cache: ProjectCache | null = null;

  // Parse query filters (e.g. "assignee:username label:bug")
  const filters = parseQueryFilters(query);

  /** Makes a GitHub GraphQL API request. */
  async function graphqlFetch<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    logger.debug("GraphQL request", { variables: JSON.stringify(variables) });
    const start = Date.now();
    const res = await withBackoff(() =>
      fetch(GITHUB_GRAPHQL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "agent-worker",
        },
        body: JSON.stringify({ query, variables }),
      })
    );
    logger.debug("GraphQL response", { status: res.status, durationMs: Date.now() - start });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub GraphQL error ${res.status}: ${text}`);
    }

    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new Error(`GitHub GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data as T;
  }

  /** Makes a GitHub REST API request for issue operations. */
  async function restFetch(path: string, options?: RequestInit): Promise<Response> {
    const url = `${GITHUB_REST}/repos/${owner}/${repo}${path}`;
    logger.debug("REST request", { method: options?.method ?? "GET", path });
    const start = Date.now();
    const res = await withBackoff(() =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "agent-worker",
          ...options?.headers,
        },
      })
    );
    logger.debug("REST response", { path, status: res.status, durationMs: Date.now() - start });
    if (!res.ok && res.status !== 201) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub REST error ${res.status}: ${text}`);
    }
    return res;
  }

  /** Resolves and caches the project ID, status field ID, and option map. */
  async function ensureCache(): Promise<ProjectCache> {
    if (cache) return cache;

    const ownerField = owner_type === "organization" ? "organization" : "user";
    const query = `
      query($login: String!, $number: Int!) {
        ${ownerField}(login: $login) {
          projectV2(number: $number) {
            id
            field(name: "${status_field}") {
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;

    const data = await graphqlFetch<Record<string, unknown>>(query, { login: owner, number: project_number });

    const ownerNode = data[ownerField] as Record<string, unknown> | null;
    const project = ownerNode?.projectV2 as Record<string, unknown> | null;
    if (!project) {
      throw new Error(`GitHub Project #${project_number} not found for ${ownerField} "${owner}"`);
    }

    const field = project.field as { id: string; options: { id: string; name: string }[] } | null;
    if (!field?.id || !field?.options) {
      throw new Error(`Status field "${status_field}" not found or is not a single-select field on project #${project_number}`);
    }

    const optionsByName = new Map<string, string>();
    for (const opt of field.options) {
      optionsByName.set(opt.name, opt.id);
    }

    cache = {
      projectId: project.id as string,
      fieldId: field.id,
      optionsByName,
    };
    logger.debug("Project cache initialized", {
      projectId: cache.projectId,
      fieldId: cache.fieldId,
      optionCount: optionsByName.size,
    });
    return cache;
  }

  /**
   * Fetches project items filtered by status name and repository.
   * Paginates through all items since the GraphQL API does not support
   * server-side filtering by field values.
   */
  async function fetchItemsByStatus(statusName: string, limit?: number): Promise<Ticket[]> {
    const { projectId } = await ensureCache();
    const tickets: Ticket[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const needsAssignees = filters.assignees.length > 0;
      const needsLabels = filters.labels.length > 0;

      const query = `
        query($projectId: ID!, $cursor: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  fieldValueByName(name: "${status_field}") {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                    }
                  }
                  content {
                    ... on Issue {
                      number
                      title
                      body
                      repository {
                        name
                        owner {
                          login
                        }
                      }
                      ${needsAssignees ? "assignees(first: 10) { nodes { login } }" : ""}
                      ${needsLabels ? "labels(first: 20) { nodes { name } }" : ""}
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const data = await graphqlFetch<Record<string, unknown>>(query, { projectId, cursor });
      const node = data.node as Record<string, unknown>;
      const items = node.items as {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          fieldValueByName: { name: string } | null;
          content: {
            number: number;
            title: string;
            body: string | null;
            repository: { name: string; owner: { login: string } };
            assignees?: { nodes: { login: string }[] };
            labels?: { nodes: { name: string }[] };
          } | null;
        }[];
      };

      for (const item of items.nodes) {
        // Skip draft issues, PRs, or items without issue content
        if (!item.content?.repository) continue;
        // Filter to the configured repository
        if (item.content.repository.owner.login !== owner || item.content.repository.name !== repo) continue;
        // Filter by status
        if (item.fieldValueByName?.name !== statusName) continue;
        // Filter by assignee
        if (needsAssignees) {
          const issueAssignees = new Set(item.content.assignees?.nodes.map((a) => a.login) ?? []);
          if (!filters.assignees.some((a) => issueAssignees.has(a))) continue;
        }
        // Filter by label
        if (needsLabels) {
          const issueLabels = new Set(item.content.labels?.nodes.map((l) => l.name) ?? []);
          if (!filters.labels.every((l) => issueLabels.has(l))) continue;
        }

        tickets.push({
          id: makeTicketId(item.id, item.content.number),
          identifier: String(item.content.number),
          title: item.content.title,
          description: item.content.body ?? undefined,
        });

        if (limit && tickets.length >= limit) {
          return tickets;
        }
      }

      hasNextPage = items.pageInfo.hasNextPage;
      cursor = items.pageInfo.endCursor;
    }

    return tickets;
  }

  return {
    async fetchReadyTickets(): Promise<Ticket[]> {
      logger.debug("Fetching ready tickets", { status: config.statuses.ready });
      const tickets = await fetchItemsByStatus(config.statuses.ready, 1);
      logger.debug("Fetched ready tickets", { count: tickets.length });
      return tickets;
    },

    async fetchTicketsByStatus(statusName: string): Promise<Ticket[]> {
      logger.debug("Fetching tickets by status", { status: statusName });
      const tickets = await fetchItemsByStatus(statusName);
      logger.debug("Fetched tickets by status", { status: statusName, count: tickets.length });
      return tickets;
    },

    async transitionStatus(ticketId: string, statusName: string): Promise<void> {
      logger.debug("Transitioning ticket status", { ticketId, to: statusName });
      const { projectId, fieldId, optionsByName } = await ensureCache();
      const { itemId } = parseTicketId(ticketId);

      const optionId = optionsByName.get(statusName);
      if (!optionId) {
        throw new Error(
          `GitHub Projects status "${statusName}" not found. Available: ${[...optionsByName.keys()].join(", ")}`
        );
      }

      const mutation = `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(
            input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $optionId }
            }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `;

      await graphqlFetch(mutation, { projectId, itemId, fieldId, optionId });
      logger.debug("Ticket status transitioned", { ticketId, to: statusName });
    },

    async postComment(ticketId: string, body: string): Promise<void> {
      const { issueNumber } = parseTicketId(ticketId);
      logger.debug("Posting comment", { issueNumber, bodyLength: body.length });
      await restFetch(`/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    async fetchComments(ticketId: string, since?: string): Promise<TicketComment[]> {
      const { issueNumber } = parseTicketId(ticketId);
      logger.debug("Fetching comments", { issueNumber, since });
      const params = new URLSearchParams();
      params.set("per_page", "100");
      if (since) params.set("since", since);
      const res = await restFetch(`/issues/${issueNumber}/comments?${params}`);
      const data = (await res.json()) as {
        id: number;
        user: { login: string } | null;
        body: string;
        created_at: string;
      }[];

      const results = data.map((c) => ({
        id: String(c.id),
        author: c.user?.login ?? "unknown",
        body: c.body,
        createdAt: c.created_at,
      }));
      logger.debug("Fetched comments", { issueNumber, count: results.length });
      return results;
    },
  };
}
