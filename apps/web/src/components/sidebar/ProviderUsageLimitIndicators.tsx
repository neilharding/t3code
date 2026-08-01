import { useAtomValue } from "@effect/atom-react";
import type {
  ProviderInstanceId,
  ProviderUsageLimitsSnapshot,
  ServerProvider,
} from "@t3tools/contracts";
import { memo, useMemo, type CSSProperties } from "react";

import {
  deriveProviderInstanceEntries,
  normalizeProviderAccentColor,
} from "../../providerInstances";
import { primaryProviderUsageLimitsAtom, primaryServerProvidersAtom } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DEFAULT_COLORS = {
  codex: "#3b82f6",
  claudeAgent: "#f97316",
} as const;

export interface ProviderUsageLimitIndicator {
  readonly providerInstanceId: ProviderInstanceId;
  readonly label: string;
  readonly color: string;
  readonly fiveHourPercent: number;
  readonly weeklyPercent: number;
  readonly fiveHourResetLabel: string;
  readonly weeklyResetLabel: string;
  readonly updatedLabel: string;
}

const isValidPercent = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 100;

function formatFutureDuration(timestamp: string, nowEpochMs: number): string | null {
  const resetEpochMs = Date.parse(timestamp);
  if (!Number.isFinite(resetEpochMs) || resetEpochMs <= nowEpochMs) return null;
  const minutes = Math.ceil((resetEpochMs - nowEpochMs) / 60_000);
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return `in ${minutes / (24 * 60)}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `in ${minutes / 60}h`;
  if (minutes >= 60) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

function formatUpdatedAge(timestamp: string, nowEpochMs: number): string {
  const observedAt = Date.parse(timestamp);
  if (!Number.isFinite(observedAt) || observedAt >= nowEpochMs) return "just now";
  const minutes = Math.floor((nowEpochMs - observedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function buildProviderUsageLimitIndicators(
  limits: ReadonlyArray<ProviderUsageLimitsSnapshot>,
  providers: ReadonlyArray<ServerProvider>,
  nowEpochMs: number,
): ReadonlyArray<ProviderUsageLimitIndicator> {
  const limitsByInstance = new Map(limits.map((entry) => [entry.providerInstanceId, entry]));
  return deriveProviderInstanceEntries(providers).flatMap((provider) => {
    const snapshot = provider.snapshot;
    if (
      (provider.driverKind !== "codex" && provider.driverKind !== "claudeAgent") ||
      !provider.enabled ||
      !provider.installed ||
      !provider.isAvailable ||
      snapshot.auth.status !== "authenticated"
    ) {
      return [];
    }
    const usage = limitsByInstance.get(provider.instanceId);
    if (
      usage === undefined ||
      usage.driver !== provider.driverKind ||
      !isValidPercent(usage.fiveHour.usedPercent) ||
      !isValidPercent(usage.weekly.usedPercent)
    ) {
      return [];
    }
    const fiveHourResetLabel = formatFutureDuration(usage.fiveHour.resetsAt, nowEpochMs);
    const weeklyResetLabel = formatFutureDuration(usage.weekly.resetsAt, nowEpochMs);
    if (fiveHourResetLabel === null || weeklyResetLabel === null) return [];
    return [
      {
        providerInstanceId: provider.instanceId,
        label: provider.displayName,
        color:
          normalizeProviderAccentColor(provider.accentColor) ??
          (provider.driverKind === "codex" ? DEFAULT_COLORS.codex : DEFAULT_COLORS.claudeAgent),
        fiveHourPercent: Math.round(usage.fiveHour.usedPercent),
        weeklyPercent: Math.round(usage.weekly.usedPercent),
        fiveHourResetLabel,
        weeklyResetLabel,
        updatedLabel: formatUpdatedAge(usage.observedAt, nowEpochMs),
      },
    ];
  });
}

function UsageMeter(props: {
  readonly label: string;
  readonly percent: number;
  readonly resetLabel: string;
  readonly color: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium text-popover-foreground">{props.label}</span>
        <span className="tabular-nums text-popover-foreground">{props.percent}% used</span>
      </div>
      <div
        role="meter"
        aria-label={`${props.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${props.percent}%`, backgroundColor: props.color }}
        />
      </div>
      <div className="text-[11px] text-muted-foreground">Resets {props.resetLabel}</div>
    </div>
  );
}

export function ProviderUsageLimitDetail(props: {
  readonly indicator: ProviderUsageLimitIndicator;
}) {
  const { indicator } = props;
  return (
    <div className="w-52 space-y-3 py-1.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2 rounded-full"
          style={{ backgroundColor: indicator.color }}
        />
        <span className="truncate text-sm font-semibold">{indicator.label}</span>
      </div>
      <UsageMeter
        label="5 hour"
        percent={indicator.fiveHourPercent}
        resetLabel={indicator.fiveHourResetLabel}
        color={indicator.color}
      />
      <UsageMeter
        label="Week"
        percent={indicator.weeklyPercent}
        resetLabel={indicator.weeklyResetLabel}
        color={indicator.color}
      />
      <div className="border-t pt-2 text-[11px] text-muted-foreground">
        Updated {indicator.updatedLabel}
      </div>
    </div>
  );
}

export const ProviderUsageLimitIndicatorsView = memo(
  function ProviderUsageLimitIndicatorsView(props: {
    readonly indicators: ReadonlyArray<ProviderUsageLimitIndicator>;
  }) {
    return (
      <div className="grid grid-cols-2 gap-1 group-data-[collapsible=icon]:hidden">
        {props.indicators.map((indicator) => {
          const dotStyle = { backgroundColor: indicator.color } satisfies CSSProperties;
          return (
            <Tooltip key={indicator.providerInstanceId}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${indicator.label} usage: 5 hour ${indicator.fiveHourPercent}% used, week ${indicator.weeklyPercent}% used`}
                    className="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md border border-sidebar-border/70 bg-sidebar-control-surface px-2 text-[11px] font-medium tabular-nums text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  />
                }
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={dotStyle} />
                <span>5h {indicator.fiveHourPercent}%</span>
                <span aria-hidden className="text-sidebar-muted-foreground/50">
                  |
                </span>
                <span>wk {indicator.weeklyPercent}%</span>
              </TooltipTrigger>
              <TooltipPopup side="right" align="start" sideOffset={8} className="px-2 py-1">
                <ProviderUsageLimitDetail indicator={indicator} />
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    );
  },
);

export const ProviderUsageLimitIndicators = memo(function ProviderUsageLimitIndicators() {
  const limits = useAtomValue(primaryProviderUsageLimitsAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const indicators = useMemo(
    () => buildProviderUsageLimitIndicators(limits, providers, Date.now()),
    [limits, providers],
  );
  return indicators.length === 0 ? null : (
    <ProviderUsageLimitIndicatorsView indicators={indicators} />
  );
});
