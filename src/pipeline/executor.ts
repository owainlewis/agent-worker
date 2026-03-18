import type { Logger } from "../logger.ts";
import { createClaudeExecutor } from "./claude-executor.ts";
import { createCodexExecutor } from "./codex-executor.ts";

export type ExecutorResult = {
  success: boolean;
  output: string;
  timedOut: boolean;
  exitCode: number | null;
};

export interface CodeExecutor {
  name: string;
  /** Whether the pipeline should create an isolated git worktree for this executor. */
  needsWorktree: boolean;
  run(prompt: string, cwd: string, timeoutMs: number, logger: Logger): Promise<ExecutorResult>;
}

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

export function createExecutor(type: "claude" | "codex"): CodeExecutor {
  switch (type) {
    case "claude":
      return createClaudeExecutor();
    case "codex":
      return createCodexExecutor();
    default:
      throw new Error(`Unknown executor type: ${type}`);
  }
}
