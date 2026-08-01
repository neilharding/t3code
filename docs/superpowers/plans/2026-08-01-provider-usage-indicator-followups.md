# Provider Usage Indicator Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude usage authoritative from Claude Code’s `/usage` panel, make usage chips open quickly on hover or click, and replace provider dots with Codex/Claude logos.

**Architecture:** Keep the existing `ProviderUsageLimitsUpdate` contract and privacy boundary. Add a pure Claude `/usage` text parser plus a PTY-backed reader in the server; the existing OAuth HTTP reader remains the fallback. Keep chip presentation in `ProviderUsageLimitIndicators`, using the existing `OpenAI` and `ClaudeAI` icon components and a controlled Base UI tooltip state per chip.

**Tech Stack:** Effect services and `PtyAdapter`/`ChildProcessSpawner` on the server, React/Base UI tooltip primitives on the web, Vite Plus focused tests, TypeScript, and the existing provider usage contracts.

## Global Constraints

- Do not expose Claude credentials or raw `/usage` output over WebSocket or in persisted usage records.
- Do not fabricate a usage window or reset timestamp when CLI output is missing, malformed, loading, or non-future.
- Preserve HTTP fallback behavior when Claude CLI probing fails.
- Keep the compact chip order as five-hour first, then weekly.
- Use only the existing provider logo components; do not add external image dependencies.
- Verify touched server/web tests and build; do not run repo-wide checks.

---

### Task 1: Add a pure Claude `/usage` panel parser

**Files:**

- Modify: `apps/server/src/provider/Drivers/ClaudeUsageLimits.ts`
- Test: `apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts`

**Interfaces:**

- Consumes: captured Claude CLI text, current epoch time, and the existing `ProviderUsageLimitWindow` shape.
- Produces: `parseClaudeUsagePanel(text: string, nowEpochMs: number): ProviderUsageLimitsUpdate`.

- [ ] **Step 1: Write the failing parser tests.** Cover `Current session`, `Current week (all models)`, relative reset durations, explicit weekday/date reset strings, malformed percentages, expired resets, loading text, subscription-only text, and empty output. A valid fixture must produce `fiveHour` and `weekly`; an invalid row must omit only that row.
- [ ] **Step 2: Run the parser test file and verify the expected red failure.**

```bash
vp test run apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts --exclude .worktrees --exclude .pnpm-store
```

Expected: the new parser tests fail because `parseClaudeUsagePanel` does not exist.

- [ ] **Step 3: Implement the minimal pure parser.** Strip ANSI/control characters, locate the latest exact label occurrence, parse its percentage and following reset line, resolve relative durations from `nowEpochMs`, resolve explicit weekday/date/time forms in the server’s local timezone, and return ISO timestamps only when finite and future. Reject percentages outside 0–100 and treat loading/subscription notices as unavailable.
- [ ] **Step 4: Re-run the focused parser tests and confirm green.**
- [ ] **Step 5: Commit the parser.**

```bash
git add apps/server/src/provider/Drivers/ClaudeUsageLimits.ts apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts
git commit -m "feat(usage): parse Claude Code usage panel"
```

### Task 2: Probe Claude Code through an isolated PTY with HTTP fallback

**Files:**

- Modify: `apps/server/src/provider/Drivers/ClaudeUsageLimits.ts`
- Modify: `apps/server/src/provider/Drivers/ClaudeDriver.ts`
- Modify: `apps/server/src/provider/Drivers/ClaudeDriver.test.ts` or the existing Claude usage test file
- Modify: `apps/server/src/terminal/PtyAdapter.ts` only if cleanup primitives are missing
- Test: `apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts`

**Interfaces:**

- Consumes: `PtyAdapter`, `ChildProcessSpawner`, Claude settings/environment, `parseClaudeUsagePanel`, and the existing OAuth token/HTTP reader.
- Produces: `readClaudeUsageLimits(input)` that tries the bounded CLI probe first and returns the existing HTTP-normalized snapshot when the probe is unavailable or invalid.

- [ ] **Step 1: Write failing reader tests.** Add a fake PTY that emits a valid panel after receiving `/usage\n`; assert CLI output wins and HTTP is not called. Add a timeout/spawn-failure case that asserts HTTP fallback, and a cleanup case that asserts the fake PTY is killed.
- [ ] **Step 2: Run the focused reader tests and verify red.**

```bash
vp test run apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts --exclude .worktrees --exclude .pnpm-store
```

