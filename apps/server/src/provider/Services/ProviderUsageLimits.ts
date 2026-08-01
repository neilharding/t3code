import type { ProviderUsageLimitsSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ProviderUsageLimitsShape {
  readonly getSnapshots: Effect.Effect<ReadonlyArray<ProviderUsageLimitsSnapshot>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ProviderUsageLimitsSnapshot>>;
}

export class ProviderUsageLimits extends Context.Service<
  ProviderUsageLimits,
  ProviderUsageLimitsShape
>()("t3/provider/Services/ProviderUsageLimits") {}
