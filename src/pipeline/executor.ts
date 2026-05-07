import type { Logger } from "../logger.ts";
import { createClaudeExecutor } from "./claude-executor.ts";
import { createCodexExecutor } from "./codex-executor.ts";

export type ExecutorResult = {
  success: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number | null;
  /**
   * SAM-400: true when the inactivity watchdog fired and killed the child
   * process. Distinct from `timedOut` (the hard wall-clock timeout). Allows
   * the pipeline to surface the exact failure mode in error context.
   */
  watchdogKilled?: boolean;
};

/**
 * Per-call extras for an executor invocation. Optional so test callers and
 * pre-SAM-400 integrations don't have to construct anything; the daemon's
 * pipeline always passes `ticketIdentifier`.
 */
export interface ExecutorRunExtras {
  /** Linear ticket identifier (e.g. "SAM-400"). Used in watchdog kill logs. */
  ticketIdentifier?: string;
}

export interface CodeExecutor {
  name: string;
  /** Whether the pipeline should create an isolated git worktree for this executor. */
  needsWorktree: boolean;
  run(
    prompt: string,
    cwd: string,
    timeoutMs: number,
    logger: Logger,
    extras?: ExecutorRunExtras,
  ): Promise<ExecutorResult>;
}

/**
 * Construction-time options shared by all executor factories. Currently only
 * the watchdog config; kept as an object so future per-executor knobs (extra
 * env, custom argv prefix, etc.) can be added without breaking call sites.
 */
export interface ExecutorFactoryOptions {
  /**
   * SAM-400: max milliseconds without any stdout/stderr activity before the
   * inactivity watchdog kills the child process. 0 (or negative) disables
   * the watchdog entirely, preserving pre-SAM-400 behavior.
   */
  watchdogInactivityMs?: number;
}

/**
 * Reads a stream line-by-line, calling `onLine` per non-empty line and
 * returning the full concatenated text. The optional `onChunk` callback
 * fires once per successful stream read regardless of whether a complete
 * line was assembled — used by the inactivity watchdog so partial output
 * (e.g. a slow tool call producing bytes but no newline yet) still counts
 * as activity.
 */
export async function streamToLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onChunk?: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onChunk) onChunk();

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

export function createExecutor(
  type: "claude" | "codex",
  opts: ExecutorFactoryOptions = {},
): CodeExecutor {
  switch (type) {
    case "claude":
      return createClaudeExecutor(opts);
    case "codex":
      return createCodexExecutor(opts);
    default:
      throw new Error(`Unknown executor type: ${type}`);
  }
}
