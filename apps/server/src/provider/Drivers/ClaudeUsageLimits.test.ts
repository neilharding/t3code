import { describe, expect, it } from "vite-plus/test";

import { parseClaudeUsageLimits, parseClaudeUsagePanel } from "./ClaudeUsageLimits.ts";

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

  it("prefers Claude's current weekly-all limit over the legacy seven-day field", () => {
    expect(
      parseClaudeUsageLimits({
        five_hour: { utilization: 17.5, resets_at: "2026-08-01T18:00:00.000Z" },
        seven_day: { utilization: 48, resets_at: "2026-08-05T12:00:00.000Z" },
        limits: [
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 52,
            resets_at: "2026-08-07T10:59:00.000Z",
          },
        ],
      }),
    ).toEqual({
      fiveHour: { usedPercent: 17.5, resetsAt: "2026-08-01T18:00:00.000Z" },
      weekly: { usedPercent: 52, resetsAt: "2026-08-07T10:59:00.000Z" },
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

describe("parseClaudeUsagePanel", () => {
  const nowEpochMs = new Date("2026-08-01T16:00:00.000Z").getTime();

  it("maps the latest session and all-model weekly rows with relative resets", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  12% used",
          "  Resets in 4h 30m",
          "Current week (all models)",
          "  67% used",
          "  Resets in 2d 1h",
          "Current session",
          "  \u001b[32m19% used\u001b[0m",
          "  Resets in 5h",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      fiveHour: { usedPercent: 19, resetsAt: "2026-08-01T21:00:00.000Z" },
      weekly: { usedPercent: 67, resetsAt: "2026-08-03T17:00:00.000Z" },
    });
  });

  it("resolves weekday and calendar reset descriptions in the server's local timezone", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  24.5% used",
          "  Resets Monday at 10:30 AM",
          "Current week (all models)",
          "  42% used",
          "  Resets Aug 5 at 4:15 PM",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      fiveHour: { usedPercent: 24.5, resetsAt: new Date(2026, 7, 3, 10, 30).toISOString() },
      weekly: { usedPercent: 42, resetsAt: new Date(2026, 7, 5, 16, 15).toISOString() },
    });
  });

  it("resolves a time-only reset with its displayed timezone suffix", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  24.5% used",
          "  Resets 4:15pm (America/New_York)",
          "Current week (all models)",
          "  42% used",
          "  Resets Nov 5, 4:15pm (America/New_York)",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      fiveHour: { usedPercent: 24.5, resetsAt: new Date(2026, 7, 1, 16, 15).toISOString() },
      weekly: { usedPercent: 42, resetsAt: new Date(2026, 10, 5, 16, 15).toISOString() },
    });
  });

  it("omits only rows with invalid percentages or non-future resets", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  101% used",
          "  Resets in 5h",
          "Current week (all models)",
          "  18% used",
          "  Resets in 2h",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      weekly: { usedPercent: 18, resetsAt: "2026-08-01T18:00:00.000Z" },
    });

    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  22% used",
          "  Resets in 0m",
          "Current week (all models)",
          "  18% used",
          "  Resets in 2h",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      weekly: { usedPercent: 18, resetsAt: "2026-08-01T18:00:00.000Z" },
    });
  });

  it.each([
    ["Loading usage…"],
    ["Usage limits are only available with a Pro or Max subscription."],
    [""],
  ])("treats unavailable panel output as no limits: %s", (text) => {
    expect(parseClaudeUsagePanel(text, nowEpochMs)).toEqual({});
  });
});
