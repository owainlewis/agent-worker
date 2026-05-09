import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { resolveRepoCwd } from "../src/scheduler.ts";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Ticket } from "../src/providers/types.ts";
import type { Config } from "../src/config.ts";

// SAM-481 cross-repo work-stealing — coverage for the new config fields and
// scheduler resolution logic. Three concerns:
//   A. Config schema: legacy single-project, multi-project array, mixed (rejected),
//      legacy single-path, path_by_label, missing both (rejected)
//   B. resolveRepoCwd (scheduler helper): legacy path-only, label match,
//      default_path fallback, no-match returns null (refuse-on-ambiguity)
//   C. Backward compat: every test in the legacy suite still passes (verified
//      by the existing 59-test suite continuing to pass)

let tmpDir: string;

function writeConfig(content: string): string {
  const path = join(tmpDir, "config.yaml");
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-worker-sam-481-"));
  process.env.LINEAR_API_KEY = "test-api-key-123";
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
  delete process.env.LINEAR_API_KEY;
});

describe("SAM-481 — config schema (linear.project_ids)", () => {
  const linearMultiProject = `
linear:
  project_ids:
    - "proj-primary"
    - "proj-fallback"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "In Review"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;

  const linearMixed = `
linear:
  project_id: "proj-x"
  project_ids: ["proj-y"]
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "In Review"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;

  const linearMissing = `
linear:
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "In Review"
    failed: "Canceled"
repo:
  path: "/tmp/repo"
`;

  test("project_ids array parses and is preserved in order", () => {
    const config = loadConfig(writeConfig(linearMultiProject));
    expect(config.linear.project_ids).toEqual([
      "proj-primary",
      "proj-fallback",
    ]);
    expect(config.linear.project_id).toBeUndefined();
  });

  test("project_id (legacy) and project_ids (new) together is rejected", () => {
    expect(() => loadConfig(writeConfig(linearMixed))).toThrow();
  });

  test("neither project_id nor project_ids is rejected", () => {
    expect(() => loadConfig(writeConfig(linearMissing))).toThrow();
  });
});

describe("SAM-481 — config schema (repo.path_by_label)", () => {
  const repoPathByLabel = `
linear:
  project_id: "proj-1"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "In Review"
    failed: "Canceled"
repo:
  path_by_label:
    "repo:studio-os": "/Users/sameerrijhsinghani/studio-os"
    "repo:agent-worker-pilot": "/Users/sameerrijhsinghani/dev/agent-worker-pilot"
  default_path: "/Users/sameerrijhsinghani/studio-os"
`;

  const repoMissing = `
linear:
  project_id: "proj-1"
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "In Review"
    failed: "Canceled"
repo: {}
`;

  test("path_by_label parses with default_path", () => {
    const config = loadConfig(writeConfig(repoPathByLabel));
    expect(config.repo.path_by_label).toEqual({
      "repo:studio-os": "/Users/sameerrijhsinghani/studio-os",
      "repo:agent-worker-pilot":
        "/Users/sameerrijhsinghani/dev/agent-worker-pilot",
    });
    expect(config.repo.default_path).toBe(
      "/Users/sameerrijhsinghani/studio-os",
    );
    expect(config.repo.path).toBeUndefined();
  });

  test("repo block with neither path nor path_by_label is rejected", () => {
    expect(() => loadConfig(writeConfig(repoMissing))).toThrow();
  });
});

describe("SAM-481 — resolveRepoCwd", () => {
  function makeTicket(labels: string[]): Ticket {
    return {
      id: "uuid-1",
      identifier: "SAM-100",
      title: "test",
      description: undefined,
      labels,
      projectId: "proj-1",
    };
  }

  function makeConfig(repoConfig: Config["repo"]): Config {
    return {
      apiKey: "test-key",
      linear: {
        project_id: "proj-1",
        poll_interval_seconds: 10,
        statuses: {
          ready: "Todo",
          in_progress: "In Progress",
          done: "Done",
          failed: "Canceled",
        },
      },
      repo: repoConfig,
      hooks: { pre: [], post: [] },
      executor: {
        type: "claude",
        timeout_seconds: 300,
        retries: 0,
        watchdog_inactivity_seconds: 0,
        prompt_prefix: "",
      },
      log: { level: "info" },
    };
  }

  test("legacy single path: always returns that path", () => {
    const config = makeConfig({ path: "/tmp/legacy-repo" });
    expect(resolveRepoCwd(makeTicket([]), config)).toBe("/tmp/legacy-repo");
    expect(resolveRepoCwd(makeTicket(["repo:other"]), config)).toBe(
      "/tmp/legacy-repo",
    );
  });

  test("path_by_label: matching label resolves to its mapped path", () => {
    const config = makeConfig({
      path_by_label: {
        "repo:studio-os": "/path/to/studio-os",
        "repo:agent-worker-pilot": "/path/to/awp",
      },
      default_path: "/path/to/default",
    });
    expect(
      resolveRepoCwd(makeTicket(["repo:studio-os", "type:bug"]), config),
    ).toBe("/path/to/studio-os");
    expect(
      resolveRepoCwd(makeTicket(["repo:agent-worker-pilot"]), config),
    ).toBe("/path/to/awp");
  });

  test("path_by_label: first matching label wins (label order matters)", () => {
    const config = makeConfig({
      path_by_label: {
        "repo:studio-os": "/path/to/studio-os",
        "repo:agent-worker-pilot": "/path/to/awp",
      },
    });
    expect(
      resolveRepoCwd(
        makeTicket(["repo:agent-worker-pilot", "repo:studio-os"]),
        config,
      ),
    ).toBe("/path/to/awp");
  });

  test("path_by_label: no matching label + default_path → returns default", () => {
    const config = makeConfig({
      path_by_label: { "repo:studio-os": "/path/to/studio-os" },
      default_path: "/path/to/default",
    });
    expect(resolveRepoCwd(makeTicket(["type:bug"]), config)).toBe(
      "/path/to/default",
    );
    expect(resolveRepoCwd(makeTicket([]), config)).toBe("/path/to/default");
  });

  test("path_by_label: no matching label + no default_path → returns null (refuse)", () => {
    const config = makeConfig({
      path_by_label: { "repo:studio-os": "/path/to/studio-os" },
    });
    expect(resolveRepoCwd(makeTicket(["type:bug"]), config)).toBeNull();
    expect(resolveRepoCwd(makeTicket([]), config)).toBeNull();
    expect(resolveRepoCwd(makeTicket(["repo:other"]), config)).toBeNull();
  });
});
