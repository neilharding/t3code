import {
  isProviderAvailable,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderUsageLimitWindow,
  type ProviderUsageLimitsSnapshot,
  type ProviderUsageLimitsUpdate,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface ProviderUsageLimitsRecord {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly observedAt: string;
  readonly fiveHour?: ProviderUsageLimitWindow;
  readonly weekly?: ProviderUsageLimitWindow;
}

const isSupportedUsageLimitsDriver = (driver: ProviderDriverKind): boolean =>
  driver === "codex" || driver === "claudeAgent";

const isWindowActive = (window: ProviderUsageLimitWindow, nowEpochMs: number): boolean => {
  const resetsAt = Option.getOrUndefined(DateTime.make(window.resetsAt));
  return resetsAt !== undefined && DateTime.toEpochMillis(resetsAt) > nowEpochMs;
};

export const pruneExpiredProviderUsageLimitsRecord = (
  record: ProviderUsageLimitsRecord,
  nowEpochMs: number,
): ProviderUsageLimitsRecord | undefined => {
  const fiveHour = record.fiveHour;
  const weekly = record.weekly;
  const activeFiveHour = fiveHour && isWindowActive(fiveHour, nowEpochMs) ? fiveHour : undefined;
  const activeWeekly = weekly && isWindowActive(weekly, nowEpochMs) ? weekly : undefined;
  if (activeFiveHour === undefined && activeWeekly === undefined) {
    return undefined;
  }
  return {
    providerInstanceId: record.providerInstanceId,
    driver: record.driver,
    observedAt: record.observedAt,
    ...(activeFiveHour ? { fiveHour: activeFiveHour } : {}),
    ...(activeWeekly ? { weekly: activeWeekly } : {}),
  };
};

export const mergeProviderUsageLimitsRecord = (
  existing: ProviderUsageLimitsRecord | undefined,
  input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly observedAt: string;
    readonly limits: ProviderUsageLimitsUpdate;
    readonly nowEpochMs: number;
  },
): ProviderUsageLimitsRecord | undefined => {
  if (!isSupportedUsageLimitsDriver(input.driver)) {
    return undefined;
  }
  const correlated =
    existing?.providerInstanceId === input.providerInstanceId && existing.driver === input.driver
      ? pruneExpiredProviderUsageLimitsRecord(existing, input.nowEpochMs)
      : undefined;
  return pruneExpiredProviderUsageLimitsRecord(
    {
      providerInstanceId: input.providerInstanceId,
      driver: input.driver,
      observedAt: input.observedAt,
      ...(correlated?.fiveHour ? { fiveHour: correlated.fiveHour } : {}),
      ...(correlated?.weekly ? { weekly: correlated.weekly } : {}),
      ...(input.limits.fiveHour ? { fiveHour: input.limits.fiveHour } : {}),
      ...(input.limits.weekly ? { weekly: input.limits.weekly } : {}),
    },
    input.nowEpochMs,
  );
};

export const isEligibleProviderUsageLimitsProvider = (provider: ServerProvider): boolean =>
  isSupportedUsageLimitsDriver(provider.driver) &&
  provider.enabled &&
  provider.installed &&
  isProviderAvailable(provider) &&
  provider.auth.status === "authenticated";

export const pruneIneligibleProviderUsageLimitsRecords = (
  records: ReadonlyMap<ProviderInstanceId, ProviderUsageLimitsRecord>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyMap<ProviderInstanceId, ProviderUsageLimitsRecord> => {
  const eligibleProviders = new Map(
    providers
      .filter(isEligibleProviderUsageLimitsProvider)
      .map((provider) => [provider.instanceId, provider.driver] as const),
  );
  return new Map(
    [...records].filter(
      ([instanceId, record]) => eligibleProviders.get(instanceId) === record.driver,
    ),
  );
};

export const projectProviderUsageLimitSnapshots = (
  records: ReadonlyMap<ProviderInstanceId, ProviderUsageLimitsRecord>,
  providers: ReadonlyArray<ServerProvider>,
  nowEpochMs: number,
): ReadonlyArray<ProviderUsageLimitsSnapshot> =>
  providers.flatMap((provider) => {
    if (!isEligibleProviderUsageLimitsProvider(provider)) {
      return [];
    }
    const record = records.get(provider.instanceId);
    if (record === undefined || record.driver !== provider.driver) {
      return [];
    }
    const active = pruneExpiredProviderUsageLimitsRecord(record, nowEpochMs);
    if (active === undefined) return [];
    return [
      {
        providerInstanceId: active.providerInstanceId,
        driver: active.driver,
        observedAt: active.observedAt,
        ...(active.fiveHour ? { fiveHour: active.fiveHour } : {}),
        ...(active.weekly ? { weekly: active.weekly } : {}),
      },
    ];
  });
