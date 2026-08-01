import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import {
  parseClaudeUsageLimits,
  parseClaudeUsagePanel,
  readClaudeUsageLimits,
} from "./ClaudeUsageLimits.ts";

const panel = [
  "Current session",
  "  19% used",
  "  Resets in 5h",
  "Current week (all models)",
  "  67% used",
  "  Resets in 2d 1h",
].join("\n");

const oauthUsage = {
  five_hour: { utilization: 31, resets_at: "2026-08-01T22:00:00.000Z" },
  seven_day: { utilization: 46, resets_at: "2026-08-05T12:00:00.000Z" },
};

const unusedChildProcessSpawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

const makePty = (onWrite?: (data: string, emit: (data: string) => void) => void) => {
  let dataListener: ((data: string) => void) | undefined;
  const kill = vi.fn();
  const unsubscribeData = vi.fn(() => {
    dataListener = undefined;
  });
  const unsubscribeExit = vi.fn(() => {
    return undefined;
  });
  const process: PtyAdapter.PtyProcess = {
    pid: 123,
    write: (data) => onWrite?.(data, (output) => dataListener?.(output)),
    resize: () => undefined,
    kill,
    onData: (listener) => {
      dataListener = listener;
      return unsubscribeData;
    },
    onExit: () => {
      return unsubscribeExit;
    },
  };
  return { process, kill, unsubscribeData, unsubscribeExit };
};

const runReader = (input: {
  readonly homePath: string;
  readonly ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly environment?: NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    const result = yield* readClaudeUsageLimits({
      config: { homePath: input.homePath, binaryPath: "fake-claude" },
      environment: input.environment ?? {},
      childProcessSpawner: unusedChildProcessSpawner,
      ptyAdapter: input.ptyAdapter,
    });
    return result;
  }).pipe(Effect.provideService(HttpClient.HttpClient, input.httpClient), Effect.scoped);

describe("parseClaudeUsageLimits", () => {
  it("maps Claude's five-hour and seven-day OAuth windows", () => {
    expect(
      parseClaudeUsageLimits({
        five_hour: { utilization: 17.5, resets_at: "2026-08-01T18:00:00.000Z" },
        seven_day: { utilization: 48, resets_at: "2026-08-05T12:00:00.000Z" },
      }),
    ).toEqual({
      fiveHour: { usedPercent: 17.5, resetsAt: "2026-08-01T18:00:00.000Z" },
      weekly: { usedPercent: 48, resetsAt: "2026-08-05T12:00:00.000Z" },
    });
  });

  it("prefers Claude's current weekly-all limit over the legacy seven-day field", () => {
    expect(
      parseClaudeUsageLimits({
        five_hour: { utilization: 17.5, resets_at: "2026-08-01T18:00:00.000Z" },
        seven_day: { utilization: 48, resets_at: "2026-08-05T12:00:00.000Z" },
        limits: [
          {
            kind: "weekly_all",
            group: "weekly",
            percent: 52,
            resets_at: "2026-08-07T10:59:00.000Z",
          },
        ],
      }),
    ).toEqual({
      fiveHour: { usedPercent: 17.5, resetsAt: "2026-08-01T18:00:00.000Z" },
      weekly: { usedPercent: 52, resetsAt: "2026-08-07T10:59:00.000Z" },
    });
  });

  it("ignores malformed, expired-shape, and model-specific values", () => {
    expect(
      parseClaudeUsageLimits({
        five_hour: { utilization: 101, resets_at: "2026-08-01T18:00:00.000Z" },
        seven_day_opus: { utilization: 12, resets_at: "2026-08-05T12:00:00.000Z" },
      }),
    ).toEqual({});
  });
});

