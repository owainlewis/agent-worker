// src/ui/config-api.ts
import { readFileSync, writeFileSync } from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
// Import the shared schema from config.ts — single source of truth, no drift.
// Note: importing config.ts is safe here because ConfigFileSchema itself has
// no env-var side effects; only loadConfig() reads process.env.
import { ConfigFileSchema, type ConfigJson } from "../config.ts";
export type { ConfigJson };

export function readConfigFile(filePath: string): ConfigJson {
  const text = readFileSync(filePath, "utf-8");
  const raw = parseYaml(text) as Record<string, unknown>;
  return ConfigFileSchema.parse(raw);
}

export function writeConfigFile(filePath: string, config: unknown): void {
  // Validate before writing — throws ZodError on invalid input
  const validated = ConfigFileSchema.parse(config);
  const yamlText = stringifyYaml(validated);
  writeFileSync(filePath, yamlText, "utf-8");
}
