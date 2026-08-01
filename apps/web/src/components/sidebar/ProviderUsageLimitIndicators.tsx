import { useAtomValue } from "@effect/atom-react";
import type {
  ProviderInstanceId,
  ProviderUsageLimitsSnapshot,
  ServerProvider,
} from "@t3tools/contracts";
import { memo, useMemo, useState } from "react";

import {
  deriveProviderInstanceEntries,
  normalizeProviderAccentColor,
} from "../../providerInstances";
import { primaryProviderUsageLimitsAtom, primaryServerProvidersAtom } from "../../state/server";
import { ClaudeAI, OpenAI } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DEFAULT_COLORS = {
  codex: "#3b82f6",
  claudeAgent: "#f97316",
} as const;

export const PROVIDER_USAGE_TOOLTIP_DELAY = 0;
export const PROVIDER_USAGE_TOOLTIP_CLOSE_DELAY = 0;

export function resolveProviderUsageTooltipOpen(
  currentOpen: boolean,
  requestedOpen: boolean | "toggle",
): boolean {
  return requestedOpen === "toggle" ? !currentOpen : requestedOpen;
}

interface ProviderUsageLimitIndicatorBase {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: "codex" | "claudeAgent";
  readonly label: string;
  readonly color: string;
}

export interface ProviderUsageLimitIndicatorPending extends ProviderUsageLimitIndicatorBase {
  readonly state: "pending";
}

export interface ProviderUsageLimitIndicatorReady extends ProviderUsageLimitIndicatorBase {
  readonly state: "ready";
  readonly fiveHourPercent?: number;
  readonly weeklyPercent?: number;
  readonly fiveHourResetLabel?: string;
  readonly weeklyResetLabel?: string;
  readonly updatedLabel: string;
}

export type ProviderUsageLimitIndicator =
  | ProviderUsageLimitIndicatorPending
  | ProviderUsageLimitIndicatorReady;

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
  return deriveProviderInstanceEntries(providers).flatMap<ProviderUsageLimitIndicator>(
    (provider) => {
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
      const base = {
        providerInstanceId: provider.instanceId,
        driver: provider.driverKind === "codex" ? "codex" : "claudeAgent",
        label: provider.displayName,
        color:
          normalizeProviderAccentColor(provider.accentColor) ??
          (provider.driverKind === "codex" ? DEFAULT_COLORS.codex : DEFAULT_COLORS.claudeAgent),
      } as const;
      if (usage === undefined || usage.driver !== provider.driverKind) {
        return [{ ...base, state: "pending" as const }];
      }
      const fiveHourResetLabel = usage.fiveHour
        ? formatFutureDuration(usage.fiveHour.resetsAt, nowEpochMs)
        : null;
      const weeklyResetLabel = usage.weekly
        ? formatFutureDuration(usage.weekly.resetsAt, nowEpochMs)
        : null;
      const hasFiveHour =
        usage.fiveHour !== undefined &&
        isValidPercent(usage.fiveHour.usedPercent) &&
        fiveHourResetLabel !== null;
      const hasWeekly =
        usage.weekly !== undefined &&
        isValidPercent(usage.weekly.usedPercent) &&
        weeklyResetLabel !== null;
      if (!hasFiveHour && !hasWeekly) {
        return [{ ...base, state: "pending" as const }];
      }
      return [
        {
          ...base,
          state: "ready" as const,
          ...(hasFiveHour
            ? {
                fiveHourPercent: Math.round(usage.fiveHour.usedPercent),
                fiveHourResetLabel,
              }
            : {}),
          ...(hasWeekly
            ? {
                weeklyPercent: Math.round(usage.weekly.usedPercent),
                weeklyResetLabel,
              }
            : {}),
          updatedLabel: formatUpdatedAge(usage.observedAt, nowEpochMs),
        },
      ];
    },
  );
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
  readonly indicator: ProviderUsageLimitIndicatorReady;
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
      {indicator.fiveHourPercent !== undefined && indicator.fiveHourResetLabel !== undefined ? (
        <UsageMeter
          label="5 hour"
          percent={indicator.fiveHourPercent}
          resetLabel={indicator.fiveHourResetLabel}
          color={indicator.color}
        />
      ) : null}
      {indicator.weeklyPercent !== undefined && indicator.weeklyResetLabel !== undefined ? (
        <UsageMeter
          label="Week"
          percent={indicator.weeklyPercent}
          resetLabel={indicator.weeklyResetLabel}
          color={indicator.color}
        />
      ) : null}
      <div className="border-t pt-2 text-[11px] text-muted-foreground">
        Updated {indicator.updatedLabel}
      </div>
    </div>
  );
}

