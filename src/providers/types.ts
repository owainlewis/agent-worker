export interface Ticket {
  id: string;
  identifier: string;
  title: string;
  description: string | undefined;
  priority: number;
}

export interface TicketProvider {
  fetchReadyTickets(): Promise<Ticket[]>;
  transitionStatus(ticketId: string, statusName: string): Promise<void>;
  postComment(ticketId: string, body: string): Promise<void>;
}
