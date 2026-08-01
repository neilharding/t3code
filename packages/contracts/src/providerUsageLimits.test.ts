import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderUsageLimitsSnapshot,
  ProviderUsageLimitsStreamEvent,
  ProviderUsageLimitsUpdate,
} from "./index.ts";

const decodeUpdate = Schema.decodeUnknownSync(ProviderUsageLimitsUpdate);
const decodeSnapshot = Schema.decodeUnknownSync(ProviderUsageLimitsSnapshot);
const decodeStreamEvent = Schema.decodeUnknownSync(ProviderUsageLimitsStreamEvent);

describe("ProviderUsageLimitsUpdate", () => {
  it("rejects a usage window with an invalid reset timestamp", () => {
    expect(() =>
      decodeUpdate({
        fiveHour: {
          usedPercent: 25,
          resetsAt: "not-a-timestamp",
        },
      }),
    ).toThrow();
  });
});

describe("ProviderUsageLimitsSnapshot", () => {
  it("decodes a complete provider-instance snapshot", () => {
    expect(
      decodeSnapshot({
        providerInstanceId: "codex_personal",
        driver: "codex",
        observedAt: "2026-02-28T00:00:00.000Z",
        fiveHour: {
          usedPercent: 25,
          resetsAt: "2026-02-28T05:00:00.000Z",
        },
        weekly: {
          usedPercent: 50,
          resetsAt: "2026-03-07T00:00:00.000Z",
        },
      }),
    ).toEqual({
      providerInstanceId: "codex_personal",
      driver: "codex",
      observedAt: "2026-02-28T00:00:00.000Z",
      fiveHour: {
        usedPercent: 25,
        resetsAt: "2026-02-28T05:00:00.000Z",
      },
      weekly: {
        usedPercent: 50,
        resetsAt: "2026-03-07T00:00:00.000Z",
      },
    });
  });

  it("rejects an incomplete display snapshot", () => {
    expect(() =>
      decodeSnapshot({
        providerInstanceId: "codex",
        driver: "codex",
        observedAt: "2026-02-28T00:00:00.000Z",
        fiveHour: {
          usedPercent: 25,
          resetsAt: "2026-02-28T05:00:00.000Z",
        },
      }),
    ).toThrow();
  });
});

describe("ProviderUsageLimitsStreamEvent", () => {
  it("decodes a full replacement snapshot array", () => {
    const event = decodeStreamEvent({
      version: 1,
      type: "snapshot",
      entries: [
        {
          providerInstanceId: "claude_work",
          driver: "claudeAgent",
          observedAt: "2026-02-28T00:00:00.000Z",
          fiveHour: {
            usedPercent: 30,
            resetsAt: "2026-02-28T05:00:00.000Z",
          },
          weekly: {
            usedPercent: 60,
            resetsAt: "2026-03-07T00:00:00.000Z",
          },
        },
      ],
    });

    expect(event.entries.map((entry) => entry.providerInstanceId)).toEqual(["claude_work"]);
  });
});
