import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createLogger } from "../src/logger.ts";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-worker-log-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe("createLogger", () => {
  test("outputs valid JSON with timestamp, level, and message", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ level: "info" });

    logger.info("hello");

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("hello");
    expect(parsed.timestamp).toBeDefined();

    spy.mockRestore();
  });

  test("includes context fields in output", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ level: "info" });

    logger.info("ticket found", { ticketId: "ENG-123", title: "Fix bug" });

    const parsed = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(parsed.ticketId).toBe("ENG-123");
    expect(parsed.title).toBe("Fix bug");

    spy.mockRestore();
  });

  test("filters messages below configured level", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ level: "warn" });

    logger.debug("should not appear");
    logger.info("should not appear");
    logger.warn("should appear");
    logger.error("should appear");

    expect(logSpy).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledTimes(2);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("redacts sensitive values", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const apiKey = "lin_api_secret_key_12345";
    const logger = createLogger({ level: "info", redact: [apiKey] });

    logger.info(`Connecting with key ${apiKey}`);

    const output = spy.mock.calls[0]![0] as string;
    expect(output).not.toContain(apiKey);
    expect(output).toContain("[REDACTED]");

    spy.mockRestore();
  });

  test("writes to file when filePath is set", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logFile = join(tmpDir, "test.log");
    const logger = createLogger({ level: "info", filePath: logFile });

    logger.info("file log test");
    logger.error("error log test");

    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]!);
    expect(first.message).toBe("file log test");
    expect(first.level).toBe("info");

    const second = JSON.parse(lines[1]!);
    expect(second.message).toBe("error log test");
    expect(second.level).toBe("error");

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("defaults to info level", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({});

    logger.debug("should not appear");
    logger.info("should appear");

    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
