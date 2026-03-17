# agent-worker

An autonomous worker agent that picks up tasks from your issue tracker and completes them — without you in the loop.

![Agent Worker Demo](assets/demo.png)

## Thesis

The way to scale with AI agents is to get out of the loop. Stop babysitting. Stop copy-pasting tickets into chat windows. Define the work, assign it to the agent, and walk away.

**agent-worker** is a polling-based worker that watches your issue tracker for assigned tasks, claims them, executes an agent harness to do the work, and reports results back. You stay out of the loop entirely.

### Why polling?

Webhook-based agent orchestrators like OpenClaw require you to expose ports and endpoints to the internet. That's a security surface you don't need. The polling pattern is simpler and more secure — your agent reaches out on its own schedule, nothing reaches in. This scales from a single agent on your laptop to hundreds of workers across many repos and projects without any additional infrastructure.

### Hooks: deterministic guardrails around non-deterministic agents

Agents are powerful but non-deterministic. Pre and post hooks let you wrap agent execution with deterministic, auditable steps — checking out a branch, running tests, linting, pushing code. The agent does the creative work; hooks enforce the process.

### Agent-harness agnostic

agent-worker is not tied to a single agent. It supports any agent harness that can accept a prompt and return a result. Currently supported:

- **Claude Code** — Anthropic's CLI agent
- **Codex** — OpenAI's CLI agent

Adding a new harness is a single file implementing the executor interface.

## Prerequisites

- [Bun](https://bun.sh) 1.0+
- An agent harness installed and authenticated (Claude Code or Codex)
- A Linear account with a personal API key

## Installation

Download a pre-built binary from the releases page, or build from source:

```bash
git clone https://github.com/owainlewis/agent-worker
cd agent-worker
bun install
bun run build
```

The compiled binary is written to `dist/agent-worker`.

## Configuration

Copy the example config and edit it:

```bash
cp agent-worker.example.yaml agent-worker.yaml
```

Set your Linear API key as an environment variable:

```bash
export LINEAR_API_KEY=lin_api_...
```

### Configuration reference

```yaml
linear:
  project_id: "your-project-uuid"     # Linear project UUID (required)
  poll_interval_seconds: 60           # How often to check for new tickets

  statuses:
    ready: "Todo"                     # Status that marks a ticket ready for pickup
    in_progress: "In Progress"        # Status set when the agent claims a ticket
    done: "Done"                      # Status set on success
    failed: "Canceled"                # Status set on failure

repo:
  path: "/path/to/your/repo"          # Absolute path to the working repository

hooks:
  pre:                                # Commands to run before the agent (optional)
    - "git checkout main"
    - "git pull origin main"
    - "git checkout -b agent/task-{id}"

  post:                               # Commands to run after the agent succeeds (optional)
    - "bun run test"
    - "git add -A"
    - "git commit -m '{id}: {raw_title}'"
    - "git push origin {branch}"
    - "gh pr create --title '{id}: {raw_title}' --body 'Fixes {id}. Implemented by Agent Worker.' --base main"

executor:
  type: claude                        # Agent harness: "claude" or "codex"
  timeout_seconds: 300                # Max time for the agent to complete
  retries: 0                          # Retry attempts on failure (0–3)

log:
  file: "./agent-worker.log"          # Log file path (omit for stdout only)
```

Hook commands support variable interpolation:

| Variable | Value |
|---|---|
| `{id}` | Linear ticket identifier (e.g. `ENG-42`) |
| `{title}` | Slugified ticket title (e.g. `add-login-page`) |
| `{raw_title}` | Original ticket title, sanitized for shell safety (e.g. `Add login page`) |
| `{branch}` | Generated branch name (`agent/task-{id}`) |

## Usage

```bash
agent-worker --config ./agent-worker.yaml
```

The worker runs as a foreground process and handles SIGINT/SIGTERM for graceful shutdown.

## How it works

1. **Poll** — Watch Linear for tickets in the `ready` status on a configurable interval.
2. **Claim** — Transition the ticket to `in_progress` so no other worker picks it up.
3. **Pre-hooks** — Run deterministic setup commands in the repo directory (e.g. check out a fresh branch).
4. **Agent execution** — Hand the ticket to your configured agent harness. The agent reads the task description and does the work autonomously.
5. **Post-hooks** — Run deterministic verification commands (e.g. tests, linting, push).
6. **Report** — On success, mark the ticket `done`. On failure, mark it `failed` and post a comment with the failure details.

One ticket is processed at a time. After completion, the worker returns to polling.

## Development

```bash
bun install       # Install dependencies
bun test          # Run tests
bun run build     # Compile binary to dist/agent-worker
```

Cross-platform builds:

```bash
bun run build:darwin-arm64
bun run build:darwin-x64
bun run build:linux-x64
```

## License

MIT
