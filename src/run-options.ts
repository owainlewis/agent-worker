export type RunOptions = {
  configPath: string;
  once: boolean;
  ticketIdentifier?: string;
};

export function parseRunOptions(argv: string[]): RunOptions {
  const configIndex = argv.indexOf("--config");
  if (configIndex === -1 || !argv[configIndex + 1]) {
    throw new Error("Usage: agent-worker --config <path> [--once] [--ticket <ID>]");
  }

  const ticketIndex = argv.indexOf("--ticket");
  if (ticketIndex !== -1 && !argv[ticketIndex + 1]) {
    throw new Error("--ticket requires a Linear ticket identifier");
  }

  const allowed = new Set(["--config", "--once", "--ticket"]);
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--") && !allowed.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    configPath: argv[configIndex + 1]!,
    once: argv.includes("--once"),
    ticketIdentifier: ticketIndex === -1 ? undefined : argv[ticketIndex + 1],
  };
}
