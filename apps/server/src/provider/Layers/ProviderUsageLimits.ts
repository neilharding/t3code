import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderUsageLimitsSnapshot,
  type ProviderUsageLimitsUpdate,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../../config.ts";
import {
  mergeProviderUsageLimitsRecord,
  isEligibleProviderUsageLimitsProvider,
  projectProviderUsageLimitSnapshots,
  pruneExpiredProviderUsageLimitsRecord,
  pruneIneligibleProviderUsageLimitsRecords,
  type ProviderUsageLimitsRecord,
} from "../providerUsageLimits.ts";
import {
  readProviderUsageLimitsCache,
  resolveProviderUsageLimitsCachePath,
  writeProviderUsageLimitsCache,
} from "../providerUsageLimitsCache.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageLimits } from "../Services/ProviderUsageLimits.ts";

interface PersistenceRequest {
  readonly providerInstanceId: ProviderInstanceId;
  readonly record: ProviderUsageLimitsRecord | undefined;
}

const usageWindowsEqual = (
  left: ProviderUsageLimitsSnapshot["fiveHour"],
  right: ProviderUsageLimitsSnapshot["fiveHour"],
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.usedPercent === right.usedPercent && left.resetsAt === right.resetsAt;

const snapshotsEqual = (
  left: ReadonlyArray<ProviderUsageLimitsSnapshot>,
  right: ReadonlyArray<ProviderUsageLimitsSnapshot>,
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.providerInstanceId === other.providerInstanceId &&
      entry.driver === other.driver &&
      entry.observedAt === other.observedAt &&
      usageWindowsEqual(entry.fiveHour, other.fiveHour) &&
      usageWindowsEqual(entry.weekly, other.weekly)
    );
  });

const nearestResetEpochMs = (
  records: ReadonlyMap<ProviderInstanceId, ProviderUsageLimitsRecord>,
): number | undefined => {
  let nearest: number | undefined;
  for (const record of records.values()) {
    for (const window of [record.fiveHour, record.weekly]) {
      if (window === undefined) continue;
      const reset = Option.getOrUndefined(DateTime.make(window.resetsAt));
      if (reset === undefined) continue;
      const resetEpochMs = DateTime.toEpochMillis(reset);
      if (nearest === undefined || resetEpochMs < nearest) nearest = resetEpochMs;
    }
  }
  return nearest;
};

