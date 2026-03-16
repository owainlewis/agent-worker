import type { Logger } from "../logger.ts";
import type { Ticket } from "../providers/types.ts";
import { buildTaskVars } from "./interpolate.ts";
import { runHooks } from "./hook-runner.ts";
import { runClaude } from "./claude-executor.ts";

export type PipelineResult = {
  success: boolean;
  stage?: "pre-hook" | "claude" | "post-hook";
  error?: string;
};

export async function executePipeline(options: {
  ticket: Ticket;
  preHooks: string[];
  postHooks: string[];
  repoCwd: string;
  claudeTimeoutMs: number;
  logger: Logger;
}): Promise<PipelineResult> {
  const { ticket, preHooks, postHooks, repoCwd, claudeTimeoutMs, logger } = options;
  const vars = buildTaskVars(ticket);

  // Pre-hooks
  if (preHooks.length > 0) {
    const preResult = await runHooks(preHooks, repoCwd, vars, logger);
    if (!preResult.success) {
      return {
        success: false,
        stage: "pre-hook",
        error: `Command "${preResult.failedCommand}" exited with code ${preResult.exitCode}: ${preResult.output}`,
      };
    }
  }

  // Claude Code
  const prompt = `Linear ticket: ${ticket.title}\n\n${ticket.description || "No description provided."}`;
  const claudeResult = await runClaude(prompt, repoCwd, claudeTimeoutMs, logger);
  if (!claudeResult.success) {
    const reason = claudeResult.timedOut
      ? `Timed out after ${claudeTimeoutMs}ms`
      : `Exited with code ${claudeResult.exitCode}`;
    return {
      success: false,
      stage: "claude",
      error: `${reason}: ${claudeResult.output.slice(-2000)}`,
    };
  }

  // Post-hooks
  if (postHooks.length > 0) {
    const postResult = await runHooks(postHooks, repoCwd, vars, logger);
    if (!postResult.success) {
      return {
        success: false,
        stage: "post-hook",
        error: `Command "${postResult.failedCommand}" exited with code ${postResult.exitCode}: ${postResult.output}`,
      };
    }
  }

  return { success: true };
}
