# Provider Usage Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show compact, real Codex and Claude Code five-hour/week percent-used indicators above Search in the web/desktop sidebar, with a per-instance hover/focus detail popover.

**Architecture:** Normalize provider-native limit notifications at the adapter boundary into one typed canonical update. A scoped server service merges sparse per-instance updates, validates eligibility against live provider snapshots, persists atomic per-instance cache files, expires reset windows, and exposes full snapshots over a dedicated authorized WebSocket subscription. Client runtime retains only the latest full snapshot for the active environment; the web sidebar joins it to provider presentation metadata and renders a passive UI.

**Tech Stack:** TypeScript, Effect Schema/Layer/Stream/Ref/PubSub, Vite+ tests, React 19, Effect Atom, Base UI tooltip primitives, Tailwind CSS.

## Global Constraints

- Support web and desktop through the shared web client; mobile is explicitly out of scope.
- Emit only real Codex and Claude Code data. Cursor, Grok, OpenCode, unsupported windows, and synthetic estimates stay hidden.
- Treat all usage values as percent used. Reject and hide provider-native values outside `0..100`; never clamp or guess malformed data.
- Render an instance only when both five-hour and weekly windows are present, valid, unexpired, and correlated to an enabled, installed, available, authenticated provider snapshot.
- Preserve multi-instance identity end to end with `ProviderInstanceId`; never collapse by driver kind.
- Do not expose raw provider payloads, account data, credentials, or cache parse contents over the wire or in logs.
- Do not add a polling loop or continuously repainting UI. Reset expiry uses scheduled sleeps and state revalidation; “updated” text is calculated when rendering/opening.
- Keep the stream remote-safe and single-origin-safe: no filesystem reads in clients and no baked development origins.
- Use focused tests and package typechecks only; do not run repository-wide checks.

---

### Task 1: Define the normalized usage-limit contracts

**Files:**

- Create: `packages/contracts/src/providerUsageLimits.ts`
- Modify: `packages/contracts/src/providerRuntime.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/providerRuntime.test.ts`
- Create: `packages/contracts/src/providerUsageLimits.test.ts`

- [x] **Step 1: Write failing schema tests for public snapshots and canonical sparse updates**

Add tests that decode a complete snapshot and a one-window update, and reject a percentage outside `0..100`, a non-ISO reset timestamp, and a snapshot missing one display window.

The intended contract is:

```ts
export const ProviderUsageLimitWindow = Schema.Struct({
  usedPercent: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(100),
  ),
  resetsAt: IsoDateTime,
});

export const ProviderUsageLimitsUpdate = Schema.Struct({
  fiveHour: Schema.optionalKey(ProviderUsageLimitWindow),
  weekly: Schema.optionalKey(ProviderUsageLimitWindow),
});

export const ProviderUsageLimitsSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  observedAt: IsoDateTime,
  fiveHour: ProviderUsageLimitWindow,
  weekly: ProviderUsageLimitWindow,
});

export const ProviderUsageLimitsStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  entries: Schema.Array(ProviderUsageLimitsSnapshot),
});
```

- [x] **Step 2: Run the contract tests and confirm the missing-contract failure**

Run: `vp test run packages/contracts/src/providerUsageLimits.test.ts packages/contracts/src/providerRuntime.test.ts`

Expected: FAIL because `providerUsageLimits.ts` and the typed runtime payload do not exist.

- [x] **Step 3: Implement and export the schemas**

Create `providerUsageLimits.ts`, export it from `index.ts`, and replace `AccountRateLimitsUpdatedPayload.rateLimits: Schema.Unknown` with:

```ts
const AccountRateLimitsUpdatedPayload = Schema.Struct({
  limits: ProviderUsageLimitsUpdate,
});
```

Keep the canonical event type name `account.rate-limits.updated`; only its payload becomes normalized and typed.

- [x] **Step 4: Add the dedicated stream RPC contract and authorization-visible method**

