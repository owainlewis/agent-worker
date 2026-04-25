import { describe, test, expect } from "bun:test";
import { colors, formatConsoleLine, printSplash } from "../src/format.ts";

describe("colors", () => {
  test("wraps text with ANSI escape codes", () => {
    const result = colors.red("error");
    expect(result).toContain("error");
    expect(result).toMatch(/\x1b\[\d+m/);
  });

  test("resets formatting after the text", () => {
    const result = colors.bold("hello");
    expect(result).toMatch(/\x1b\[0m$/);
  });

  test("each color function returns different escape sequences", () => {
    const results = new Set([
      colors.bold("x"),
      colors.dim("x"),
      colors.red("x"),
      colors.green("x"),
      colors.yellow("x"),
      colors.blue("x"),
      colors.cyan("x"),
      colors.gray("x"),
    ]);
    expect(results.size).toBe(8);
  });
});

describe("formatConsoleLine", () => {
  test("formats info level with message", () => {
    const result = formatConsoleLine("info", "test message");
    expect(result).toContain("test message");
    expect(result).toContain("INFO");
  });

  test("formats debug level", () => {
    const result = formatConsoleLine("debug", "debug msg");
    expect(result).toContain("DEBUG");
    expect(result).toContain("debug msg");
  });

  test("formats warn level", () => {
    const result = formatConsoleLine("warn", "warning msg");
    expect(result).toContain("WARN");
  });

  test("formats error level", () => {
    const result = formatConsoleLine("error", "error msg");
    expect(result).toContain("ERROR");
  });

  test("includes context key=value pairs", () => {
    const result = formatConsoleLine("info", "msg", { ticketId: "ENG-123", count: 5 });
    expect(result).toContain("ticketId=ENG-123");
    expect(result).toContain("count=5");
  });

  test("includes component tag when present", () => {
    const result = formatConsoleLine("info", "msg", { component: "provider:linear" });
    expect(result).toContain("[provider:linear]");
  });

  test("excludes component from context key=value pairs", () => {
    const result = formatConsoleLine("info", "msg", { component: "poller", ticketId: "ENG-1" });
    expect(result).toContain("[poller]");
    expect(result).toContain("ticketId=ENG-1");
    // component should NOT appear as a key=value
    expect(result).not.toContain("component=poller");
  });

  test("handles claude special case with line context", () => {
    const result = formatConsoleLine("info", "claude", { line: "some output" });
    expect(result).toContain("some output");
    // Should not contain the level badge for claude lines
    expect(result).not.toContain("INFO");
  });

  test("handles message without context", () => {
    const result = formatConsoleLine("info", "simple");
    expect(result).toContain("simple");
  });

  test("pads level badge to 5 characters", () => {
    const infoResult = formatConsoleLine("info", "msg");
    // INFO padded to 5 chars
    expect(infoResult).toContain("INFO ");
  });
});

describe("printSplash", () => {
  test("does not throw when called", () => {
    // Just verify it doesn't crash — actual output depends on isTTY
    expect(() => printSplash("test subtitle")).not.toThrow();
  });
});
