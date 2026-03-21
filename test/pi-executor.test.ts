import { describe, test, expect } from "bun:test";
import { createPiExecutor } from "../src/pipeline/pi-executor.ts";

describe("createPiExecutor", () => {
  test("returns a CodeExecutor with name 'pi'", () => {
    const executor = createPiExecutor();
    expect(executor.name).toBe("pi");
  });

  test("needsWorktree is true", () => {
    const executor = createPiExecutor();
    expect(executor.needsWorktree).toBe(true);
  });

  test("returns correct shape on failure (pi not installed)", async () => {
    const executor = createPiExecutor();
    const result = await executor.run("test prompt", "/tmp", 2000);
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("exitCode");
    expect(typeof result.success).toBe("boolean");
  });
});
