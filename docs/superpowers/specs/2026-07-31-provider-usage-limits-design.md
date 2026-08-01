# Provider Usage Limit Indicators

Status: Approved

## Summary

Show compact Codex and Claude Code usage-limit indicators immediately above the desktop/web sidebar search box. Each supported provider instance gets its own chip containing an accent-color dot, its 5-hour percent used, and its weekly percent used. Hovering or focusing a chip opens a provider-specific popover with named meters, reset times, and snapshot age.

Usage data remains environment-owned. Provider adapters normalize native payloads, a server service merges and caches snapshots per provider instance, and desktop/web clients consume a dedicated typed stream. Unsupported providers and incomplete or expired snapshots do not render.

## Goals

- Show real 5-hour and weekly percent-used data for Codex and Claude Code.
- Keep the resting UI compact enough to sit above sidebar search.
- Preserve correct behavior for multiple instances of the same provider.
- Display cached real data immediately after startup, then replace it with fresh events.
- Work identically in the shared desktop/web client, including remote connections.
- Keep provider-specific parsing at adapter boundaries.

## Non-goals

- Cursor, Grok, OpenCode, or providers without real native limit data.
- Mobile UI.
- Aggregating multiple accounts or provider instances.
- Model-specific Claude weekly limits such as `seven_day_opus` or `seven_day_sonnet`.
- Estimating, scraping, or deriving limits from token usage.
- Active polling that creates provider conversations or API usage.

## User experience

The expanded sidebar renders a two-column, wrapping row directly above search. Each chip contains:

1. The provider instance accent-color dot.
2. `5h <percent>%`.
3. A subtle divider.
4. `wk <percent>%`.

Codex defaults to blue and Claude Code defaults to orange. A configured provider-instance accent color overrides the default. Additional instances wrap into more rows. The collapsed sidebar hides the row.

Hovering or keyboard-focusing a chip opens a popover containing:

- the provider instance display name, falling back to the driver display name;
- a 5-hour meter with percent used and local reset time;
- a weekly meter with percent used and local reset time; and
- relative snapshot age.

The popover and the trigger's accessible label include the provider name, so color is not the only identifier. Chips have no click action and no continuous animation.

## Contracts

Add a provider-neutral usage contract keyed by provider instance:

```ts
interface ProviderUsageLimitWindow {
  usedPercent: number; // integer, 0 through 100
  resetsAt: IsoDateTime;
}

interface ProviderUsageLimitsSnapshot {
  providerInstanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
  observedAt: IsoDateTime;
  fiveHour?: ProviderUsageLimitWindow;
  weekly?: ProviderUsageLimitWindow;
}
```

The wire stream carries an initial array snapshot followed by replacement updates. A replacement may contain one or both windows; the server service owns merging. Removal events identify a provider instance whose renderable snapshot no longer exists.

Contract schemas reject percentages outside `0..100`, invalid timestamps, and invalid provider identities. The UI only receives normalized data.

## Provider normalization

### Codex

Normalize `account/rateLimits/updated` notifications at the Codex adapter boundary.

- The 300-minute primary window becomes `fiveHour`.
- The 10,080-minute secondary window becomes `weekly`.
- When duration metadata is absent, primary and secondary are accepted as the respective fallback positions.
- Native `usedPercent` is passed through after schema validation.

### Claude Code

Normalize Claude Agent SDK `rate_limit_event` messages at the Claude adapter boundary.

- `five_hour` becomes `fiveHour`.
- General `seven_day` becomes `weekly`.
- Native `utilization` becomes `usedPercent`.
- `seven_day_opus`, `seven_day_sonnet`, `overage`, and messages without utilization or reset time do not populate the two compact windows.

Adapters emit a typed canonical usage event rather than placing provider-native data in `Schema.Unknown`.

## Server usage service

Create a scoped server service that subscribes to the canonical provider runtime event stream and owns a map keyed by `ProviderInstanceId`.

For every normalized event, the service:

1. Verifies the event's instance/driver correlation.
2. Merges the supplied window into the instance snapshot.
3. Drops any window whose reset time has passed.
4. Persists the resulting valid snapshot atomically.
5. Publishes a replacement or removal update.

The service hydrates per-instance cache files during startup. Cached windows are accepted only when the cached instance and driver still match a configured provider and their reset times remain in the future. Disabled, unavailable, unauthenticated, removed, or mismatched instances are excluded immediately.

An instance is renderable only when both `fiveHour` and `weekly` are present and unexpired. Expiration is condition-driven from the nearest reset time rather than a continuously repainting client timer. Cache-write failures are logged with non-sensitive metadata and do not interrupt in-memory updates.

## Transport and client state

Expose a dedicated typed RPC subscription rather than attaching usage to the slower provider-status snapshot.

- The initial subscription event contains all currently renderable snapshots.
- Subsequent events replace or remove one provider instance.
- Reconnect receives a fresh initial snapshot, so clients do not depend on missed deltas.
- The shared client runtime owns environment-scoped usage state.
- The web primary-environment atom selects the current environment's snapshots for the sidebar.

This keeps local, remote/relay, tunnel, multi-device, and multi-environment behavior aligned with existing connection semantics.

## Failure and stale-data behavior

- Unsupported provider kinds never produce snapshots.
- Incomplete snapshots stay cached internally but remain hidden until both windows exist.
- A window disappears at its reset time if no fresh event has replaced it; losing either required window hides the chip.
- Malformed provider data is ignored and logged, never clamped or guessed.
- Cache parse failures fall back to no data.
- Stream or connection failure follows existing environment synchronization behavior; the client does not manufacture new values.
- A cached but unexpired snapshot is labeled by its real age in the popover.

## Testing

Add focused tests for:

- contract acceptance and rejection boundaries;
- Codex primary/secondary and duration-based normalization;
- Claude `five_hour`/`seven_day` normalization and ignored model-specific limits;
- partial-window merging, multi-instance isolation, and driver correlation;
- cache write/read, hydration, invalid cache rejection, and reset-time expiry;
- provider disable/removal/auth transitions;
- RPC initial snapshots, replacements, removals, and reconnect behavior;
- shared client-runtime environment scoping; and
- sidebar chips, ordering/wrapping, percent-used labels, hidden incomplete data, hover popovers, and keyboard focus.

Use focused package tests, lint, and typechecks for touched workspaces. Perform one integrated desktop/web pass after implementation with explicit user approval for browser automation if needed.

## Surfaces and documentation

- Desktop and locally hosted/public web use the shared web sidebar and are in scope.
- Mobile is unchanged.
- Provider decisions are explicit: Codex and Claude Code supported; Cursor, Grok, and OpenCode unsupported until they expose real limit data.
- Add user documentation describing supported providers, percent-used semantics, cached startup values, reset expiry, and the popover.
