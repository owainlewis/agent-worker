# Architecture

## Overview
Agent Worker is a single-process CLI tool built in TypeScript, compiled to native binaries via `bun build --compile`. It follows a **poll-dispatch-update loop** pattern: poll Linear for ready tickets, dispatch work through a hook → Claude Code → hook pipeline, and update ticket status based on the outcome (per FR-01, FR-02, FR-10, FR-11).

The system has no server, no database, and no background threads. It is a sequential, single-ticket-at-a-time worker (per FR-03) designed for simplicity and predictability.

## System Design

```
┌─────────────────────────────────────────────────┐
│                  agent-worker                    │
│                                                  │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐  │
│  │  Poller  │──▶│ Scheduler │──▶│  Pipeline   │  │
│  └──────────┘   └───────────┘   │             │  │
│       │                         │ Pre-hooks   │  │
│       │                         │ Claude Code │  │
│       │                         │ Post-hooks  │  │
│       │                         └──────┬──────┘  │
│       │                                │         │
│  ┌────▼────────────────────────────────▼──────┐  │
│  │          Ticket Provider (interface)       │  │
│  │          └─ Linear Provider (default)      │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                          │
│  ┌────────────────────▼───────────────────────┐  │
│  │              Config / Logger                │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                        │
                        ▼
                   Linear API
```

## Components
<components>

### Config
- **Purpose**: Load, validate, and expose the YAML configuration and environment variables.
- **Responsibilities**:
  - Parse the YAML config file from disk
  - Validate all required fields are present and well-typed (project_id, statuses, repo path)
  - Read `LINEAR_API_KEY` from environment
  - Provide typed config object to all other components
  - Exit with a clear error message on invalid config (NFR-05)
- **Interface**: `loadConfig(path: string): Config` — called once at startup
- **Requirements satisfied**: FR-15, FR-16, NFR-05, NFR-08

### Logger
- **Purpose**: Structured logging to stdout and file.
- **Responsibilities**:
  - Write log lines with timestamp, level, and optional ticket identifier
  - Output to both stdout and a configurable log file
  - Redact the Linear API key if it appears in any log output
- **Interface**: `logger.info(msg, context?)`, `logger.error(msg, context?)`, `logger.debug(msg, context?)`
- **Requirements satisfied**: NFR-02, NFR-03, NFR-08

### Ticket Provider (Interface)
- **Purpose**: Abstract interface for issue tracker communication. Enables future support for Jira, GitHub Issues, etc.
- **Responsibilities**:
  - Define a common contract for fetching, transitioning, and commenting on tickets
- **Interface**:
  - `fetchReadyTickets(): Promise<Ticket[]>`
  - `transitionStatus(ticketId: string, status: string): Promise<void>`
  - `postComment(ticketId: string, body: string): Promise<void>`
- **Requirements satisfied**: FR-02, FR-04, FR-10, FR-11

### Linear Provider (implements Ticket Provider)
- **Purpose**: Linear-specific implementation of the Ticket Provider interface.
- **Responsibilities**:
  - Query tickets by project ID and status name via @linear/sdk
  - Transition ticket status (ready → in_progress, in_progress → done/failed)
  - Post comments on tickets (failure details)
  - Handle rate limiting with exponential backoff
- **Interface**: Implements `TicketProvider`
- **Requirements satisfied**: FR-02, FR-04, FR-10, FR-11, NFR-06

### Poller
- **Purpose**: Periodically check Linear for work.
- **Responsibilities**:
  - Run on a configurable interval (default 60s)
  - Call Linear Client to fetch ready tickets
  - Pass the first available ticket to the Scheduler
  - Do nothing if no tickets are ready
- **Interface**: `start(): void` — begins the polling loop, runs until SIGINT/SIGTERM
- **Requirements satisfied**: FR-01, FR-02, FR-03, FR-17

### Scheduler
- **Purpose**: Orchestrate the lifecycle of a single ticket.
- **Responsibilities**:
  - Receive a ticket from the Poller
  - Transition ticket to "In Progress" atomically before any work
  - Execute the Pipeline (pre-hooks → Claude Code → post-hooks)
  - Handle retries (0 to 3 attempts)
  - Transition ticket to "Done" or "Failed" based on outcome
  - Post error comment on failure
- **Interface**: `processTicket(ticket: Ticket): Promise<void>`
- **Requirements satisfied**: FR-04, FR-10, FR-11, FR-14, FR-18

