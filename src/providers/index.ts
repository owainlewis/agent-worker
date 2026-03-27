/**
 * @module src/providers/index — Ticket provider factory.
 */

import type { TicketProvider } from "./types.ts";
import type { ProviderConfig } from "../config.ts";
import { createLinearProvider } from "./linear.ts";
import { createJiraProvider } from "./jira.ts";
import { createPlaneProvider } from "./plane.ts";
import { createGitHubProvider } from "./github.ts";

/**
 * Creates a ticket provider based on the configured type.
 * @param config - Provider configuration including the `type` field ("linear" | "jira" | "plane" | "github").
 * @returns A {@link TicketProvider} implementation for the specified type.
 * @throws Error if `config.type` does not match a known provider.
 */
export function createProvider(config: ProviderConfig): TicketProvider {
  switch (config.type) {
    case "linear":
      return createLinearProvider(config);
    case "jira":
      return createJiraProvider(config);
    case "plane":
      return createPlaneProvider(config);
    case "github":
      return createGitHubProvider(config);
  }
}
