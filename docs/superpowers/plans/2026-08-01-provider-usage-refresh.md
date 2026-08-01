# Provider usage refresh amendment

> **For implementation:** Execute this plan in order, with focused tests after
> each behavior change. Preserve user-owned untracked workspace files.

**Goal:** Keep authenticated Codex and Claude Code usage chips visible while
real data is pending, and replace Claude's unreliable passive telemetry with a
provider-owned usage refresh path.

**Architecture:** The sidebar derives eligible provider instances independently
of the usage snapshot. An absent or invalid snapshot produces a waiting
indicator; a complete unexpired snapshot upgrades that same chip to percentages
and meters. Server-side per-instance usage readers provide normalized sparse
updates to the existing usage-limit service. Runtime events stay a fast-path.

**Safety boundaries:** Credential material is read and used only in the server.
No tokens reach contracts, logs, caches, or clients. Do not use browser cookies
or initiate Keychain prompts. No periodic polling loop is introduced.

## 1. Add pending indicators

**Files:**

- Modify `apps/web/src/components/sidebar/ProviderUsageLimitIndicators.tsx`
- Modify `apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx`

1. Represent a usage indicator as either `pending` or `ready`.
2. Produce a pending indicator for enabled, installed, available, authenticated
   Codex/Claude instances missing a valid complete snapshot.
3. Render the compact dash labels and a waiting popover for pending indicators.
4. Add focused coverage for eligibility, placeholder rendering, and upgrade to
   real data.

## 2. Define an internal provider usage reader

**Files:**

- Modify `apps/server/src/provider/ProviderDriver.ts`
- Modify `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- Modify `apps/server/src/provider/Drivers/CodexDriver.ts`
- Add focused reader modules/tests under `apps/server/src/provider/Drivers/`

1. Add an optional per-instance reader that returns a normalized sparse usage
   update or a non-sensitive no-data result.
2. Implement Claude's reader from its configured local OAuth credential file
   and documented OAuth usage endpoint, parsing only the two supported windows.
3. Implement Codex's reader through its app-server `account/rateLimits/read`
   protocol in the configured Codex home context.
4. Validate payload structure and reset times before an update is accepted.

## 3. Refresh in the usage service

**Files:**

- Modify `apps/server/src/provider/Layers/ProviderUsageLimits.ts`
- Modify `apps/server/src/provider/Layers/ProviderUsageLimits.test.ts`

1. Depend on `ProviderInstanceRegistry` and refresh each eligible live reader
   at service startup and after provider-instance registry changes.
2. Merge reader updates through the exact same validation, correlation,
   persistence, expiry, and publication route as runtime events.
3. Log failures by provider instance and error category only; leave waiting
   chips intact when no real data is available.

## 4. Document and verify

**Files:**

- Modify the user-facing provider usage documentation.

1. Explain pending chips and supported authenticated data paths.
2. Run focused server/web tests, touched package typechecks, and lint.
3. Rebuild the running desktop server bundle, then ask before browser-based
   visual verification if it remains useful.
