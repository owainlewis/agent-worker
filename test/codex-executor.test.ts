import { describe, test, expect } from "bun:test";
import {
  buildCodexPrompt,
  createCodexExecutor,
} from "../src/pipeline/codex-executor.ts";
import type { Logger } from "../src/logger.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("createCodexExecutor", () => {
  test("returns a CodeExecutor with name 'codex'", () => {
    const executor = createCodexExecutor();
    expect(executor.name).toBe("codex");
  });

  test("needsWorktree is false", () => {
    const executor = createCodexExecutor();
    expect(executor.needsWorktree).toBe(false);
  });

  test("fixer lane prompt overrides branch recreation with branch reuse", () => {
    const prompt = buildCodexPrompt(
      "Read prompts/codex-fixer.md. You are in the fixer lane.\n\nLinear ticket: SAM-424",
    );
    expect(prompt).toContain("FIXER LANE OVERRIDE");
    expect(prompt).toContain("reuse the existing PR branch");
    expect(prompt).toContain("Do NOT force-delete or recreate");
  });

  test("returns correct shape on failure (codex not installed)", async () => {
    const executor = createCodexExecutor();
    const result = await executor.run("test prompt", "/tmp", 2000, noopLogger);
    // codex CLI likely not installed in test env
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("exitCode");
    expect(typeof result.success).toBe("boolean");
  });
});
