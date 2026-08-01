import * as NodeOS from "node:os";

import type { ClaudeSettings, ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const KEYCHAIN_ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/u;

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

/** Parse only the two plan windows T3 Code displays. */
export const parseClaudeUsageLimits = (payload: unknown): ProviderUsageLimitsUpdate => {
  const record = asRecord(payload);
  const fiveHour = parseWindow(record?.five_hour);
  const weekly = parseWindow(record?.seven_day);
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

/**
 * Fetches the same OAuth usage snapshot Claude Code uses, without creating a
 * Claude session. Credential material stays in this server process.
 */
export const readClaudeUsageLimits = Effect.fn("readClaudeUsageLimits")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const token = yield* readClaudeOAuthToken(input);
  if (!token) return undefined;
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const response = yield* client.execute(request).pipe(Effect.orElseSucceed(() => undefined));
  if (!response || response.status < 200 || response.status >= 300) return undefined;
  const payload = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
  const limits = parseClaudeUsageLimits(payload);
  return limits.fiveHour || limits.weekly ? limits : undefined;
});