it.layer(NodeServices.layer)("readClaudeUsageLimits", (it) => {
  it.effect("returns the Claude usage panel before attempting the OAuth HTTP reader", () => {
    const pty = makePty((data, emit) => {
      if (data === "/usage\n") emit(panel);
    });
    const httpCalls: Array<string> = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        httpCalls.push(request.url);
        return HttpClientResponse.fromWeb(request, Response.json(oauthUsage));
      }),
    );

    return Effect.gen(function* () {
      expect(
        yield* runReader({
          homePath: "",
          ptyAdapter: PtyAdapter.PtyAdapter.of({ spawn: () => Effect.succeed(pty.process) }),
          httpClient,
        }),
      ).toEqual({
        fiveHour: { usedPercent: 19, resetsAt: expect.any(String) },
        weekly: { usedPercent: 67, resetsAt: expect.any(String) },
      });
      expect(httpCalls).toEqual([]);
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(pty.unsubscribeData).toHaveBeenCalledTimes(1);
      expect(pty.unsubscribeExit).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("waits for the weekly panel when the two limits arrive in separate chunks", () => {
    const [session, weekly] = panel.split("Current week (all models)\n");
    const pty = makePty((data, emit) => {
      if (data !== "/usage\n") return;
      emit(session);
      emit(`Current week (all models)\n${weekly}`);
    });
    const httpClient = HttpClient.make(() => Effect.die("HTTP fallback should not run"));

    return Effect.gen(function* () {
      expect(
        yield* runReader({
          homePath: "",
          ptyAdapter: PtyAdapter.PtyAdapter.of({ spawn: () => Effect.succeed(pty.process) }),
          httpClient,
        }),
      ).toEqual({
        fiveHour: { usedPercent: 19, resetsAt: expect.any(String) },
        weekly: { usedPercent: 67, resetsAt: expect.any(String) },
      });
    });
  });

  it.effect("runs a resolved Windows Claude command shim through cmd.exe", () => {
    const pty = makePty((data, emit) => {
      if (data === "/usage\n") emit(panel);
    });
    let spawnInput: PtyAdapter.PtySpawnInput | undefined;
    const httpClient = HttpClient.make(() => Effect.die("HTTP fallback should not run"));

    return Effect.gen(function* () {
      yield* runReader({
        homePath: "",
        environment: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        ptyAdapter: PtyAdapter.PtyAdapter.of({
          spawn: (input) =>
            Effect.sync(() => {
              spawnInput = input;
              return pty.process;
            }),
        }),
        httpClient,
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          SpawnExecutableResolution,
          () => "C:\\Program Files\\Anthropic\\claude.cmd",
        ),
      );

      expect(spawnInput).toEqual({
        shell: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", '^"C:\\Program^ Files\\Anthropic\\claude.cmd^"'],
        cwd: expect.any(String),
        cols: 100,
        rows: 30,
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      });
    });
  });

  it.effect("falls back to OAuth HTTP when the PTY probe cannot start", () => {
    const httpCalls: Array<string> = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        httpCalls.push(request.url);
        return HttpClientResponse.fromWeb(request, Response.json(oauthUsage));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-home-" });
      yield* fs.writeFileString(
        path.join(homePath, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"sk-ant-oat-test"}}',
      );

      const result = yield* readClaudeUsageLimits({
        config: { homePath, binaryPath: "fake-claude" },
        environment: {},
        childProcessSpawner: unusedChildProcessSpawner,
        ptyAdapter: PtyAdapter.PtyAdapter.of({
          spawn: () =>
            Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "test", shell: "fake-claude" })),
        }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

      expect(result).toEqual({
        fiveHour: { usedPercent: 31, resetsAt: "2026-08-01T22:00:00.000Z" },
        weekly: { usedPercent: 46, resetsAt: "2026-08-05T12:00:00.000Z" },
      });
      expect(httpCalls).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
    }).pipe(Effect.scoped);
  });

  it.effect("falls back to OAuth HTTP when the PTY panel is invalid", () => {
    let exitListener: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    const pty = makePty((data, emit) => {
      if (data === "/usage\n") emit("Loading usage…");
      exitListener?.({ exitCode: 1, signal: null });
    });
    const originalOnExit = pty.process.onExit;
    pty.process.onExit = (listener) => {
      exitListener = listener;
      return originalOnExit(listener);
    };
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(oauthUsage))),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-home-" });
      yield* fs.writeFileString(
        path.join(homePath, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"sk-ant-oat-test"}}',
      );

      expect(
        yield* readClaudeUsageLimits({
          config: { homePath, binaryPath: "fake-claude" },
          environment: {},
          childProcessSpawner: unusedChildProcessSpawner,
          ptyAdapter: PtyAdapter.PtyAdapter.of({ spawn: () => Effect.succeed(pty.process) }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      ).toEqual({
        fiveHour: { usedPercent: 31, resetsAt: "2026-08-01T22:00:00.000Z" },
        weekly: { usedPercent: 46, resetsAt: "2026-08-05T12:00:00.000Z" },
      });
    }).pipe(Effect.scoped);
  });

  it.effect("kills the PTY and falls back when the usage panel times out", () => {
    const pty = makePty();
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))),
    );

    return Effect.gen(function* () {
      const reader = yield* runReader({
        homePath: "",
        ptyAdapter: PtyAdapter.PtyAdapter.of({ spawn: () => Effect.succeed(pty.process) }),
        httpClient,
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(reader)).toBeUndefined();
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(pty.unsubscribeData).toHaveBeenCalledTimes(1);
      expect(pty.unsubscribeExit).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(TestClock.layer()));
  });
});

