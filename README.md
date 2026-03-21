# agent-worker

An autonomous worker agent that picks up tasks from your issue tracker and completes them — without you in the loop.

![Agent Worker Demo](assets/demo.png)

## Thesis

The way to scale with AI agents is to get out of the loop. Stop babysitting. Stop copy-pasting tickets into chat windows. Define the work, assign it to the agent, and walk away.

**agent-worker** is a polling-based worker that watches your issue tracker for assigned tasks, claims them, executes an agent harness to do the work, reports results back, and monitors PRs for review feedback. You stay out of the loop entirely.

### Why polling?

Webhook-based agent orchestrators require you to expose ports and endpoints to the internet. That's a security surface you don't need. The polling pattern is simpler and more secure — your agent reaches out on its own schedule, nothing reaches in. This scales from a single agent on your laptop to hundreds of workers across many repos and projects without any additional infrastructure.

### Hooks: deterministic guardrails around non-deterministic agents

Agents are powerful but non-deterministic. Pre and post hooks let you wrap agent execution with deterministic, auditable steps — checking out a branch, running tests, linting, pushing code. The agent does the creative work; hooks enforce the process.

### Agent-harness agnostic

agent-worker is not tied to a single agent. It supports any agent harness that can accept a prompt and return a result. Currently supported:

- **Claude Code** — Anthropic's CLI agent
- **Codex** — OpenAI's CLI agent
- **OpenCode** — open-source terminal-based coding agent
- **Pi** — the Pi coding agent harness

Adding a new harness is a single file implementing the executor interface.

### Feedback loop

After the agent creates a PR, agent-worker monitors the PR for review comments prefixed with `/agent` (configurable). When actionable feedback is found, the agent re-runs on the existing branch to address it, then pushes the changes. This closes the loop without human intervention.

## Prerequisites

