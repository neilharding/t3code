import {
  IsoDateTime,
  ProviderDriverKind,
  type ProviderInstanceId,
  ProviderInstanceId as ProviderInstanceIdSchema,
  ProviderUsageLimitWindow,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { ProviderUsageLimitsRecord } from "./providerUsageLimits.ts";

const ProviderUsageLimitsRecordCache = Schema.Struct({
  providerInstanceId: ProviderInstanceIdSchema,
  driver: ProviderDriverKind,
  observedAt: IsoDateTime,
  fiveHour: Schema.optionalKey(ProviderUsageLimitWindow),
  weekly: Schema.optionalKey(ProviderUsageLimitWindow),
});

const decodeProviderUsageLimitsCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderUsageLimitsRecordCache),
);

export const resolveProviderUsageLimitsCachePath = Effect.fn("resolveProviderUsageLimitsCachePath")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
  }): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    return path.join(input.cacheDir, `${input.instanceId}.usage-limits.json`);
  },
);

export const readProviderUsageLimitsCache = Effect.fn("readProviderUsageLimitsCache")(
  function* (input: {
    readonly filePath: string;
    readonly expectedProviderInstanceId: ProviderInstanceId;
    readonly expectedDriver: ProviderDriverKind;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(input.filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return undefined;

    const raw = yield* fs.readFileString(input.filePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return undefined;

    const decoded = yield* decodeProviderUsageLimitsCache(raw).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse provider usage limits cache, ignoring", {
            path: input.filePath,
            expectedProviderInstanceId: input.expectedProviderInstanceId,
            expectedDriver: input.expectedDriver,
            errorTag: causeErrorTag(cause),
          }).pipe(Effect.as(undefined)),
        onSuccess: Effect.succeed,
      }),
    );
    if (
      decoded === undefined ||
      decoded.providerInstanceId !== input.expectedProviderInstanceId ||
      decoded.driver !== input.expectedDriver
    ) {
      return undefined;
    }
    return decoded satisfies ProviderUsageLimitsRecord;
  },
);

export const writeProviderUsageLimitsCache = (input: {
  readonly filePath: string;
  readonly record: ProviderUsageLimitsRecord;
}) =>
  writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${JSON.stringify(input.record, null, 2)}\n`,
  });
