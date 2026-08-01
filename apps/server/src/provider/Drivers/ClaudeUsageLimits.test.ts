import { describe, expect, it } from "vite-plus/test";

import { parseClaudeUsageLimits } from "./ClaudeUsageLimits.ts";

describe("parseClaudeUsageLimits", () => {
  it("maps Claude's five-hour and seven-day OAuth windows", () => {
    expect(
      parseClaudeUsageLimits({
        five_hour: { utilization: 17.5, resets_at: "2026-08-01T18:00:00.000Z" },
        seven_day: { utilization: 48, resets_at: "2026-08-05T12:00:00.000Z" },
      }),
    ).toEqual({
      fiveHour: { usedPercent: 17.5, resetsAt: "2026-08-01T18:00:00.000Z" },
      weekly: { usedPercent: 48, resetsAt: "2026-08-05T12:00:00.000Z" },
    });
  });

  it("ignores malformed, expired-shape, and model-specific values", () => {
    expect(
      parseClaudeUsageLimits({
        five_hour: { utilization: 101, resets_at: "2026-08-01T18:00:00.000Z" },
        seven_day_opus: { utilization: 12, resets_at: "2026-08-05T12:00:00.000Z" },
      }),
    ).toEqual({});
  });
});