- [Bun](https://bun.sh) 1.0+
- An agent harness installed and authenticated (Claude Code, Codex, OpenCode, or Pi)
- A ticket provider account with an API key:
  - **Linear** — personal API key
  - **Jira** — username + API token
  - **Plane** — personal API key
- An SCM token for PR creation:
  - **GitHub** — `GITHUB_TOKEN`
  - **Bitbucket Server** — `BITBUCKET_TOKEN`

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

### Configuration reference

```yaml
# --- Provider (required) ---
# Choose one: linear, jira, or plane
provider:
  type: linear                          # Provider type (required)

  # Linear-specific fields
  project_id: "your-project-uuid"       # Linear project UUID (required for linear)
  poll_interval_seconds: 60             # How often to check for new tickets (default: 60)

  # Status names must match your provider's workflow exactly
  statuses:
    ready: "Todo"                       # Status that marks a ticket ready for pickup
    in_progress: "In Progress"          # Status set when the agent claims a ticket
    code_review: "Code Review"          # Status set after the agent creates a PR
    verification: "Verification"        # Status set after the PR is merged (terminal)
    failed: "Canceled"                  # Status set on failure

  # --- Jira example ---
  # type: jira
  # base_url: "https://jira.example.com"
  # poll_interval_seconds: 60
  # jql: "project = FOO AND status = 'Todo' AND assignee = currentUser()"
  # statuses:
  #   ready: "Todo"
  #   in_progress: "In Progress"
  #   code_review: "Code Review"
  #   verification: "Verification"
  #   failed: "Canceled"

  # --- Plane example ---
  # type: plane
  # base_url: "https://plane.example.com"
  # workspace_slug: "my-workspace"
  # project_id: "your-project-uuid-here"
  # poll_interval_seconds: 60
  # query: "state_group: backlog"
  # statuses:
  #   ready: "Backlog"
  #   in_progress: "In Progress"
  #   code_review: "Code Review"
  #   verification: "Verification"
  #   failed: "Canceled"

# --- SCM (required) ---
# Source control platform where PRs are created
# Choose one: github or bitbucket_server
scm:
  type: github
  owner: "your-github-org"
  repo: "your-repo"

  # --- Bitbucket Server example ---
  # type: bitbucket_server
  # base_url: "https://bitbucket.example.com"
  # project: "PROJ"
  # repo: "myrepo"

# --- Repository (required) ---
repo:
  path: "/path/to/your/repo"            # Absolute path to the working repository

# --- Hooks (optional) ---
hooks:
  pre: []                               # Commands to run before the agent (optional)

  post:                                 # Commands to run after the agent succeeds (optional)
    - "git add -A"
    - "git commit -m '{id}: {raw_title}'"
    - "git push origin {branch}"
    - "gh pr create --title '{id}: {raw_title}' --body 'Fixes {id}. Implemented by Agent Worker.' --base main"

# --- Executor (optional) ---
executor:
  type: claude                          # Agent harness: claude, codex, opencode, or pi (default: claude)
  timeout_seconds: 300                  # Max time for the agent to complete (default: 300)
  retries: 0                            # Retry attempts on failure, 0–3 (default: 0)

# --- Feedback (optional) ---
feedback:
  comment_prefix: "/agent"              # Comment prefix that triggers agent re-runs (default: "/agent")
  poll_interval_seconds: 120            # How often to check for review comments (default: 120)

# --- Logging (optional) ---
log:
  file: "./agent-worker.log"            # Log file path (omit for stdout only)
  level: info                           # Log level: debug, info, warn, error (default: info)
  redact: []                            # Sensitive strings to redact from log output
```

### Environment variables

| Variable | Provider | Description |
|---|---|---|
| `LINEAR_API_KEY` | Linear | Your Linear personal API key |
| `JIRA_USERNAME` | Jira | Your Jira username |
| `JIRA_API_TOKEN` | Jira | Your Jira API token |
| `PLANE_API_KEY` | Plane | Your Plane API key |
| `GITHUB_TOKEN` | SCM (GitHub) | GitHub personal access token with repo scope |
| `BITBUCKET_TOKEN` | SCM (Bitbucket Server) | Bitbucket Server personal access token |

### Hook variable interpolation

Hook commands support the following variables:

| Variable | Value |
|---|---|
| `{id}` | Ticket identifier (e.g. `ENG-42`) |
| `{title}` | Slugified ticket title (e.g. `add-login-page`) |
| `{raw_title}` | Original ticket title, sanitized for shell safety (e.g. `Add login page`) |
| `{branch}` | Generated branch name (`agent/task-{id}`) |
| `{worktree}` | Absolute path to the worktree directory |
| `{date}` | Current date in `YYYY-MM-DD` format |

## Usage

```bash
agent-worker --config ./agent-worker.yaml
```

Additional flags:

```bash
agent-worker --config ./agent-worker.yaml --debug    # Enable debug-level logging
agent-worker --version                                # Print version and exit
```

The worker runs as a foreground process and handles `SIGINT`/`SIGTERM` for graceful shutdown.

## How it works

### Ticket lifecycle

1. **Ready** — ticket appears in the provider's ready queue (e.g. `Todo` in Linear).
2. **In Progress** — the agent claims the ticket by transitioning its status. An isolated git worktree is created on a fresh branch (`agent/task-{id}`).
3. **Code Review** — the agent succeeds, post-hooks run (commit, push, create PR), and the ticket transitions to `code_review`.
4. **Verification** — the PR is merged. The feedback poller detects the merge and transitions the ticket.
5. **Failed** — the agent or pipeline failed after all retries. A structured error comment is posted to the ticket.

### Pipeline stages

One ticket is processed at a time:

1. **Poll** — Watch the provider for tickets in the `ready` status on a configurable interval.
2. **Claim** — Transition the ticket to `in_progress` so no other worker picks it up.
3. **Worktree isolation** — For executors that set `needsWorktree: true` (Claude), the pipeline creates an isolated git worktree for the ticket on a fresh branch (`agent/task-{id}`). Each ticket's work is fully isolated from the main repo and from other in-flight tickets.
4. **Pre-hooks** — Run deterministic setup commands in the worktree directory (optional).
5. **Agent execution** — Hand the ticket to your configured agent harness. The agent reads the task description and does the work autonomously.
6. **Post-hooks** — Run deterministic verification commands (e.g. commit, push, open PR).
7. **Report** — On success, mark the ticket `code_review` and post a comment with the last 50 lines of output. On failure, mark it `failed` and post a structured error comment.

### Feedback loop

After a PR is created, a second poller runs concurrently that:

- Discovers PRs for tickets in `code_review` status
- Checks whether PRs have been merged (transitions ticket to `verification`)
- Fetches actionable PR and ticket comments prefixed with `/agent`
- Re-runs the executor on the existing branch to address feedback
- Posts results back to the ticket

### Running multiple agents in parallel

Because each ticket gets its own isolated worktree and branch, you can safely run multiple agent-worker processes pointing at the same repository:

```bash
# Terminal 1
agent-worker --config ./agent-worker.yaml

# Terminal 2
agent-worker --config ./agent-worker.yaml
```

Each process claims different tickets (the `in_progress` status transition acts as a distributed lock) and works in a separate worktree, so there are no conflicts.

## Git worktree isolation

When using the **Claude** executor, the pipeline automatically creates a dedicated git worktree for each ticket before invoking the agent:

- A new branch `agent/task-{id}` is created from the current `HEAD` of the main repo.
- The agent runs inside that worktree, so its changes are fully isolated.
- Multiple agent-worker processes can run against the same repository in parallel without conflicting.

Because branch creation is handled automatically, **pre-hooks no longer need `git checkout` or branch commands** when using Claude:

```yaml
# Claude executor — worktree is created automatically
hooks:
  pre: []
  post:
    - "git add -A"
    - "git commit -m '{id}: {raw_title}'"
    - "git push origin {branch}"
    - "gh pr create --title '{id}: {raw_title}' --body 'Fixes {id}.' --base main"
```

**Codex** and **OpenCode** manage their own worktrees internally, so the pipeline skips automatic worktree creation; hooks run in the original repo path.

This behaviour is controlled by the `needsWorktree` flag on the `CodeExecutor` interface (`src/pipeline/executor.ts`). Set it to `true` in a custom executor to opt in to automatic worktree isolation, or `false` to manage isolation yourself.

## Executor details

### Claude Code

Invokes [Claude Code](https://docs.anthropic.com/claude/docs/claude-code) as a headless subprocess:

```
claude --print --dangerously-skip-permissions -p "<ticket prompt>"
```

- `--print` — non-interactive mode; Claude reads the prompt, does the work, and exits.
- `--dangerously-skip-permissions` — suppresses interactive permission prompts so the agent can run fully autonomously.
- `-p` — passes the ticket title and description as the initial prompt.

Streams stdout and stderr to the log in real time. Returns success if the process exits with code `0`.

### Codex

Invokes OpenAI's Codex CLI as a headless subprocess.

### OpenCode

Invokes the open-source OpenCode terminal-based coding agent.

### Pi

Invokes the Pi coding agent harness.

### Timeout and retry configuration

Control how long the agent is allowed to run and how many times to retry on failure:

```yaml
executor:
  type: claude
  timeout_seconds: 300   # Kill the agent if it hasn't finished within this many seconds
  retries: 0             # Retry the full pipeline on non-zero exit or timeout (0–3)
```

If `timeout_seconds` is exceeded the process is killed and the ticket is marked failed. If `retries` is greater than `0`, the full pipeline (pre-hooks → agent → post-hooks) is retried up to that many times before giving up.

### AGENTS.md — project-specific instructions

Coding agents read an `AGENTS.md` file from the root of the worktree if one exists. Use this file to give the agent project-specific context:

```markdown
# My Project

## Stack
- Runtime: Bun
- Language: TypeScript
- Testing: `bun test`

## Conventions
- No classes — use plain functions and interfaces
- All API routes under /api/v1/
```

Place `AGENTS.md` in the root of your repository. It is checked in alongside your code and is inherited by every worktree the agent runs in.

## Debug mode

Pass `--debug` to enable debug-level logging (overrides `log.level` in config):

```bash
agent-worker --config config.yaml --debug
```

Additional debug output includes:
- Provider and SCM API calls with status codes and durations
- Rate limit retry attempts
- Data counts (tickets fetched, comments retrieved, etc.)
- Component-scoped tags (e.g. `[provider:linear]`, `[scm:github]`)

Alternatively, set `log.level: debug` in the config file:

```yaml
log:
  level: debug
  file: /tmp/agent-worker-debug.log
  redact:
    - lin_api_secret_key_12345
```

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

## CI

This project uses [Drone CI](docs/drone-ci.md). Type checking and tests run on pull requests. Cross-platform binaries are built on pushes to `main`.

## License

MIT
