import * as NodeOS from "node:os";

import type { ClaudeSettings, ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";
import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_PTY_COLS = 100;
const CLAUDE_USAGE_PTY_ROWS = 30;
const CLAUDE_USAGE_PTY_TIMEOUT = "2 seconds";
const MAX_CLAUDE_USAGE_PTY_OUTPUT_LENGTH = 64 * 1024;
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const KEYCHAIN_ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const CLAUDE_MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const LOCAL_TIME_ZONE = DateTime.zoneMakeLocal();
type DateTimeInput = Parameters<typeof DateTime.makeZoned>[0];

const makeLocalDateTime = (input: DateTimeInput): DateTime.Zoned | undefined =>
  Option.getOrUndefined(
    DateTime.makeZoned(input, { timeZone: LOCAL_TIME_ZONE, adjustForTimeZone: true }),
  );

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

const parseWindow = (value: unknown) => {
  const record = asRecord(value);
  const usedPercent = record?.utilization;
  const resetsAt = record?.resets_at;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    typeof resetsAt !== "string" ||
    !Number.isFinite(Date.parse(resetsAt))
  ) {
    return undefined;
  }
  return { usedPercent, resetsAt };
};

const parseCurrentWeeklyLimit = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const record = asRecord(entry);
    if (record?.kind !== "weekly_all" || record.group !== "weekly") continue;
    return parseWindow({ utilization: record.percent, resets_at: record.resets_at });
  }
  return undefined;
};

const stripTerminalControlCharacters = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex -- Claude's rendered terminal panel may contain OSC sequences.
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?/gu, "")
    // eslint-disable-next-line no-control-regex -- Claude's rendered terminal panel may contain CSI sequences.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex -- Remove non-printing terminal control characters after preserving line breaks.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu, "");

const parsePanelPercentage = (line: string): number | undefined => {
  const match = /^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*%(?:\s|$)/u.exec(line);
  if (!match) return undefined;
  const usedPercent = Number(match[1]);
  return Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100
    ? usedPercent
    : undefined;
};

const parseClockTime = (
  text: string,
): { readonly hours: number; readonly minutes: number } | undefined => {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/iu.exec(text.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    return undefined;
  }
  const meridiem = match[3]?.toUpperCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return undefined;
    return {
      hours: (hours % 12) + (meridiem === "PM" ? 12 : 0),
      minutes,
    };
  }
  return hours >= 0 && hours <= 23 ? { hours, minutes } : undefined;
};

