import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { printSplash } from "./format.ts";
import { createLinearProvider } from "./providers/linear.ts";
import { createPoller } from "./poller.ts";
import { processTicket } from "./scheduler.ts";
import { parseRunOptions } from "./run-options.ts";
import { version } from "../package.json";

function main() {
  if (process.argv.includes("--version")) {
    console.log(version);
    process.exit(0);
  }

  let runOptions;
  try {
    runOptions = parseRunOptions(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(runOptions.configPath);
  } catch (err) {
    console.error(
      "Configuration error:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  printSplash(version);

  const logger = createLogger({
    level: config.log.level,
    filePath: config.log.file,
    redact: [config.apiKey],
  });

  // SAM-481: provider accepts either single projectId (legacy) or projectIds
  // array (multi-project). Config validation guarantees exactly one is set.
  const provider = createLinearProvider({
    apiKey: config.apiKey,
    ...(config.linear.project_id
      ? { projectId: config.linear.project_id }
      : { projectIds: config.linear.project_ids! }),
    statuses: config.linear.statuses,
    requiredLabels: config.linear.required_labels,
    excludedLabels: config.linear.excluded_labels,
    targetIdentifier: runOptions.ticketIdentifier,
  });

  const poller = createPoller({
    provider,
    intervalMs: config.linear.poll_interval_seconds * 1000,
    logger,
    onTicket: async (ticket) => {
      await processTicket({ ticket, provider, config, logger });
    },
  });

  printSplash(config.executor.type);

  logger.info("Agent Worker started", {
    projectIds:
      config.linear.project_ids ??
      (config.linear.project_id ? [config.linear.project_id] : []),
    pollInterval: config.linear.poll_interval_seconds,
    executor: config.executor.type,
    repoMode: config.repo.path_by_label ? "path_by_label" : "single",
    requiredLabels: config.linear.required_labels,
    excludedLabels: config.linear.excluded_labels,
    once: runOptions.once,
    ticketIdentifier: runOptions.ticketIdentifier,
  });

  if (runOptions.once) {
    provider
      .fetchReadyTickets()
      .then(async (tickets) => {
        const ticket = tickets[0];
        if (!ticket) {
          logger.warn("No matching ticket found for one-shot run", {
            ticketIdentifier: runOptions.ticketIdentifier,
          });
          return;
        }
        logger.info("Ticket found", {
          ticketId: ticket.identifier,
          title: ticket.title,
          once: true,
        });
        await processTicket({ ticket, provider, config, logger });
      })
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error("Fatal error", {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
    return;
  }

  process.on("SIGINT", () => {
    logger.info("Shutting down", { signal: "SIGINT" });
    poller.stop();
  });
  process.on("SIGTERM", () => {
    logger.info("Shutting down", { signal: "SIGTERM" });
    poller.stop();
  });

  poller
    .start()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      logger.error("Fatal error", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}

main();