Add `WS_METHODS.subscribeProviderUsageLimits = "subscribeProviderUsageLimits"`, define `WsSubscribeProviderUsageLimitsRpc` with an empty payload, `ProviderUsageLimitsStreamEvent` success, `EnvironmentAuthorizationError`, and `stream: true`, then include it in `WsRpcGroup`.

- [x] **Step 5: Run focused tests and typecheck**

Run: `vp test run packages/contracts/src/providerUsageLimits.test.ts packages/contracts/src/providerRuntime.test.ts`

Expected: PASS.

Run: `vp run --filter @t3tools/contracts typecheck`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/contracts/src/providerUsageLimits.ts packages/contracts/src/providerUsageLimits.test.ts packages/contracts/src/providerRuntime.ts packages/contracts/src/providerRuntime.test.ts packages/contracts/src/rpc.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): type provider usage limits"
```

### Task 2: Normalize Codex and Claude native events in their adapters

**Files:**

- Modify: `apps/server/src/provider/Layers/CodexAdapter.ts`
- Modify: `apps/server/src/provider/Layers/CodexAdapter.test.ts`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

- [x] **Step 1: Add failing Codex normalization tests**

Cover:

- primary `windowDurationMins: 300` maps to `fiveHour`;
- secondary `windowDurationMins: 10080` maps to `weekly`;
- primary/secondary positional fallback is used only when duration metadata is absent;
- `resetsAt` epoch seconds becomes ISO time;
- missing `resetsAt`, unknown durations, and non-finite percentages omit only the affected window;
- finite percentages outside the provider contract omit only the affected window;
- the emitted canonical payload is `{ limits }`, while `raw` retains the native payload for existing internal diagnostics.

- [x] **Step 2: Run the Codex adapter test and confirm failure**

Run: `vp test run apps/server/src/provider/Layers/CodexAdapter.test.ts`

Expected: FAIL because the adapter still emits `{ rateLimits: unknown }`.

- [x] **Step 3: Implement a pure Codex normalizer and use it in the notification branch**

Add an exported-for-test helper near the existing event projection helpers:

```ts
export function normalizeCodexUsageLimits(
  snapshot: EffectCodexSchema.V2AccountRateLimitsUpdatedNotification["rateLimits"],
): ProviderUsageLimitsUpdate;
```

Match `300` and `10080` minutes first. When both durations are absent, map primary to five-hour and secondary to weekly. Return no canonical event if neither usable window exists.

- [x] **Step 4: Add failing Claude normalization tests**

Cover:

- `five_hour` maps to `fiveHour`;
- general `seven_day` maps to `weekly`;
- `seven_day_opus`, `seven_day_sonnet`, and `overage` are ignored;
- SDK `utilization` remains percent used without scaling;
- missing utilization/reset or non-finite percentages emit no usage window;
- finite utilization outside the SDK contract emits no usage window;
- sparse Claude events preserve exactly one normalized window for server-side merging.

- [x] **Step 5: Run the Claude adapter test and confirm failure**

Run: `vp test run apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

Expected: FAIL because the adapter still forwards the SDK message as unknown data.

- [x] **Step 6: Implement a pure Claude normalizer and use it in `rate_limit_event`**

Add:

```ts
export function normalizeClaudeUsageLimits(rateLimit: SDKRateLimitInfo): ProviderUsageLimitsUpdate;
```

Convert the SDK reset timestamp to ISO, map only `five_hour` and general `seven_day`, and skip emitting the canonical event when the update is empty.

- [ ] **Step 7: Run focused adapter tests and server typecheck**