const parseRelativeReset = (description: string, nowEpochMs: number): number | undefined => {
  const units =
    /(?<amount>\d+(?:\.\d+)?)\s*(?<unit>days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/giu;
  let consumed = "";
  let totalMs = 0;
  for (const match of description.matchAll(units)) {
    consumed += match[0];
    const amount = Number(match.groups?.amount);
    const unit = match.groups?.unit;
    if (unit === undefined) return undefined;
    const normalizedUnit = unit.toLowerCase();
    const multiplier =
      normalizedUnit === "d" || normalizedUnit === "day" || normalizedUnit === "days"
        ? 86_400_000
        : normalizedUnit === "h" ||
            normalizedUnit === "hr" ||
            normalizedUnit === "hrs" ||
            normalizedUnit === "hour" ||
            normalizedUnit === "hours"
          ? 3_600_000
          : normalizedUnit === "m" ||
              normalizedUnit === "min" ||
              normalizedUnit === "mins" ||
              normalizedUnit === "minute" ||
              normalizedUnit === "minutes"
            ? 60_000
            : 1_000;
    if (!Number.isFinite(amount)) return undefined;
    totalMs += amount * multiplier;
  }
  if (
    !consumed ||
    description.replace(units, "").replace(/[\s,]+/gu, "") ||
    !Number.isFinite(totalMs)
  ) {
    return undefined;
  }
  return nowEpochMs + totalMs;
};

const resolvePanelReset = (line: string, nowEpochMs: number): string | undefined => {
  const match = /^\s*resets\s+(.+?)\s*$/iu.exec(line);
  if (!match || !Number.isFinite(nowEpochMs)) return undefined;
  const descriptionText = match[1];
  if (descriptionText === undefined) return undefined;
  const description = descriptionText.replace(/\s+\([^()]*\)\s*$/u, "");
  let resetEpochMs: number | undefined;

  if (/^in\s+/iu.test(description)) {
    resetEpochMs = parseRelativeReset(description.replace(/^in\s+/iu, ""), nowEpochMs);
  } else {
    const timeAtEnd =
      /^(.*?)(?:,?\s+at\s+|,\s+)(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)$/iu.exec(description) ??
      /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)$/iu.exec(
        description,
      );
    if (!timeAtEnd) return undefined;
    const timeText = timeAtEnd[2];
    if (timeText === undefined) return undefined;
    const clockTime = parseClockTime(timeText);
    if (!clockTime) return undefined;
    const dateText = timeAtEnd[1];
    if (dateText === undefined) return undefined;
    const dateDescription = dateText.trim();
    const now = DateTime.makeZonedUnsafe(nowEpochMs, { timeZone: LOCAL_TIME_ZONE });
    const nowParts = DateTime.toParts(now);
    const weekday = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/iu.exec(
      dateDescription,
    );
    const calendarDate =
      /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/iu.exec(
        dateDescription ?? "",
      );
    if (weekday) {
      const weekdayName = weekday[1];
      if (weekdayName === undefined) return undefined;
      const weekdayIndex = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ].indexOf(weekdayName.toLowerCase());
      const candidate = makeLocalDateTime({
        year: nowParts.year,
        month: nowParts.month,
        day: nowParts.day,
        hour: clockTime.hours,
        minute: clockTime.minutes,
      });
      if (candidate === undefined) return undefined;
      const candidateWeekday = DateTime.toParts(candidate).weekDay;
      const adjustedCandidate = DateTime.add(candidate, {
        days: (weekdayIndex - candidateWeekday + 7) % 7,
      });
      resetEpochMs = DateTime.toEpochMillis(adjustedCandidate);
      if (resetEpochMs <= nowEpochMs) return undefined;
    } else if (calendarDate) {
      const monthText = calendarDate[1];
      const dayText = calendarDate[2];
      if (monthText === undefined || dayText === undefined) return undefined;
      const month = CLAUDE_MONTHS[monthText.toLowerCase()];
      const day = Number(dayText);
      const providedYear = calendarDate[3] === undefined ? undefined : Number(calendarDate[3]);
      if (month === undefined || !Number.isInteger(day)) return undefined;
      const candidate = makeLocalDateTime({
        year: providedYear ?? nowParts.year,
        month,
        day,
        hour: clockTime.hours,
        minute: clockTime.minutes,
      });
      if (candidate === undefined) return undefined;
      resetEpochMs = DateTime.toEpochMillis(candidate);
      if (providedYear === undefined && resetEpochMs <= nowEpochMs) return undefined;
    }
  }
  if (resetEpochMs === undefined || !Number.isFinite(resetEpochMs) || resetEpochMs <= nowEpochMs) {
    return undefined;
  }
  return DateTime.formatIso(DateTime.makeUnsafe(resetEpochMs));
};

const parsePanelWindow = (lines: ReadonlyArray<string>, label: string, nowEpochMs: number) => {
  const labelIndex = lines.reduce<number>(
    (latest, line, index) => (line.trim() === label ? index : latest),
    -1,
  );
  if (labelIndex < 0) return undefined;
  const nextSectionIndex = lines.findIndex(
    (line, index) => index > labelIndex && line.trim().startsWith("Current "),
  );
  const rowLines = lines.slice(
    labelIndex + 1,
    nextSectionIndex < 0 ? labelIndex + 7 : nextSectionIndex,
  );
  const percentageIndex = rowLines.findIndex((line) => parsePanelPercentage(line) !== undefined);
  if (percentageIndex < 0) return undefined;
  const percentageLine = rowLines[percentageIndex];
  if (percentageLine === undefined) return undefined;
  const usedPercent = parsePanelPercentage(percentageLine);
  const resetLine = rowLines.slice(percentageIndex + 1).find((line) => /^\s*resets\b/iu.test(line));
  const resetsAt = resetLine ? resolvePanelReset(resetLine, nowEpochMs) : undefined;
  return usedPercent === undefined || resetsAt === undefined
    ? undefined
    : { usedPercent, resetsAt };
};

