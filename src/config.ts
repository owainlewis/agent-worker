import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

const StatusesSchema = z.object({
  ready: z.string(),
  in_progress: z.string(),
  done: z.string(),
  failed: z.string(),
});

// SAM-481 cross-repo work-stealing: a daemon can be configured with EITHER
//   project_id: <single uuid>                (legacy, single-project mode)
// OR
//   project_ids: [<primary uuid>, <fallback uuid>, ...]   (priority-ordered list)
//
// At least one must be set. Both is rejected — caller bug. The provider walks
// project_ids in order and returns tickets from the first non-empty project.
// A daemon configured with [primary, fallback] only consults `fallback` when
// `primary` is empty — matches the user mental model "claude-ia helps with
// studio-os work only when its own queue is drained, not in parallel."
const LinearSchema = z
  .object({
    project_id: z.string().optional(),
    project_ids: z.array(z.string()).optional(),
    poll_interval_seconds: z.number().positive().default(60),
    statuses: StatusesSchema,
  })
  .refine(
    (v) =>
      Boolean(v.project_id) !== Boolean(v.project_ids && v.project_ids.length),
    {
      message:
        "linear: exactly one of `project_id` (legacy) or `project_ids` (multi-project) must be set",
      path: ["project_id"],
    },
  );

// SAM-481 cross-repo work-stealing: a daemon can be configured with EITHER
//   path: <single absolute path>            (legacy, all tickets ship from here)
// OR per-label routing:
//   path_by_label:
//     "repo:studio-os": "/Users/.../studio-os"
//     "repo:agent-worker-pilot": "/Users/.../agent-worker-pilot"
//   default_path: "/Users/.../studio-os"   # used when ticket has no repo:* label
//
// When `path_by_label` is set, the scheduler reads the ticket's labels, finds
// the FIRST one matching a key in `path_by_label`, and uses the mapped path as
// the worktree base. If no label matches, falls back to `default_path`. If
// `default_path` is unset and no label matches, the daemon refuses to claim
// the ticket (logs an error, skips it). This refuses-on-ambiguity stance is
// intentional: silently shipping from the wrong repo is the failure mode we
// are trying to prevent.
const RepoSchema = z
  .object({
    path: z.string().optional(),
    path_by_label: z.record(z.string(), z.string()).optional(),
    default_path: z.string().optional(),
  })
  .refine(
    (v) =>
      Boolean(v.path) ||
      Boolean(v.path_by_label && Object.keys(v.path_by_label).length > 0),
    {
      message:
        "repo: must set either `path` (legacy) or `path_by_label` (per-ticket routing)",
      path: ["path"],
    },
  );

const HooksSchema = z
  .object({
    pre: z.array(z.string()).default([]),
    post: z.array(z.string()).default([]),
  })
  .default({ pre: [], post: [] });

// SAM-400: `watchdog_inactivity_seconds` is the inactivity window (no
// stdout/stderr from the child for this many seconds) after which the
// streaming executor kills the process. 0 disables the watchdog entirely
// — preserves pre-SAM-400 behavior where only the hard `timeout_seconds`
// could rescue a hung session. Default 300s catches the silent-hang
// failure mode (~7.7% of runs in the 24h window before SAM-400 was
// filed) without false-killing healthy runs (Claude Code emits tool-use
// activity every few seconds during normal operation).
const ExecutorSchema = z
  .object({
    type: z.enum(["claude", "codex"]).default("claude"),
    timeout_seconds: z.number().positive().default(300),
    retries: z.number().int().min(0).max(3).default(0),
    watchdog_inactivity_seconds: z.number().int().nonnegative().default(300),
  })
  .default({
    type: "claude",
    timeout_seconds: 300,
    retries: 0,
    watchdog_inactivity_seconds: 300,
  });

const LogSchema = z
  .object({
    file: z.string().optional(),
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .default({ level: "info" });

const ConfigFileSchema = z.object({
  linear: LinearSchema,
  repo: RepoSchema,
  hooks: HooksSchema,
  executor: ExecutorSchema,
  log: LogSchema,
});

type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type Config = ConfigFile & {
  apiKey: string;
};

export function loadConfig(filePath: string): Config {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY environment variable is required");
  }

  const text = readFileSync(filePath, "utf-8");
  const raw = parseYaml(text) as Record<string, unknown>;

  // Backward compat: map `claude` key to `executor` with type "claude"
  if (raw.claude && !raw.executor) {
    raw.executor = {
      ...(raw.claude as Record<string, unknown>),
      type: "claude",
    };
    delete raw.claude;
  }

  const parsed = ConfigFileSchema.parse(raw);

  return { ...parsed, apiKey };
}
