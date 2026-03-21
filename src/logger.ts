import { appendFileSync } from "fs";
import { formatConsoleLine, isTTY } from "./format.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

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
  child(component: string): Logger;
}

export async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    log.debug(`${label} completed`, { durationMs: Date.now() - start });
    return result;
  } catch (err) {
    log.debug(`${label} failed`, {
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function createLoggerInternal(options: {
  level?: LogLevel;
  filePath?: string;
  redact?: string[];
  component?: string;
}): Logger {
  const minLevel = LEVEL_ORDER[options.level ?? "info"];
  const filePath = options.filePath;
  const redactValues = (options.redact ?? []).filter((v) => v.length > 0);
  const component = options.component;

  function redact(text: string): string {
    let result = text;
    for (const value of redactValues) {
      result = result.replaceAll(value, "[REDACTED]");
    }
    return result;
  }

  function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < minLevel) return;

    const merged = component ? { component, ...ctx } : ctx;

    // Console output: human-readable for TTY, JSON for non-TTY
    const consoleLine = isTTY
      ? redact(formatConsoleLine(level, msg, merged))
      : redact(
          JSON.stringify({
            ...merged,
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
          ...merged,
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

  function child(sub: string): Logger {
    return createLoggerInternal({
      ...options,
      component: component ? `${component}:${sub}` : sub,
    });
  }

  return {
    debug: (msg, ctx?) => write("debug", msg, ctx),
    info: (msg, ctx?) => write("info", msg, ctx),
    warn: (msg, ctx?) => write("warn", msg, ctx),
    error: (msg, ctx?) => write("error", msg, ctx),
    child,
  };
}

/**
 * No-op logger used as the default before `initLogger()` is called.
 * Prevents crashes if a provider or SCM module is imported during testing
 * before the test setup has called `initLogger()`.
 */
const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

/**
 * Module-level singleton logger. Initialized once at startup via `initLogger()`.
 * Falls back to a no-op logger so that imports don't crash before init.
 */
export let log: Logger = noopLogger;

/** Initialize the global logger. Call once at startup. */
export function initLogger(options: {
  level?: LogLevel;
  filePath?: string;
  redact?: string[];
}): void {
  log = createLoggerInternal(options);
}

/**
 * Create a standalone logger (useful in tests that need a specific config
 * without mutating the global singleton).
 */
export function createLogger(options: {
  level?: LogLevel;
  filePath?: string;
  redact?: string[];
  component?: string;
}): Logger {
  return createLoggerInternal(options);
}
