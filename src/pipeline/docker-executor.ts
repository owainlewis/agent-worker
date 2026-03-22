import type { CodeExecutor, ExecutorResult } from "./executor.ts";
import { streamToLines, spawnOrError } from "./executor.ts";
import { log } from "../logger.ts";

export interface DockerExecutorConfig {
  image: string;
  command: string[];
  dangerously_skip_permissions?: boolean;
  memory?: string;
  cpus?: string;
  network?: string;
  env?: Record<string, string>;
  mounts?: { source: string; dest: string }[];
}

/**
 * Resolves ${VAR} references in env values to process.env values.
 * Keeps the literal value unchanged when no env var is found.
 */
function resolveEnvVars(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] ?? "";
    });
  }
  return resolved;
}

/**
 * Expands ~ to the user's home directory in mount source paths.
 */
function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? "/root";
  if (path.startsWith("~/")) return `${process.env.HOME ?? "/root"}${path.slice(1)}`;
  return path;
}

/**
 * Resolves a mount source path to an absolute path. Supports ~ expansion.
 */
function resolveMountSource(source: string): string {
  const expanded = expandHome(source);
  if (expanded.startsWith("/")) return expanded;
  // Relative path — resolve against CWD
  return `${process.cwd()}/${expanded}`;
}

export function createDockerExecutor(config: DockerExecutorConfig): CodeExecutor {
  return {
    name: "docker",
    needsWorktree: true,
    async run(prompt: string, cwd: string, timeoutMs: number): Promise<ExecutorResult> {
      log.info("Docker executor started", { image: config.image, cwd, timeoutMs });

      const dockerArgs: string[] = [
        "run",
        "--rm",
        "-i",
        "-w", "/workspace",
      ];

      // Mount the working directory (worktree)
      dockerArgs.push("-v", `${cwd}:/workspace`);

      // Resource limits
      if (config.memory) {
        dockerArgs.push("--memory", config.memory);
      }
      if (config.cpus) {
        dockerArgs.push("--cpus", config.cpus);
      }

      // Network mode
      if (config.network) {
        dockerArgs.push("--network", config.network);
      }

      // Environment variables
      if (config.env && Object.keys(config.env).length > 0) {
        const resolved = resolveEnvVars(config.env);
        for (const [key, value] of Object.entries(resolved)) {
          dockerArgs.push("-e", `${key}=${value}`);
        }
      }

      // Extra mounts
      if (config.mounts) {
        for (const mount of config.mounts) {
          const source = resolveMountSource(mount.source);
          dockerArgs.push("-v", `${source}:${mount.dest}`);
        }
      }

      // Image
      dockerArgs.push(config.image);

      // Command — append prompt as final argument
      const command = [...config.command];
      if (config.dangerously_skip_permissions) {
        // Insert --dangerously-skip-permissions before prompt if not already present
        if (!command.includes("--dangerously-skip-permissions")) {
          command.push("--dangerously-skip-permissions");
        }
      }
      command.push(prompt);

      dockerArgs.push(...command);

      log.debug("Docker run command", { dockerArgs: dockerArgs.join(" ") });

      const spawned = spawnOrError(
        ["docker", ...dockerArgs],
        { stdout: "pipe", stderr: "pipe" }
      );

      if ("success" in spawned) return spawned;

      const proc = spawned.proc;

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      const [stdout, stderr] = await Promise.all([
        streamToLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
          log.info("docker", { stream: "stdout", line });
        }),
        streamToLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
          log.info("docker", { stream: "stderr", line });
        }),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const output = (stdout + "\n" + stderr).trim();

      if (timedOut) {
        log.error("Docker executor timed out", { timeoutMs, image: config.image });
        return { success: false, output, timedOut: true, exitCode: null };
      }

      if (exitCode !== 0) {
        log.error("Docker executor failed", { exitCode, image: config.image });
      } else {
        log.info("Docker executor completed successfully");
      }

      return { success: exitCode === 0, output, timedOut: false, exitCode };
    },
  };
}
