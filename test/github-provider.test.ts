import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createGitHubProvider } from "../src/providers/github.ts";

const githubConfig = {
  type: "github" as const,
  owner: "my-org",
  repo: "my-repo",
  project_number: 5,
  owner_type: "organization" as const,
  status_field: "Status",
  poll_interval_seconds: 60,
  statuses: {
    ready: "Todo",
    in_progress: "In Progress",
    code_review: "Code Review",
    verification: "Done",
    failed: "Canceled",
  },
};

function mockFetch(fn: typeof fetch) {
  (globalThis as { fetch: typeof fetch }).fetch = fn;
}

/** Returns a GraphQL response for the project cache init query. */
function projectCacheResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        organization: {
          projectV2: {
            id: "PVT_abc123",
            field: {
              id: "FIELD_status",
              options: [
                { id: "OPT_todo", name: "Todo" },
                { id: "OPT_in_progress", name: "In Progress" },
                { id: "OPT_code_review", name: "Code Review" },
                { id: "OPT_done", name: "Done" },
                { id: "OPT_canceled", name: "Canceled" },
              ],
            },
          },
        },
      },
    }),
  };
}

/** Returns a GraphQL response for fetching project items. */
function itemsResponse(items: unknown[]) {
  return {
    ok: true,
    json: async () => ({
      data: {
        node: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: items,
          },
        },
      },
    }),
  };
}

function makeItem(overrides: {
  id?: string;
  status?: string;
  number?: number;
  title?: string;
  body?: string | null;
  repoOwner?: string;
  repoName?: string;
} = {}) {
  return {
    id: overrides.id ?? "PVTI_item1",
    fieldValueByName: overrides.status !== undefined ? { name: overrides.status } : null,
    content: {
      number: overrides.number ?? 42,
      title: overrides.title ?? "Fix the bug",
      body: overrides.body !== undefined ? overrides.body : "Description here",
      repository: {
        name: overrides.repoName ?? "my-repo",
        owner: { login: overrides.repoOwner ?? "my-org" },
      },
    },
  };
}

