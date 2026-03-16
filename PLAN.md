## Agent Worker — High Level Requirements

**Overview**
A local CLI process that polls Linear for tickets, dispatches them to Claude Code, and runs configurable pre and post hooks around each task.

---

**Core Behaviour**
- Runs as a persistent loop on a local machine
- Polls a configured Linear team/project for tickets with a specified label or status
- Picks up one ticket at a time, marks it in progress atomically
- Dispatches the ticket title and description to Claude Code as a task
- Marks the ticket done or failed based on the outcome
- Runs continuously until manually stopped

---

**Pre-hooks**
- Ordered list of shell commands that run before Claude Code is dispatched
- Run deterministically and sequentially — if any fail, the task is marked failed and Claude Code is not dispatched
- Examples: `git pull`, `git checkout -b agent/task-{id}`, custom setup scripts

**Post-hooks**
- Ordered list of shell commands that run after Claude Code completes successfully
- Run deterministically and sequentially — if any fail, the task is marked failed
- Examples: `npm run test`, `npm run lint`, `git push`, `git commit -am "..."`
- Post-hooks only run if Claude Code completed without error

---

**Configuration**
A single config file (YAML or JSON) defining:
```yaml
linear:
  api_key: ...
  team_id: ...       # required — used for auth and label lookup
  project_id: ...    # optional — filters to a specific project
  agent_label: agent # tickets must also have this label
  poll_interval_seconds: 10

repo:
  path: /path/to/repo

hooks:
  pre:
    - git pull
    - git checkout -b agent/task-{id}
  post:
    - npm run lint
    - npm run test
    - git add -A
    - git commit -m "feat: {title}"
    - git push origin agent/task-{id}

claude_code:
  timeout_seconds: 300
```

---

**Task variable interpolation**
Hooks should support simple variable substitution:
- `{id}` — Linear ticket identifier
- `{title}` — ticket title slugified
- `{branch}` — generated branch name

---

**Out of scope for now**
- Multiple model support (Claude Code only)
- GitHub PR creation (manual for now)
- Multiple parallel workers
- Remote/VPS deployment

---

**Success criteria**
- Run `npm start` locally and it begins polling
- Create a Linear ticket with the agent label
- Worker picks it up, runs pre-hooks, dispatches to Claude Code, runs post-hooks, updates the ticket
- Ticket status reflects outcome — done or failed with error message