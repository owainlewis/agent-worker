import { describe, test, expect } from "bun:test";
import { runHooks } from "../src/pipeline/hook-runner.ts";
import type { TaskVars } from "../src/pipeline/interpolate.ts";
import type { Logger } from "../src/logger.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const vars: TaskVars = {
  id: "ENG-123",
  title: "fix-bug",
  branch: "agent/task-ENG-123",
};

describe("runHooks", () => {
  test("succeeds with no commands", async () => {
    const result = await runHooks([], "/tmp", vars, noopLogger);
    expect(result.success).toBe(true);
  });

  test("succeeds with passing commands", async () => {
    const result = await runHooks(["echo hello", "echo world"], "/tmp", vars, noopLogger);
    expect(result.success).toBe(true);
  });

  test("fails on non-zero exit", async () => {
    const result = await runHooks(["exit 1"], "/tmp", vars, noopLogger);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test("aborts on first failure", async () => {
    const result = await runHooks(
      ["exit 1", "echo should-not-run"],
      "/tmp",
      vars,
      noopLogger
    );
    expect(result.success).toBe(false);
    expect(result.failedCommand).toBe("exit 1");
  });

  test("interpolates variables in commands", async () => {
    const result = await runHooks(
      ["echo {id}"],
      "/tmp",
      vars,
      noopLogger
    );
    expect(result.success).toBe(true);
  });
});
