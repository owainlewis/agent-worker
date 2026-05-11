import { describe, expect, test } from "bun:test";
import { labelFilterAllowsTicket } from "../src/providers/linear.ts";

describe("Linear provider label filters", () => {
  test("allows tickets with all required labels and no excluded labels", () => {
    expect(
      labelFilterAllowsTicket(
        ["repo:studio-os", "agent:needs-fix", "type:bug"],
        {
          requiredLabels: ["repo:studio-os", "agent:needs-fix"],
          excludedLabels: ["agent:blocked", "agent:working"],
        },
      ),
    ).toBe(true);
  });

  test("denies tickets missing any required label", () => {
    expect(
      labelFilterAllowsTicket(["repo:studio-os"], {
        requiredLabels: ["repo:studio-os", "agent:needs-fix"],
        excludedLabels: [],
      }),
    ).toBe(false);
  });

  test("denies tickets with excluded labels", () => {
    expect(
      labelFilterAllowsTicket(["repo:studio-os", "agent:needs-fix", "agent:blocked"], {
        requiredLabels: ["repo:studio-os", "agent:needs-fix"],
        excludedLabels: ["agent:blocked"],
      }),
    ).toBe(false);
  });
});