### Pipeline
- **Purpose**: Execute the pre-hook → Claude Code → post-hook sequence for a single ticket.
- **Responsibilities**:
  - Run pre-hook commands sequentially; abort on first failure
  - Invoke Claude Code headless CLI with ticket title + description
  - Enforce Claude Code timeout
  - Run post-hook commands sequentially; abort on first failure
  - Interpolate variables (`{id}`, `{title}`, `{branch}`) into hook commands
- **Interface**: `execute(ticket: Ticket, config: Config): Promise<PipelineResult>`
- **Requirements satisfied**: FR-05, FR-06, FR-07, FR-08, FR-09, FR-12, FR-13

### Hook Runner
- **Purpose**: Execute a list of shell commands sequentially in a given working directory.
- **Responsibilities**:
  - Run each command via `Bun.spawn` (or `child_process`) in the configured repo directory
  - Capture stdout/stderr for logging
  - Return on first non-zero exit code with the failing command and output
  - Interpolate task variables before execution
- **Interface**: `runHooks(commands: string[], cwd: string, vars: TaskVars): Promise<HookResult>`
- **Requirements satisfied**: FR-05, FR-06, FR-08, FR-09, FR-12

### Claude Executor
- **Purpose**: Invoke Claude Code as a headless subprocess.
- **Responsibilities**:
  - Spawn `claude --task <prompt>` with the ticket title and description
  - Run in the configured repo directory
  - Enforce timeout via `AbortController` / process kill
  - Capture stdout/stderr for logging
  - Return success/failure + output
- **Interface**: `run(prompt: string, cwd: string, timeoutMs: number): Promise<ExecutorResult>`
- **Requirements satisfied**: FR-07, FR-13

</components>

## Data Flow

Step-by-step for a single ticket lifecycle:

1. **Startup**: `main()` calls `loadConfig()` to parse YAML + env vars. If invalid, exit with error. Initialize Logger and Linear Client.
2. **Poll**: Poller calls `linearClient.fetchReadyTickets()` filtered by project ID + configured "ready" status name. If empty, sleep for `poll_interval_seconds` and repeat.
3. **Claim**: Poller passes first ticket to Scheduler. Scheduler calls `linearClient.transitionStatus(ticket.id, "in_progress")` atomically. If this fails (e.g. ticket was already claimed), log and return to polling.
4. **Pre-hooks**: Pipeline calls `hookRunner.runHooks(config.hooks.pre, config.repo.path, vars)`. If any hook fails → jump to step 8 (failure).
5. **Claude Code**: Pipeline calls `claudeExecutor.run(prompt, config.repo.path, timeout)`. If timeout or non-zero exit → jump to step 8 (failure).
6. **Post-hooks**: Pipeline calls `hookRunner.runHooks(config.hooks.post, config.repo.path, vars)`. If any hook fails → jump to step 8 (failure).
7. **Success**: Scheduler calls `linearClient.transitionStatus(ticket.id, "done")`. Log success. Return to polling.
8. **Failure**: If retries remain, Scheduler loops back to step 4. If retries exhausted, Scheduler calls `linearClient.transitionStatus(ticket.id, "failed")` and `linearClient.postComment(ticket.id, errorDetails)`. Log failure. Return to polling.

## Key Technical Decisions
<decisions>

- **TypeScript + Bun compile**: Chosen over Go/Rust for contributor accessibility and ecosystem fit. Over Python for clean binary distribution. `bun build --compile` produces ~50-80MB self-contained binaries. — Alternatives: Go (better binaries, smaller ecosystem for Linear SDK), Rust (overkill for I/O-bound loop), Python (distribution pain).

- **Headless CLI over Agent SDK**: Claude Code is invoked as `claude --task "..."` subprocess, not via the Agent SDK. This keeps the worker language-agnostic, enables future support for other AI tools (Codex, Aider), and avoids coupling to Anthropic's Python SDK. — Alternative: Agent SDK (richer control, but locks to Python and Anthropic).

- **Provider abstraction for ticket sources**: The Linear Client implements a `TicketProvider` interface (`fetchReadyTickets`, `transitionStatus`, `postComment`). This keeps the core loop provider-agnostic and enables future Jira/GitHub Issues support without changing the Scheduler or Pipeline. — The interface is minimal (3 methods) to avoid speculative abstraction.

