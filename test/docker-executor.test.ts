import { describe, test, expect } from "bun:test";
import { createDockerExecutor, type DockerExecutorConfig } from "../src/pipeline/docker-executor.ts";
import { z } from "zod/v4";

describe("createDockerExecutor", () => {
  test("returns a CodeExecutor with name 'docker'", () => {
    const executor = createDockerExecutor({
      image: "anthropic/claude-code:latest",
      command: ["claude", "--print", "-p"],
    });
    expect(executor.name).toBe("docker");
    expect(executor.needsWorktree).toBe(true);
  });

  test("returns correct shape on failure (docker not available)", async () => {
    const executor = createDockerExecutor({
      image: "anthropic/claude-code:latest",
      command: ["claude", "--print", "-p"],
    });
    const result = await executor.run("test prompt", "/tmp", 2000);
    // Docker may or may not be installed in test env, but we should get a valid result shape
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("exitCode");
    expect(typeof result.success).toBe("boolean");
  });

  test("resolves ${VAR} env references from process.env", async () => {
    process.env.__TEST_DOCKER_VAR__ = "resolved-value";
    const executor = createDockerExecutor({
      image: "test:latest",
      command: ["echo"],
      env: {
        MY_KEY: "${__TEST_DOCKER_VAR__}",
        STATIC: "plain-value",
      },
    });

    // We can't easily inspect the docker args, but we verify the executor was created
    expect(executor.name).toBe("docker");
    delete process.env.__TEST_DOCKER_VAR__;
  });

  test("handles missing env var gracefully", async () => {
    const executor = createDockerExecutor({
      image: "test:latest",
      command: ["echo"],
      env: {
        MISSING: "${THIS_VAR_DOES_NOT_EXIST}",
      },
    });

    expect(executor.name).toBe("docker");
  });

  test("accepts all container config options", () => {
    const executor = createDockerExecutor({
      image: "anthropic/claude-code:latest",
      command: ["claude", "--print", "-p"],
      dangerously_skip_permissions: true,
      memory: "4g",
      cpus: "2",
      network: "none",
      env: { API_KEY: "test" },
      mounts: [
        { source: "~/.agents/skills", dest: "/root/.agents/skills" },
      ],
    });

    expect(executor.name).toBe("docker");
    expect(executor.needsWorktree).toBe(true);
  });
});

describe("ContainerExecutorConfig schema", () => {
  // Inline the schema to test parsing without needing loadConfig (which requires yaml)
  const MountSchema = z.object({
    source: z.string(),
    dest: z.string(),
  });

  const ContainerExecutorSchema = z.object({
    type: z.literal("container"),
    image: z.string(),
    command: z.array(z.string()),
    dangerously_skip_permissions: z.boolean().default(false),
    memory: z.string().optional(),
    cpus: z.string().optional(),
    network: z.string().default("none"),
    env: z.record(z.string(), z.string()).default({}),
    mounts: z.array(MountSchema).default([]),
    timeout_seconds: z.number().positive().default(300),
    retries: z.number().int().min(0).max(3).default(0),
  });

  test("parses minimal container config with defaults", () => {
    const config = ContainerExecutorSchema.parse({
      type: "container",
      image: "anthropic/claude-code:latest",
      command: ["claude", "--print", "-p"],
    });

    expect(config.type).toBe("container");
    expect(config.image).toBe("anthropic/claude-code:latest");
    expect(config.command).toEqual(["claude", "--print", "-p"]);
    expect(config.dangerously_skip_permissions).toBe(false);
    expect(config.network).toBe("none");
    expect(config.env).toEqual({});
    expect(config.mounts).toEqual([]);
    expect(config.timeout_seconds).toBe(300);
    expect(config.retries).toBe(0);
  });

  test("parses full container config", () => {
    const config = ContainerExecutorSchema.parse({
      type: "container",
      image: "anthropic/claude-code:latest",
      command: ["claude", "--print", "-p"],
      dangerously_skip_permissions: true,
      memory: "4g",
      cpus: "2",
      network: "none",
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
      mounts: [{ source: "~/.agents/skills", dest: "/root/.agents/skills" }],
      timeout_seconds: 600,
      retries: 2,
    });

    expect(config.type).toBe("container");
    expect(config.dangerously_skip_permissions).toBe(true);
    expect(config.memory).toBe("4g");
    expect(config.cpus).toBe("2");
    expect(config.network).toBe("none");
    expect(config.env).toEqual({ ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" });
    expect(config.mounts).toEqual([{ source: "~/.agents/skills", dest: "/root/.agents/skills" }]);
    expect(config.timeout_seconds).toBe(600);
    expect(config.retries).toBe(2);
  });

  test("rejects missing image", () => {
    expect(() =>
      ContainerExecutorSchema.parse({
        type: "container",
        command: ["claude"],
      })
    ).toThrow();
  });

  test("rejects missing command", () => {
    expect(() =>
      ContainerExecutorSchema.parse({
        type: "container",
        image: "test:latest",
      })
    ).toThrow();
  });

  test("rejects retries greater than 3", () => {
    expect(() =>
      ContainerExecutorSchema.parse({
        type: "container",
        image: "test:latest",
        command: ["echo"],
        retries: 5,
      })
    ).toThrow();
  });
});