Run: `vp test run apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

Expected: PASS.

The focused adapter tests and targeted adapter lint pass. The server package typecheck is deferred
until Task 4 installs authorization and a handler for the RPC contract introduced in Task 1; until
then the RPC group is intentionally incomplete.

Run: `vp run --filter t3 typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/provider/Layers/CodexAdapter.ts apps/server/src/provider/Layers/CodexAdapter.test.ts apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "feat(server): normalize provider usage limits"
```

### Task 3: Build the server-side merge, cache, eligibility, and expiry service

**Files:**

- Create: `apps/server/src/provider/providerUsageLimits.ts`
- Create: `apps/server/src/provider/providerUsageLimits.test.ts`
- Create: `apps/server/src/provider/providerUsageLimitsCache.ts`
- Create: `apps/server/src/provider/providerUsageLimitsCache.test.ts`
- Create: `apps/server/src/provider/Services/ProviderUsageLimits.ts`
- Create: `apps/server/src/provider/Layers/ProviderUsageLimits.ts`
- Create: `apps/server/src/provider/Layers/ProviderUsageLimits.test.ts`

- [ ] **Step 1: Write failing pure projection tests**

Specify pure helpers for:

- merging sparse updates by `ProviderInstanceId` without overwriting the other window;
- accepting only `codex` and `claudeAgent` driver kinds;
- returning a display snapshot only when both reset times are after `now`;
- dropping expired windows from the internal partial record so a later sparse update cannot merge against stale data;
- filtering against `ServerProvider` identity plus `enabled`, `installed`, availability, and `auth.status === "authenticated"`;
- sorting output in current provider-registry order, not map insertion order;
- pruning a removed, driver-mismatched, disabled, unavailable, or unauthenticated instance.

- [ ] **Step 2: Run the pure projection test and confirm failure**

Run: `vp test run apps/server/src/provider/providerUsageLimits.test.ts`

Expected: FAIL because the projection helpers do not exist.

- [ ] **Step 3: Implement the pure merge/projection module**

Use an internal partial record:

```ts
interface ProviderUsageLimitsRecord {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly observedAt: IsoDateTime;
  readonly fiveHour?: ProviderUsageLimitWindow;
  readonly weekly?: ProviderUsageLimitWindow;
}
```

Make time an explicit `nowEpochMs` argument so all expiry behavior is deterministic under tests.

- [ ] **Step 4: Write failing cache tests**

Test one atomic JSON file per instance using `<providerStatusCacheDir>/<instanceId>.usage-limits.json`. Verify round-trip, missing file, invalid JSON/schema, instance/driver mismatch rejection, and non-sensitive warning attributes that do not contain invalid file contents.

- [ ] **Step 5: Run cache tests and confirm failure**

Run: `vp test run apps/server/src/provider/providerUsageLimitsCache.test.ts`

Expected: FAIL because the cache module does not exist.

- [ ] **Step 6: Implement the cache module**

Follow `providerStatusCache.ts`: Effect `FileSystem`/`Path`, `Schema.fromJsonString`, and `writeFileStringAtomically`. Export path resolution, read, and write helpers. Log only path, expected identity, and structural error tag.

- [ ] **Step 7: Write failing service-layer tests with controlled streams and clock**

Use test layers for `ProviderService`, `ProviderRegistry`, `ServerConfig`, platform services, and `TestClock`. Verify:

- valid cached entries form the initial full snapshot while expired cached windows are discarded;
- a sparse five-hour event followed by weekly event merges and emits one complete entry;
- every emission contains the full current array;
- registry changes immediately remove ineligible entries and delete them from in-memory output;
- advancing `TestClock` past either reset prunes the expired window from state/cache and removes the entry without polling;
- cache read/write failures are logged and do not fail the stream;
- events without `providerInstanceId` or with mismatched/unsupported drivers are ignored.

- [ ] **Step 8: Run the service-layer tests and confirm failure**

Run: `vp test run apps/server/src/provider/Layers/ProviderUsageLimits.test.ts`

Expected: FAIL because the service and live layer do not exist.

- [ ] **Step 9: Implement `ProviderUsageLimits` and its live layer**

The service interface exposes:

```ts
interface ProviderUsageLimitsShape {
  readonly getSnapshots: Effect.Effect<ReadonlyArray<ProviderUsageLimitsSnapshot>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ProviderUsageLimitsSnapshot>>;
}
```

The layer must:

1. load and correlate caches for current provider instances;
2. subscribe to `ProviderService.streamEvents` and process only typed `account.rate-limits.updated` events;
3. subscribe to `ProviderRegistry.streamChanges` for eligibility/removal changes;
4. publish only when the projected full array changes;
5. persist merged records atomically after valid updates;
6. drive expiry from `SubscriptionRef.changes(records).pipe(Stream.switchMap(...))`: each state change interrupts the prior sleep and schedules exactly one sleep for the nearest reset across all records; on wake, prune every expired window from state/cache and re-project.

Batch cache persistence with a short bounded `Stream.groupedWithin` window and keep only the latest pending record per instance in each batch. This prevents a burst of native events from producing redundant atomic writes while preserving multi-instance updates.

- [ ] **Step 10: Run focused server tests and typecheck**

Run: `vp test run apps/server/src/provider/providerUsageLimits.test.ts apps/server/src/provider/providerUsageLimitsCache.test.ts apps/server/src/provider/Layers/ProviderUsageLimits.test.ts`

Expected: PASS.

Run: `vp run --filter t3 typecheck`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/provider/providerUsageLimits.ts apps/server/src/provider/providerUsageLimits.test.ts apps/server/src/provider/providerUsageLimitsCache.ts apps/server/src/provider/providerUsageLimitsCache.test.ts apps/server/src/provider/Services/ProviderUsageLimits.ts apps/server/src/provider/Layers/ProviderUsageLimits.ts apps/server/src/provider/Layers/ProviderUsageLimits.test.ts
git commit -m "feat(server): track provider usage limit snapshots"
```

