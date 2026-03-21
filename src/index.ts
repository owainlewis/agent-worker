import { loadConfig } from "./config.ts";
import { initLogger, log, type LogLevel } from "./logger.ts";
import { printSplash } from "./format.ts";
import { createProvider } from "./providers/index.ts";
import { createPoller } from "./poller.ts";
import { processTicket } from "./scheduler.ts";
import { createScmProvider } from "./scm/index.ts";
import { createPRTracker } from "./feedback/tracking.ts";
import { createFeedbackPoller } from "./feedback/feedback-poller.ts";
import { version } from "../package.json";

function main() {
  if (process.argv.includes("--version")) {
    console.log(version);
    process.exit(0);
  }

  const configIndex = process.argv.indexOf("--config");
  if (configIndex === -1 || !process.argv[configIndex + 1]) {
    console.error("Usage: agent-worker --config <path> [--debug]");
    process.exit(1);
  }

  const configPath = process.argv[configIndex + 1]!;
  const debugFlag = process.argv.includes("--debug");

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

  // --debug flag overrides config log level to debug
  const logLevel: LogLevel = debugFlag ? "debug" : config.log.level;

  printSplash(`${config.provider.type} → ${config.executor.type}${debugFlag ? " (debug)" : ""}`);

  initLogger({
    level: logLevel,
    filePath: config.log.file,
    redact: config.log.redact.length > 0 ? config.log.redact : undefined,
  });

  const provider = createProvider(config.provider);
  const scmProvider = createScmProvider(config.scm);
  const prTracker = createPRTracker();

  const poller = createPoller({
    provider,
    intervalMs: config.provider.poll_interval_seconds * 1000,
    onTicket: async (ticket) => {
      const result = await processTicket({ ticket, provider, config });

      if (result.outcome === "code_review") {
        prTracker.track({
          ticketId: result.ticketId,
          ticketIdentifier: ticket.identifier,
          prNumber: 0, // Will be discovered by feedback poller
          branch: result.branch,
          lastCommentCheck: new Date().toISOString(),
        });
      }
    },
  });

  const feedbackPoller = createFeedbackPoller({
    provider,
    scm: scmProvider,
    prTracker,
    config,
  });

  log.info("Agent Worker started", {
    provider: config.provider.type,
    pollInterval: config.provider.poll_interval_seconds,
    executor: config.executor.type,
  });

  process.on("SIGINT", () => {
    log.info("Shutting down", { signal: "SIGINT" });
    poller.stop();
    feedbackPoller.stop();
  });
  process.on("SIGTERM", () => {
    log.info("Shutting down", { signal: "SIGTERM" });
    poller.stop();
    feedbackPoller.stop();
  });

  // Both pollers run in parallel. Only exit on signal (via stop()).
  // Wire up error handlers to surface fatal rejections.
  poller.start().catch((err) => {
    log.error("Main poller fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });

  feedbackPoller.start().catch((err) => {
    log.error("Feedback poller fatal error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

main();
