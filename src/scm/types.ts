export interface PullRequest {
  number: number;
  url: string;
  branch: string;
  state: "open" | "closed" | "merged";
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface MergeInfo {
  url: string;
  sha: string;
  summary: string;
}

export interface ScmProvider {
  findPullRequest(branch: string): Promise<PullRequest | null>;
  getPRComments(prNumber: number, since?: string): Promise<PRComment[]>;
  isPRMerged(prNumber: number): Promise<boolean>;
  getPRMergeInfo(prNumber: number): Promise<MergeInfo | null>;
}