### Task 4: Wire the server service into the authorized RPC stream

**Files:**

- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/auth/RpcAuthorization.ts`
- Modify: `apps/server/src/auth/RpcAuthorization.test.ts`
- Modify: `apps/server/src/server.test.ts`

- [ ] **Step 1: Add failing authorization and WebSocket stream tests**

Assert `subscribeProviderUsageLimits` requires `AuthOrchestrationReadScope`. In the server test harness, assert a subscriber receives an immediate `{ version: 1, type: "snapshot", entries }`, followed by full snapshots from service changes, with no raw runtime payload fields.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `vp test run apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/server.test.ts`

Expected: FAIL because the method has no scope, handler, or layer dependency.

- [ ] **Step 3: Wire the live layer once into runtime dependencies**

Import `ProviderUsageLimitsLive` in `server.ts` and provide-merge it alongside provider runtime/registry services so the entire process and every remote client share one cache and one event subscription. A server process is one environment; the client keeps this stream environment-scoped because its connection registry can attach to multiple server processes.

- [ ] **Step 4: Add the WebSocket handler**

Resolve the service in `makeWsRpcLayer` and implement:

```ts
[WS_METHODS.subscribeProviderUsageLimits]: () =>
  observeRpcStreamEffect(
    WS_METHODS.subscribeProviderUsageLimits,
    providerUsageLimits.getSnapshots.pipe(
      Effect.map((initial) =>
        Stream.concat(
          Stream.make({ version: 1, type: "snapshot", entries: initial }),
          providerUsageLimits.streamChanges.pipe(
            Stream.map((entries) => ({ version: 1, type: "snapshot", entries })),
          ),
        ),
      ),
    ),
    { "rpc.aggregate": "server" },
  )
