import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { createLogger } from "../src/logger.ts";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;
let logSpy: Mock<typeof console.log>;
let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-worker-log-test-"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(tmpDir, { recursive: true });
});

describe("createLogger", () => {
  test("outputs level and message to console", () => {
    const logger = createLogger({ level: "info" });

    logger.info("hello");

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("hello");
    expect(output).toContain("info");
  });

  test("includes context fields in output", () => {
    const logger = createLogger({ level: "info" });

    logger.info("ticket found", { ticketId: "ENG-123", title: "Fix bug" });

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).toContain("ENG-123");
    expect(output).toContain("Fix bug");
  });

  test("filters messages below configured level", () => {
    const logger = createLogger({ level: "warn" });

    logger.debug("should not appear");
    logger.info("should not appear");
    logger.warn("should appear");
    logger.error("should appear");

    expect(logSpy).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  test("redacts sensitive values", () => {
    const apiKey = "lin_api_secret_key_12345";
    const logger = createLogger({ level: "info", redact: [apiKey] });

    logger.info(`Connecting with key ${apiKey}`);

    const output = logSpy.mock.calls[0]![0] as string;
    expect(output).not.toContain(apiKey);
    expect(output).toContain("[REDACTED]");
  });

  test("writes JSON to file when filePath is set", () => {
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
  });

  test("defaults to info level", () => {
    const logger = createLogger({});

    logger.debug("should not appear");
    logger.info("should appear");

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
