import type { CodeExecutor, ExecutorFactoryOptions } from "./executor.ts";
import { runStreamingProcess } from "./streaming-executor.ts";

/**
 * SAM-611 (2026-05-08) — Codex ship-instruction prelude.
 *
 * Background: when Sameer's autonomous-worker daemon switched claude-ia to use
 * the codex executor, codex completed the code changes correctly but exited
 * without running git commit / push / gh pr create. Result: SAM-428's beautiful
 * 1549-line-file-into-5-modules refactor was lost when the daemon's worktree
 * cleanup ran.
 *
 * Root cause: claude executor uses Sameer's /ship-sameer skill behavior baked
 * into Claude Code, so it knows the daemon expects "do work → commit → push
 * → PR → exit." Codex CLI has no equivalent skill, so it stops after writing
 * code. The fix is to instruct codex explicitly via a prepended prompt prelude.
 *
 * Different from claude executor: codex uses `needsWorktree: false` (per
 * pipeline.ts:90-95), so codex runs in the main repo path and must create its
 * own `agent/task-<ticket>` branch before editing. Claude gets a fresh worktree
 * pre-built on that branch by createWorktree().
 */
const CODEX_SHIP_PRELUDE = `You are running inside Sameer's autonomous-worker daemon. The daemon expects you to ship a Linear ticket end-to-end: do the work, commit, push, open a PR, then exit. The ticket body is below the separator.

CRITICAL — your job is NOT done when the code change is done. You MUST commit, push, and open a PR before exiting. The daemon has a post-hook that fails the ticket if no PR exists for the run's branch.

WORKFLOW:

1. Read the ticket body below. Identify the ticket ID — the first line says "Linear ticket: <TICKET-ID>" or the SAM-NNN identifier appears in the description.

2. You are running in the main repo path on the \`main\` branch (the daemon's pre-hook just refreshed it). You MUST create your work branch BEFORE editing anything:
       git checkout -b agent/task-<TICKET-ID> main
   If a stale local branch with that name exists, force-delete it first:
       git branch -D agent/task-<TICKET-ID> 2>/dev/null || true
       git checkout -b agent/task-<TICKET-ID> main

3. Make the change requested by the ticket. Match existing code patterns. Do NOT introduce TODOs, mocks, stubs, or placeholder code in runtime paths.

4. Run the verify recipe in the ticket's "## Verify" section. Apply this triage:
   - If a command fails in code YOU TOUCHED, fix it and re-run.
   - If a command fails in PRE-EXISTING unrelated suites/files (e.g. lint or test failures in files you did not modify), include a clear note in the PR body but proceed — surfacing pre-existing breakage is not your scope.
   - If the verify recipe is fundamentally unsatisfiable (e.g. requires credentials the test env doesn't have, or has mutually-exclusive acceptance criteria), STOP — see "BLOCKED PATH" below.

5. Commit using conventional format with a Refs trailer for Linear:
       git add -A
       git commit -m "<type>(<scope>): <imperative description>

       <body explaining what changed and why>

       Refs <TICKET-ID>"
   Type: feat (new code), fix (bug fix), refactor (restructure), test (test-only), chore (tooling). Scope is the affected package/area.

6. Push the branch:
       git push -u origin agent/task-<TICKET-ID>

7. Open a PR via gh:
       gh pr create --base main --title "<conventional-type>(<scope>): <description> (<TICKET-ID>)" --body "$(cat <<'EOF'
       Closes <TICKET-ID>

       ## What changed

       <Brief explanation of the change.>

       ## Acceptance criteria

       <Reproduce the ticket's acceptance criteria as a markdown checklist with [x] for completed items.>

       ## Verify

       <Output of the verify recipe. Note any pre-existing failures in unrelated suites that the recipe surfaced — this prevents the reviewer from blaming your PR.>

       ## Risks remaining

       <Anything you couldn't fully verify, or any pre-existing issues you noticed.>

       🤖 Generated with Codex agent-worker daemon
       EOF
       )"

   Critical: the FIRST LINE of the PR body MUST start with \`Closes <TICKET-ID>\` (or \`Refs <TICKET-ID>\` if the work doesn't fully close the ticket). Linear uses this for auto-close on merge.

8. Print the PR URL in your final summary so the daemon's logs capture it. Then exit cleanly.

BLOCKED PATH — if you cannot satisfy the ticket's constraints:

If the ticket has mutually-unsatisfiable acceptance criteria, missing credentials the test env doesn't have, or any other genuine blocker:
- Do NOT half-ship. Do NOT introduce mocks/stubs to make the verify recipe pass.
- Output a section starting with "## BLOCKED" in your final summary explaining:
  - What you tried
  - Why the constraints can't all be satisfied at once
  - 2-3 specific unblock paths Sameer can choose from
- Do NOT commit or push anything. Leave the working tree clean.
- Exit cleanly. The daemon's postflight will detect the still-failing verify recipe and route the ticket appropriately.

NOT YOUR JOB:
- Do not modify the daemon (\`/Users/sameerrijhsinghani/dev/agent-worker-pilot/\`).
- Do not modify Codex CLI / Claude Code / any AI tool config.
- Do not change branches the daemon pre-hooks already touched.
- Do not run \`git worktree add\` or \`git worktree remove\` — the daemon owns worktree lifecycle (and you're not in a worktree, you're in the main repo path).

Ticket body follows.

---

`;

export function createCodexExecutor(
  opts: ExecutorFactoryOptions = {},
): CodeExecutor {
  return {
    name: "codex",
    needsWorktree: false,
    async run(prompt, cwd, timeoutMs, logger, extras) {
      logger.info("Codex started", { timeoutMs });

      const fullPrompt = `${CODEX_SHIP_PRELUDE}${prompt}`;

      const result = await runStreamingProcess({
        argv: [
          "codex",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          fullPrompt,
        ],
        cwd,
        timeoutMs,
        watchdogInactivityMs: opts.watchdogInactivityMs ?? 0,
        logger,
        executorName: "codex",
        ticketIdentifier: extras?.ticketIdentifier,
      });

      if (result.timedOut) {
        logger.error("Codex timed out", { timeoutMs });
      } else if (result.watchdogKilled) {
        logger.error("Codex killed by inactivity watchdog", {
          inactivityMs: opts.watchdogInactivityMs ?? 0,
        });
      } else if (result.exitCode !== 0) {
        logger.error("Codex failed", { exitCode: result.exitCode });
      } else {
        logger.info("Codex completed successfully");
      }

      return result;
    },
  };
}
