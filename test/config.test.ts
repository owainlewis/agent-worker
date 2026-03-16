import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tmpDir: string;

function writeConfig(content: string): string {
  const path = join(tmpDir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-worker-test-"));
  process.env.LINEAR_API_KEY = "test-api-key-123";
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
  delete process.env.LINEAR_API_KEY;
});

describe("loadConfig", () => {
  const validYaml = `
linear:
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;

  test("parses valid config with defaults", () => {
    const config = loadConfig(writeConfig(validYaml));

    expect(config.linear.project_id).toBe("proj-123");
    expect(config.linear.poll_interval_seconds).toBe(60);
    expect(config.linear.statuses.ready).toBe("Todo");
    expect(config.repo.path).toBe("/tmp/repo");
    expect(config.hooks.pre).toEqual([]);
    expect(config.hooks.post).toEqual([]);
    expect(config.claude.timeout_seconds).toBe(300);
    expect(config.claude.retries).toBe(0);
    expect(config.log.level).toBe("info");
    expect(config.apiKey).toBe("test-api-key-123");
  });

  test("parses config with all fields set", () => {
    const fullYaml = `
linear:
  project_id: "proj-456"
  poll_interval_seconds: 30
  statuses:
    ready: "Ready"
    in_progress: "Working"
    done: "Complete"
    failed: "Failed"
repo:
  path: "/home/user/project"
hooks:
  pre:
    - "git pull"
    - "git checkout -b feature"
  post:
    - "npm test"
claude:
  timeout_seconds: 600
  retries: 2
log:
  file: "./test.log"
`;
    const config = loadConfig(writeConfig(fullYaml));

    expect(config.linear.poll_interval_seconds).toBe(30);
    expect(config.hooks.pre).toEqual(["git pull", "git checkout -b feature"]);
    expect(config.hooks.post).toEqual(["npm test"]);
    expect(config.claude.timeout_seconds).toBe(600);
    expect(config.claude.retries).toBe(2);
    expect(config.log.file).toBe("./test.log");
  });

  test("throws on missing project_id", () => {
    const yaml = `
linear:
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing statuses", () => {
    const yaml = `
linear:
  project_id: "proj-123"
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing repo path", () => {
    const yaml = `
linear:
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws when LINEAR_API_KEY is not set", () => {
    delete process.env.LINEAR_API_KEY;
    expect(() => loadConfig(writeConfig(validYaml))).toThrow(
      "LINEAR_API_KEY environment variable is required"
    );
  });

  test("rejects retries greater than 3", () => {
    const yaml = `
linear:
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
claude:
  retries: 5
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("rejects negative poll interval", () => {
    const yaml = `
linear:
  project_id: "proj-123"
  poll_interval_seconds: -1
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });
});
