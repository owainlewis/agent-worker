import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { printSplash } from "./format.ts";
import { createLinearProvider } from "./providers/linear.ts";
import { createPoller } from "./poller.ts";
import { processTicket } from "./scheduler.ts";
import { version } from "../package.json";
import { createWorkerState } from "./ui/state.ts";
import { startUiServer } from "./ui/server.ts";

function main() {
  if (process.argv.includes("--version")) {
    console.log(version);
    process.exit(0);
  }

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

  printSplash(version);

  const logger = createLogger({
    level: config.log.level,
    filePath: config.log.file,
    redact: [config.apiKey],
  });

  const workerState = createWorkerState();

  // Declare poller as let so the UI server controls closure can reference it
  // before createPoller is called below.
  let poller: ReturnType<typeof createPoller>;

  let uiServer: { stop(): void } | null = null;
  if (config.ui?.enabled) {
    uiServer = startUiServer({
      state: workerState,
      configPath: configPath,
      port: config.ui.port,
      host: config.ui.host,
      token: config.ui.token,
      controls: {
        startWorker: () => { poller?.start(); },
        stopWorker:  () => { poller?.stop(); },
        cancelJob:   () => { poller?.stop(); }, // v1: stop accepting new jobs
      },
    });
    logger.info("UI dashboard started", {
      url: `http://${config.ui.host}:${config.ui.port}`,
    });
  }

  const provider = createLinearProvider({
    apiKey: config.apiKey,
    projectId: config.linear.project_id,
    statuses: config.linear.statuses,
  });

  poller = createPoller({
    provider,
    intervalMs: config.linear.poll_interval_seconds * 1000,
    logger,
    onPollResult: (tickets) => { workerState.setPendingTickets(tickets); },
    onTicket: async (ticket) => {
      await processTicket({ ticket, provider, config, logger, workerState });
    },
  });

  printSplash(config.executor.type);

  logger.info("Agent Worker started", {
    projectId: config.linear.project_id,
    pollInterval: config.linear.poll_interval_seconds,
    executor: config.executor.type,
  });

  process.on("SIGINT", () => {
    logger.info("Shutting down", { signal: "SIGINT" });
    workerState.setWorkerStatus("stopped");
    uiServer?.stop();
    poller.stop();
  });
  process.on("SIGTERM", () => {
    logger.info("Shutting down", { signal: "SIGTERM" });
    workerState.setWorkerStatus("stopped");
    uiServer?.stop();
    poller.stop();
  });

  workerState.setWorkerStatus("running");
  poller.start().then(() => {
    workerState.setWorkerStatus("stopped");
    process.exit(0);
  }).catch((err) => {
    logger.error("Fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

main();
