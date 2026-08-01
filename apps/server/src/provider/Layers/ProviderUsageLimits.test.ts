import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderUsageLimitsUpdate,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderUsageLimits } from "../Services/ProviderUsageLimits.ts";
import {
  resolveProviderUsageLimitsCachePath,
  writeProviderUsageLimitsCache,
} from "../providerUsageLimitsCache.ts";
import { ProviderUsageLimitsLive } from "./ProviderUsageLimits.ts";

const instanceId = ProviderInstanceId.make("codex_personal");
const codex = ProviderDriverKind.make("codex");
const resetFiveHour = "1970-01-01T00:00:10.000Z";
const resetWeekly = "1970-01-01T00:00:20.000Z";

const makeProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId,
  driver: codex,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  availability: "available",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const makeUsageEvent = (
  createdAt: string,
  limits: ProviderUsageLimitsUpdate,
): ProviderRuntimeEvent => ({
  eventId: EventId.make(`event-${createdAt}`),
  provider: codex,
  providerInstanceId: instanceId,
  threadId: ThreadId.make("thread-usage-limits"),
  createdAt,
  type: "account.rate-limits.updated",
  payload: { limits },
});

const unsupported = () => Effect.die(new Error("unsupported provider test call")) as never;

it.layer(NodeServices.layer)("ProviderUsageLimitsLive", (it) => {
  it.effect("hydrates a valid complete startup snapshot from cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-limits-cache-" });
      const filePath = yield* resolveProviderUsageLimitsCachePath({ cacheDir, instanceId });
      yield* writeProviderUsageLimitsCache({
        filePath,
        record: {
          providerInstanceId: instanceId,
          driver: codex,
          observedAt: "1970-01-01T00:00:01.000Z",
          fiveHour: { usedPercent: 20, resetsAt: resetFiveHour },
          weekly: { usedPercent: 60, resetsAt: resetWeekly },
        },
      });
      const providers = [makeProvider()];
      const providerService = {
        startSession: unsupported,
        sendTurn: unsupported,
        interruptTurn: unsupported,
        respondToRequest: unsupported,
        respondToUserInput: unsupported,
        stopSession: unsupported,
        listSessions: unsupported,
        getCapabilities: unsupported,
        getInstanceInfo: unsupported,
        rollbackConversation: unsupported,
        streamEvents: Stream.empty,
      } satisfies ProviderServiceShape;
      const providerRegistry = {
        getProviders: Effect.succeed(providers),
        refresh: () => Effect.succeed(providers),
        refreshInstance: () => Effect.succeed(providers),
        getProviderMaintenanceCapabilitiesForInstance: unsupported,
        setProviderMaintenanceActionState: unsupported,
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const snapshots = yield* ProviderUsageLimits.pipe(
        Effect.flatMap((usageLimits) => usageLimits.getSnapshots),
        Effect.provide(ProviderUsageLimitsLive),
        Effect.provide(Layer.succeed(ProviderService, providerService)),
        Effect.provide(Layer.succeed(ProviderRegistry, providerRegistry)),
        Effect.provide(
          Layer.succeed(ServerConfig, {
            providerStatusCacheDir: cacheDir,
          } as ServerConfig["Service"]),
        ),
      );

      assert.strictEqual(snapshots.length, 1);
      assert.strictEqual(snapshots[0]?.fiveHour.usedPercent, 20);
      assert.strictEqual(snapshots[0]?.weekly.usedPercent, 60);
    }),
  );

  it.effect("merges sparse events, emits full snapshots, and removes ineligible providers", () =>
    Effect.gen(function* () {
      const eventBus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
      const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([makeProvider()]);
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-limits-layer-" });
      const providerService = {
        startSession: unsupported,
        sendTurn: unsupported,
        interruptTurn: unsupported,
        respondToRequest: unsupported,
        respondToUserInput: unsupported,
        stopSession: unsupported,
        listSessions: unsupported,
        getCapabilities: unsupported,
        getInstanceInfo: unsupported,
        rollbackConversation: unsupported,
        streamEvents: Stream.fromPubSub(eventBus),
      } satisfies ProviderServiceShape;
      const providerRegistry = {
        getProviders: Ref.get(providersRef),
        refresh: () => Ref.get(providersRef),
        refreshInstance: () => Ref.get(providersRef),
        getProviderMaintenanceCapabilitiesForInstance: unsupported,
        setProviderMaintenanceActionState: unsupported,
        streamChanges: Stream.fromPubSub(providerChanges),
      } satisfies ProviderRegistryShape;
      const config = { providerStatusCacheDir: cacheDir } as ServerConfig["Service"];

      const program = Effect.gen(function* () {
        const usageLimits = yield* ProviderUsageLimits;
        yield* Effect.yieldNow;

        yield* PubSub.publish(
          eventBus,
          makeUsageEvent("1970-01-01T00:00:01.000Z", {
            fiveHour: { usedPercent: 20, resetsAt: resetFiveHour },
          }),
        );
        yield* Effect.yieldNow;
        assert.deepStrictEqual(yield* usageLimits.getSnapshots, []);

        const completedFiber = yield* usageLimits.streamChanges.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* PubSub.publish(
          eventBus,
          makeUsageEvent("1970-01-01T00:00:02.000Z", {
            weekly: { usedPercent: 60, resetsAt: resetWeekly },
          }),
        );
        const completed = yield* Fiber.join(completedFiber);
        assert.strictEqual(Option.getOrThrow(completed)[0]?.fiveHour.usedPercent, 20);
        assert.strictEqual(Option.getOrThrow(completed)[0]?.weekly.usedPercent, 60);

        const removedFiber = yield* usageLimits.streamChanges.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        const disabled = [makeProvider({ enabled: false, status: "disabled" })];
        yield* Ref.set(providersRef, disabled);
        yield* PubSub.publish(providerChanges, disabled);
        assert.deepStrictEqual(Option.getOrThrow(yield* Fiber.join(removedFiber)), []);
      });

      return yield* program.pipe(
        Effect.provide(ProviderUsageLimitsLive),
        Effect.provide(Layer.succeed(ProviderService, providerService)),
        Effect.provide(Layer.succeed(ProviderRegistry, providerRegistry)),
        Effect.provide(Layer.succeed(ServerConfig, config)),
      );
    }),
  );

  it.effect("expires the nearest reset without polling", () =>
    Effect.gen(function* () {
      const eventBus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const providers = [makeProvider()];
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-limits-expiry-" });
      const providerService = {
        startSession: unsupported,
        sendTurn: unsupported,
        interruptTurn: unsupported,
        respondToRequest: unsupported,
        respondToUserInput: unsupported,
        stopSession: unsupported,
        listSessions: unsupported,
        getCapabilities: unsupported,
        getInstanceInfo: unsupported,
        rollbackConversation: unsupported,
        streamEvents: Stream.fromPubSub(eventBus),
      } satisfies ProviderServiceShape;
      const providerRegistry = {
        getProviders: Effect.succeed(providers),
        refresh: () => Effect.succeed(providers),
        refreshInstance: () => Effect.succeed(providers),
        getProviderMaintenanceCapabilitiesForInstance: unsupported,
        setProviderMaintenanceActionState: unsupported,
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const program = Effect.gen(function* () {
        const usageLimits = yield* ProviderUsageLimits;
        yield* Effect.yieldNow;
        yield* PubSub.publish(
          eventBus,
          makeUsageEvent("1970-01-01T00:00:01.000Z", {
            fiveHour: { usedPercent: 20, resetsAt: resetFiveHour },
            weekly: { usedPercent: 60, resetsAt: resetWeekly },
          }),
        );
        yield* Effect.yieldNow;
        assert.strictEqual((yield* usageLimits.getSnapshots).length, 1);

        const expiredFiber = yield* usageLimits.streamChanges.pipe(
          Stream.drop(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        assert.deepStrictEqual(Option.getOrThrow(yield* Fiber.join(expiredFiber)), []);
      });

      return yield* program.pipe(
        Effect.provide(ProviderUsageLimitsLive),
        Effect.provide(Layer.succeed(ProviderService, providerService)),
        Effect.provide(Layer.succeed(ProviderRegistry, providerRegistry)),
        Effect.provide(
          Layer.succeed(ServerConfig, {
            providerStatusCacheDir: cacheDir,
          } as ServerConfig["Service"]),
        ),
      );
    }),
  );
});
