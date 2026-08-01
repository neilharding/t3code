import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageLimitsSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  buildProviderUsageLimitIndicators,
  ProviderUsageLimitDetail,
  ProviderUsageLimitIndicatorsView,
} from "./ProviderUsageLimitIndicators";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const codexId = ProviderInstanceId.make("codex_personal");
const claudeId = ProviderInstanceId.make("claude_work");
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const makeProvider = (
  instanceId: ReturnType<typeof ProviderInstanceId.make>,
  driver: ReturnType<typeof ProviderDriverKind.make>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver,
  displayName: driver === codex ? "Codex" : "Claude Code",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-31T12:00:00.000Z",
  availability: "available",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const makeLimits = (
  providerInstanceId: ReturnType<typeof ProviderInstanceId.make>,
  driver: ReturnType<typeof ProviderDriverKind.make>,
  overrides: Partial<ProviderUsageLimitsSnapshot> = {},
): ProviderUsageLimitsSnapshot => ({
  providerInstanceId,
  driver,
  observedAt: "2026-07-31T11:55:00.000Z",
  fiveHour: { usedPercent: 20.4, resetsAt: "2026-07-31T17:00:00.000Z" },
  weekly: { usedPercent: 60.6, resetsAt: "2026-08-07T12:00:00.000Z" },
  ...overrides,
});

describe("buildProviderUsageLimitIndicators", () => {
  it("joins by instance and driver in provider order with configured/default colors", () => {
    const providers = [
      makeProvider(claudeId, claude, { accentColor: "#123456" }),
      makeProvider(codexId, codex),
    ];
    const indicators = buildProviderUsageLimitIndicators(
      [makeLimits(codexId, codex), makeLimits(claudeId, claude)],
      providers,
      NOW,
    );

    expect(indicators.map((indicator) => indicator.providerInstanceId)).toEqual([
      claudeId,
      codexId,
    ]);
    expect(indicators[0]).toMatchObject({
      color: "#123456",
      fiveHourPercent: 20,
      weeklyPercent: 61,
    });
    expect(indicators[1]?.color).toBe("#3b82f6");
  });

  it.each([
    ["driver mismatch", makeProvider(codexId, claude)],
    ["disabled", makeProvider(codexId, codex, { enabled: false })],
    ["not installed", makeProvider(codexId, codex, { installed: false })],
    ["unavailable", makeProvider(codexId, codex, { availability: "unavailable" })],
    ["unauthenticated", makeProvider(codexId, codex, { auth: { status: "unauthenticated" } })],
  ])("hides %s instances", (_label, provider) => {
    expect(
      buildProviderUsageLimitIndicators([makeLimits(codexId, codex)], [provider], NOW),
    ).toEqual([]);
  });

  it("hides incomplete, expired, unsupported, and out-of-range data", () => {
    expect(
      buildProviderUsageLimitIndicators(
        [
          makeLimits(codexId, codex, {
            fiveHour: { usedPercent: 101, resetsAt: "2026-07-31T17:00:00.000Z" },
          }),
        ],
        [makeProvider(codexId, codex)],
        NOW,
      ),
    ).toEqual([]);
    expect(
      buildProviderUsageLimitIndicators(
        [
          makeLimits(codexId, codex, {
            weekly: { usedPercent: 60, resetsAt: "2026-07-31T11:00:00.000Z" },
          }),
        ],
        [makeProvider(codexId, codex)],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("ProviderUsageLimitIndicatorsView", () => {
  const indicator = buildProviderUsageLimitIndicators(
    [makeLimits(codexId, codex)],
    [makeProvider(codexId, codex)],
    NOW,
  )[0]!;

  it("renders compact dot-only chip copy in five-hour then weekly order", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageLimitIndicatorsView indicators={[indicator]} />,
    );
    expect(markup).toContain("group-data-[collapsible=icon]:hidden");
    expect(markup).toContain("grid-cols-2");
    expect(markup).toContain("5h 20%");
    expect(markup).toContain("wk 61%");
    expect(markup.indexOf("5h 20%")).toBeLessThan(markup.indexOf("wk 61%"));
    expect(markup).not.toContain(">Codex<");
    expect(markup).toContain('aria-label="Codex Personal usage: 5 hour 20% used, week 61% used"');
  });

  it("renders detail meters, reset labels, and updated age", () => {
    const markup = renderToStaticMarkup(<ProviderUsageLimitDetail indicator={indicator} />);
    expect(markup).toContain("Codex Personal");
    expect(markup.match(/role="meter"/gu)).toHaveLength(2);
    expect(markup).toContain("20% used");
    expect(markup).toContain("61% used");
    expect(markup).toContain("Resets in 5h");
    expect(markup).toContain("Updated 5m ago");
  });
});
