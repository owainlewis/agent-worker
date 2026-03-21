import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createPlaneProvider } from "../src/providers/plane.ts";

const planeConfig = {
  type: "plane" as const,
  base_url: "https://plane.example.com",
  workspace_slug: "my-workspace",
  project_id: "proj-uuid-123",
  poll_interval_seconds: 60,
  query: "state_group: backlog",
  statuses: {
    ready: "Backlog",
    in_progress: "In Progress",
    done: "Done",
    failed: "Canceled",
  },
};

const projectResponse = {
  ok: true,
  json: async () => ({ identifier: "ENG" }),
};

describe("createPlaneProvider", () => {
  beforeEach(() => {
    process.env.PLANE_API_KEY = "test-plane-key";
  });

  afterEach(() => {
    delete process.env.PLANE_API_KEY;
  });

  test("throws when PLANE_API_KEY is not set", () => {
    delete process.env.PLANE_API_KEY;
    expect(() => createPlaneProvider(planeConfig)).toThrow(
      "PLANE_API_KEY environment variable is required"
    );
  });

  test("returns a TicketProvider with required methods", () => {
    const provider = createPlaneProvider(planeConfig);
    expect(typeof provider.fetchReadyTickets).toBe("function");
    expect(typeof provider.transitionStatus).toBe("function");
    expect(typeof provider.postComment).toBe("function");
  });

  test("fetchReadyTickets calls Plane issues API with query param", async () => {
    const issuesResponse = {
      ok: true,
      json: async () => ({
        results: [
          {
            id: "issue-uuid-1",
            sequence_id: 42,
            name: "Fix the login bug",
            description_html: "<p>Login is broken</p>",
            state: "backlog",
          },
        ],
      }),
    };

    globalThis.fetch = mock((url: string) => {
      if (url.includes("/projects/proj-uuid-123/issues/")) {
        return Promise.resolve(issuesResponse as Response);
      }
      // Project detail endpoint
      if (url.endsWith("/projects/proj-uuid-123/")) {
        return Promise.resolve(projectResponse as Response);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const provider = createPlaneProvider(planeConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe("issue-uuid-1");
    expect(tickets[0].identifier).toBe("ENG-42");
    expect(tickets[0].title).toBe("Fix the login bug");
    expect(tickets[0].description).toBe("<p>Login is broken</p>");

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
    // First call should be project detail, second should be issues
    expect(calls[0][0]).toContain("/projects/proj-uuid-123/");
    expect(calls[1][0]).toContain("query=state_group");
    expect(calls[1][0]).toContain("/projects/proj-uuid-123/issues/");
  });

  test("fetchReadyTickets handles null description_html", async () => {
    const issuesResponse = {
      ok: true,
      json: async () => ({
        results: [
          {
            id: "issue-uuid-2",
            sequence_id: 43,
            name: "No desc issue",
            description_html: null,
            state: "backlog",
          },
        ],
      }),
    };

    globalThis.fetch = mock((url: string) => {
      if (url.includes("/projects/proj-uuid-123/issues/")) {
        return Promise.resolve(issuesResponse as Response);
      }
      if (url.endsWith("/projects/proj-uuid-123/")) {
        return Promise.resolve(projectResponse as Response);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const provider = createPlaneProvider(planeConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets[0].description).toBeUndefined();
  });

  test("fetchReadyTickets returns empty array when no issues", async () => {
    const emptyResponse = {
      ok: true,
      json: async () => ({ results: [] }),
    };

    globalThis.fetch = mock((url: string) => {
      if (url.includes("/projects/proj-uuid-123/issues/")) {
        return Promise.resolve(emptyResponse as Response);
      }
      if (url.endsWith("/projects/proj-uuid-123/")) {
        return Promise.resolve(projectResponse as Response);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const provider = createPlaneProvider(planeConfig);
    const tickets = await provider.fetchReadyTickets();

    expect(tickets).toEqual([]);
  });

  test("transitionStatus fetches states then patches issue", async () => {
    const statesResponse = {
      ok: true,
      json: async () => ({
        results: [
          { id: "state-1", name: "Backlog", group: "backlog" },
          { id: "state-2", name: "In Progress", group: "started" },
          { id: "state-3", name: "Done", group: "completed" },
          { id: "state-4", name: "Canceled", group: "cancelled" },
        ],
      }),
    };

    const patchResponse = {
      ok: true,
      json: async () => ({}),
    };

    globalThis.fetch = mock((url: string) => {
      if (url.includes("/states/")) {
        return Promise.resolve(statesResponse as Response);
      }
      if (url.endsWith("/projects/proj-uuid-123/")) {
        return Promise.resolve(projectResponse as Response);
      }
      return Promise.resolve(patchResponse as Response);
    });

    const provider = createPlaneProvider(planeConfig);
    await provider.transitionStatus("issue-uuid-1", "Done");

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("transitionStatus throws when state name not found", async () => {
    const statesResponse = {
      ok: true,
      json: async () => ({
        results: [
          { id: "state-1", name: "Backlog", group: "backlog" },
        ],
      }),
    };

    globalThis.fetch = mock((url: string) => {
      if (url.includes("/states/")) {
        return Promise.resolve(statesResponse as Response);
      }
      if (url.endsWith("/projects/proj-uuid-123/")) {
        return Promise.resolve(projectResponse as Response);
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const provider = createPlaneProvider(planeConfig);
    await expect(provider.transitionStatus("issue-uuid-1", "Done")).rejects.toThrow(
      'Plane state "Done" not found'
    );
  });

  test("postComment calls Plane comments API", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ id: "comment-1" }),
    };

    globalThis.fetch = mock(() => Promise.resolve(mockResponse as Response));

    const provider = createPlaneProvider(planeConfig);
    await provider.postComment("issue-uuid-1", "Test comment");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(call[0]).toContain("/issues/issue-uuid-1/comments/");
    expect(call[1].method).toBe("POST");
  });
});
