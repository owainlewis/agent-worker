import type { Ticket, TicketComment, TicketProvider } from "./types.ts";
import type { PlaneProviderConfig } from "../config.ts";

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
        (err instanceof Error && err.message.toLowerCase().includes("ratelimit"));

      if (!isRateLimit || attempt === maxRetries) throw err;

      const jitter = Math.random() * JITTER_MS;
      await Bun.sleep(delay + jitter);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
  throw new Error("Unreachable");
}

interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  description_html: string | null;
  state: string;
}

interface PlaneIssuesResponse {
  results: PlaneIssue[];
}

interface PlaneState {
  id: string;
  name: string;
  group: string;
}

interface PlaneStatesResponse {
  results: PlaneState[];
}

interface PlaneComment {
  id: string;
  created_at: string;
  comment_html: string;
  actor: {
    display_name: string;
  };
}

interface PlaneCommentsResponse {
  results: PlaneComment[];
}

export function createPlaneProvider(config: PlaneProviderConfig): TicketProvider {
  const apiKey = process.env.PLANE_API_KEY;
  if (!apiKey) {
    throw new Error("PLANE_API_KEY environment variable is required for Plane provider");
  }

  const baseUrl = config.base_url.replace(/\/+$/, "");
  const { workspace_slug, project_id } = config;

  const stateCache = new Map<string, PlaneState[]>();
  let projectIdentifier: string | undefined;

  async function planeFetch(path: string, options?: RequestInit): Promise<Response> {
    const url = `${baseUrl}/api/v1/workspaces/${workspace_slug}${path}`;
    const res = await withBackoff(() =>
      fetch(url, {
        ...options,
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      })
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Plane API error ${res.status}: ${text}`);
    }
    return res;
  }

  async function getStates(): Promise<PlaneState[]> {
    if (stateCache.has(project_id)) return stateCache.get(project_id)!;
    const res = await planeFetch(`/projects/${project_id}/states/`);
    const data = (await res.json()) as PlaneStatesResponse;
    const states = data.results;
    stateCache.set(project_id, states);
    return states;
  }

  async function getProjectIdentifier(): Promise<string> {
    if (projectIdentifier) return projectIdentifier;
    const res = await planeFetch(`/projects/${project_id}/`);
    const data = (await res.json()) as { identifier: string };
    projectIdentifier = data.identifier;
    return projectIdentifier;
  }

  function makeIdentifier(issue: PlaneIssue, identifier: string): string {
    return `${identifier}-${issue.sequence_id}`;
  }

  return {
    async fetchReadyTickets(): Promise<Ticket[]> {
      const identifier = await getProjectIdentifier();
      const params = new URLSearchParams();
      params.set("query", config.query);
      const res = await planeFetch(`/projects/${project_id}/issues/?${params}`);
      const data = (await res.json()) as PlaneIssuesResponse;

      return data.results.map((issue) => ({
        id: issue.id,
        identifier: makeIdentifier(issue, identifier),
        title: issue.name,
        description: issue.description_html ?? undefined,
      }));
    },

    async fetchTicketsByStatus(statusName: string): Promise<Ticket[]> {
      const states = await getStates();
      const target = states.find((s) => s.name === statusName);
      if (!target) return [];

      const identifier = await getProjectIdentifier();
      const params = new URLSearchParams();
      params.set("query", `state:${target.id}`);
      const res = await planeFetch(`/projects/${project_id}/issues/?${params}`);
      const data = (await res.json()) as PlaneIssuesResponse;

      return data.results.map((issue) => ({
        id: issue.id,
        identifier: makeIdentifier(issue, identifier),
        title: issue.name,
        description: issue.description_html ?? undefined,
      }));
    },

    async transitionStatus(ticketId: string, statusName: string): Promise<void> {
      const states = await getStates();
      const target = states.find((s) => s.name === statusName);
      if (!target) {
        throw new Error(`Plane state "${statusName}" not found for project ${project_id}. Available: ${states.map((s) => s.name).join(", ")}`);
      }

      await planeFetch(`/projects/${project_id}/issues/${ticketId}/`, {
        method: "PATCH",
        body: JSON.stringify({ state: target.id }),
      });
    },

    async postComment(ticketId: string, body: string): Promise<void> {
      await planeFetch(`/projects/${project_id}/issues/${ticketId}/comments/`, {
        method: "POST",
        body: JSON.stringify({ comment_html: body }),
      });
    },

    async fetchComments(ticketId: string, since?: string): Promise<TicketComment[]> {
      const res = await planeFetch(`/projects/${project_id}/issues/${ticketId}/comments/`);
      const data = (await res.json()) as PlaneCommentsResponse;

      let results = data.results.map((c) => ({
        id: c.id,
        author: c.actor.display_name,
        body: c.comment_html,
        createdAt: c.created_at,
      }));

      if (since) {
        const sinceDate = new Date(since);
        results = results.filter((c) => new Date(c.createdAt) > sinceDate);
      }

      return results;
    },
  };
}