/** Parse the explicit session and all-model weekly rows from Claude Code's rendered /usage panel. */
export const parseClaudeUsagePanel = (
  text: string,
  nowEpochMs: number,
): ProviderUsageLimitsUpdate => {
  const lines = stripTerminalControlCharacters(text).split(/\r?\n/u);
  const fiveHour = parsePanelWindow(lines, "Current session", nowEpochMs);
  const weekly = parsePanelWindow(lines, "Current week (all models)", nowEpochMs);
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
};

/** Parse only the two plan windows T3 Code displays. */
export const parseClaudeUsageLimits = (payload: unknown): ProviderUsageLimitsUpdate => {
  const record = asRecord(payload);
  const fiveHour = parseWindow(record?.five_hour);
  // Anthropic's newer `limits` collection supersedes the legacy flat fields
  // when both are present. Prefer its all-models weekly limit so reset times
  // stay aligned with Claude Code's current usage panel.
  const weekly = parseCurrentWeeklyLimit(record?.limits) ?? parseWindow(record?.seven_day);
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
};

const extractOAuthToken = (payload: unknown): string | undefined => {
  const record = asRecord(payload);
  const oauth = asRecord(record?.claudeAiOauth) ?? record;
  const token = oauth?.accessToken;
  return typeof token === "string" && token.startsWith("sk-ant-oat") ? token : undefined;
};

const resolveKeychainAccount = (): string => {
  let account: string;
  try {
    account = process.env.USER || NodeOS.userInfo().username;
  } catch {
    account = "claude-code-user";
  }
  return KEYCHAIN_ACCOUNT_PATTERN.test(account) ? account : "claude-code-user";
};

const readJsonFile = Effect.fn("readClaudeUsageLimitsCredentials")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  if (!contents) return undefined;
  return yield* decodeUnknownJson(contents).pipe(Effect.orElseSucceed(() => undefined));
});

const readClaudeOAuthToken = Effect.fn("readClaudeOAuthToken")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const path = yield* Path.Path;
  const configDir = input.config.homePath.trim()
    ? path.resolve(expandHomePath(input.config.homePath))
    : input.environment.CLAUDE_CONFIG_DIR?.trim()
      ? path.resolve(input.environment.CLAUDE_CONFIG_DIR)
      : path.join(NodeOS.homedir(), ".claude");
  const fromFile = extractOAuthToken(
    yield* readJsonFile(path.join(configDir, ".credentials.json")),
  );
  if (fromFile) return fromFile;

  // Claude Code commonly stores this same JSON record in the macOS keychain.
  // `security` performs a read-only lookup and does not modify or export it.
  if (process.platform !== "darwin") return undefined;
  const keychainJson = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* input.childProcessSpawner.spawn(
        ChildProcess.make("security", [
          "find-generic-password",
          "-a",
          resolveKeychainAccount(),
          "-s",
          "Claude Code-credentials",
          "-w",
        ]),
      );
      const [stdout, exitCode] = yield* Effect.all([
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        ),
        child.exitCode,
      ]);
      return exitCode === 0 ? stdout : undefined;
    }),
  ).pipe(
    Effect.timeoutOption("3 seconds"),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  if (!keychainJson) return undefined;
  return extractOAuthToken(
    yield* decodeUnknownJson(keychainJson).pipe(Effect.orElseSucceed(() => undefined)),
  );
});

const hasUsageLimits = (limits: ProviderUsageLimitsUpdate): boolean =>
  limits.fiveHour !== undefined || limits.weekly !== undefined;

const hasCompleteUsagePanel = (limits: ProviderUsageLimitsUpdate): boolean =>
  limits.fiveHour !== undefined && limits.weekly !== undefined;

