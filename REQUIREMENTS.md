# Requirements

## Overview
Agent Worker is an open-source CLI tool that polls Linear for tickets, dispatches them to Claude Code for autonomous implementation, and runs configurable shell hooks before and after each task. It runs as a persistent local process and updates ticket status based on outcomes.

## Problem Statement
Developers waste time on repetitive, well-scoped tickets that an AI agent could handle autonomously. Today there is no lightweight, self-hosted tool that bridges a Linear backlog to Claude Code with proper lifecycle management (branch creation, testing, pushing). Without this, teams must manually copy ticket descriptions into Claude Code, run setup/teardown steps by hand, and update ticket status themselves.

## Users
- **Primary**: Individual developers and small engineering teams who use Linear and Claude Code and want to automate well-scoped tickets.
- **Secondary**: Open-source contributors who want to extend or adapt the tool for their own workflows.

## Functional Requirements
<requirements>
- FR-01: The worker runs as a persistent loop on a local machine, polling Linear at a configurable interval (default 60 seconds).
- FR-02: The worker queries Linear for tickets in a configured project that have a configurable "ready" status (e.g. "Todo", "Ready"). No label is required.
- FR-03: The worker picks up one ticket at a time. Ticket selection is arbitrary (first returned by the API).
- FR-04: When a ticket is picked up, the worker atomically transitions it to "In Progress" before any other processing.
- FR-05: Before dispatching to Claude Code, the worker executes an ordered list of pre-hook shell commands sequentially in the configured repo directory.
- FR-06: If any pre-hook command exits with a non-zero code, the task is marked failed and Claude Code is not invoked.
- FR-07: The worker dispatches the ticket title and description to Claude Code for execution.
- FR-08: After Claude Code completes successfully, the worker executes an ordered list of post-hook shell commands sequentially in the configured repo directory.
- FR-09: If any post-hook command exits with a non-zero code, the task is marked failed.
- FR-10: On success (Claude Code + all post-hooks pass), the worker transitions the ticket to "Done".
- FR-11: On failure (pre-hook, Claude Code, post-hook, or timeout), the worker transitions the ticket to "Failed" and posts the error message as a comment on the ticket.
- FR-12: Hook commands support variable interpolation: `{id}` (Linear ticket identifier), `{title}` (slugified ticket title), `{branch}` (generated branch name in the form `agent/task-{id}`).
- FR-13: Claude Code execution has a configurable timeout (default 300 seconds). Exceeding the timeout is treated as a failure.
- FR-14: Task retries are configurable from 0 (default) to 3. When retries are exhausted, the ticket is marked failed.
- FR-15: The worker reads its Linear API key from the `LINEAR_API_KEY` environment variable.
- FR-16: The worker accepts a single configuration file (YAML) defining: project ID, status names (ready, in_progress, done, failed), poll interval, repo path, pre-hooks, post-hooks, Claude Code timeout, and retry count.
- FR-17: The worker runs continuously until manually stopped (e.g. Ctrl-C / SIGINT / SIGTERM).
- FR-18: If the worker process crashes mid-task, the ticket remains in "In Progress" (no cleanup attempt).
</requirements>

## Non-Functional Requirements
<nfr>
- NFR-01: The tool must produce native binaries for macOS (arm64, x86_64) and Linux (x86_64).
- NFR-02: The worker must log all activity to both stdout and a configurable log file.
- NFR-03: Log output must include timestamps, log level, and ticket identifier (when applicable).
- NFR-04: The tool must be open-source under the MIT license.
- NFR-05: The worker must validate the configuration file on startup and exit with a clear error message if it is invalid.
- NFR-06: The worker must handle Linear API rate limits by backing off and retrying without crashing.
- NFR-07: The tool must be installable via a single command (e.g. `curl | sh`, Homebrew, or binary download).
- NFR-08: The worker must not store or log the Linear API key in plain text in log files.
</nfr>

## Out of Scope
- GitHub/GitLab PR creation — handled by post-hooks or manually.
- Multiple parallel workers processing tickets concurrently.
- Remote/VPS deployment or hosted service mode.
- Web UI or dashboard.
- Automatic conflict resolution or merge handling.

**Planned for future versions:**
- Alternative issue tracker providers (Jira, GitHub Issues, Shortcut) behind a provider interface.
- Alternative AI coding tools (Codex, Aider) behind an executor interface.

## Success Metrics
1. A user can run the binary, create a Linear ticket in the configured project with the "ready" status, and observe the full lifecycle (pickup → pre-hooks → Claude Code → post-hooks → status update) without manual intervention.
2. Failed tasks produce a comment on the Linear ticket with enough detail to diagnose the failure.
3. The worker runs for 24+ hours without crashing or leaking resources under normal conditions (steady ticket flow).

## Assumptions
- [ASSUMED] The user has Claude Code installed and available on PATH (the tool does not install or manage Claude Code itself).
- [ASSUMED] The configured repo directory already exists and is a valid git repository.
- [ASSUMED] The Linear workspace has workflow statuses that the user can map via config (e.g. "Ready" → pickup, "In Progress" → working, "Done" → complete, "Failed" → error).
- [ASSUMED] Only one instance of the worker runs against a given team/project at a time — no distributed locking is needed.
- [ASSUMED] Pre-hooks and post-hooks have access to the same shell environment as the worker process.

## Decisions
- **Implementation language** — TypeScript, compiled to native binaries via `bun build --compile` (macOS arm64/x86_64, Linux x86_64). Chosen for contributor accessibility, ecosystem fit (@linear/sdk, YAML parsing), and single-binary distribution without a runtime dependency.
- **Claude Code invocation method** — Headless CLI (`claude --task "..."`). Subprocess boundary keeps the worker simple, decouples from Anthropic-specific SDKs, and makes it trivial to swap in alternative AI coding tools later (Codex, Aider, etc.).

## Open Questions
None — all blocking decisions resolved.
