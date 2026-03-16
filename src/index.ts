import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { createLinearProvider } from "./providers/linear.ts";
import { createPoller } from "./poller.ts";
import { processTicket } from "./scheduler.ts";

function main() {
  const configIndex = process.argv.indexOf("--config");
  if (configIndex === -1 || !process.argv[configIndex + 1]) {
    console.error("Usage: agent-worker --config <path>");
    process.exit(1);
  }

  const configPath = process.argv[configIndex + 1]!;

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(
      "Configuration error:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }

  const logger = createLogger({
    level: config.log.level,
    filePath: config.log.file,
    redact: [config.apiKey],
  });

  const provider = createLinearProvider({
    apiKey: config.apiKey,
    projectId: config.linear.project_id,
    statuses: config.linear.statuses,
  });

  const poller = createPoller({
    provider,
    intervalMs: config.linear.poll_interval_seconds * 1000,
    logger,
    onTicket: async (ticket) => {
      await processTicket({ ticket, provider, config, logger });
    },
  });

  logger.info("Agent Worker started", {
    projectId: config.linear.project_id,
    pollInterval: config.linear.poll_interval_seconds,
  });

  process.on("SIGINT", () => {
    logger.info("Shutting down", { signal: "SIGINT" });
    poller.stop();
  });
  process.on("SIGTERM", () => {
    logger.info("Shutting down", { signal: "SIGTERM" });
    poller.stop();
  });

  poller.start().then(() => {
    process.exit(0);
  });
}

main();
