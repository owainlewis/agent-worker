import { describe, expect, test } from "bun:test";
import { parseRunOptions } from "../src/run-options.ts";

describe("parseRunOptions", () => {
  test("parses daemon mode", () => {
    expect(parseRunOptions(["agent-worker", "--config", "worker.yaml"])).toEqual({
      configPath: "worker.yaml",
      once: false,
      ticketIdentifier: undefined,
    });
  });

  test("parses one-ticket proof mode", () => {
    expect(
      parseRunOptions([
        "agent-worker",
        "--config",
        "worker.yaml",
        "--once",
        "--ticket",
        "SAM-424",
      ]),
    ).toEqual({
      configPath: "worker.yaml",
      once: true,
      ticketIdentifier: "SAM-424",
    });
  });

  test("rejects ticket without identifier", () => {
    expect(() =>
      parseRunOptions(["agent-worker", "--config", "worker.yaml", "--ticket"]),
    ).toThrow("--ticket requires a Linear ticket identifier");
  });
});
