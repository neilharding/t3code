import { type DevinSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Devin's ACP server (`devin acp`) authenticates against the credentials
 * created by `devin auth login`. Unlike Cursor's OAuth-style
 * `cursor_login` method id, Devin advertises this id explicitly during
 * `initialize`.
 */
const DEVIN_AUTH_METHOD_ID = "windsurf-api-key";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath" | "launchArgs">;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp", ...tokenizeCliArgs(devinSettings?.launchArgs ?? "")],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        authMethodId: DEVIN_AUTH_METHOD_ID,
        clientCapabilities: {},
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Devin's model catalog is exposed through the `model` session config
 * option rather than a bespoke extension method (cf. Cursor). Model ids
 * are plain slugs — no bracketed suffixes to strip — so normalization only
 * needs to fall back to the session default and apply cross-provider
 * aliasing.
 */
export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "adaptive";
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? base;
}

interface DevinAcpModelSelectionRuntime {
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
}

/**
 * Applies a model selection, but only when the caller explicitly picked a
 * model. Devin sessions default to `adaptive`, a value that is not itself
 * one of the selectable `model` config options — round-tripping it through
 * `setModel` would be rejected by Devin's option validation. Leaving the
 * model untouched when nothing was requested preserves that default.
 */
export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const requested = input.model?.trim();
  if (!requested) {
    return Effect.void;
  }
  return input.runtime
    .setModel(resolveDevinAcpBaseModelId(requested))
    .pipe(Effect.mapError(input.mapError));
}
