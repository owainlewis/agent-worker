import type { Ticket } from "../providers/types.ts";

export type TaskVars = {
  id: string;
  title: string;
  raw_title: string;
  branch: string;
  worktree: string;
  /**
   * SAM-481: the resolved source repo path for this ticket (the path that
   * worktrees are created from). With per-ticket repo path resolution
   * (Config.repo.path_by_label), this is dynamic per ticket — pre-hooks like
   * pull-main.sh need the source repo path, NOT the temp worktree path.
   * Use {repo_cwd} in hook commands to interpolate this value.
   */
  repo_cwd: string;
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function sanitizeTitle(text: string): string {
  return text.replace(/['`$\\]/g, "");
}

export function buildTaskVars(
  ticket: Ticket,
  worktree = "",
  repoCwd = "",
): TaskVars {
  return {
    id: ticket.identifier,
    title: slugify(ticket.title),
    raw_title: sanitizeTitle(ticket.title),
    branch: `agent/task-${ticket.identifier}`,
    worktree,
    repo_cwd: repoCwd,
  };
}

export function interpolate(template: string, vars: TaskVars): string {
  return template
    .replaceAll("{id}", vars.id)
    .replaceAll("{title}", vars.title)
    .replaceAll("{raw_title}", vars.raw_title)
    .replaceAll("{branch}", vars.branch)
    .replaceAll("{worktree}", vars.worktree)
    .replaceAll("{repo_cwd}", vars.repo_cwd)
    .replaceAll("{date}", new Date().toISOString());
}
