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

const minimalProvider = `
provider:
  type: linear
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    code_review: "Code Review"
    verification: "Verification"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-worker-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe("loadConfig", () => {
  test("parses valid linear config with defaults", () => {
    const config = loadConfig(writeConfig(minimalProvider));

    expect(config.provider.type).toBe("linear");
    if (config.provider.type === "linear") {
      expect(config.provider.project_id).toBe("proj-123");
      expect(config.provider.poll_interval_seconds).toBe(60);
    }
    expect(config.provider.statuses.ready).toBe("Todo");
    expect(config.provider.statuses.code_review).toBe("Code Review");
    expect(config.provider.statuses.verification).toBe("Verification");
    expect(config.scm.type).toBe("github");
    expect(config.repo.path).toBe("/tmp/repo");
    expect(config.hooks.pre).toEqual([]);
    expect(config.hooks.post).toEqual([]);
    expect(config.executor.type).toBe("claude");
    expect(config.executor.timeout_seconds).toBe(300);
    expect(config.executor.retries).toBe(0);
    expect(config.log.level).toBe("info");
    expect(config.feedback.comment_prefix).toBe("/agent");
    expect(config.feedback.poll_interval_seconds).toBe(120);
  });

  test("parses linear config with all fields set", () => {
    const fullYaml = `
provider:
  type: linear
  project_id: "proj-456"
  poll_interval_seconds: 30
  statuses:
    ready: "Ready"
    in_progress: "Working"
    code_review: "Review"
    verification: "Verification"
    failed: "Failed"
repo:
  path: "/home/user/project"
hooks:
  pre:
    - "git pull"
    - "git checkout -b feature"
  post:
    - "npm test"
executor:
  type: claude
  timeout_seconds: 600
  retries: 2
scm:
  type: github
  owner: "org"
  repo: "repo"
feedback:
  comment_prefix: "/bot"
  poll_interval_seconds: 300
log:
  file: "./test.log"
`;
    const config = loadConfig(writeConfig(fullYaml));

    expect(config.provider.poll_interval_seconds).toBe(30);
    expect(config.hooks.pre).toEqual(["git pull", "git checkout -b feature"]);
    expect(config.hooks.post).toEqual(["npm test"]);
    expect(config.executor.type).toBe("claude");
    expect(config.executor.timeout_seconds).toBe(600);
    expect(config.executor.retries).toBe(2);
    expect(config.log.file).toBe("./test.log");
    expect(config.feedback.comment_prefix).toBe("/bot");
    expect(config.feedback.poll_interval_seconds).toBe(300);
  });

  test("parses jira config", () => {
    const yaml = `
provider:
  type: jira
  base_url: "https://jira.example.com"
  poll_interval_seconds: 45
  jql: "project = FOO AND status = 'Todo'"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    code_review: "Code Review"
    verification: "Verification"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.provider.type).toBe("jira");
    if (config.provider.type === "jira") {
      expect(config.provider.base_url).toBe("https://jira.example.com");
      expect(config.provider.jql).toBe("project = FOO AND status = 'Todo'");
      expect(config.provider.poll_interval_seconds).toBe(45);
    }
  });

  test("parses plane config", () => {
    const yaml = `
provider:
  type: plane
  base_url: "https://plane.example.com"
  workspace_slug: "my-workspace"
  project_id: "proj-uuid"
  query: "state_group: backlog"
  statuses:
    ready: "Backlog"
    in_progress: "In Progress"
    code_review: "Code Review"
    verification: "Verification"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.provider.type).toBe("plane");
    if (config.provider.type === "plane") {
      expect(config.provider.base_url).toBe("https://plane.example.com");
      expect(config.provider.workspace_slug).toBe("my-workspace");
      expect(config.provider.project_id).toBe("proj-uuid");
      expect(config.provider.query).toBe("state_group: backlog");
    }
  });

  test("parses opencode executor", () => {
    const yaml = `
${minimalProvider}
executor:
  type: opencode
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.executor.type).toBe("opencode");
  });

  test("parses pi executor", () => {
    const yaml = `
${minimalProvider}
executor:
  type: pi
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.executor.type).toBe("pi");
  });

  test("parses BitBucket Server SCM config", () => {
    const yaml = `
${minimalProvider.replace(
      "scm:\n  type: github\n  owner: \"myorg\"\n  repo: \"myrepo\"",
      "scm:\n  type: bitbucket_server\n  base_url: \"https://bb.example.com\"\n  project: \"PROJ\"\n  repo: \"myrepo\""
)}
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.scm.type).toBe("bitbucket_server");
    if (config.scm.type === "bitbucket_server") {
      expect(config.scm.base_url).toBe("https://bb.example.com");
      expect(config.scm.project).toBe("PROJ");
      expect(config.scm.repo).toBe("myrepo");
    }
  });

  test("throws on missing project_id for linear", () => {
    const yaml = `
provider:
  type: linear
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    code_review: "Code Review"
    verification: "Verification"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing statuses", () => {
    const yaml = `
provider:
  type: linear
  project_id: "proj-123"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing scm", () => {
    const yaml = `
provider:
  type: linear
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    code_review: "Code Review"
    verification: "Verification"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing code_review status", () => {
    const yaml = `
provider:
  type: linear
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    verification: "Verification"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing verification status", () => {
    const yaml = `
provider:
  type: linear
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    code_review: "Code Review"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("throws on missing repo path", () => {
    const yaml = `
provider:
  type: linear
  project_id: "proj-123"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    code_review: "Code Review"
    verification: "Verification"
    failed: "Canceled"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("rejects retries greater than 3", () => {
    const yaml = `
${minimalProvider}
executor:
  retries: 5
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("rejects negative poll interval", () => {
    const yaml = `
provider:
  type: linear
  project_id: "proj-123"
  poll_interval_seconds: -1
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    code_review: "Code Review"
    verification: "Verification"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("rejects invalid executor type", () => {
    const yaml = `
${minimalProvider}
executor:
  type: invalid
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("rejects invalid provider type", () => {
    const yaml = `
provider:
  type: github
repo:
  path: "/tmp/repo"
scm:
  type: github
  owner: "myorg"
  repo: "myrepo"
`;
    expect(() => loadConfig(writeConfig(yaml))).toThrow();
  });

  test("parses prompts config with implement and feedback", () => {
    const yaml = `
${minimalProvider}
prompts:
  implement: |
    Follow the project conventions in AGENTS.md.
    Always run \`bun typecheck && bun test\` before finishing.
  feedback: |
    Keep changes minimal. Only address the specific feedback.
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.prompts.implement).toContain("Follow the project conventions");
    expect(config.prompts.implement).toContain("bun typecheck");
    expect(config.prompts.feedback).toContain("Keep changes minimal");
  });

  test("parses prompts config with only implement", () => {
    const yaml = `
${minimalProvider}
prompts:
  implement: "Custom implementation prompt"
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.prompts.implement).toBe("Custom implementation prompt");
    expect(config.prompts.feedback).toBeUndefined();
  });

  test("parses prompts config with only feedback", () => {
    const yaml = `
${minimalProvider}
prompts:
  feedback: "Custom feedback prompt"
`;
    const config = loadConfig(writeConfig(yaml));
    expect(config.prompts.implement).toBeUndefined();
    expect(config.prompts.feedback).toBe("Custom feedback prompt");
  });

  test("parses config without prompts section (defaults to empty object)", () => {
    const config = loadConfig(writeConfig(minimalProvider));
    expect(config.prompts).toEqual({});
    expect(config.prompts.implement).toBeUndefined();
    expect(config.prompts.feedback).toBeUndefined();
  });
});
