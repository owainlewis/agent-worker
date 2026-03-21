import type { ScmProvider, PullRequest, PRComment } from "./types.ts";
import type { GitHubScmConfig } from "../config.ts";
import { log } from "../logger.ts";

const GITHUB_API = "https://api.github.com";

export function createGitHubProvider(config: GitHubScmConfig): ScmProvider {
  const logger = log.child("github");
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required for GitHub SCM provider");
  }

  const { owner, repo } = config;

  async function ghFetch(path: string): Promise<Response> {
    const url = `${GITHUB_API}/repos/${owner}/${repo}${path}`;
    logger.debug("GitHub API request", { path });
    const start = Date.now();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "agent-worker",
      },
    });
    logger.debug("GitHub API response", { path, status: res.status, durationMs: Date.now() - start });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API error ${res.status}: ${text}`);
    }
    return res;
  }

  return {
    async findPullRequest(branch: string): Promise<PullRequest | null> {
      logger.debug("Finding pull request", { branch });
      const res = await ghFetch(`/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open&per_page=1`);
      const prs = (await res.json()) as unknown[];

      if (!Array.isArray(prs) || prs.length === 0) {
        logger.debug("No pull request found", { branch });
        return null;
      }

      const pr = prs[0] as Record<string, unknown>;
      logger.debug("Found pull request", { branch, prNumber: pr.number });
      return {
        number: pr.number as number,
        url: pr.html_url as string,
        branch: branch,
        state: "open",
      };
    },

    async getPRComments(prNumber: number, since?: string): Promise<PRComment[]> {
      logger.debug("Fetching PR comments", { prNumber, since });
      const params = new URLSearchParams();
      params.set("per_page", "100");
      if (since) params.set("since", since);
      const res = await ghFetch(`/pulls/${prNumber}/comments?${params}`);
      const comments = (await res.json()) as unknown[];

      const results = (Array.isArray(comments) ? comments : []).map((c) => {
        const comment = c as Record<string, unknown>;
        const user = comment.user as Record<string, unknown> | undefined;
        return {
          id: comment.id as number,
          author: user?.login as string ?? "unknown",
          body: comment.body as string,
          createdAt: comment.created_at as string,
        };
      });
      logger.debug("Fetched PR comments", { prNumber, count: results.length });
      return results;
    },

    async isPRMerged(prNumber: number): Promise<boolean> {
      logger.debug("Checking if PR is merged", { prNumber });
      try {
        const res = await ghFetch(`/pulls/${prNumber}/merge`);
        const merged = res.status === 204;
        logger.debug("PR merge check", { prNumber, merged });
        return merged;
      } catch {
        logger.debug("PR merge check failed", { prNumber, merged: false });
        return false;
      }
    },
  };
}