describe("createGitHubProvider", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.GITHUB_TOKEN = "ghp_testtoken";
  });

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    delete process.env.GITHUB_TOKEN;
  });

  test("throws when GITHUB_TOKEN is not set", () => {
    delete process.env.GITHUB_TOKEN;
    expect(() => createGitHubProvider(githubConfig)).toThrow(
      "GITHUB_TOKEN environment variable is required for GitHub provider"
    );
  });

  test("returns a TicketProvider with required methods", () => {
    const provider = createGitHubProvider(githubConfig);
    expect(typeof provider.fetchReadyTickets).toBe("function");
    expect(typeof provider.fetchTicketsByStatus).toBe("function");
    expect(typeof provider.transitionStatus).toBe("function");
    expect(typeof provider.postComment).toBe("function");
    expect(typeof provider.fetchComments).toBe("function");
  });

  test("fetchReadyTickets returns tickets matching ready status and repo", async () => {
    let callCount = 0;
    mockFetch(
      mock((url: string) => {
        callCount++;
        if (url.includes("graphql") && callCount === 1) {
          return Promise.resolve(projectCacheResponse() as Response);
        }
        // Items query
        return Promise.resolve(
          itemsResponse([
            makeItem({ status: "Todo", number: 42, title: "Fix the bug", body: "Description here" }),
            makeItem({ status: "In Progress", number: 43, title: "Other task" }),
          ]) as Response
        );
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.id).toBe("PVTI_item1:42");
    expect(tickets[0]!.identifier).toBe("42");
    expect(tickets[0]!.title).toBe("Fix the bug");
    expect(tickets[0]!.description).toBe("Description here");
  });

  test("fetchReadyTickets skips draft issues (null content)", async () => {
    let callCount = 0;
    mockFetch(
      mock((url: string) => {
        callCount++;
        if (url.includes("graphql") && callCount === 1) {
          return Promise.resolve(projectCacheResponse() as Response);
        }
        return Promise.resolve(
          itemsResponse([
            { id: "PVTI_draft", fieldValueByName: { name: "Todo" }, content: null },
            makeItem({ status: "Todo", number: 10 }),
          ]) as Response
        );
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.identifier).toBe("10");
  });

  test("fetchReadyTickets skips items from other repos", async () => {
    let callCount = 0;
    mockFetch(
      mock((url: string) => {
        callCount++;
        if (url.includes("graphql") && callCount === 1) {
          return Promise.resolve(projectCacheResponse() as Response);
        }
        return Promise.resolve(
          itemsResponse([
            makeItem({ status: "Todo", number: 1, repoName: "other-repo" }),
            makeItem({ status: "Todo", number: 2, repoOwner: "other-org" }),
            makeItem({ status: "Todo", number: 3 }),
          ]) as Response
        );
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.identifier).toBe("3");
  });

  test("fetchReadyTickets handles null description", async () => {
    let callCount = 0;
    mockFetch(
      mock((url: string) => {
        callCount++;
        if (url.includes("graphql") && callCount === 1) {
          return Promise.resolve(projectCacheResponse() as Response);
        }
        return Promise.resolve(
          itemsResponse([makeItem({ status: "Todo", body: null })]) as Response
        );
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets[0]!.description).toBeUndefined();
  });

  test("fetchReadyTickets returns empty array when no matching items", async () => {
    let callCount = 0;
    mockFetch(
      mock((url: string) => {
        callCount++;
        if (url.includes("graphql") && callCount === 1) {
          return Promise.resolve(projectCacheResponse() as Response);
        }
        return Promise.resolve(itemsResponse([]) as Response);
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets).toEqual([]);
  });

  test("transitionStatus calls updateProjectV2ItemFieldValue with correct option ID", async () => {
    const calls: { url: string; body: string }[] = [];
    let callCount = 0;

    mockFetch(
      mock((url: string, options?: RequestInit) => {
        callCount++;
        calls.push({ url, body: options?.body as string ?? "" });
        if (callCount === 1) {
          return Promise.resolve(projectCacheResponse() as Response);
        }
        // Mutation response
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item1" } } },
          }),
        } as Response);
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    await provider.transitionStatus("PVTI_item1:42", "In Progress");

    expect(callCount).toBe(2);
    const mutationBody = JSON.parse(calls[1]!.body);
    expect(mutationBody.variables.itemId).toBe("PVTI_item1");
    expect(mutationBody.variables.optionId).toBe("OPT_in_progress");
    expect(mutationBody.variables.fieldId).toBe("FIELD_status");
  });

  test("transitionStatus throws when status name not found", async () => {
    mockFetch(
      mock(() => Promise.resolve(projectCacheResponse() as Response)) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    await expect(provider.transitionStatus("PVTI_item1:42", "Nonexistent")).rejects.toThrow(
      'GitHub Projects status "Nonexistent" not found'
    );
  });

  test("postComment calls REST API for issue comments", async () => {
    const calls: { url: string; method: string }[] = [];
    mockFetch(
      mock((url: string, options?: RequestInit) => {
        calls.push({ url, method: options?.method ?? "GET" });
        return Promise.resolve({ ok: true, status: 201, json: async () => ({}) } as Response);
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    await provider.postComment("PVTI_item1:42", "Test comment");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/repos/my-org/my-repo/issues/42/comments");
    expect(calls[0]!.method).toBe("POST");
  });

  test("fetchComments calls REST API and maps response", async () => {
    const calls: string[] = [];
    mockFetch(
      mock((url: string) => {
        calls.push(url);
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 100,
              user: { login: "reviewer" },
              body: "Looks good",
              created_at: "2026-03-26T10:00:00Z",
            },
            {
              id: 101,
              user: null,
              body: "Bot comment",
              created_at: "2026-03-26T11:00:00Z",
            },
          ],
        } as Response);
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    const comments = await provider.fetchComments("PVTI_item1:42", "2026-03-26T00:00:00Z");

    expect(calls[0]).toContain("/repos/my-org/my-repo/issues/42/comments");
    expect(calls[0]).toContain("since=2026-03-26T00%3A00%3A00Z");
    expect(comments).toHaveLength(2);
    expect(comments[0]!.id).toBe("100");
    expect(comments[0]!.author).toBe("reviewer");
    expect(comments[0]!.body).toBe("Looks good");
    expect(comments[1]!.author).toBe("unknown");
  });

  test("fetchReadyTickets filters by assignee and label when query is set", async () => {
    const configWithQuery = {
      ...githubConfig,
      query: "assignee:bot-user label:agent",
    };

    let callCount = 0;
    mockFetch(
      mock((url: string) => {
        callCount++;
        if (url.includes("graphql") && callCount === 1) {
          return Promise.resolve(projectCacheResponse() as Response);
        }
        return Promise.resolve(
          itemsResponse([
            // Matches: correct assignee and label
            {
              ...makeItem({ status: "Todo", number: 1 }),
              content: {
                ...makeItem({ status: "Todo", number: 1 }).content,
                assignees: { nodes: [{ login: "bot-user" }] },
                labels: { nodes: [{ name: "agent" }, { name: "bug" }] },
              },
            },
            // No match: wrong assignee
            {
              ...makeItem({ status: "Todo", number: 2 }),
              content: {
                ...makeItem({ status: "Todo", number: 2 }).content,
                assignees: { nodes: [{ login: "other-user" }] },
                labels: { nodes: [{ name: "agent" }] },
              },
            },
            // No match: missing label
            {
              ...makeItem({ status: "Todo", number: 3 }),
              content: {
                ...makeItem({ status: "Todo", number: 3 }).content,
                assignees: { nodes: [{ login: "bot-user" }] },
                labels: { nodes: [{ name: "bug" }] },
              },
            },
          ]) as Response
        );
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(configWithQuery);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.identifier).toBe("1");
  });

  test("caches project metadata across calls", async () => {
    let graphqlCallCount = 0;
    mockFetch(
      mock((url: string) => {
        if (url.includes("graphql")) {
          graphqlCallCount++;
          if (graphqlCallCount === 1) {
            return Promise.resolve(projectCacheResponse() as Response);
          }
          // Subsequent GraphQL calls are item queries
          return Promise.resolve(itemsResponse([makeItem({ status: "Todo" })]) as Response);
        }
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }) as unknown as typeof fetch
    );

    const provider = createGitHubProvider(githubConfig);
    await provider.fetchReadyTickets();
    await provider.fetchReadyTickets();

    // Cache init (1) + items query (1) + items query (1) = 3
    // NOT cache init (1) + items (1) + cache init (1) + items (1) = 4
    expect(graphqlCallCount).toBe(3);
  });
});
