import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";

import type { ProviderUsageLimitsRecord } from "./providerUsageLimits.ts";
import {
  readProviderUsageLimitsCache,
  resolveProviderUsageLimitsCachePath,
  writeProviderUsageLimitsCache,
} from "./providerUsageLimitsCache.ts";

const instanceId = ProviderInstanceId.make("codex_personal");
const codex = ProviderDriverKind.make("codex");
const record: ProviderUsageLimitsRecord = {
  providerInstanceId: instanceId,
  driver: codex,
  observedAt: "2026-07-31T12:00:00.000Z",
  fiveHour: { usedPercent: 20, resetsAt: "2026-07-31T17:00:00.000Z" },
  weekly: { usedPercent: 60, resetsAt: "2026-08-07T12:00:00.000Z" },
};

it.layer(NodeServices.layer)("providerUsageLimitsCache", (it) => {
  it.effect("resolves one usage-limit cache file per provider instance", () =>
    Effect.gen(function* () {
      const path = yield* resolveProviderUsageLimitsCachePath({
        cacheDir: "/tmp/provider-cache",
        instanceId,
      });
      assert.strictEqual(path, "/tmp/provider-cache/codex_personal.usage-limits.json");
    }),
  );

  it.effect("round-trips a correlated record and treats a missing file as empty", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-limits-" });
      const filePath = yield* resolveProviderUsageLimitsCachePath({ cacheDir, instanceId });

      assert.strictEqual(
        yield* readProviderUsageLimitsCache({
          filePath,
          expectedProviderInstanceId: instanceId,
          expectedDriver: codex,
        }),
        undefined,
      );

      yield* writeProviderUsageLimitsCache({ filePath, record });
      assert.deepStrictEqual(
        yield* readProviderUsageLimitsCache({
          filePath,
          expectedProviderInstanceId: instanceId,
          expectedDriver: codex,
        }),
        record,
      );
    }),
  );

  it.effect("rejects instance and driver mismatches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-limits-" });
      const filePath = yield* resolveProviderUsageLimitsCachePath({ cacheDir, instanceId });
      yield* writeProviderUsageLimitsCache({ filePath, record });

      assert.strictEqual(
        yield* readProviderUsageLimitsCache({
          filePath,
          expectedProviderInstanceId: ProviderInstanceId.make("codex_work"),
          expectedDriver: codex,
        }),
        undefined,
      );
      assert.strictEqual(
        yield* readProviderUsageLimitsCache({
          filePath,
          expectedProviderInstanceId: instanceId,
          expectedDriver: ProviderDriverKind.make("claudeAgent"),
        }),
        undefined,
      );
    }),
  );

  it.effect("logs structural diagnostics without exposing invalid cache contents", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (Array.isArray(options.message)) messages.push(...options.message);
      else messages.push(options.message);
    });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-limits-" });
      const filePath = yield* resolveProviderUsageLimitsCachePath({ cacheDir, instanceId });
      const secret = "do-not-log-this-cache-content";
      yield* fs.writeFileString(filePath, `{ "credential": "${secret}" }`);

      assert.strictEqual(
        yield* readProviderUsageLimitsCache({
          filePath,
          expectedProviderInstanceId: instanceId,
          expectedDriver: codex,
        }),
        undefined,
      );
      const failure = messages.find(
        (message): message is Record<string, unknown> =>
          typeof message === "object" && message !== null && "path" in message,
      );
      assert.exists(failure);
      assert.strictEqual(failure.path, filePath);
      assert.strictEqual(failure.expectedProviderInstanceId, instanceId);
      assert.strictEqual(failure.expectedDriver, codex);
      assert.strictEqual(typeof failure.errorTag, "string");
      assert.ok(!Object.values(failure).map(String).join("\n").includes(secret));
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
});
