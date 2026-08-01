# Provider Usage Indicator Follow-ups

## Goal

Make the provider usage indicators trustworthy and quick to use by reading Claude Code’s rendered `/usage` panel, opening the existing detail popover on hover or click, and showing recognizable provider logos in the compact chips.

## Scope

- Claude Code usage: run a short-lived Claude CLI `/usage` probe using the existing authenticated local CLI installation; parse only explicit session and all-model weekly rows; fall back to the existing authenticated HTTP reader when the CLI is unavailable or cannot produce a valid snapshot.
- Indicator interaction: reduce the hover delay for these indicators only, preserve the existing hoverable detail content, and make the chip click toggle the same detail popover.
- Indicator identity: replace the colored dot with small Codex and Claude Code logo marks while retaining provider-specific color accents for meters and borders.
- Keep provider usage privacy boundaries: credentials and raw CLI output never cross the WebSocket or enter persistent usage-limit records.

## Design

### Claude CLI probe

`readClaudeUsageLimits` will compose a CLI probe before its current HTTP request. The probe launches `claude` in a temporary working directory, drives `/usage` through a PTY-compatible process interface, captures the rendered output with a bounded timeout, and always terminates/cleans up the child process. A parser converts explicit labels into the existing `ProviderUsageLimitsUpdate` shape:

- `Current session` supplies the five-hour percentage and reset description.
- `Current week (all models)` supplies the weekly percentage and reset description.
- Missing, loading, subscription-only, malformed, or non-future reset values make that window unavailable rather than guessing.

The probe uses local Claude authentication but does not expose credentials to the client. If it fails for any reason, the existing OAuth HTTP endpoint remains the fallback so a provider with valid data still appears. Tests use captured CLI text fixtures and a fake process boundary; no test launches a real provider session.

### Chip interaction

Each indicator owns a controlled open state. The hover trigger uses a shorter delay than the global tooltip default and retains a short close delay. Pointer/click activation toggles the controlled state, while focus and Escape continue to work through the existing Base UI tooltip primitives. The popover content and partial-window behavior remain unchanged.

### Provider logos

The chip uses a small inline provider mark selected from the provider driver kind. Codex uses the existing OpenAI/Codex mark and Claude Code uses a simple Claude mark from the project’s icon set. The mark is decorative when the accessible label already names the provider; provider color remains available to meters and other non-logo affordances.

## Error handling and compatibility

- CLI probe timeout, missing binary, non-zero exit, invalid text, and cleanup failures are contained within the reader and trigger HTTP fallback.
- HTTP and CLI values are normalized through the same percentage and future-reset validation.
- No new wire fields are required for the UI interaction or logo work; the existing versioned usage stream remains the privacy boundary.

## Verification

- Parser tests cover session/week extraction, reset parsing, malformed/loading output, and unavailable fallback behavior.
- Reader tests cover CLI success and HTTP fallback without launching a real process.
- Component tests cover shortened delay props, click toggling, keyboard accessibility, and provider-specific logo marks.
- Run focused server and web tests, web/server type checks for touched packages, `git diff --check`, and a production build.
