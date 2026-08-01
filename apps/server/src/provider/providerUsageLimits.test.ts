import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageLimitsUpdate,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  mergeProviderUsageLimitsRecord,
  projectProviderUsageLimitSnapshots,
  pruneExpiredProviderUsageLimitsRecord,
  pruneIneligibleProviderUsageLimitsRecords,
  type ProviderUsageLimitsRecord,
} from "./providerUsageLimits.ts";

const NOW = 1_000_000;
const FIVE_HOUR_RESET = "1970-01-01T01:00:01.000Z";
const WEEKLY_RESET = "1970-01-08T00:16:40.000Z";
const EXPIRED_RESET = "1970-01-01T00:00:00.000Z";

const instanceId = ProviderInstanceId.make("codex_personal");
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const makeProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId,
  driver: codex,
  displayName: "Codex Personal",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:16:40.000Z",
  availability: "available",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const makeRecord = (overrides: Partial<ProviderUsageLimitsRecord> = {}) => ({
  providerInstanceId: instanceId,
  driver: codex,
  observedAt: "1970-01-01T00:16:40.000Z",
  fiveHour: { usedPercent: 23, resetsAt: FIVE_HOUR_RESET },
  weekly: { usedPercent: 61, resetsAt: WEEKLY_RESET },
  ...overrides,
});

describe("provider usage limit projection", () => {
  it("merges sparse windows without replacing the other window", () => {
    const initial = mergeProviderUsageLimitsRecord(undefined, {
      providerInstanceId: instanceId,
      driver: codex,
      observedAt: "1970-01-01T00:16:40.000Z",
      limits: { fiveHour: { usedPercent: 23, resetsAt: FIVE_HOUR_RESET } },
      nowEpochMs: NOW,
    });
    const merged = mergeProviderUsageLimitsRecord(initial, {
      providerInstanceId: instanceId,
      driver: codex,
      observedAt: "1970-01-01T00:16:41.000Z",
      limits: { weekly: { usedPercent: 61, resetsAt: WEEKLY_RESET } },
      nowEpochMs: NOW,
    });

    expect(merged).toEqual(makeRecord({ observedAt: "1970-01-01T00:16:41.000Z" }));
  });

  it("rejects unsupported drivers", () => {
    const update: ProviderUsageLimitsUpdate = {
      fiveHour: { usedPercent: 23, resetsAt: FIVE_HOUR_RESET },
    };
    expect(
      mergeProviderUsageLimitsRecord(undefined, {
        providerInstanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        observedAt: "1970-01-01T00:16:40.000Z",
        limits: update,
        nowEpochMs: NOW,
      }),
    ).toBeUndefined();
  });

  it("drops expired windows before a sparse merge", () => {
    const merged = mergeProviderUsageLimitsRecord(
      makeRecord({ fiveHour: { usedPercent: 23, resetsAt: EXPIRED_RESET } }),
      {
        providerInstanceId: instanceId,
        driver: codex,
        observedAt: "1970-01-01T00:16:41.000Z",
        limits: { weekly: { usedPercent: 62, resetsAt: WEEKLY_RESET } },
        nowEpochMs: NOW,
      },
    );

    expect(merged).toEqual({
      providerInstanceId: instanceId,
      driver: codex,
      observedAt: "1970-01-01T00:16:41.000Z",
      weekly: { usedPercent: 62, resetsAt: WEEKLY_RESET },
    });
  });

  it("removes a record after its final window expires", () => {
    expect(
      pruneExpiredProviderUsageLimitsRecord(
        makeRecord({
          fiveHour: { usedPercent: 23, resetsAt: EXPIRED_RESET },
          weekly: { usedPercent: 61, resetsAt: EXPIRED_RESET },
        }),
        NOW,
      ),
    ).toBeUndefined();
  });

  it("projects complete snapshots in provider registry order", () => {
    const claudeId = ProviderInstanceId.make("claude_work");
    const records = new Map([
      [instanceId, makeRecord()],
      [
        claudeId,
        makeRecord({
          providerInstanceId: claudeId,
          driver: claude,
          observedAt: "1970-01-01T00:16:42.000Z",
        }),
      ],
    ]);
    const providers = [
      makeProvider({ instanceId: claudeId, driver: claude, displayName: "Claude Work" }),
      makeProvider(),
    ];

    expect(
      projectProviderUsageLimitSnapshots(records, providers, NOW).map((entry) => entry.driver),
    ).toEqual([claude, codex]);
  });

  it.each([
    ["removed", []],
    ["driver mismatch", [makeProvider({ driver: claude })]],
    ["disabled", [makeProvider({ enabled: false, status: "disabled" })]],
    ["not installed", [makeProvider({ installed: false })]],
    ["unavailable", [makeProvider({ availability: "unavailable" })]],
    ["unauthenticated", [makeProvider({ auth: { status: "unauthenticated" } })]],
  ])("hides %s providers", (_name, providers) => {
    expect(
      projectProviderUsageLimitSnapshots(new Map([[instanceId, makeRecord()]]), providers, NOW),
    ).toEqual([]);
    expect(
      pruneIneligibleProviderUsageLimitsRecords(new Map([[instanceId, makeRecord()]]), providers),
    ).toEqual(new Map());
  });

  it("hides incomplete and expired records", () => {
    expect(
      projectProviderUsageLimitSnapshots(
        new Map([
          [
            instanceId,
            {
              providerInstanceId: instanceId,
              driver: codex,
              observedAt: "1970-01-01T00:16:40.000Z",
              fiveHour: { usedPercent: 23, resetsAt: EXPIRED_RESET },
            },
          ],
        ]),
        [makeProvider()],
        NOW,
      ),
    ).toEqual([]);
  });
});
