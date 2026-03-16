import { describe, test, expect } from "bun:test";
import { runClaude } from "../src/pipeline/claude-executor.ts";
import type { Logger } from "../src/logger.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("runClaude", () => {
  test("returns correct shape on failure (claude not installed)", async () => {
    const result = await runClaude("test prompt", "/tmp", 2000, noopLogger);
    // claude CLI likely not installed in test env
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("exitCode");
    expect(typeof result.success).toBe("boolean");
  });
});
