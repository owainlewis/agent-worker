import type { ScmProvider, PullRequest, PRComment } from "./types.ts";
import type { BitbucketServerScmConfig } from "../config.ts";
import { log } from "../logger.ts";

export function createBitbucketServerProvider(config: BitbucketServerScmConfig): ScmProvider {
  const logger = log.child("bitbucket");
  const token = process.env.BITBUCKET_TOKEN;
  if (!token) {
    throw new Error("BITBUCKET_TOKEN environment variable is required for BitBucket Server SCM provider");
  }

  const baseUrl = config.base_url.replace(/\/+$/, "");
  const { project, repo } = config;

  async function bbFetch(path: string): Promise<Response> {
    const url = `${baseUrl}/rest/api/1.0${path}`;
    logger.debug("Bitbucket API request", { path });
    const start = Date.now();
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    logger.debug("Bitbucket API response", { path, status: res.status, durationMs: Date.now() - start });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`BitBucket Server API error ${res.status}: ${text}`);
    }
    return res;
  }

  return {
    async findPullRequest(branch: string): Promise<PullRequest | null> {
      logger.debug("Finding pull request", { branch });
      const res = await bbFetch(
        `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests?at=refs/heads/${encodeURIComponent(branch)}&state=ALL&limit=5`
      );
      const data = (await res.json()) as Record<string, unknown>;
      const values = data.values as Record<string, unknown>[] | undefined;

      if (!Array.isArray(values) || values.length === 0) {
        logger.debug("No pull request found", { branch });
        return null;
      }

      // Prefer open PRs; fall back to most recent merged/closed
      const sorted = values.sort((a, b) => {
        const aOpen = a.state === "OPEN" ? 0 : 1;
        const bOpen = b.state === "OPEN" ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return new Date(b.createdDate as string).getTime() - new Date(a.createdDate as string).getTime();
      });
      const pr = sorted[0]!;
      const bbState = pr.state as string;
      const state: PullRequest["state"] = bbState === "MERGED" ? "merged" : bbState === "OPEN" ? "open" : "closed";
      logger.debug("Found pull request", { branch, prNumber: pr.id, state });
      return {
        number: pr.id as number,
        url: `${baseUrl}/projects/${project}/repos/${repo}/pull-requests/${pr.id}`,
        branch,
        state,
      };
    },

    async getPRComments(prNumber: number, since?: string): Promise<PRComment[]> {
      logger.debug("Fetching PR comments", { prNumber, since });
      const res = await bbFetch(
        `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${prNumber}/activities?limit=100`
      );
      const data = (await res.json()) as Record<string, unknown>;
      const activities = data.values as Record<string, unknown>[] | undefined;

      if (!Array.isArray(activities)) return [];

      const results = activities
        .filter((a) => a.action === "COMMENTED")
        .filter((a) => {
          if (!since) return true;
          const commentDate = new Date(a.createdDate as string);
          return commentDate > new Date(since);
        })
        .map((a) => {
          const comment = a.comment as Record<string, unknown>;
          const author = comment.author as Record<string, unknown>;
          return {
            id: comment.id as number,
            author: (author.displayName as string) ?? (author.name as string) ?? "unknown",
            body: comment.text as string,
            createdAt: a.createdDate as string,
          };
        });
      logger.debug("Fetched PR comments", { prNumber, count: results.length });
      return results;
    },

    async isPRMerged(prNumber: number): Promise<boolean> {
      logger.debug("Checking if PR is merged", { prNumber });
      try {
        const res = await bbFetch(
          `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${prNumber}`
        );
        const data = (await res.json()) as Record<string, unknown>;
        const merged = data.state === "MERGED";
        logger.debug("PR merge check", { prNumber, merged });
        return merged;
      } catch {
        logger.debug("PR merge check failed", { prNumber, merged: false });
        return false;
      }
    },
  };
}