- **@linear/sdk for Linear provider**: The official Linear TypeScript SDK provides typed GraphQL queries, handles pagination, and is well-maintained. Using it directly rather than raw HTTP avoids reimplementing auth, pagination, and query building. — Alternative: Raw GraphQL (more control, more boilerplate).

- **YAML for configuration**: YAML is more readable than JSON for a config file with nested lists (hooks). Parsed with `yaml` npm package. — Alternative: JSON (noisier for lists), TOML (less familiar to JS developers).

- **Sequential single-ticket processing**: No concurrency, no job queue, no worker pool. One ticket at a time, in-process. This matches FR-03 and the explicit out-of-scope statement on parallel workers. Keeps the architecture trivially simple.

- **No persistent state**: The worker is stateless between poll cycles. It does not maintain a local database or checkpoint file. Linear is the single source of truth for ticket state. If the process dies, tickets remain "In Progress" and require manual triage (per FR-18).

- **Exponential backoff for rate limits**: Linear API rate limit responses (HTTP 429) trigger exponential backoff with jitter (starting at 1s, max 60s). This satisfies NFR-06 without external libraries.

</decisions>

## External Dependencies

| Dependency | Purpose | Version Constraint |
|---|---|---|
| `bun` | Runtime + compiler (`bun build --compile`) | >= 1.1 |
| `@linear/sdk` | Linear API client (typed GraphQL) | Latest stable |
| `yaml` | YAML config file parsing | ^2.x |
| `zod` | Config validation + type inference | ^3.x |
| `claude` CLI | Headless AI code execution (runtime dependency, not bundled) | User-installed |

No database. No Docker. No external services beyond Linear API.

## File & Folder Structure

```
agent-worker/
├── src/
│   ├── index.ts              # Entry point — parse args, load config, start poller
│   ├── config.ts             # Config loading, Zod schema, validation
│   ├── logger.ts             # Structured logger (stdout + file)
│   ├── providers/
│   │   ├── types.ts          # TicketProvider interface, Ticket type
│   │   └── linear.ts         # Linear SDK implementation of TicketProvider
│   ├── pipeline/
│   │   ├── pipeline.ts       # Pre-hooks → Claude → Post-hooks orchestration
│   │   ├── hook-runner.ts    # Sequential shell command executor
│   │   ├── claude-executor.ts# Claude Code subprocess invocation
│   │   └── interpolate.ts    # Variable substitution ({id}, {title}, {branch})
│   ├── scheduler.ts          # Ticket lifecycle: claim → pipeline → update
│   └── poller.ts             # Poll loop with interval + signal handling
├── test/
│   ├── config.test.ts
│   ├── interpolate.test.ts
│   ├── hook-runner.test.ts
│   ├── pipeline.test.ts
│   ├── scheduler.test.ts
│   └── poller.test.ts
├── agent-worker.example.yaml # Example configuration file
├── package.json
├── tsconfig.json
├── REQUIREMENTS.md
├── ARCHITECTURE.md
├── PLAN.md
├── LICENSE                   # MIT
└── README.md
```

## Configuration

Configuration is loaded from a YAML file whose path is passed as a CLI argument:

```bash
agent-worker --config ./agent-worker.yaml
```

**Schema** (validated with Zod at startup per NFR-05):

```yaml
linear:
  project_id: "PROJECT_UUID"        # required
  poll_interval_seconds: 60          # optional, default 60
  statuses:
    ready: "Todo"                    # required — status name to poll for
    in_progress: "In Progress"       # required — status to set on pickup
    done: "Done"                     # required — status to set on success
    failed: "Canceled"               # required — status to set on failure

repo:
  path: "/absolute/path/to/repo"    # required

hooks:
  pre:                               # optional, default []
    - "git checkout main"
    - "git pull origin main"
    - "git checkout -b agent/task-{id}"
  post:                              # optional, default []
    - "bun run lint"
    - "bun run test"
    - "git add -A"
    - "git commit -m 'feat: {title}'"
    - "git push origin agent/task-{id}"

claude:
  timeout_seconds: 300               # optional, default 300
  retries: 0                         # optional, default 0, max 3

log:
  file: "./agent-worker.log"         # optional, default no file logging
```

**Environment variables**:
- `LINEAR_API_KEY` (required) — Linear API personal access token

## Error Handling Strategy

Errors are categorized by source and handled at the Scheduler level:

