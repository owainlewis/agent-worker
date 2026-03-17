import { appendFileSync } from "fs";
import { formatConsoleLine, isTTY } from "./format.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export function createLogger(options: {
  level?: LogLevel;
  filePath?: string;
  redact?: string[];
}): Logger {
  const minLevel = LEVEL_ORDER[options.level ?? "info"];
  const filePath = options.filePath;
  const redactValues = (options.redact ?? []).filter((v) => v.length > 0);

  function redact(text: string): string {
    let result = text;
    for (const value of redactValues) {
      result = result.replaceAll(value, "[REDACTED]");
    }
    return result;
  }

  function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < minLevel) return;

    // Console output: human-readable for TTY, JSON for non-TTY
    const consoleLine = isTTY
      ? redact(formatConsoleLine(level, msg, ctx))
      : redact(
          JSON.stringify({
            ...ctx,
            timestamp: new Date().toISOString(),
            level,
            message: msg,
          })
        );

    if (level === "error" || level === "warn") {
      console.error(consoleLine);
    } else {
      console.log(consoleLine);
    }

    // File output: always JSON
    if (filePath) {
      const jsonLine = redact(
        JSON.stringify({
          ...ctx,
          timestamp: new Date().toISOString(),
          level,
          message: msg,
        })
      );
      try {
        appendFileSync(filePath, jsonLine + "\n");
      } catch {
        // Best-effort file logging — don't crash if file write fails
      }
    }
  }

  return {
    debug: (msg, ctx?) => write("debug", msg, ctx),
    info: (msg, ctx?) => write("info", msg, ctx),
    warn: (msg, ctx?) => write("warn", msg, ctx),
    error: (msg, ctx?) => write("error", msg, ctx),
  };
}