Expected: the new reader tests fail because the reader does not yet use `PtyAdapter`.

- [ ] **Step 3: Implement the bounded PTY probe.** Inject `PtyAdapter` into `ClaudeDriverEnv` and provide it when constructing `readClaudeUsageLimits`. Resolve the configured Claude executable, create a temporary probe directory, spawn a fixed-size PTY with inherited Claude auth environment, write `/usage` and Enter, collect output until a valid panel or timeout, and always unregister listeners, kill the PTY, and clean temporary artifacts. Convert every probe failure into the existing HTTP fallback path.
- [ ] **Step 4: Run the reader and provider tests green.**

```bash
vp test run apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts apps/server/src/provider/Drivers/ClaudeDriver.test.ts --exclude .worktrees --exclude .pnpm-store
```

- [ ] **Step 5: Commit the probe.**

```bash
git add apps/server/src/provider/Drivers/ClaudeUsageLimits.ts apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts apps/server/src/provider/Drivers/ClaudeDriver.ts apps/server/src/provider/Drivers/ClaudeDriver.test.ts apps/server/src/terminal/PtyAdapter.ts
git commit -m "feat(usage): read Claude limits from CLI usage panel"
```

### Task 3: Make usage chips fast and click-toggleable

**Files:**

- Modify: `apps/web/src/components/sidebar/ProviderUsageLimitIndicators.tsx`
- Test: `apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx`

**Interfaces:**

- Consumes: existing `ProviderUsageLimitIndicator` values and Base UI tooltip root/trigger props.
- Produces: one controlled tooltip per chip with a short hover delay, click toggle behavior, and provider-specific logo content.

- [ ] **Step 1: Write failing component tests.** Assert the compact view exposes the chosen short timing values, pointer/click toggles its controlled open state, Escape closes it, and Codex/Claude render the existing `OpenAI`/`ClaudeAI` marks.
- [ ] **Step 2: Run the component tests and verify red.**

```bash
vp test run apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx --exclude .worktrees --exclude .pnpm-store
```

Expected: the new tests fail because the chips currently use colored dot spans, global tooltip timing, and uncontrolled hover-only behavior.

- [ ] **Step 3: Implement the interaction and logos.** Use local `open` state and `onOpenChange` per chip, pass the shortest supported Base UI delay/close-delay props, and make button click toggle the controlled state without breaking keyboard focus/Escape behavior. Import `OpenAI` and `ClaudeAI` from `apps/web/src/components/Icons.tsx`, render the selected mark compactly with `aria-hidden`, and preserve the existing labels, percentage order, partial-window dashes, and detail content.
- [ ] **Step 4: Re-run the component tests and confirm green.**
- [ ] **Step 5: Commit the UI changes.**

```bash
git add apps/web/src/components/sidebar/ProviderUsageLimitIndicators.tsx apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx
git commit -m "feat(usage): improve indicator interaction and branding"
```

### Task 4: Integrate, verify, and refresh the desktop bundle

**Files:**

- Modify: any files changed by Tasks 1–3 after formatting or type fixes.
- Test: focused server and web tests listed below.

**Interfaces:**

- Consumes: the completed parser/probe and chip UI behavior.
- Produces: a built desktop/server bundle ready for the existing dev supervisor and fork PR.

- [ ] **Step 1: Run focused regression tests.**

```bash
vp test run apps/server/src/provider/Drivers/ClaudeUsageLimits.test.ts apps/server/src/provider/Drivers/ClaudeDriver.test.ts apps/web/src/components/sidebar/ProviderUsageLimitIndicators.test.tsx apps/server/src/provider/providerUsageLimits.test.ts packages/contracts/src/providerUsageLimits.test.ts --exclude .worktrees --exclude .pnpm-store
```

- [ ] **Step 2: Run package type checks.**

```bash
vp run --filter t3 typecheck
vp run --filter web typecheck
```

Record pre-existing diagnostics separately; no new diagnostics should mention changed files.

- [ ] **Step 3: Build and inspect the diff.**

```bash
vp run --filter t3 build
git diff --check
git status --short
```

The build must exit successfully, and only the known untracked `.pnpm-store/` and `.superpowers/` directories may remain.

- [ ] **Step 4: Push the branch.**

```bash
git push origin codex/provider-usage-limits
```

- [ ] **Step 5: Refresh the running desktop app.** Ask the user to press Cmd-Q once; the existing `vp run dev:desktop` supervisor will relaunch with the newly built bundle. Perform visual verification only with explicit user permission.