const makeProviderUsageLimits = Effect.fn("makeProviderUsageLimits")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const providerInstanceRegistry = yield* ProviderInstanceRegistry;
  const providers = yield* providerRegistry.getProviders;
  const now = DateTime.toEpochMillis(yield* DateTime.now);

  const cachedRecords = yield* Effect.forEach(
    providers,
    (provider) =>
      Effect.gen(function* () {
        if (provider.driver !== "codex" && provider.driver !== "claudeAgent") return undefined;
        const filePath = yield* resolveProviderUsageLimitsCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: provider.instanceId,
        });
        const cached = yield* readProviderUsageLimitsCache({
          filePath,
          expectedProviderInstanceId: provider.instanceId,
          expectedDriver: provider.driver,
        });
        return cached && pruneExpiredProviderUsageLimitsRecord(cached, now);
      }),
    { concurrency: "unbounded" },
  );
  const initialRecords = pruneIneligibleProviderUsageLimitsRecords(
    new Map(
      cachedRecords
        .filter((record): record is ProviderUsageLimitsRecord => record !== undefined)
        .map((record) => [record.providerInstanceId, record] as const),
    ),
    providers,
  );

  const recordsRef = yield* SubscriptionRef.make(initialRecords);
  const providersRef = yield* Ref.make(providers);
  const snapshotsRef = yield* SubscriptionRef.make(
    projectProviderUsageLimitSnapshots(initialRecords, providers, now),
  );
  const updateSemaphore = yield* Semaphore.make(1);
  const persistenceQueue = yield* Queue.unbounded<PersistenceRequest>();

  const publishProjection = Effect.fn("ProviderUsageLimits.publishProjection")(function* () {
    const currentNow = DateTime.toEpochMillis(yield* DateTime.now);
    const records = yield* SubscriptionRef.get(recordsRef);
    const currentProviders = yield* Ref.get(providersRef);
    const next = projectProviderUsageLimitSnapshots(records, currentProviders, currentNow);
    const previous = yield* SubscriptionRef.get(snapshotsRef);
    if (!snapshotsEqual(previous, next)) yield* SubscriptionRef.set(snapshotsRef, next);
  });

  const enqueuePersistenceDiff = Effect.fn("ProviderUsageLimits.enqueuePersistenceDiff")(function* (
    previous: ReadonlyMap<ProviderInstanceId, ProviderUsageLimitsRecord>,
    next: ReadonlyMap<ProviderInstanceId, ProviderUsageLimitsRecord>,
  ) {
    const instanceIds = new Set([...previous.keys(), ...next.keys()]);
    for (const providerInstanceId of instanceIds) {
      if (previous.get(providerInstanceId) !== next.get(providerInstanceId)) {
        yield* Queue.offer(persistenceQueue, {
          providerInstanceId,
          record: next.get(providerInstanceId),
        });
      }
    }
  });

  const pruneExpiredRecords = updateSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const currentNow = DateTime.toEpochMillis(yield* DateTime.now);
      const previous = yield* SubscriptionRef.get(recordsRef);
      const next = new Map<ProviderInstanceId, ProviderUsageLimitsRecord>();
      for (const [providerInstanceId, record] of previous) {
        const active = pruneExpiredProviderUsageLimitsRecord(record, currentNow);
        if (active !== undefined) next.set(providerInstanceId, active);
      }
      yield* SubscriptionRef.set(recordsRef, next);
      yield* enqueuePersistenceDiff(previous, next);
      yield* publishProjection();
    }),
  );

  const persistBatch = Effect.fn("ProviderUsageLimits.persistBatch")(function* (
    batch: ReadonlyArray<PersistenceRequest>,
  ) {
    const latest = new Map(batch.map((request) => [request.providerInstanceId, request]));
    yield* Effect.forEach(
      latest.values(),
      (request) =>
        Effect.gen(function* () {
          const filePath = yield* resolveProviderUsageLimitsCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: request.providerInstanceId,
          });
          if (request.record === undefined) {
            const exists = yield* fileSystem
              .exists(filePath)
              .pipe(Effect.orElseSucceed(() => false));
            if (exists) yield* fileSystem.remove(filePath);
          } else {
            yield* writeProviderUsageLimitsCache({ filePath, record: request.record });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist provider usage limits cache", {
              providerInstanceId: request.providerInstanceId,
              errorTag: causeErrorTag(cause),
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  yield* Stream.fromQueue(persistenceQueue).pipe(
    Stream.groupedWithin(32, "25 millis"),
    Stream.runForEach(persistBatch),
    Effect.forkScoped,
  );

  const applyUsageLimits = Effect.fn("ProviderUsageLimits.applyUsageLimits")(function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly observedAt: string;
    readonly limits: ProviderUsageLimitsUpdate;
  }) {
    return yield* updateSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const currentNow = DateTime.toEpochMillis(yield* DateTime.now);
        const previous = yield* SubscriptionRef.get(recordsRef);
        const currentProviders = yield* Ref.get(providersRef);
        const correlatedProvider = currentProviders.find(
          (provider) =>
            provider.instanceId === input.providerInstanceId && provider.driver === input.driver,
        );
        if (correlatedProvider === undefined) return;
        const merged = mergeProviderUsageLimitsRecord(previous.get(input.providerInstanceId), {
          providerInstanceId: input.providerInstanceId,
          driver: correlatedProvider.driver,
          observedAt: input.observedAt,
          limits: input.limits,
          nowEpochMs: currentNow,
        });
        if (merged === undefined) return;
        const next = new Map(previous).set(input.providerInstanceId, merged);
        const eligible = pruneIneligibleProviderUsageLimitsRecords(next, currentProviders);
        if (!eligible.has(input.providerInstanceId)) return;
        yield* SubscriptionRef.set(recordsRef, eligible);
        yield* enqueuePersistenceDiff(previous, eligible);
        yield* publishProjection();
      }),
    );
  });

  const refreshUsageReader = Effect.fn("ProviderUsageLimits.refreshUsageReader")(function* (
    providerInstanceId?: ProviderInstanceId,
  ) {
    const currentProviders = yield* Ref.get(providersRef);
    const instances = yield* providerInstanceRegistry.listInstances;
    yield* Effect.forEach(
      instances,
      (instance) =>
        Effect.gen(function* () {
          if (providerInstanceId !== undefined && instance.instanceId !== providerInstanceId)
            return;
          const provider = currentProviders.find(
            (candidate) => candidate.instanceId === instance.instanceId,
          );
          if (
            provider === undefined ||
            provider.driver !== instance.driverKind ||
            !isEligibleProviderUsageLimitsProvider(provider) ||
            instance.readUsageLimits === undefined
          ) {
            return;
          }
          const limits = yield* instance.readUsageLimits;
          if (limits === undefined) return;
          const observedAt = DateTime.formatIso(yield* DateTime.now);
          yield* applyUsageLimits({
            providerInstanceId: instance.instanceId,
            driver: instance.driverKind,
            observedAt,
            limits,
          });
        }),
      { concurrency: "unbounded", discard: true },
    );
  });

  yield* providerService.streamEvents.pipe(
    Stream.runForEach((event) => {
      if (event.type === "session.started" && event.providerInstanceId !== undefined) {
        return refreshUsageReader(event.providerInstanceId).pipe(Effect.forkScoped, Effect.asVoid);
      }
      if (event.type !== "account.rate-limits.updated" || event.providerInstanceId === undefined) {
        return Effect.void;
      }
      return applyUsageLimits({
        providerInstanceId: event.providerInstanceId,
        driver: event.provider,
        observedAt: event.createdAt,
        limits: event.payload.limits,
      });
    }),
    Effect.forkScoped,
  );

  yield* providerRegistry.streamChanges.pipe(
    Stream.runForEach((nextProviders) =>
      updateSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.set(providersRef, nextProviders);
          const previous = yield* SubscriptionRef.get(recordsRef);
          const next = pruneIneligibleProviderUsageLimitsRecords(previous, nextProviders);
          yield* SubscriptionRef.set(recordsRef, next);
          yield* enqueuePersistenceDiff(previous, next);
          yield* publishProjection();
        }),
      ),
    ),
    Effect.forkScoped,
  );

  yield* SubscriptionRef.changes(recordsRef).pipe(
    Stream.switchMap((records) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          const nearest = nearestResetEpochMs(records);
          if (nearest === undefined) return yield* Effect.never;
          const currentNow = DateTime.toEpochMillis(yield* DateTime.now);
          yield* Effect.sleep(Duration.millis(Math.max(0, nearest - currentNow)));
        }),
      ),
    ),
    Stream.runForEach(() => pruneExpiredRecords),
    Effect.forkScoped,
  );

  yield* Effect.yieldNow;
  yield* refreshUsageReader();

  return ProviderUsageLimits.of({
    getSnapshots: SubscriptionRef.get(snapshotsRef),
    streamChanges: SubscriptionRef.changes(snapshotsRef),
  });
});

export const ProviderUsageLimitsLive = Layer.effect(ProviderUsageLimits, makeProviderUsageLimits());
