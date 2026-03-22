/**
 * @module src/pipeline/executor — Executor SPI contract, factory, and shared utilities.
 */

import type { Config } from "../config.ts";
import { createClaudeExecutor } from "./claude-executor.ts";
import { createCodexExecutor } from "./codex-executor.ts";
import { createDockerExecutor } from "./docker-executor.ts";
import { createOpencodeExecutor } from "./opencode-executor.ts";
import { createPiExecutor } from "./pi-executor.ts";

/**
 * Attempts to spawn a process, catching ENOENT (binary not found).
 * Returns the process on success, or an ExecutorResult describing the failure.
 * @param command - Command and arguments to spawn.
 * @param options - Spawn options forwarded to `Bun.spawn`.
 * @returns An object wrapping the spawned process on success, or an {@link ExecutorResult} with success: false if the executable was not found.
 * @throws Re-throws any non-ENOENT error from `Bun.spawn`.
 */
export function spawnOrError(
  command: string[],
  options: Parameters<typeof Bun.spawn>[1]
): { proc: ReturnType<typeof Bun.spawn> } | ExecutorResult {
  try {
    const proc = Bun.spawn(command, options);
    return { proc };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT") {
      return {
        success: false,
        output: `Executable not found: ${command[0]}`,
        timedOut: false,
        exitCode: null,
      };
    }
    throw err;
  }
}

/** Result returned by a {@link CodeExecutor} after invocation. */
export type ExecutorResult = {
  /** Whether the executor completed successfully. */
  success: boolean;
  /** Combined stdout and stderr output from the executor. */
  output: string;
  /** Whether the executor was killed due to exceeding the timeout. */
  timedOut: boolean;
  /** Process exit code, or `null` if the process was killed (e.g. timeout or signal). */
  exitCode: number | null;
};

/**
 * SPI contract for coding agent executors.
 *
 * Implementations must not import from `scheduler.ts`, `poller.ts`, `feedback/`, or `index.ts`.
 */
export interface CodeExecutor {
  /** Human-readable executor name (e.g. "Claude", "Codex"). */
  name: string;
  /** Whether the pipeline should create an isolated git worktree for this executor. */
  needsWorktree: boolean;
  /**
   * Runs the executor with the given prompt.
   * @param prompt - The task prompt / instructions for the coding agent.
   * @param cwd - Working directory in which the executor should operate.
   * @param timeoutMs - Maximum execution time in milliseconds before the process is killed.
   */
  run(prompt: string, cwd: string, timeoutMs: number): Promise<ExecutorResult>;
}

/**
 * Reads chunks from a readable stream, calling `onLine` for each complete line.
 * @param stream - The readable stream to consume.
 * @param onLine - Callback invoked for each line containing non-whitespace characters, as it becomes available.
 * @returns The full text content of the stream (all chunks concatenated).
 */
export async function streamToLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    chunks.push(text);
    buffer += text;

    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  }

  if (buffer.trim()) onLine(buffer);
  return chunks.join("");
}

/**
 * Creates a code executor based on the executor configuration.
 * @param executorConfig - Executor configuration from the parsed config file.
 * @returns A {@link CodeExecutor} implementation for the specified type.
 * @throws Error if `type` does not match a known executor.
 */
export function createExecutor(executorConfig: Config["executor"]): CodeExecutor {
  switch (executorConfig.type) {
    case "claude":
      return createClaudeExecutor();
    case "codex":
      return createCodexExecutor();
    case "opencode":
      return createOpencodeExecutor();
    case "pi":
      return createPiExecutor();
    case "container":
      return createDockerExecutor({
        image: executorConfig.image,
        command: executorConfig.command,
        memory: executorConfig.memory,
        cpus: executorConfig.cpus,
        network: executorConfig.network,
        env: executorConfig.env,
        mounts: executorConfig.mounts,
      });
    default: {
      const _exhaustive: never = executorConfig;
      throw new Error(`Unknown executor type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}