```

Ensure the service stream does not replay the same current value after the explicit initial snapshot; test and use a changes-only stream or de-duplicate in the handler.

- [ ] **Step 5: Declare read authorization and run tests/typecheck**

Run: `vp test run apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/server.test.ts`

Expected: PASS.

Run: `vp run --filter t3 typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/server.ts apps/server/src/ws.ts apps/server/src/auth/RpcAuthorization.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/server.test.ts
git commit -m "feat(server): stream provider usage limits"
```

### Task 5: Add environment-scoped client runtime state

**Files:**

- Modify: `packages/client-runtime/src/state/server.ts`
- Modify: `packages/client-runtime/src/state/server.test.ts`
- Modify: `apps/web/src/state/server.ts`
- Create: `apps/web/src/state/server.test.ts`

- [ ] **Step 1: Add failing client-runtime subscription tests**

Extend the environment RPC test layer with `subscribeProviderUsageLimits`. Assert the returned atom family subscribes with the target environment id, retains only the latest full event, and isolates two environment ids.

- [ ] **Step 2: Run the client-runtime test and confirm failure**

Run: `vp test run packages/client-runtime/src/state/server.test.ts`

Expected: FAIL because `serverEnvironment.usageLimits` does not exist.

- [ ] **Step 3: Add the subscription atom family**

In `createServerEnvironmentAtoms`, return:

```ts
usageLimits: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
  label: "environment-data:server:provider-usage-limits",
  tag: WS_METHODS.subscribeProviderUsageLimits,
}),
```

Use no client persistence; the server-owned cache supplies startup snapshots.

- [ ] **Step 4: Add a failing web-state projection test**

Test a pure helper that resolves `ReadonlyArray<ProviderUsageLimitsSnapshot>` from the latest event and returns the shared empty constant for null/failure/pending state.

- [ ] **Step 5: Run the web-state test and confirm failure**

Run: `vp test run apps/web/src/state/server.test.ts`

Expected: FAIL because the primary usage-limit atom/helper does not exist.

- [ ] **Step 6: Implement the primary-environment atom**

Add `primaryProviderUsageLimitsAtom` in `apps/web/src/state/server.ts`. It reads `primaryEnvironmentIdAtom`, then the latest `serverEnvironment.usageLimits({ environmentId, input: {} })` event via `AsyncResult.value`, and returns `event.entries` or the module-level empty array.

- [ ] **Step 7: Run focused tests and typechecks**

Run: `vp test run packages/client-runtime/src/state/server.test.ts apps/web/src/state/server.test.ts`

Expected: PASS.

Run: `vp run --filter @t3tools/client-runtime typecheck`

Expected: PASS.

Run: `vp run --filter @t3tools/web typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/client-runtime/src/state/server.ts packages/client-runtime/src/state/server.test.ts apps/web/src/state/server.ts apps/web/src/state/server.test.ts
git commit -m "feat(client): subscribe to provider usage limits"
```

### Task 6: Render compact sidebar chips and detail popovers

**Files:**

- Create: `apps/web/src/components/sidebar/ProviderUsageLimitIndicators.tsx`
- Create: `apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx`
- Modify: `apps/web/src/components/SidebarV2.tsx`

- [ ] **Step 1: Add failing pure view-model tests**

Export and test `buildProviderUsageLimitIndicators(limits, providers, nowEpochMs)`. It must:

- join strictly by instance id and driver;
- include only Codex and Claude Code instances that remain enabled/installed/available/authenticated;
- preserve provider order;
- use configured accent color, otherwise Codex blue and Claude orange;
- round display percentages consistently after contract validation;
- derive accessible provider/instance labels and reset/updated text;
- return nothing if either reset has passed.

- [ ] **Step 2: Add failing static markup tests for compact and detail content**

Render a presentation-only `ProviderUsageLimitIndicatorsView` with explicit props and assert:

- resting chips contain no visible “Codex” or “Claude” names;
- each chip shows the colored dot, `5h NN%`, divider, and `wk NN%` in that order;
- each chip is a focusable button with a descriptive `aria-label`;
- detail content includes the instance display name, two mini meters, percent-used values, reset labels, and last-updated age;
- the wrapper uses a compact two-column/wrapping layout and carries `group-data-[collapsible=icon]:hidden` so it disappears with the sidebar.

- [ ] **Step 3: Run the component test and confirm failure**

Run: `vp test run apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 4: Implement the pure view model and memoized view**

