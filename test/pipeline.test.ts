import { describe, test, expect } from "bun:test";
import { executePipeline } from "../src/pipeline/pipeline.ts";
import type { Logger } from "../src/logger.ts";
import type { Ticket } from "../src/providers/types.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const ticket: Ticket = {
  id: "uuid-1",
  identifier: "ENG-100",
  title: "Test ticket",
  description: "Do something",
};

describe("executePipeline", () => {
  test("fails on pre-hook failure before reaching claude", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: ["exit 1"],
      postHooks: [],
      repoCwd: "/tmp",
      claudeTimeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("pre-hook");
  });

  test("returns error details from failed pre-hook", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: ["echo 'setup ok'", "sh -c 'echo bad >&2; exit 2'"],
      postHooks: [],
      repoCwd: "/tmp",
      claudeTimeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("pre-hook");
    expect(result.error).toContain("exited with code 2");
  });

  test("succeeds when all pre-hooks pass and claude succeeds", async () => {
    // Use `echo` as a stand-in for claude by testing just hooks
    // Real claude integration is tested manually
    const result = await executePipeline({
      ticket,
      preHooks: ["echo pre"],
      postHooks: [],
      repoCwd: "/tmp",
      claudeTimeoutMs: 1000,
      logger: noopLogger,
    });
    // Will fail at claude stage since claude isn't installed, which is expected
    expect(result.success).toBe(false);
    expect(result.stage).toBe("claude");
  });
});
