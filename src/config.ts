import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

const StatusesSchema = z.object({
  ready: z.string(),
  in_progress: z.string(),
  done: z.string(),
  failed: z.string(),
});

const LinearSchema = z.object({
  project_id: z.string(),
  poll_interval_seconds: z.number().positive().default(60),
  statuses: StatusesSchema,
});

const RepoSchema = z.object({
  path: z.string(),
});

const HooksSchema = z.object({
  pre: z.array(z.string()).default([]),
  post: z.array(z.string()).default([]),
}).default({ pre: [], post: [] });

const ClaudeSchema = z.object({
  timeout_seconds: z.number().positive().default(300),
  retries: z.number().int().min(0).max(3).default(0),
}).default({ timeout_seconds: 300, retries: 0 });

const LogSchema = z.object({
  file: z.string().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).default({ level: "info" });

const ConfigFileSchema = z.object({
  linear: LinearSchema,
  repo: RepoSchema,
  hooks: HooksSchema,
  claude: ClaudeSchema,
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
  const raw = parseYaml(text);
  const parsed = ConfigFileSchema.parse(raw);

  return { ...parsed, apiKey };
}
