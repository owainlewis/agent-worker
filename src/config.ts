/** @module src/config — YAML config loader with Zod validation */
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

// --- Provider schemas ---

const StatusesSchema = z.object({
  ready: z.string(),
  in_progress: z.string(),
  code_review: z.string(),
  verification: z.string(),
  failed: z.string(),
});

/** Maps ticket lifecycle stages to provider-specific status names. */
export type Statuses = z.infer<typeof StatusesSchema>;

const LinearProviderSchema = z.object({
  type: z.literal("linear"),
  project_id: z.string(),
  poll_interval_seconds: z.number().positive().default(60),
  statuses: StatusesSchema,
});

/** Linear provider config requiring a project ID and status mappings. */
export type LinearProviderConfig = z.infer<typeof LinearProviderSchema>;

const JiraProviderSchema = z.object({
  type: z.literal("jira"),
  base_url: z.string(),
  poll_interval_seconds: z.number().positive().default(60),
  jql: z.string(),
  statuses: StatusesSchema,
});

/** Jira provider config requiring a base URL, JQL query, and status mappings. */
export type JiraProviderConfig = z.infer<typeof JiraProviderSchema>;

const PlaneProviderSchema = z.object({
  type: z.literal("plane"),
  base_url: z.string(),
  workspace_slug: z.string(),
  project_id: z.string(),
  poll_interval_seconds: z.number().positive().default(60),
  query: z.string(),
  statuses: StatusesSchema,
});

/** Plane provider config requiring a workspace slug, project ID, query, and status mappings. */
export type PlaneProviderConfig = z.infer<typeof PlaneProviderSchema>;

const ProviderSchema = z.discriminatedUnion("type", [
  LinearProviderSchema,
  JiraProviderSchema,
  PlaneProviderSchema,
]);

/** Discriminated union of all supported ticket provider configurations. */
export type ProviderConfig = z.infer<typeof ProviderSchema>;

// --- Shared schemas ---

const RepoSchema = z.object({
  path: z.string(),
});

const HooksSchema = z.object({
  pre: z.array(z.string()).default([]),
  post: z.array(z.string()).default([]),
}).default({ pre: [], post: [] });

const MountSchema = z.object({
  source: z.string(),
  dest: z.string(),
});

export type MountConfig = z.infer<typeof MountSchema>;

const NativeExecutorSchema = z.object({
  type: z.enum(["claude", "codex", "opencode", "pi"]),
  /** Optional model identifier passed to the executor CLI via --model flag. */
  model: z.string().optional(),
  /** When true, executors add their respective auto-approve flags (claude: --dangerously-skip-permissions, codex: --yolo). Ignored by opencode/pi (always auto). Defaults to true for backward compatibility. */
  dangerously_skip_permissions: z.boolean().default(true),
  timeout_seconds: z.number().positive().default(300),
  retries: z.number().int().min(0).max(3).default(0),
});

const ContainerExecutorSchema = z.object({
  type: z.literal("container"),
  image: z.string(),
  command: z.array(z.string()),
  /** Executor-specific auto-approve flag to inject before the prompt (e.g. "--dangerously-skip-permissions" for claude, "--yolo" for codex). Not needed for opencode/pi. */
  permissions_flag: z.string().optional(),
  memory: z.string().optional(),
  cpus: z.string().optional(),
  network: z.string().default("none"),
  env: z.record(z.string(), z.string()).default({}),
  mounts: z.array(MountSchema).default([]),
  timeout_seconds: z.number().positive().default(300),
  retries: z.number().int().min(0).max(3).default(0),
});

export type ContainerExecutorConfig = z.infer<typeof ContainerExecutorSchema>;

const ExecutorSchema = z.discriminatedUnion("type", [
  NativeExecutorSchema,
  ContainerExecutorSchema,
]).default({ type: "claude", dangerously_skip_permissions: true, timeout_seconds: 300, retries: 0 });

const LogSchema = z.object({
  file: z.string().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  redact: z.array(z.string()).default([]),
}).default({ level: "info", redact: [] });

// --- SCM schemas ---

const GitHubScmSchema = z.object({
  type: z.literal("github"),
  owner: z.string(),
  repo: z.string(),
});

/** GitHub SCM config requiring an owner and repo name. */
export type GitHubScmConfig = z.infer<typeof GitHubScmSchema>;

const BitbucketServerScmSchema = z.object({
  type: z.literal("bitbucket_server"),
  base_url: z.string(),
  project: z.string(),
  repo: z.string(),
});

/** Bitbucket Server SCM config requiring a base URL, project key, and repo name. */
export type BitbucketServerScmConfig = z.infer<typeof BitbucketServerScmSchema>;

const ScmSchema = z.discriminatedUnion("type", [
  GitHubScmSchema,
  BitbucketServerScmSchema,
]);

/** Discriminated union of all supported SCM provider configurations. */
export type ScmConfig = z.infer<typeof ScmSchema>;

// --- Feedback schema ---

const FeedbackSchema = z.object({
  comment_prefix: z.string().default("/agent"),
  poll_interval_seconds: z.number().positive().default(120),
}).default({ comment_prefix: "/agent", poll_interval_seconds: 120 });

/** Config for the feedback polling system, including comment prefix and poll interval. */
export type FeedbackConfig = z.infer<typeof FeedbackSchema>;

// --- Prompts schema ---

const PromptsSchema = z.object({
  /** Custom prompt prepended to the implementation prompt (before ticket title/description). */
  implement: z.string().optional(),
  /** Custom prompt prepended to the feedback prompt (before review comment body). */
  feedback: z.string().optional(),
}).default({});

/** Config for custom prompts injected into executor runs. */
export type PromptsConfig = z.infer<typeof PromptsSchema>;

const ConfigFileSchema = z.object({
  provider: ProviderSchema,
  repo: RepoSchema,
  hooks: HooksSchema,
  executor: ExecutorSchema,
  log: LogSchema,
  scm: ScmSchema,
  feedback: FeedbackSchema,
  prompts: PromptsSchema,
});

type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** Top-level application configuration combining all sub-configs. */
export type Config = ConfigFile;

/**
 * Reads a YAML config file and validates it against the full schema.
 * @param filePath - path to the YAML file
 * @returns validated Config object
 * @throws {z.ZodError} if validation fails
 * @throws {Error} if file cannot be read
 */
export function loadConfig(filePath: string): Config {
  const text = readFileSync(filePath, "utf-8");
  const raw = parseYaml(text) as Record<string, unknown>;
  return ConfigFileSchema.parse(raw);
}
