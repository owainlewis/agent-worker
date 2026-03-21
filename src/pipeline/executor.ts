import { createClaudeExecutor } from "./claude-executor.ts";
import { createCodexExecutor } from "./codex-executor.ts";
import { createOpencodeExecutor } from "./opencode-executor.ts";
import { createPiExecutor } from "./pi-executor.ts";

/**
 * Attempts to spawn a process, catching ENOENT (binary not found).
 * Returns the process on success, or an ExecutorResult describing the failure.
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
  run(prompt: string, cwd: string, timeoutMs: number): Promise<ExecutorResult>;
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

export function createExecutor(type: "claude" | "codex" | "opencode" | "pi"): CodeExecutor {
  switch (type) {
    case "claude":
      return createClaudeExecutor();
    case "codex":
      return createCodexExecutor();
    case "opencode":
      return createOpencodeExecutor();
    case "pi":
      return createPiExecutor();
    default:
      throw new Error(`Unknown executor type: ${type}`);
  }
}
