import { describe, test, expect } from "bun:test";
import { slugify, sanitizeTitle, buildTaskVars, interpolate } from "../src/pipeline/interpolate.ts";

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("strips special characters", () => {
    expect(slugify("Hello, World! #123")).toBe("hello-world-123");
  });

  test("collapses multiple hyphens", () => {
    expect(slugify("a---b")).toBe("a-b");
  });

  test("trims leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("sanitizeTitle", () => {
  test("strips shell-unsafe characters", () => {
    expect(sanitizeTitle("Fix user's profile")).toBe("Fix users profile");
    expect(sanitizeTitle("Add `feature` support")).toBe("Add feature support");
    expect(sanitizeTitle("Cost is $100")).toBe("Cost is 100");
    expect(sanitizeTitle("Path\\to\\thing")).toBe("Pathtothing");
  });

  test("preserves safe characters", () => {
    expect(sanitizeTitle("Add login page (v2)")).toBe("Add login page (v2)");
    expect(sanitizeTitle("Fix bug #123 - urgent!")).toBe("Fix bug #123 - urgent!");
  });
});

describe("buildTaskVars", () => {
  test("builds vars from ticket", () => {
    const vars = buildTaskVars({
      id: "uuid-123",
      identifier: "ENG-123",
      title: "Fix login bug",
      description: "Some description",
    });

    expect(vars.id).toBe("ENG-123");
    expect(vars.title).toBe("fix-login-bug");
    expect(vars.raw_title).toBe("Fix login bug");
    expect(vars.branch).toBe("agent/task-ENG-123");
  });
});

describe("interpolate", () => {
  const vars = { id: "ENG-123", title: "fix-login-bug", raw_title: "Fix login bug", branch: "agent/task-ENG-123" };

  test("replaces all variables", () => {
    expect(interpolate("git checkout -b {branch}", vars)).toBe(
      "git checkout -b agent/task-ENG-123"
    );
  });

  test("replaces multiple variables in one string", () => {
    expect(interpolate("{id} {title} {branch}", vars)).toBe(
      "ENG-123 fix-login-bug agent/task-ENG-123"
    );
  });

  test("no-op when no variables present", () => {
    expect(interpolate("echo hello", vars)).toBe("echo hello");
  });

  test("replaces raw_title variable", () => {
    expect(interpolate("gh pr create --title '{raw_title}'", vars)).toBe(
      "gh pr create --title 'Fix login bug'"
    );
  });

  test("replaces multiple occurrences", () => {
    expect(interpolate("{id}-{id}", vars)).toBe("ENG-123-ENG-123");
  });
});
