import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { providerUsageLimitsFromStreamResult } from "./server";

const entries = [
  {
    providerInstanceId: ProviderInstanceId.make("codex_personal"),
    driver: ProviderDriverKind.make("codex"),
    observedAt: "2026-07-31T12:00:00.000Z",
    fiveHour: { usedPercent: 20, resetsAt: "2026-07-31T17:00:00.000Z" },
    weekly: { usedPercent: 60, resetsAt: "2026-08-07T12:00:00.000Z" },
  },
];

describe("providerUsageLimitsFromStreamResult", () => {
  it("returns the latest full snapshot entries", () => {
    expect(
      providerUsageLimitsFromStreamResult(
        AsyncResult.success({ version: 1 as const, type: "snapshot" as const, entries }),
      ),
    ).toBe(entries);
  });

  it("uses one shared empty value while the stream has no snapshot", () => {
    expect(providerUsageLimitsFromStreamResult(AsyncResult.initial())).toBe(
      providerUsageLimitsFromStreamResult(AsyncResult.initial()),
    );
  });
});