describe("parseClaudeUsagePanel", () => {
  const nowEpochMs = new Date("2026-08-01T16:00:00.000Z").getTime();

  it("maps the latest session and all-model weekly rows with relative resets", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  12% used",
          "  Resets in 4h 30m",
          "Current week (all models)",
          "  67% used",
          "  Resets in 2d 1h",
          "Current session",
          "  \u001b[32m19% used\u001b[0m",
          "  Resets in 5h",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      fiveHour: { usedPercent: 19, resetsAt: "2026-08-01T21:00:00.000Z" },
      weekly: { usedPercent: 67, resetsAt: "2026-08-03T17:00:00.000Z" },
    });
  });

  it("resolves weekday and calendar reset descriptions in the server's local timezone", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  24.5% used",
          "  Resets Monday at 10:30 AM",
          "Current week (all models)",
          "  42% used",
          "  Resets Aug 5 at 4:15 PM",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      fiveHour: { usedPercent: 24.5, resetsAt: new Date(2026, 7, 3, 10, 30).toISOString() },
      weekly: { usedPercent: 42, resetsAt: new Date(2026, 7, 5, 16, 15).toISOString() },
    });
  });

  it("omits a time-only reset even with its displayed timezone suffix", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  24.5% used",
          "  Resets 4:15pm (America/New_York)",
          "Current week (all models)",
          "  42% used",
          "  Resets Nov 5, 4:15pm (America/New_York)",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      weekly: { usedPercent: 42, resetsAt: new Date(2026, 10, 5, 16, 15).toISOString() },
    });
  });

  it("omits reset rows that would require rolling an undated value forward", () => {
    const weekly = { usedPercent: 42, resetsAt: new Date(2026, 7, 5, 16, 15).toISOString() };

    for (const reset of ["Saturday at 10:30 AM", "Jul 5 at 4:15 PM"]) {
      expect(
        parseClaudeUsagePanel(
          [
            "Current session",
            "  24.5% used",
            `  Resets ${reset}`,
            "Current week (all models)",
            "  42% used",
            "  Resets Aug 5 at 4:15 PM",
          ].join("\n"),
          nowEpochMs,
        ),
      ).toEqual({ weekly });
    }
  });

  it("omits only rows with invalid percentages or non-future resets", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  101% used",
          "  Resets in 5h",
          "Current week (all models)",
          "  18% used",
          "  Resets in 2h",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      weekly: { usedPercent: 18, resetsAt: "2026-08-01T18:00:00.000Z" },
    });

    expect(
      parseClaudeUsagePanel(
        [
          "Current session",
          "  22% used",
          "  Resets in 0m",
          "Current week (all models)",
          "  18% used",
          "  Resets in 2h",
        ].join("\n"),
        nowEpochMs,
      ),
    ).toEqual({
      weekly: { usedPercent: 18, resetsAt: "2026-08-01T18:00:00.000Z" },
    });
  });

  it.each([
    ["Loading usage…"],
    ["Usage limits are only available with a Pro or Max subscription."],
    [""],
  ])("treats unavailable panel output as no limits: %s", (text) => {
    expect(parseClaudeUsagePanel(text, nowEpochMs)).toEqual({});
  });
});