export function ProviderUsageLimitPendingDetail(props: {
  readonly indicator: ProviderUsageLimitIndicatorPending;
}) {
  return (
    <div className="w-52 space-y-2 py-1.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2 rounded-full"
          style={{ backgroundColor: props.indicator.color }}
        />
        <span className="truncate text-sm font-semibold">{props.indicator.label}</span>
      </div>
      <p className="text-xs text-muted-foreground">Waiting for usage data from this provider.</p>
    </div>
  );
}

function ProviderUsageLimitIndicatorChip(props: {
  readonly indicator: ProviderUsageLimitIndicator;
}) {
  const { indicator } = props;
  const [open, setOpen] = useState(false);
  const ProviderIcon = indicator.driver === "codex" ? OpenAI : ClaudeAI;
  const usageLabel =
    indicator.state === "ready"
      ? [
          indicator.fiveHourPercent === undefined
            ? "5 hour unavailable"
            : `5 hour ${indicator.fiveHourPercent}% used`,
          indicator.weeklyPercent === undefined
            ? "week unavailable"
            : `week ${indicator.weeklyPercent}% used`,
        ].join(", ")
      : "waiting for real usage data";

  return (
    <Tooltip
      open={open}
      onOpenChange={(nextOpen) =>
        setOpen((wasOpen) => resolveProviderUsageTooltipOpen(wasOpen, nextOpen))
      }
    >
      <TooltipTrigger
        closeOnClick={false}
        delay={PROVIDER_USAGE_TOOLTIP_DELAY}
        closeDelay={PROVIDER_USAGE_TOOLTIP_CLOSE_DELAY}
        render={
          <button
            type="button"
            aria-label={`${indicator.label} usage: ${usageLabel}`}
            onClick={() => setOpen((wasOpen) => resolveProviderUsageTooltipOpen(wasOpen, "toggle"))}
            className="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md border border-sidebar-border/70 bg-sidebar-control-surface px-2 text-[11px] font-medium tabular-nums text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          />
        }
      >
        <ProviderIcon aria-hidden className="size-3 shrink-0" />
        <span>
          5h{" "}
          {indicator.state === "ready" && indicator.fiveHourPercent !== undefined
            ? `${indicator.fiveHourPercent}%`
            : "—"}
        </span>
        <span aria-hidden className="text-sidebar-muted-foreground/50">
          |
        </span>
        <span>
          wk{" "}
          {indicator.state === "ready" && indicator.weeklyPercent !== undefined
            ? `${indicator.weeklyPercent}%`
            : "—"}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="right" align="start" sideOffset={8} className="px-2 py-1">
        {indicator.state === "ready" ? (
          <ProviderUsageLimitDetail indicator={indicator} />
        ) : (
          <ProviderUsageLimitPendingDetail indicator={indicator} />
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

export const ProviderUsageLimitIndicatorsView = memo(
  function ProviderUsageLimitIndicatorsView(props: {
    readonly indicators: ReadonlyArray<ProviderUsageLimitIndicator>;
  }) {
    return (
      <div className="grid grid-cols-2 gap-1 group-data-[collapsible=icon]:hidden">
        {props.indicators.map((indicator) => (
          <ProviderUsageLimitIndicatorChip
            key={indicator.providerInstanceId}
            indicator={indicator}
          />
        ))}
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
