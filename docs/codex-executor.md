# Codex Executor

agent-worker supports [OpenAI Codex](https://github.com/openai/codex) as an alternative to the default Claude executor. This document covers setup, configuration, and behaviour specific to the Codex executor.

## How it works

When `executor.type: codex` is set, the pipeline invokes Codex as a headless subprocess:

```
codex exec --full-auto <prompt>
```

The prompt contains the ticket title and description. Codex runs autonomously, makes code changes, and exits. The exit code determines success (`0`) or failure (non-zero).

## Worktree isolation

The Claude executor sets `needsWorktree: true`, so the pipeline creates an isolated git worktree (`agent/task-{id}`) before execution. **Codex sets `needsWorktree: false`** — Codex manages its own internal worktree isolation, so the pipeline skips automatic worktree creation.

This means:
- Hooks run in the original `repo.path` directory, not in a separate worktree.
- You do **not** need to add `git checkout` or branch creation commands to your pre-hooks; Codex handles that internally.
- Post-hooks that push or open a PR should reference the branch that Codex created — or omit branch-specific commands if Codex handles the full PR lifecycle.

## Prerequisites

1. **Install Codex CLI** — follow the [Codex installation instructions](https://github.com/openai/codex).
2. **Authenticate** — set your OpenAI API key:
   ```bash
   export OPENAI_API_KEY=sk-...
   ```
3. **Verify** the `codex` binary is on your `PATH`:
   ```bash
   codex --version
   ```

The `codex` binary is a runtime dependency — it is not bundled with agent-worker.

## Configuration

Set `executor.type` to `codex` in your config file:

```yaml
linear:
  project_id: "your-project-uuid"
  poll_interval_seconds: 60
  statuses:
    ready: "Todo"
    in_progress: "In Progress"
    done: "Done"
    failed: "Canceled"

repo:
  path: "/path/to/your/repo"

hooks:
  # Codex manages its own worktrees — no branch checkout needed here.
  pre: []
  post:
    - "git add -A"
    - "git commit -m '{id}: {raw_title}'"
    - "git push origin {branch}"
    - "gh pr create --title '{id}: {raw_title}' --body 'Fixes {id}. Implemented by Agent Worker.' --base main"

executor:
  type: codex              # Use the Codex executor
  timeout_seconds: 300     # Kill Codex if it exceeds this duration (default: 300)
  retries: 0               # Retry attempts on failure, 0–3 (default: 0)

log:
  file: "./agent-worker.log"
```

### Timeout

`timeout_seconds` controls how long the pipeline waits for Codex to finish. If Codex exceeds this limit, the process is killed and the ticket is marked failed. For large or complex tasks, increase this value:

```yaml
executor:
  type: codex
  timeout_seconds: 600     # 10 minutes
```

### Retries

`retries` sets how many additional attempts to make if Codex exits with a non-zero code or times out. Valid range is `0`–`3`:

```yaml
executor:
  type: codex
  timeout_seconds: 300
  retries: 2               # Up to 3 total attempts
```

Each retry re-runs the full pipeline (pre-hooks → Codex → post-hooks).

## Logging

Codex stdout and stderr are streamed line-by-line to the agent-worker logger at `info` level under the `codex` key. Set `log.level: debug` in your config for maximum verbosity.