| Error Source | Behavior | Ticket Update |
|---|---|---|
| Config validation failure | Exit process with error message | N/A (startup) |
| Linear API error (non-rate-limit) | Log error, skip ticket, return to polling | No change |
| Linear API rate limit (429) | Exponential backoff (1s → 60s max), retry | No change |
| Linear status transition conflict | Log warning, skip ticket (already claimed) | No change |
| Pre-hook failure (non-zero exit) | Abort pipeline, no Claude invocation | → Failed + comment |
| Claude Code non-zero exit | Abort pipeline, no post-hooks | → Failed + comment (retry if configured) |
| Claude Code timeout | Kill process, abort pipeline | → Failed + comment (retry if configured) |
| Post-hook failure (non-zero exit) | Abort remaining hooks | → Failed + comment |
| Unhandled exception in worker | Log, skip ticket, continue polling | Ticket stays In Progress |

**Failure comments** include: which stage failed (pre-hook/claude/post-hook), the specific command that failed, exit code, and last 50 lines of stdout/stderr.

## Observability

**Log levels**: `debug`, `info`, `warn`, `error`

| Event | Level | Context |
|---|---|---|
| Worker started | info | config path, project ID |
| Poll cycle (no tickets) | debug | — |
| Ticket picked up | info | ticket ID, title |
| Status transition | info | ticket ID, from → to |
| Pre-hook running | info | ticket ID, command |
| Pre-hook output | debug | ticket ID, stdout/stderr |
| Claude Code started | info | ticket ID, timeout |
| Claude Code output | debug | ticket ID, stdout (truncated) |
| Post-hook running | info | ticket ID, command |
| Post-hook output | debug | ticket ID, stdout/stderr |
| Ticket completed | info | ticket ID, duration |
| Ticket failed | error | ticket ID, stage, error |
| Rate limit hit | warn | retry delay |
| Worker shutdown | info | signal received |

Default level is `info`. Future: configurable via CLI flag.

## Security Considerations

- **API key handling**: `LINEAR_API_KEY` is read from environment only (FR-15). It is never logged (NFR-08) — the logger redacts any string matching the key value.
- **Shell injection in hooks**: Hook commands are defined in the config file by the user who runs the tool. Variable interpolation (`{id}`, `{title}`, `{branch}`) sanitizes values: `{title}` is slugified (alphanumeric + hyphens only), `{id}` is alphanumeric, `{branch}` is derived from `{id}`. No user-generated input from Linear ticket content is interpolated into shell commands — only the ticket ID and a sanitized title.
- **Claude Code prompt**: The ticket title and description are passed as a string argument to `claude --task`. This is not shell-interpolated — it is passed programmatically via spawn args, avoiding injection.
- **File system access**: The worker only operates in the configured `repo.path` directory. Hooks run with the same permissions as the worker process.

## Testing Strategy

**Unit tests** (all pure logic, no I/O):
- `config.test.ts` — Valid configs parse correctly, invalid configs produce clear errors, env var reading
- `interpolate.test.ts` — Variable substitution, slugification, edge cases (special characters in title)
- `hook-runner.test.ts` — Sequential execution, first-failure-aborts, variable interpolation, output capture
- `pipeline.test.ts` — Full pipeline flow with mocked hook-runner and claude-executor
- `scheduler.test.ts` — Retry logic, status transitions, failure comment posting

**Integration tests** (mocked Linear API, real subprocess):
- `poller.test.ts` — Poll cycle with mock Linear client, signal handling

**Manual e2e** (documented in README):
- Run against a real Linear project with test tickets
- Verify full lifecycle: pickup → hooks → Claude → status update

Test runner: `bun test`. Tests use Bun's built-in test runner and mock facilities.

## Assumptions
- [ASSUMED] `claude` CLI supports `--task` flag for headless invocation and returns exit code 0 on success.
- [ASSUMED] Linear's GraphQL API allows filtering issues by project ID and workflow state name in a single query.
- [ASSUMED] `bun build --compile` produces stable, production-ready binaries for the target platforms.
- [ASSUMED] The user's shell environment (PATH, env vars) is inherited by spawned hook subprocesses.

## Open Questions
- [TBD] **CLI argument parsing** — Use a library (e.g. `commander`, `yargs`) or hand-roll minimal arg parsing? Given the tool has exactly one flag (`--config`), hand-rolling is likely sufficient.
