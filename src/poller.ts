import type { Logger } from "./logger.ts";
import type { Ticket, TicketProvider } from "./providers/types.ts";

export function createPoller(options: {
  provider: TicketProvider;
  intervalMs: number;
  logger: Logger;
  onTicket: (ticket: Ticket) => Promise<void>;
}): { start: () => Promise<void>; stop: () => void } {
  let isRunning = false;

  return {
    async start() {
      isRunning = true;
      while (isRunning) {
        try {
          const tickets = await options.provider.fetchReadyTickets();
          if (tickets.length > 0) {
            const ticket = tickets[0]!;
            options.logger.info("Ticket found", {
              ticketId: ticket.identifier,
              title: ticket.title,
            });
            try {
              await options.onTicket(ticket);
            } catch (err) {
              options.logger.error("onTicket handler failed", {
                ticketId: ticket.identifier,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          } else {
            options.logger.debug("No tickets found");
          }
        } catch (err) {
          options.logger.error("Poll cycle failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (!isRunning) break;
        await Bun.sleep(options.intervalMs);
      }
    },

    stop() {
      isRunning = false;
    },
  };
}
