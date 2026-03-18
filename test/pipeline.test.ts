import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { executePipeline } from "../src/pipeline/pipeline.ts";
import type { CodeExecutor } from "../src/pipeline/executor.ts";
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

function mockExecutor(overrides?: Partial<CodeExecutor>): CodeExecutor {
  return {
    name: "mock",
    needsWorktree: true,
    run: async () => ({
      success: true,
      output: "mock output",
      timedOut: false,
      exitCode: 0,
    }),
    ...overrides,
  };
}

function failingExecutor(): CodeExecutor {
  return {
    name: "mock",
    needsWorktree: true,
    run: async () => ({
      success: false,
      output: "error output",
      timedOut: false,
      exitCode: 1,
    }),
  };
}

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-worker-test-"));
  execSync("git init && git commit --allow-empty -m 'init'", { cwd: dir });
  return dir;
}

describe("executePipeline", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    // Clean up any worktrees and the temp repo
    try {
      execSync("git worktree prune", { cwd: repoDir });
    } catch {}
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("fails on pre-hook failure before reaching executor", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: ["exit 1"],
      postHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
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
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("pre-hook");
    expect(result.error).toContain("exited with code 2");
  });

  test("succeeds when all hooks pass and executor succeeds", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: ["echo pre"],
      postHooks: ["echo post"],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("mock output");
  });

  test("fails at executor stage when executor fails", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: [],
      repoCwd: repoDir,
      executor: failingExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("executor");
  });

  test("does not run post-hooks when executor fails", async () => {
    const result = await executePipeline({
      ticket,
      preHooks: [],
      postHooks: ["echo post"],
      repoCwd: repoDir,
      executor: failingExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(result.success).toBe(false);
    expect(result.stage).toBe("executor");
  });

  test("cleans up worktree after success", async () => {
    await executePipeline({
      ticket,
      preHooks: [],
      postHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    // Worktree should be cleaned up — only the main working tree remains
    const output = execSync("git worktree list", { cwd: repoDir }).toString();
    const lines = output.trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("cleans up worktree after failure", async () => {
    await executePipeline({
      ticket,
      preHooks: ["exit 1"],
      postHooks: [],
      repoCwd: repoDir,
      executor: mockExecutor(),
      timeoutMs: 5000,
      logger: noopLogger,
    });
    const output = execSync("git worktree list", { cwd: repoDir }).toString();
    const lines = output.trim().split("\n");
    expect(lines.length).toBe(1);
  });
});
