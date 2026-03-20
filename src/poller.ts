import type { Logger } from "./logger.ts";
import type { Ticket, TicketProvider } from "./providers/types.ts";

export function createPoller(options: {
  provider: TicketProvider;
  intervalMs: number;
  logger: Logger;
  onTicket: (ticket: Ticket) => Promise<void>;
}): { start: () => Promise<void>; stop: () => void } {
  let isRunning = false;
  let wakeSleep: (() => void) | null = null;
  let pollCount = 0;
  const startTime = Date.now();

  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
    });
  }

  return {
    async start() {
      isRunning = true;
      while (isRunning) {
        pollCount++;
        const uptimeMs = Date.now() - startTime;
        const totalSeconds = Math.floor(uptimeMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        const uptime = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        options.logger.info(`Poll #${pollCount} (uptime: ${uptime}) — checking for tickets...`);
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
        await interruptibleSleep(options.intervalMs);
      }
    },

    stop() {
      isRunning = false;
      wakeSleep?.();
    },
  };
}