const mergeUsageLimits = (
  fallback: ProviderUsageLimitsUpdate,
  preferred: ProviderUsageLimitsUpdate | undefined,
): ProviderUsageLimitsUpdate => ({
  ...(fallback.fiveHour ? { fiveHour: fallback.fiveHour } : {}),
  ...(fallback.weekly ? { weekly: fallback.weekly } : {}),
  ...(preferred?.fiveHour ? { fiveHour: preferred.fiveHour } : {}),
  ...(preferred?.weekly ? { weekly: preferred.weekly } : {}),
});

const probeClaudeUsagePanel = Effect.fn("probeClaudeUsagePanel")(function* (input: {
  readonly config: Pick<ClaudeSettings, "binaryPath" | "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly ptyAdapter?: PtyAdapter.PtyAdapter["Service"];
}) {
  const ptyAdapter = input.ptyAdapter;
  if (!ptyAdapter) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const nowEpochMs = yield* Clock.currentTimeMillis;
  const claudeEnvironment = yield* makeClaudeEnvironment(input.config, input.environment);
  const resolvedCommand = yield* resolveSpawnCommand(input.config.binaryPath, [], {
    env: claudeEnvironment,
  });
  const probeDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-claude-usage-probe-",
  });
  const process = yield* ptyAdapter.spawn({
    shell: resolvedCommand.shell
      ? (claudeEnvironment.ComSpec ?? "cmd.exe")
      : resolvedCommand.command,
    args: resolvedCommand.shell
      ? ["/d", "/s", "/c", resolvedCommand.command, ...resolvedCommand.args]
      : [...resolvedCommand.args],
    cwd: probeDirectory,
    cols: CLAUDE_USAGE_PTY_COLS,
    rows: CLAUDE_USAGE_PTY_ROWS,
    env: claudeEnvironment,
  });
  const result = yield* Deferred.make<ProviderUsageLimitsUpdate | undefined>();
  let unsubscribeData: () => void = () => undefined;
  let unsubscribeExit: () => void = () => undefined;

  let output = "";
  let latestLimits: ProviderUsageLimitsUpdate | undefined;
  const finish = (value: ProviderUsageLimitsUpdate | undefined = latestLimits) => {
    Deferred.doneUnsafe(result, Effect.succeed(value));
  };

  return yield* Effect.sync(() => {
    unsubscribeData = process.onData((data) => {
      if (data.length > MAX_CLAUDE_USAGE_PTY_OUTPUT_LENGTH - output.length) {
        finish(undefined);
        return;
      }
      output += data;
      const limits = parseClaudeUsagePanel(output, nowEpochMs);
      if (hasUsageLimits(limits)) latestLimits = limits;
      if (hasCompleteUsagePanel(limits)) finish(limits);
    });
    unsubscribeExit = process.onExit(() => finish());
    process.write("/usage\n");
  }).pipe(
    Effect.andThen(
      Deferred.await(result).pipe(
        Effect.timeoutOption(CLAUDE_USAGE_PTY_TIMEOUT),
        Effect.map((value) => Option.getOrElse(value, () => latestLimits)),
      ),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        unsubscribeData();
        unsubscribeExit();
        process.kill();
      }),
    ),
  );
});

/**
 * Fetches the same OAuth usage snapshot Claude Code uses, without creating a
 * Claude session. Credential material stays in this server process.
 */
export const readClaudeUsageLimits = Effect.fn("readClaudeUsageLimits")(function* (input: {
  readonly config: Pick<ClaudeSettings, "binaryPath" | "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ptyAdapter?: PtyAdapter.PtyAdapter["Service"];
}) {
  const cliLimits = yield* Effect.scoped(probeClaudeUsagePanel(input)).pipe(
    Effect.orElseSucceed(() => undefined),
  );

  const token = yield* readClaudeOAuthToken(input);
  if (!token) return cliLimits;
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const response = yield* client.execute(request).pipe(Effect.orElseSucceed(() => undefined));
  if (!response || response.status < 200 || response.status >= 300) return cliLimits;
  const payload = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  const limits = mergeUsageLimits(parseClaudeUsageLimits(payload), cliLimits);
  return hasUsageLimits(limits) ? limits : undefined;
});
