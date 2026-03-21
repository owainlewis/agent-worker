import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

describe("BitBucket Server SCM Provider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BITBUCKET_TOKEN: "bb_test" };
  });

  afterEach(() => {
    process.env = originalEnv;
    mock.restore();
  });

  test("throws if BITBUCKET_TOKEN is not set", async () => {
    delete process.env.BITBUCKET_TOKEN;
    const { createBitbucketServerProvider } = await import("../../src/scm/bitbucket-server.ts");
    expect(() =>
      createBitbucketServerProvider({
        type: "bitbucket_server",
        base_url: "https://bb.example.com",
        project: "PROJ",
        repo: "myrepo",
      })
    ).toThrow("BITBUCKET_TOKEN environment variable is required");
  });

  describe("getPRMergeInfo", () => {
    test("returns merge info with url, sha, and summary", async () => {
      const mockFetch = mock(async (url: string) => {
        if (url.includes("/pull-requests/42") && !url.includes("/commits")) {
          return new Response(JSON.stringify({
            id: 42,
            state: "MERGED",
            links: {
              self: [{ href: "https://bb.example.com/projects/PROJ/repos/myrepo/pull-requests/42" }],
            },
            mergeCommit: {
              id: "abc123def456789abc123def456789abc123def",
              displayId: "abc123d",
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/commits/abc123")) {
          return new Response(JSON.stringify({
            id: "abc123def456789abc123def456789abc123def",
            message: "feat: add new feature (#42)\n\nThis adds a new feature.",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      });

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createBitbucketServerProvider } = await import("../../src/scm/bitbucket-server.ts");
      const provider = createBitbucketServerProvider({
        type: "bitbucket_server",
        base_url: "https://bb.example.com",
        project: "PROJ",
        repo: "myrepo",
      });
      const result = await provider.getPRMergeInfo(42);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://bb.example.com/projects/PROJ/repos/myrepo/pull-requests/42");
      expect(result!.sha).toBe("abc123def456789abc123def456789abc123def");
      expect(result!.summary).toBe("feat: add new feature (#42)");
    });

    test("returns null when merge commit is missing", async () => {
      const mockFetch = mock(async () => {
        return new Response(JSON.stringify({
          id: 42,
          state: "MERGED",
          links: {
            self: [{ href: "https://bb.example.com/projects/PROJ/repos/myrepo/pull-requests/42" }],
          },
          mergeCommit: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      });

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createBitbucketServerProvider } = await import("../../src/scm/bitbucket-server.ts");
      const provider = createBitbucketServerProvider({
        type: "bitbucket_server",
        base_url: "https://bb.example.com",
        project: "PROJ",
        repo: "myrepo",
      });
      const result = await provider.getPRMergeInfo(42);

      expect(result).toBeNull();
    });

    test("returns merge info with empty summary when commit fetch fails", async () => {
      const mockFetch = mock(async (url: string) => {
        if (url.includes("/pull-requests/42") && !url.includes("/commits")) {
          return new Response(JSON.stringify({
            id: 42,
            state: "MERGED",
            links: {
              self: [{ href: "https://bb.example.com/projects/PROJ/repos/myrepo/pull-requests/42" }],
            },
            mergeCommit: {
              id: "abc123def456789abc123def456789abc123def",
              displayId: "abc123d",
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      });

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createBitbucketServerProvider } = await import("../../src/scm/bitbucket-server.ts");
      const provider = createBitbucketServerProvider({
        type: "bitbucket_server",
        base_url: "https://bb.example.com",
        project: "PROJ",
        repo: "myrepo",
      });
      const result = await provider.getPRMergeInfo(42);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://bb.example.com/projects/PROJ/repos/myrepo/pull-requests/42");
      expect(result!.sha).toBe("abc123def456789abc123def456789abc123def");
      expect(result!.summary).toBe("");
    });

    test("falls back to constructed URL when self link is missing", async () => {
      const mockFetch = mock(async (url: string) => {
        if (url.includes("/pull-requests/42") && !url.includes("/commits")) {
          return new Response(JSON.stringify({
            id: 42,
            state: "MERGED",
            links: {},
            mergeCommit: {
              id: "abc123def456789abc123def456789abc123def",
              displayId: "abc123d",
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/commits/abc123")) {
          return new Response(JSON.stringify({
            id: "abc123def456789abc123def456789abc123def",
            message: "fix: correct typo",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      });

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createBitbucketServerProvider } = await import("../../src/scm/bitbucket-server.ts");
      const provider = createBitbucketServerProvider({
        type: "bitbucket_server",
        base_url: "https://bb.example.com",
        project: "PROJ",
        repo: "myrepo",
      });
      const result = await provider.getPRMergeInfo(42);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://bb.example.com/projects/PROJ/repos/myrepo/pull-requests/42");
      expect(result!.summary).toBe("fix: correct typo");
    });
  });
});
