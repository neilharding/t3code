import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  resolveDevinAcpBaseModelId,
} from "./DevinAcpSupport.ts";

describe("buildDevinAcpSpawnInput", () => {
  it("defaults to the `devin` binary and no launch args", () => {
    const spawn = buildDevinAcpSpawnInput(undefined, "/repo");
    NodeAssert.equal(spawn.command, "devin");
    NodeAssert.deepStrictEqual(spawn.args, ["acp"]);
    NodeAssert.equal(spawn.cwd, "/repo");
  });

  it("uses the configured binary path and tokenizes launch args after `acp`", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/usr/local/bin/devin", launchArgs: "--model opus" },
      "/repo",
    );
    NodeAssert.equal(spawn.command, "/usr/local/bin/devin");
    NodeAssert.deepStrictEqual(spawn.args, ["acp", "--model", "opus"]);
  });
});

describe("resolveDevinAcpBaseModelId", () => {
  it("falls back to `adaptive` when no model is provided", () => {
    NodeAssert.equal(resolveDevinAcpBaseModelId(undefined), "adaptive");
    NodeAssert.equal(resolveDevinAcpBaseModelId("   "), "adaptive");
  });

  it("trims a provided model id", () => {
    NodeAssert.equal(resolveDevinAcpBaseModelId(" claude-opus-4-6 "), "claude-opus-4-6");
  });
});

describe("applyDevinAcpModelSelection", () => {
  it("does not call setModel when no model was explicitly selected", async () => {
    let called = false;
    const runtime = {
      setModel: (_model: string) => {
        called = true;
        return Effect.void;
      },
    };
    await Effect.runPromise(
      applyDevinAcpModelSelection({ runtime, model: undefined, mapError: (cause) => cause }),
    );
    NodeAssert.equal(called, false);
  });

  it("calls setModel with the resolved base model id when a model is selected", async () => {
    let receivedModel: string | undefined;
    const runtime = {
      setModel: (model: string) => {
        receivedModel = model;
        return Effect.void;
      },
    };
    await Effect.runPromise(
      applyDevinAcpModelSelection({
        runtime,
        model: " claude-opus-4-6 ",
        mapError: (cause) => cause,
      }),
    );
    NodeAssert.equal(receivedModel, "claude-opus-4-6");
  });
});
