import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

describe("GitHub SCM Provider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, GITHUB_TOKEN: "ghp_test" };
  });

  afterEach(() => {
    process.env = originalEnv;
    mock.restore();
  });

  test("throws if GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    const { createGitHubProvider } = await import("../../src/scm/github.ts");
    expect(() => createGitHubProvider({ type: "github", owner: "myorg", repo: "myrepo" })).toThrow(
      "GITHUB_TOKEN environment variable is required"
    );
  });

  describe("getPRMergeInfo", () => {
    test("returns merge info with url, sha, and summary", async () => {
      const mockFetch = mock(async (url: string) => {
        if (url.includes("/pulls/42")) {
          return new Response(JSON.stringify({
            number: 42,
            html_url: "https://github.com/myorg/myrepo/pull/42",
            merge_commit_sha: "abc123def456789abc123def456789abc123def",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/commits/abc123")) {
          return new Response(JSON.stringify({
            commit: {
              message: "feat: add new feature (#42)\n\nThis adds a new feature.",
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      });

      mock.module("node:http", () => ({
        default: { fetch: mockFetch },
        fetch: mockFetch,
      }));

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createGitHubProvider } = await import("../../src/scm/github.ts");
      const provider = createGitHubProvider({ type: "github", owner: "myorg", repo: "myrepo" });
      const result = await provider.getPRMergeInfo(42);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://github.com/myorg/myrepo/pull/42");
      expect(result!.sha).toBe("abc123def456789abc123def456789abc123def");
      expect(result!.summary).toBe("feat: add new feature (#42)");
    });

    test("returns null when merge commit SHA is missing", async () => {
      const mockFetch = mock(async () => {
        return new Response(JSON.stringify({
          number: 42,
          html_url: "https://github.com/myorg/myrepo/pull/42",
          merge_commit_sha: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      });

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createGitHubProvider } = await import("../../src/scm/github.ts");
      const provider = createGitHubProvider({ type: "github", owner: "myorg", repo: "myrepo" });
      const result = await provider.getPRMergeInfo(42);

      expect(result).toBeNull();
    });

    test("returns merge info with empty summary when commit fetch fails", async () => {
      const mockFetch = mock(async (url: string) => {
        if (url.includes("/pulls/42")) {
          return new Response(JSON.stringify({
            number: 42,
            html_url: "https://github.com/myorg/myrepo/pull/42",
            merge_commit_sha: "abc123def456789abc123def456789abc123def",
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not found", { status: 404 });
      });

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createGitHubProvider } = await import("../../src/scm/github.ts");
      const provider = createGitHubProvider({ type: "github", owner: "myorg", repo: "myrepo" });
      const result = await provider.getPRMergeInfo(42);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://github.com/myorg/myrepo/pull/42");
      expect(result!.sha).toBe("abc123def456789abc123def456789abc123def");
      expect(result!.summary).toBe("");
    });

    test("returns null when PR fetch fails", async () => {
      const mockFetch = mock(async () => {
        return new Response("Not found", { status: 404 });
      });

      // @ts-expect-error mocking global fetch
      globalThis.fetch = mockFetch;

      const { createGitHubProvider } = await import("../../src/scm/github.ts");
      const provider = createGitHubProvider({ type: "github", owner: "myorg", repo: "myrepo" });
      const result = await provider.getPRMergeInfo(42);

      expect(result).toBeNull();
    });
  });
});
