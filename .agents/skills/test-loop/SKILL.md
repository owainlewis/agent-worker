# Agent Worker Testing Loop

Test agent-worker end-to-end by running it against a branch/PR and verifying both the implementation and feedback loops.

## Prerequisites

- `GITHUB_TOKEN` or `gh auth token` must be available
- `PLANE_API_KEY` must be set for Plane provider
- Build the binary first: `bun run build`

## Quick Start

```bash
# 1. Checkout the branch to test
git checkout <branch>

# 2. Rebuild and verify
bun typecheck && bun test && bun run build

# 3. Update config with test prompts (optional but recommended)
# Add prompts section to agent-worker.yaml for visibility

# 4. Start agent-worker in tmux (creates session if not exists)
SOCKET_DIR=${TMPDIR:-/tmp}/claude-tmux-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/claude.sock"
SESSION="claude-agent-worker"

# Create session only if it doesn't exist
tmux -S "$SOCKET" has-session -t "$SESSION" 2>/dev/null || tmux -S "$SOCKET" new -d -s "$SESSION" -n worker

# Start agent-worker
tmux -S "$SOCKET" send-keys -t "$SESSION":1.1 -- 'export GITHUB_TOKEN=$(gh auth token) && ./dist/agent-worker --config agent-worker.yaml --debug' Enter

# 5. Monitor
tmux -S "$SOCKET" attach -t claude-agent-worker
```

## Test Scenarios

### 1. Implementation Loop

Tests that agent picks up tickets and processes them.

**Setup:**

```bash
# Create a test ticket in Plane with label "ai" in Todo state
# Or use an existing ticket in Code Review status
```

**Verify:**

- Agent detects ticket within one poll cycle (60s default)
- Status transitions to "In Progress"
- Worktree created at `$TMPDIR/agent-worker-<branch>`
- Branch `agent/task-<TICKET-ID>` created
- Executor starts (check logs for "pi started")
- Post-hooks run: commit, push, PR created

### 2. Feedback Loop

Tests that agent responds to PR comments.

**Setup:**

```bash
# Add a comment to an existing PR
gh pr comment <PR_NUMBER> --body "/agent Please add a comment explaining this function"
```

**Verify:**

- Feedback poller detects comment (120s interval default)
- Comment starts with `/agent` prefix
- No agent reactions already present (eyes/+1/-1)
- Worktree created for existing branch
- Executor runs with feedback prompt
- Agent replies to comment with result

## Monitor Commands

```bash
# Attach to session
tmux -S "${TMPDIR:-/tmp}/claude-tmux-sockets/claude.sock" attach -t claude-agent-worker

# Capture output (detached)
tmux -S "${TMPDIR:-/tmp}/claude-tmux-sockets/claude.sock" capture-pane -p -J -t claude-agent-worker:1.1 -S -200

# List sessions
tmux -S "${TMPDIR:-/tmp}/claude-tmux-sockets/claude.sock" list-sessions
```

## Check Worktree

```bash
# List worktrees
ls -la ${TMPDIR}/agent-worker-*/

# Check git status in worktree
cd ${TMPDIR}/agent-worker-agent/task-<TICKET-ID>
git status
git log --oneline -5
```

## Debug Logging

The `--debug` flag enables verbose logging:

- All API requests/responses with timing
- Rate limit retries
- Data counts (tickets, comments, etc.)
- Cache hits/misses

Look for key log lines:

```
INFO   Ticket found ticketId=<ID> title=<TITLE>
INFO   Ticket claimed ticketId=<ID>
INFO   Creating worktree worktreePath=<PATH> branch=<BRANCH>
INFO   pi started timeoutMs=<MS> model=<MODEL>
INFO   Actionable feedback found ticketId=<ID> count=<N>
INFO   Tracking PR for ticket ticketId=<ID> prNumber=<N>
```

## Test Config

Add to `agent-worker.yaml` for visibility into prompt interpolation:

```yaml
prompts:
  implement: |
    Working on {id}: {raw_title}

    Project conventions:
    - Follow AGENTS.md
    - Run `bun typecheck && bun test` before finishing

    Date: {date}
  feedback: |
    Processing feedback for {id}: {raw_title}

    Guidelines:
    - Keep changes minimal
    - Run `bun typecheck && bun test` after changes

    Date: {date}
```

## Cleanup

```bash
# Remove worktrees
rm -rf ${TMPDIR}/agent-worker-*/

# Delete test branches (optional)
git branch -D agent/task-<TICKET-ID>
```

## Common Issues

| Issue                   | Cause                         | Solution                                 |
| ----------------------- | ----------------------------- | ---------------------------------------- |
| `GITHUB_TOKEN not set`  | Environment variable missing  | `export GITHUB_TOKEN=$(gh auth token)`   |
| Worktree creation fails | Testing in same checkout      | Expected in dev; works in production     |
| Ticket not found        | Wrong status or missing label | Check `state:Todo label:ai` query        |
| Feedback not processed  | Comment lacks `/agent` prefix | Start comment with `/agent`              |
| Duplicate processing    | Reaction already present      | Agent adds eyes/+1 to processed comments |
