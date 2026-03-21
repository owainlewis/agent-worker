import { describe, test, expect, beforeEach } from "bun:test";
import { runHooks } from "../src/pipeline/hook-runner.ts";
import { initLogger } from "../src/logger.ts";
import type { TaskVars } from "../src/pipeline/interpolate.ts";

beforeEach(() => {
  initLogger({ level: "error" });
});

const vars: TaskVars = {
  id: "ENG-123",
  title: "fix-bug",
  raw_title: "fix bug",
  branch: "agent/task-ENG-123",
  worktree: "/tmp/worktree",
};

describe("runHooks", () => {
  test("succeeds with no commands", async () => {
    const result = await runHooks([], "/tmp", vars);
    expect(result.success).toBe(true);
  });

  test("succeeds with passing commands", async () => {
    const result = await runHooks(["echo hello", "echo world"], "/tmp", vars);
    expect(result.success).toBe(true);
  });

  test("fails on non-zero exit", async () => {
    const result = await runHooks(["exit 1"], "/tmp", vars);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test("aborts on first failure", async () => {
    const result = await runHooks(
      ["exit 1", "echo should-not-run"],
      "/tmp",
      vars
    );
    expect(result.success).toBe(false);
    expect(result.failedCommand).toBe("exit 1");
  });

  test("interpolates variables in commands", async () => {
    const result = await runHooks(
      ["echo {id}"],
      "/tmp",
      vars
    );
    expect(result.success).toBe(true);
  });
});
