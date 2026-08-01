import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const UsageLimitIsoDateTime = IsoDateTime.check(
  Schema.makeFilter(
    (value) => Number.isFinite(Date.parse(value)) || "Expected a valid ISO date-time string.",
  ),
);

export const ProviderUsageLimitWindow = Schema.Struct({
  usedPercent: Schema.Number.check(
    Schema.isBetween({
      minimum: 0,
      maximum: 100,
    }),
  ),
  resetsAt: UsageLimitIsoDateTime,
});
export type ProviderUsageLimitWindow = typeof ProviderUsageLimitWindow.Type;

export const ProviderUsageLimitsUpdate = Schema.Struct({
  fiveHour: Schema.optionalKey(ProviderUsageLimitWindow),
  weekly: Schema.optionalKey(ProviderUsageLimitWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const ProviderUsageLimitsSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  observedAt: UsageLimitIsoDateTime,
  fiveHour: Schema.optionalKey(ProviderUsageLimitWindow),
  weekly: Schema.optionalKey(ProviderUsageLimitWindow),
});
export type ProviderUsageLimitsSnapshot = typeof ProviderUsageLimitsSnapshot.Type;

export const ProviderUsageLimitsSnapshotV1 = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  observedAt: UsageLimitIsoDateTime,
  fiveHour: ProviderUsageLimitWindow,
  weekly: ProviderUsageLimitWindow,
});
export type ProviderUsageLimitsSnapshotV1 = typeof ProviderUsageLimitsSnapshotV1.Type;

export const ProviderUsageLimitsSubscription = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(2)),
});

const ProviderUsageLimitsStreamEventV1 = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  entries: Schema.Array(ProviderUsageLimitsSnapshotV1),
});

const ProviderUsageLimitsStreamEventV2 = Schema.Struct({
  version: Schema.Literal(2),
  type: Schema.Literal("snapshot"),
  entries: Schema.Array(ProviderUsageLimitsSnapshot),
});
export const ProviderUsageLimitsStreamEvent = Schema.Union([
  ProviderUsageLimitsStreamEventV1,
  ProviderUsageLimitsStreamEventV2,
]);
export type ProviderUsageLimitsStreamEvent = typeof ProviderUsageLimitsStreamEvent.Type;
