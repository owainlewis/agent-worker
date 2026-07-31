// test/ui-config-api.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readConfigFile, writeConfigFile } from "../src/ui/config-api.ts";

let tmpDir: string;
const VALID_YAML = `
linear:
  project_id: "proj-123"
  poll_interval_seconds: 60
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
executor:
  type: claude
  timeout_seconds: 300
  retries: 0
hooks:
  pre: []
  post:
    - "git add -A"
    - "git commit -m '{id}'"
log:
  level: info
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-api-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe("readConfigFile", () => {
  test("returns structured JSON from valid YAML", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const result = readConfigFile(path);
    expect(result.linear.project_id).toBe("proj-123");
    expect(result.executor.type).toBe("claude");
    expect(result.hooks.post).toHaveLength(2);
  });
});

describe("writeConfigFile", () => {
  test("writes valid JSON as YAML and round-trips correctly", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const original = readConfigFile(path);
    original.linear.poll_interval_seconds = 120;
    writeConfigFile(path, original);
    const updated = readConfigFile(path);
    expect(updated.linear.poll_interval_seconds).toBe(120);
  });

  test("throws ZodError for invalid config (bad executor type)", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const config = readConfigFile(path);
    (config.executor as { type: string }).type = "invalid-executor";
    expect(() => writeConfigFile(path, config)).toThrow();
  });

  test("throws ZodError for retries > 3", () => {
    const path = join(tmpDir, "config.yaml");
    writeFileSync(path, VALID_YAML);
    const config = readConfigFile(path);
    config.executor.retries = 5;
    expect(() => writeConfigFile(path, config)).toThrow();
  });
});
