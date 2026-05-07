export interface Ticket {
  id: string;
  identifier: string;
  title: string;
  description: string | undefined;
  /**
   * All labels currently on the ticket (e.g. ["agent:ready", "repo:studio-os", "type:bug"]).
   * Empty array if the ticket has no labels. Used by the scheduler for per-ticket
   * repo path resolution when the daemon is configured with multi-repo support
   * (see Config.repo.path_by_label).
   */
  labels: string[];
  /**
   * UUID of the Linear project this ticket was fetched from. When the daemon is
   * configured with multiple project_ids (primary + fallbacks), this field tells
   * the scheduler which project the ticket came from — useful for logging and
   * for the in-flight metric "what project is currently being worked on".
   */
  projectId: string;
}

export interface TicketProvider {
  fetchReadyTickets(): Promise<Ticket[]>;
  transitionStatus(ticketId: string, statusName: string): Promise<void>;
  postComment(ticketId: string, body: string): Promise<void>;
}
