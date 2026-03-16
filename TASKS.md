# Implementation Plan

## Summary
- Total phases: 5
- Total tasks: 16
- Estimated complexity: Medium

---

## Phase 1: Project Scaffold & CLI Entry Point
**Goal**: `bun run src/index.ts --config agent-worker.example.yaml` starts, validates config, prints a startup log line, then exits cleanly on Ctrl-C. No Linear calls, no pipeline — just proof the skeleton runs.
**Requirements covered**: FR-15, FR-16, FR-17, NFR-02, NFR-03, NFR-05, NFR-08

<task id="1.1">
  <title>Initialize Bun project with dependencies</title>
  <context>
    This is a TypeScript project using Bun as runtime and compiler. Dependencies: @linear/sdk, yaml (^2.x), zod (^3.x). Dev dependencies: @types/bun. The project uses `bun test` for testing. The repo already has PLAN.md, REQUIREMENTS.md, ARCHITECTURE.md — do not overwrite those.
  </context>
  <files>
    - package.json
    - tsconfig.json
    - LICENSE
    - agent-worker.example.yaml
  </files>
  <action>
    1. Run `bun init` to create package.json (name: "agent-worker", type: "module").
    2. Run `bun add @linear/sdk yaml zod` and `bun add -d @types/bun`.
    3. Create tsconfig.json: strict mode, ESNext target, moduleResolution: bundler, outDir: dist, rootDir: src.
    4. Create LICENSE with MIT text (year 2026, "Agent Worker Contributors").
    5. Create agent-worker.example.yaml with the full config schema from ARCHITECTURE.md (linear.project_id, statuses, repo.path, hooks.pre/post, claude.timeout_seconds, claude.retries, log.file) using placeholder values and comments explaining each field.
  </action>
  <verify>
    Run `bun run src/index.ts` — should fail with "Cannot find module" (src/index.ts doesn't exist yet), confirming Bun and deps are set up. Run `bun test` — should report 0 tests.
  </verify>
  <depends_on></depends_on>
</task>

<task id="1.2">
  <title>Implement config loading and validation</title>
  <context>
    Config is a YAML file parsed with the `yaml` package and validated with Zod. Required fields: linear.project_id, linear.statuses (ready, in_progress, done, failed), repo.path. Optional with defaults: linear.poll_interval_seconds (60), hooks.pre ([]), hooks.post ([]), claude.timeout_seconds (300), claude.retries (0, max 3), log.file (undefined). The LINEAR_API_KEY is read from process.env and must be present. On validation failure, the process exits with a clear error message (NFR-05). The API key must never be logged (NFR-08).
  </context>
  <files>
    - src/config.ts
    - test/config.test.ts
  </files>
  <action>
    1. Define a Zod schema `ConfigSchema` matching the YAML structure. Use `z.object` with nested objects for linear, repo, hooks, claude, log sections. Apply `.default()` for optional fields.
    2. Export a `loadConfig(filePath: string): Config` function that: reads the file with `Bun.file().text()`, parses YAML with `yaml.parse()`, validates with `ConfigSchema.parse()`, reads `LINEAR_API_KEY` from `process.env`, throws if missing.
    3. Export the inferred `Config` type via `z.infer<typeof ConfigSchema>` plus the apiKey field.
    4. Write tests: valid config parses correctly, missing required fields produce ZodError, defaults are applied, missing LINEAR_API_KEY throws, retries > 3 rejected.
  </action>
  <verify>
    Run `bun test test/config.test.ts` — all tests pass.
  </verify>
  <depends_on>1.1</depends_on>
</task>

<task id="1.3">
  <title>Implement structured logger</title>
  <context>
    The logger writes JSON-structured lines to stdout and optionally to a file. Each line includes: timestamp (ISO 8601), level (debug/info/warn/error), message, and optional context object (e.g. ticketId). The logger must redact any occurrence of the LINEAR_API_KEY value in log output — compare against a redaction list set at initialization. Default level is info. The logger is a plain object with methods, not a class.
  </context>
  <files>
    - src/logger.ts
    - test/logger.test.ts
  </files>
  <action>
    1. Export `createLogger(options: { level?: string, filePath?: string, redact?: string[] }): Logger`.
    2. Logger has methods: `debug(msg, ctx?)`, `info(msg, ctx?)`, `warn(msg, ctx?)`, `error(msg, ctx?)`.
    3. Each method formats a JSON line: `{ timestamp, level, message, ...ctx }`. Before writing, scan the serialized string for any value in `redact` array and replace with `[REDACTED]`.
    4. Write to stdout via `console.log`. If `filePath` is set, also append to that file using `Bun.file().writer()`.
    5. Level filtering: debug < info < warn < error. Only log if message level >= configured level.
    6. Write tests: log line format is correct JSON, redaction works, level filtering works, context fields appear in output.
  </action>
  <verify>
    Run `bun test test/logger.test.ts` — all tests pass.
  </verify>
  <depends_on>1.1</depends_on>
</task>

<task id="1.4">
  <title>Wire up CLI entry point with config + logger + signal handling</title>
  <context>
    src/index.ts is the entry point. It parses a single CLI arg `--config <path>`, calls `loadConfig()`, creates the logger, logs "Agent Worker started" with the project ID, then enters an idle loop (placeholder for poller). On SIGINT/SIGTERM, it logs "Shutting down" and exits cleanly with code 0. No Linear calls yet — just config + logger + graceful shutdown.
  </context>
  <files>
    - src/index.ts
  </files>
  <action>
    1. Parse `process.argv` for `--config` flag. If missing, print usage ("Usage: agent-worker --config <path>") and exit 1.
    2. Call `loadConfig(configPath)` in a try/catch. On error, print the validation error message to stderr and exit 1.
    3. Call `createLogger({ level: "info", filePath: config.log?.file, redact: [config.apiKey] })`.
    4. Log `info` "Agent Worker started" with `{ projectId: config.linear.project_id }`.
    5. Register `process.on("SIGINT")` and `process.on("SIGTERM")` handlers that log "Shutting down" and call `process.exit(0)`.
    6. Start a placeholder interval (`setInterval(() => {}, config.linear.poll_interval_seconds * 1000)`) to keep the process alive. This will be replaced by the Poller in Phase 2.
  </action>
  <verify>
    Run `LINEAR_API_KEY=test-key bun run src/index.ts --config agent-worker.example.yaml` — should print a JSON log line with "Agent Worker started". Press Ctrl-C — should print "Shutting down" and exit. Run without --config — should print usage and exit 1. Run with invalid YAML — should print validation error and exit 1.
  </verify>
  <depends_on>1.2, 1.3</depends_on>
</task>

---

## Phase 2: Ticket Provider & Polling Loop
**Goal**: The worker polls Linear for real tickets and logs when it finds one. No pipeline execution yet — just fetch and log.
**Requirements covered**: FR-01, FR-02, FR-03, FR-04, NFR-06

<task id="2.1">
  <title>Define TicketProvider interface and Ticket type</title>
  <context>
    The TicketProvider is a TypeScript interface that abstracts issue tracker communication. It has 3 methods: fetchReadyTickets() returns Ticket[], transitionStatus(ticketId, statusName) returns void, postComment(ticketId, body) returns void. The Ticket type has: id (string), identifier (string, e.g. "ENG-123"), title (string), description (string | undefined). This interface enables future providers (Jira, GitHub Issues) without changing the core loop.
  </context>
  <files>
    - src/providers/types.ts
  </files>
  <action>
    1. Export `interface Ticket { id: string; identifier: string; title: string; description: string | undefined; }`.
    2. Export `interface TicketProvider { fetchReadyTickets(): Promise<Ticket[]>; transitionStatus(ticketId: string, statusName: string): Promise<void>; postComment(ticketId: string, body: string): Promise<void>; }`.
  </action>
  <verify>
    Run `bun run src/providers/types.ts` — should compile with no errors and no output (types only).
  </verify>
  <depends_on>1.1</depends_on>
</task>

<task id="2.2">
  <title>Implement Linear provider</title>
  <context>
    The Linear provider implements the TicketProvider interface using @linear/sdk. It is constructed with: apiKey, projectId, and a statuses map ({ ready, in_progress, done, failed } — all status name strings). fetchReadyTickets() queries Linear for issues in the project with the "ready" status name, returning the first page. transitionStatus() finds the workflow state by name on the issue's team and updates the issue. postComment() creates a comment on the issue. Rate limiting (HTTP 429) is handled with exponential backoff: start at 1s, double each retry, max 60s, add random jitter 0-500ms.
  </context>
  <files>
    - src/providers/linear.ts
  </files>
  <action>
    1. Export `createLinearProvider(options: { apiKey: string, projectId: string, statuses: StatusMap }): TicketProvider`.
    2. Inside, instantiate `new LinearClient({ apiKey })` from @linear/sdk.
    3. `fetchReadyTickets()`: Use `client.issues({ filter: { project: { id: { eq: projectId } }, state: { name: { eq: statuses.ready } } } })`. Map results to `Ticket[]`.
    4. `transitionStatus(ticketId, statusName)`: Fetch the issue to get its team, then fetch `team.states()` to find the state ID matching `statusName`. Call `client.issueUpdate(ticketId, { stateId })`.
    5. `postComment(ticketId, body)`: Call `client.commentCreate({ issueId: ticketId, body })`.
    6. Wrap all API calls in a retry helper that catches rate limit errors (check for 429 status or "ratelimited" in error message), waits with exponential backoff (1s base, 2x multiplier, 60s cap, random jitter 0-500ms), and retries up to 5 times.
  </action>
  <verify>
    File compiles: `bun build src/providers/linear.ts --outdir /tmp/check` succeeds with no type errors.
  </verify>
  <depends_on>2.1</depends_on>
</task>

<task id="2.3">
  <title>Implement poller and wire into entry point</title>
  <context>
    The Poller runs a loop: call provider.fetchReadyTickets(), if a ticket is found log it and call a callback, then wait poll_interval_seconds before polling again. If no tickets, log at debug level and wait. The poller must be stoppable — it checks an `isRunning` flag that is set to false on SIGINT/SIGTERM. The callback for now just logs the ticket; the Scheduler will be wired in Phase 3. The poller should not crash if the provider throws — log the error and continue to the next cycle.
  </context>
  <files>
    - src/poller.ts
    - src/index.ts
  </files>
  <action>
    1. Export `createPoller(options: { provider: TicketProvider, intervalMs: number, logger: Logger, onTicket: (ticket: Ticket) => Promise<void> }): { start: () => Promise<void>, stop: () => void }`.
    2. `start()`: Set `isRunning = true`. Enter a while loop: if `!isRunning` break. Try `fetchReadyTickets()`, if results exist call `onTicket(results[0])`, else log debug "No tickets found". Catch errors and log them at error level without crashing. Await `sleep(intervalMs)` (use `Bun.sleep` or `new Promise(resolve => setTimeout(resolve, ms))`).
    3. `stop()`: Set `isRunning = false`.
    4. Update src/index.ts: remove the placeholder setInterval. Create the Linear provider with `createLinearProvider()`. Create the poller with `createPoller()`, passing a temporary `onTicket` that logs `info` "Ticket found" with `{ ticketId, title }`. Call `poller.start()`. In SIGINT/SIGTERM handlers, call `poller.stop()` before exiting.
  </action>
  <verify>
    Run `LINEAR_API_KEY=<real-key> bun run src/index.ts --config agent-worker.example.yaml` (with a real Linear project that has a "Todo" ticket). Should see "Ticket found" log lines. With no tickets, should see debug-level "No tickets found" (visible if you temporarily set level to debug). Ctrl-C stops cleanly.
  </verify>
  <depends_on>1.4, 2.2</depends_on>
</task>

---

## Phase 3: Pipeline Execution
**Goal**: When a ticket is found, the full pipeline runs: pre-hooks → Claude Code → post-hooks. Ticket status is updated. This is the core feature.
**Requirements covered**: FR-04, FR-05, FR-06, FR-07, FR-08, FR-09, FR-10, FR-11, FR-12, FR-13

<task id="3.1">
  <title>Implement variable interpolation</title>
  <context>
    Hook commands support variable substitution: {id} is the Linear ticket identifier (e.g. "ENG-123"), {title} is the ticket title slugified to lowercase alphanumeric + hyphens (e.g. "Fix login bug" → "fix-login-bug"), {branch} is "agent/task-{id}" (e.g. "agent/task-ENG-123"). The interpolation function takes a command string and a vars object and returns the substituted string. Slugification must strip all non-alphanumeric characters except hyphens, collapse multiple hyphens, and trim leading/trailing hyphens.
  </context>
  <files>
    - src/pipeline/interpolate.ts
    - test/interpolate.test.ts
  </files>
  <action>
    1. Export `slugify(text: string): string` — lowercase, replace non-alphanumeric with hyphens, collapse multiples, trim edges.
    2. Export `type TaskVars = { id: string; title: string; branch: string; }`.
    3. Export `buildTaskVars(ticket: Ticket): TaskVars` — sets id to `ticket.identifier`, title to `slugify(ticket.title)`, branch to `agent/task-${ticket.identifier}`.
    4. Export `interpolate(template: string, vars: TaskVars): string` — replace all occurrences of `{id}`, `{title}`, `{branch}` with corresponding values.
    5. Tests: basic substitution, slugify with special chars ("Hello, World! #123" → "hello-world-123"), slugify with leading/trailing hyphens, multiple variables in one string, no-op when no variables present, empty title.
  </action>
  <verify>
    Run `bun test test/interpolate.test.ts` — all tests pass.
  </verify>
  <depends_on>1.1</depends_on>
</task>

<task id="3.2">
  <title>Implement hook runner</title>
  <context>
    The hook runner executes an ordered list of shell commands sequentially in a specified working directory. Each command is run via Bun.spawn with `shell: true` (so pipes and shell syntax work). It captures stdout and stderr. If a command exits with non-zero, it stops immediately and returns a failure result with the command, exit code, and captured output. If all commands succeed, it returns a success result. Before execution, each command has its variables interpolated using the interpolate function.
  </context>
  <files>
    - src/pipeline/hook-runner.ts
    - test/hook-runner.test.ts
  </files>
  <action>
    1. Export `type HookResult = { success: boolean; failedCommand?: string; exitCode?: number; output?: string; }`.
    2. Export `async function runHooks(commands: string[], cwd: string, vars: TaskVars, logger: Logger): Promise<HookResult>`.
    3. For each command: interpolate variables, log info "Running hook" with the command, spawn via `Bun.spawn(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })`. Await the process. Read stdout and stderr as text. Log output at debug level. If `exitCode !== 0`, return `{ success: false, failedCommand: command, exitCode, output: stderr || stdout }`. After all commands, return `{ success: true }`.
    4. Tests: use simple commands like `echo hello` (success), `exit 1` (failure), verify sequential execution with `echo a && echo b`, verify first-failure-aborts by running `exit 1` then `echo should-not-run`.
  </action>
  <verify>
    Run `bun test test/hook-runner.test.ts` — all tests pass.
  </verify>
  <depends_on>3.1</depends_on>
</task>

<task id="3.3">
  <title>Implement Claude Code executor</title>
  <context>
    The Claude executor spawns `claude` as a headless subprocess with the --print flag (for non-interactive output). The command is: `claude --task "<prompt>" --print`. The prompt combines ticket title and description. It runs in the configured repo directory. A configurable timeout (default 300s) is enforced — if exceeded, the process is killed and a timeout error is returned. stdout and stderr are captured for logging.
  </context>
  <files>
    - src/pipeline/claude-executor.ts
    - test/claude-executor.test.ts
  </files>
  <action>
    1. Export `type ExecutorResult = { success: boolean; output: string; timedOut: boolean; exitCode: number | null; }`.
    2. Export `async function runClaude(prompt: string, cwd: string, timeoutMs: number, logger: Logger): Promise<ExecutorResult>`.
    3. Build the prompt: `"Linear ticket: ${title}\n\n${description || 'No description provided.'}"`.
    4. Spawn `claude` with args `["--task", prompt, "--print"]` in `cwd`. Use `Bun.spawn` with stdout/stderr piped.
    5. Set up a timeout: `setTimeout(() => proc.kill(), timeoutMs)`. Clear the timeout when the process exits.
    6. If the process was killed by timeout, return `{ success: false, output, timedOut: true, exitCode: null }`.
    7. Otherwise return `{ success: exitCode === 0, output, timedOut: false, exitCode }`.
    8. Tests: mock by using a simple command wrapper — create a test that spawns `echo "mock claude output"` instead of real claude. Test timeout with `sleep 10` and a 100ms timeout.
  </action>
  <verify>
    Run `bun test test/claude-executor.test.ts` — all tests pass.
  </verify>
  <depends_on>1.1</depends_on>
</task>

<task id="3.4">
  <title>Implement pipeline orchestration</title>
  <context>
    The Pipeline orchestrates the full sequence for one ticket: run pre-hooks, then Claude Code, then post-hooks. If pre-hooks fail, Claude is not invoked. If Claude fails, post-hooks are not run. The pipeline returns a result indicating which stage failed (if any), with error details. It uses the hook runner and Claude executor internally. The pipeline does NOT handle retries or status updates — that is the Scheduler's job.
  </context>
  <files>
    - src/pipeline/pipeline.ts
    - test/pipeline.test.ts
  </files>
  <action>
    1. Export `type PipelineResult = { success: boolean; stage?: "pre-hook" | "claude" | "post-hook"; error?: string; }`.
    2. Export `async function executePipeline(options: { ticket: Ticket, preHooks: string[], postHooks: string[], repoCwd: string, claudeTimeoutMs: number, logger: Logger }): Promise<PipelineResult>`.
    3. Build `TaskVars` from ticket via `buildTaskVars()`.
    4. Run pre-hooks via `runHooks(preHooks, repoCwd, vars, logger)`. If failed, return `{ success: false, stage: "pre-hook", error: formatted message with command + exit code + output }`.
    5. Build prompt from ticket, run `runClaude(prompt, repoCwd, claudeTimeoutMs, logger)`. If failed, return `{ success: false, stage: "claude", error: formatted message }`.
    6. Run post-hooks via `runHooks(postHooks, repoCwd, vars, logger)`. If failed, return `{ success: false, stage: "post-hook", error: formatted message }`.
    7. Return `{ success: true }`.
    8. Tests: mock `runHooks` and `runClaude` to test all failure paths (pre-hook fail skips claude, claude fail skips post-hooks, post-hook fail, all succeed).
  </action>
  <verify>
    Run `bun test test/pipeline.test.ts` — all tests pass.
  </verify>
  <depends_on>3.2, 3.3</depends_on>
</task>

---

## Phase 4: Scheduler, Retries & Status Updates
**Goal**: The Scheduler wires everything together — claim ticket, run pipeline, handle retries, update status, post failure comments. The full end-to-end loop works.
**Requirements covered**: FR-04, FR-10, FR-11, FR-14, FR-18

<task id="4.1">
  <title>Implement scheduler with retry logic</title>
  <context>
    The Scheduler orchestrates the lifecycle of a single ticket. It receives a ticket from the Poller, transitions it to "in_progress" via the TicketProvider, runs the Pipeline, and based on the result either transitions to "done" or retries (up to config.claude.retries times). On final failure, it transitions to "failed" and posts a comment with the error details (stage, command, exit code, last 50 lines of output). If the status transition to "in_progress" fails (e.g. ticket already claimed), it logs a warning and returns without processing. The scheduler does not throw — all errors are caught and logged.
  </context>
  <files>
    - src/scheduler.ts
    - test/scheduler.test.ts
  </files>
  <action>
    1. Export `async function processTicket(options: { ticket: Ticket, provider: TicketProvider, config: Config, logger: Logger }): Promise<void>`.
    2. Try to transition ticket to `config.linear.statuses.in_progress`. If it throws, log warn "Failed to claim ticket" and return.
    3. Retry loop: `for (let attempt = 0; attempt <= config.claude.retries; attempt++)`. Call `executePipeline(...)`. If success, break. If failure and retries remain, log warn "Retrying" with attempt number.
    4. After loop: if pipeline succeeded, call `provider.transitionStatus(ticket.id, config.linear.statuses.done)`. Log info "Ticket completed".
    5. If pipeline failed, call `provider.transitionStatus(ticket.id, config.linear.statuses.failed)`. Format error comment: `"## Agent Worker Failure\n\n**Stage:** ${stage}\n**Error:**\n\`\`\`\n${last50Lines}\n\`\`\`"`. Call `provider.postComment(ticket.id, comment)`. Log error "Ticket failed".
    6. Wrap entire function body in try/catch. On unexpected error, log error and return (ticket stays In Progress per FR-18).
    7. Tests: mock provider and pipeline. Test: success path updates to done, failure path updates to failed + posts comment, retries exhaust correctly, claim failure skips processing, unexpected error is caught.
  </action>
  <verify>
    Run `bun test test/scheduler.test.ts` — all tests pass.
  </verify>
  <depends_on>3.4, 2.1</depends_on>
</task>

<task id="4.2">
  <title>Wire scheduler into poller and complete the loop</title>
  <context>
    The entry point (src/index.ts) currently has a placeholder onTicket callback that just logs. Replace it with the real Scheduler's processTicket function. After this change, the full end-to-end loop works: poll Linear → find ticket → claim → pre-hooks → Claude Code → post-hooks → update status.
  </context>
  <files>
    - src/index.ts
  </files>
  <action>
    1. Import `processTicket` from `./scheduler`.
    2. Replace the placeholder `onTicket` callback with: `async (ticket) => { await processTicket({ ticket, provider, config, logger }); }`.
    3. No other changes needed — the poller already calls onTicket and handles errors.
  </action>
  <verify>
    Run against a real Linear project with a test ticket in "Todo" status. The ticket should transition to "In Progress", Claude Code should run (or fail if not installed — that's fine for verification), and the ticket should end in "Done" or "Failed" with a comment. Check the Linear ticket's activity log to confirm status transitions and comment.
  </verify>
  <depends_on>4.1, 2.3</depends_on>
</task>

---

## Phase 5: Build, Distribution & Polish
**Goal**: The tool compiles to native binaries, has a working example config, and is ready for `v0.1.0` release.
**Requirements covered**: NFR-01, NFR-04, NFR-07

<task id="5.1">
  <title>Add build scripts for cross-platform binaries</title>
  <context>
    Bun supports cross-compilation via `bun build --compile --target=bun-linux-x64 --target=bun-darwin-arm64` etc. The project needs build scripts that produce binaries for: macOS arm64, macOS x86_64, Linux x86_64. Binaries should be named `agent-worker-{platform}-{arch}`. The entry point is src/index.ts.
  </context>
  <files>
    - package.json
  </files>
  <action>
    1. Add scripts to package.json:
       - `"build": "bun build src/index.ts --compile --outfile dist/agent-worker"`
       - `"build:linux-x64": "bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/agent-worker-linux-x64"`
       - `"build:darwin-arm64": "bun build src/index.ts --compile --target=bun-darwin-arm64 --outfile dist/agent-worker-darwin-arm64"`
       - `"build:darwin-x64": "bun build src/index.ts --compile --target=bun-darwin-x64 --outfile dist/agent-worker-darwin-x64"`
       - `"build:all": "bun run build:linux-x64 && bun run build:darwin-arm64 && bun run build:darwin-x64"`
    2. Add `dist/` to .gitignore.
    3. Add a `"start"` script: `"bun run src/index.ts"`.
  </action>
  <verify>
    Run `bun run build` — should produce `dist/agent-worker` binary. Run `./dist/agent-worker --config agent-worker.example.yaml` (with LINEAR_API_KEY set) — should start and log the startup message identically to `bun run src/index.ts`.
  </verify>
  <depends_on>4.2</depends_on>
</task>

<task id="5.2">
  <title>Add poller integration test</title>
  <context>
    The poller test uses a mock TicketProvider (not real Linear) to verify the poll loop behavior: it calls fetchReadyTickets on interval, passes tickets to the onTicket callback, handles provider errors without crashing, and stops cleanly when stop() is called. This is the only integration-style test — all other tests are unit tests with mocked dependencies.
  </context>
  <files>
    - test/poller.test.ts
  </files>
  <action>
    1. Create a mock TicketProvider that returns configurable results from fetchReadyTickets() and tracks calls to transitionStatus() and postComment().
    2. Create a mock logger that captures log calls.
    3. Test "polls and finds ticket": mock returns one ticket, verify onTicket is called with it.
    4. Test "no tickets": mock returns empty array, verify onTicket is not called.
    5. Test "provider error": mock throws an error, verify poller continues without crashing.
    6. Test "stop": call stop() after first poll, verify loop exits.
    7. Use short intervals (10ms) and `setTimeout` to control timing.
  </action>
  <verify>
    Run `bun test test/poller.test.ts` — all tests pass.
  </verify>
  <depends_on>2.3</depends_on>
</task>

<task id="5.3">
  <title>Write README with usage instructions</title>
  <context>
    The README is the primary onboarding doc for the open-source project. It should cover: what the tool does (one paragraph), prerequisites (Bun, Claude Code CLI, Linear API key), installation (download binary or build from source), configuration (reference the example YAML with explanation), usage (run command), how the lifecycle works (poll → claim → hooks → claude → hooks → status), and contributing (run tests with bun test).
  </context>
  <files>
    - README.md
  </files>
  <action>
    1. Title: "Agent Worker".
    2. One-line description: "A CLI tool that polls Linear for tickets and dispatches them to Claude Code for autonomous implementation."
    3. Sections: Prerequisites, Installation (binary download + build from source), Configuration (show example YAML, explain each section, note LINEAR_API_KEY env var), Usage (`agent-worker --config ./agent-worker.yaml`), How It Works (numbered lifecycle steps), Development (bun install, bun test, bun run build), License (MIT).
    4. Keep it concise — no marketing language, no badges, no emojis.
  </action>
  <verify>
    README.md exists and covers all sections listed above.
  </verify>
  <depends_on>5.1</depends_on>
</task>

<task id="5.4">
  <title>Add .gitignore and finalize project files</title>
  <context>
    The project needs a .gitignore appropriate for a Bun/TypeScript project. It should ignore: node_modules, dist, *.log, .env, and the bun lockfile binary (bun.lockb should be committed but .env should not). Also ensure the example config does not contain real API keys or project IDs.
  </context>
  <files>
    - .gitignore
    - agent-worker.example.yaml
  </files>
  <action>
    1. Create .gitignore with: `node_modules/`, `dist/`, `*.log`, `.env`, `.DS_Store`.
    2. Review agent-worker.example.yaml — ensure all values are clearly placeholders (e.g. "your-project-uuid-here", "/path/to/your/repo"). Add comments explaining each field.
  </action>
  <verify>
    Run `cat .gitignore` — contains all expected entries. Run `grep -r "real" agent-worker.example.yaml` — should find no real credentials or IDs.
  </verify>
  <depends_on>1.1</depends_on>
</task>