Use a `Tooltip`/`TooltipTrigger`/rich `TooltipPopup` per chip: Base UI supplies hover and keyboard-focus behavior without click state or custom timers. Use static `<div role="meter">` rails with inline width based on percent used and no animation. Default dots are stable palette values; valid `accentColor` overrides them.

Keep `Date.now()` outside any interval. Recompute relative text only from new state or component render; the feature must not create a ticking render loop.

- [ ] **Step 5: Connect the state and insert it directly above Search**

The stateful wrapper reads `primaryProviderUsageLimitsAtom` and `primaryServerProvidersAtom`, builds its view model with `useMemo`, and returns null for an empty list. Insert `<ProviderUsageLimitIndicators />` as the first child of the `SidebarV2` fixed `SidebarGroup`, immediately before the existing search/new-thread row.

- [ ] **Step 6: Run focused web tests and typecheck**

Run: `vp test run apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx`

Expected: PASS.

Run: `vp run --filter @t3tools/web typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/sidebar/ProviderUsageLimitIndicators.tsx apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx apps/web/src/components/SidebarV2.tsx
git commit -m "feat(web): show provider usage limit chips"
```

### Task 7: Document, verify, and review the integrated feature

**Files:**

- Modify: `docs/user/providers-codex.md`
- Modify: `docs/user/providers-claude.md`
- Modify as findings require: files from Tasks 1–6

- [ ] **Step 1: Document visible behavior and data availability**

In shipped-product voice, document that web/desktop shows five-hour and weekly percent-used chips only after the provider reports real limit data, that hover/focus reveals resets and update time, and that expired/incomplete/unsupported data is hidden. Do not mention source paths, internal caches, or development commands.

- [ ] **Step 2: Run the focused regression suite**

Run:

```bash
vp test run \
  packages/contracts/src/providerUsageLimits.test.ts \
  packages/contracts/src/providerRuntime.test.ts \
  apps/server/src/provider/Layers/CodexAdapter.test.ts \
  apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
  apps/server/src/provider/providerUsageLimits.test.ts \
  apps/server/src/provider/providerUsageLimitsCache.test.ts \
  apps/server/src/provider/Layers/ProviderUsageLimits.test.ts \
  apps/server/src/auth/RpcAuthorization.test.ts \
  apps/server/src/server.test.ts \
  packages/client-runtime/src/state/server.test.ts \
  apps/web/src/state/server.test.ts \
  apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run targeted package typechecks**

Run:

```bash
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter @t3tools/web typecheck
```

Expected: all PASS.

- [ ] **Step 4: Inspect the final diff for scope and surface coverage**

Run: `git diff --check && git status --short && git diff --stat HEAD~7..HEAD`

Confirm:

- web and desktop share the finished UI;
- mobile has no dangling contract/client requirement;
- only Codex and Claude adapters emit usable limit windows;
- RPC authorization covers remote clients;
- no credentials, raw provider payloads, `.t3`, `.pnpm-store`, or `.superpowers` artifacts are tracked;
- no unrelated user changes are included.

- [ ] **Step 5: Request a focused final code review and resolve verified findings**

Use the `superpowers:requesting-code-review` workflow against the feature branch diff. Treat review comments as hypotheses: reproduce or verify each against the code and focused tests before changing behavior.

- [ ] **Step 6: Re-run affected tests after review fixes**

Run the smallest tests and typechecks covering any edited files, then repeat `git diff --check`.

- [ ] **Step 7: Commit documentation or review fixes**

```bash
git add docs/user/providers-codex.md docs/user/providers-claude.md
git commit -m "docs: explain provider usage limit indicators"
```

If review fixes touched code, include those files in a separate conventional commit with the narrowest accurate title.
