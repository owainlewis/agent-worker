import type { Ticket } from "../providers/types.ts";

export type TaskVars = {
  id: string;
  title: string;
  branch: string;
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildTaskVars(ticket: Ticket): TaskVars {
  return {
    id: ticket.identifier,
    title: slugify(ticket.title),
    branch: `agent/task-${ticket.identifier}`,
  };
}

export function interpolate(template: string, vars: TaskVars): string {
  return template
    .replaceAll("{id}", vars.id)
    .replaceAll("{title}", vars.title)
    .replaceAll("{branch}", vars.branch);
}
