#!/usr/bin/env bun
/**
 * `cortex plugin <subcommand>` — cortex#1793 (S8, ADR-0024 D3).
 *
 * Runtime attach/detach/reload for adapters and renderers WITHOUT restarting
 * the daemon. Talks to a running daemon over the bus
 * (`src/cli/cortex/commands/plugin-lib.ts` + `src/gateway/plugin-control-server.ts`
 * on the daemon side) — every subcommand requires a live daemon with NATS
 * configured for the target `--config`.
 *
 * Subcommands:
 *   list                     Live adapters + renderers: kind, platform/kind,
 *                            instance id, bundle (or "in-tree"), running.
 *   unload <instance-id>     Detach a live instance. DRY-RUN by default;
 *                            `--apply` sends the mutation.
 *   reload <instance-id>     Cache-bust re-import + attach-before-detach.
 *                            RENDERER-ONLY in this slice — see
 *                            `src/gateway/plugin-runtime.ts`'s module doc for
 *                            why adapter reload is out of scope (cortex#1896).
 *                            DRY-RUN by default; `--apply` sends the mutation.
 *   load <bundle-name>       Activate a renderer bundle whose `renderers[]`
 *                            config entry failed to construct at boot because
 *                            the plugin hadn't loaded yet. DRY-RUN by default;
 *                            `--apply` sends the mutation.
 *
 * SAFETY (mirrors `cortex network` / `cortex stack`): every mutating verb is
 * dry-run unless `--apply`.
 *
 * Exit codes: 0 success · 1 operational failure (refused / timed out) · 2 usage.
 */

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type FlagMap, type SubcommandSpec } from "./_shared/parser";
import {
  renderLoadPreview,
  renderMutationPreview,
  renderPluginList,
  sendPluginControlRequest,
  type PluginControlResult,
} from "./plugin-lib";
import { DEFAULT_CONFIG } from "../../../common/pidfile";

export { type ExitResult } from "./_shared/exit-result";

type PluginSubcommand = "list" | "unload" | "reload" | "load";

const SPEC: SubcommandSpec<PluginSubcommand> = {
  cliName: "plugin",
  subcommands: {
    list: { positionals: [], flags: { "--config": "value" } },
    unload: { positionals: ["instance-id"], flags: { "--config": "value", "--apply": "bool" } },
    reload: { positionals: ["instance-id"], flags: { "--config": "value", "--apply": "bool" } },
    load: { positionals: ["bundle-name"], flags: { "--config": "value", "--apply": "bool" } },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

export async function dispatchPlugin(argv: string[]): Promise<ExitResult> {
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return { exitCode: 2, stdout: "", stderr: `cortex plugin: ${err.message}\n${topLevelHelp()}` };
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;

  if (parsed.subcommand === "help" || parsed.help) {
    return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === "" ? "usage error — no subcommand specified." : `unknown subcommand "${parsed.rawSubcommand}".`;
    return { exitCode: 2, stdout: "", stderr: `cortex plugin: ${msg}\n${topLevelHelp()}` };
  }

  const configPath = optionalValueFlag(parsed.flags, "--config") ?? DEFAULT_CONFIG;

  switch (parsed.subcommand) {
    case "list":
      return runList(configPath, json);
    case "unload":
      return runMutation("unload", configPath, parsed.positionals["instance-id"] ?? "", parsed.flags, json);
    case "reload":
      return runMutation("reload", configPath, parsed.positionals["instance-id"] ?? "", parsed.flags, json);
    case "load":
      return runLoad(configPath, parsed.positionals["bundle-name"] ?? "", parsed.flags, json);
  }
}

// =============================================================================
// Subcommand handlers
// =============================================================================

async function runList(configPath: string, json: boolean): Promise<ExitResult> {
  let result: PluginControlResult;
  try {
    result = await sendPluginControlRequest(configPath, { action: "list" });
  } catch (err) {
    return operationalError(err, json);
  }
  if (!result.ok) {
    return json
      ? { exitCode: 1, stdout: renderJson(envelopeError(result.reason)), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: `cortex plugin: ${result.reason}\n` };
  }
  const rows = result.rows ?? [];
  return json
    ? { exitCode: 0, stdout: renderJson(envelopeOk(rows)), stderr: "" }
    : { exitCode: 0, stdout: renderPluginList(rows), stderr: "" };
}

async function runMutation(
  verb: "unload" | "reload",
  configPath: string,
  instanceId: string,
  flags: FlagMap,
  json: boolean,
): Promise<ExitResult> {
  const apply = flags["--apply"] === true;

  if (!apply) {
    // Dry-run: fetch the current list so the preview names a REAL instance
    // (or clearly says there isn't one) rather than guessing.
    let listResult: PluginControlResult;
    try {
      listResult = await sendPluginControlRequest(configPath, { action: "list" });
    } catch (err) {
      return operationalError(err, json);
    }
    if (!listResult.ok) {
      return json
        ? { exitCode: 1, stdout: renderJson(envelopeError(listResult.reason)), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: `cortex plugin: ${listResult.reason}\n` };
    }
    const preview = renderMutationPreview(verb, instanceId, listResult.rows ?? []);
    return json
      ? { exitCode: 0, stdout: renderJson(envelopeOk([{ dryRun: true, preview }])), stderr: "" }
      : { exitCode: 0, stdout: preview, stderr: "" };
  }

  let result: PluginControlResult;
  try {
    result = await sendPluginControlRequest(configPath, { action: verb, instanceId });
  } catch (err) {
    return operationalError(err, json);
  }
  if (!result.ok) {
    return json
      ? { exitCode: 1, stdout: renderJson(envelopeError(result.reason)), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: `cortex plugin: ${result.reason}\n` };
  }
  const detail = result.detail ?? `${verb} ok`;
  return json
    ? { exitCode: 0, stdout: renderJson(envelopeOk([{ detail }])), stderr: "" }
    : { exitCode: 0, stdout: `${detail}\n`, stderr: "" };
}

async function runLoad(configPath: string, bundleName: string, flags: FlagMap, json: boolean): Promise<ExitResult> {
  const apply = flags["--apply"] === true;

  if (!apply) {
    const preview = renderLoadPreview(bundleName);
    return json
      ? { exitCode: 0, stdout: renderJson(envelopeOk([{ dryRun: true, preview }])), stderr: "" }
      : { exitCode: 0, stdout: preview, stderr: "" };
  }

  let result: PluginControlResult;
  try {
    result = await sendPluginControlRequest(configPath, { action: "load", bundleName });
  } catch (err) {
    return operationalError(err, json);
  }
  if (!result.ok) {
    return json
      ? { exitCode: 1, stdout: renderJson(envelopeError(result.reason)), stderr: "" }
      : { exitCode: 1, stdout: "", stderr: `cortex plugin: ${result.reason}\n` };
  }
  const detail = result.detail ?? "load ok";
  return json
    ? { exitCode: 0, stdout: renderJson(envelopeOk([{ detail }])), stderr: "" }
    : { exitCode: 0, stdout: `${detail}\n`, stderr: "" };
}

// =============================================================================
// Helpers
// =============================================================================

function optionalValueFlag(flags: FlagMap, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function operationalError(err: unknown, json: boolean): ExitResult {
  const reason = err instanceof Error ? err.message : String(err);
  return json
    ? { exitCode: 1, stdout: renderJson(envelopeError(reason)), stderr: "" }
    : { exitCode: 1, stdout: "", stderr: `cortex plugin: ${reason}\n` };
}

function topLevelHelp(): string {
  return `cortex plugin — runtime attach/detach/reload for adapters + renderers (cortex#1793, S8)

Usage:
  cortex plugin list [--config <path>] [--json]
  cortex plugin unload <instance-id> [--apply] [--config <path>] [--json]
  cortex plugin reload <instance-id> [--apply] [--config <path>] [--json]
  cortex plugin load <bundle-name> [--apply] [--config <path>] [--json]

Every subcommand talks to a RUNNING daemon over the bus — it must be booted
against the same --config with NATS configured, or every subcommand fails
with a timeout.

Subcommands:
  list    Live adapters + renderers: kind, platform/kind, instance id, bundle
          name ("in-tree" for statically-registered plugins), running state.
  unload  Detach a live instance. Renderers: always supported. Adapters: only
          when the daemon is running with CORTEX_GATEWAY=1 (per-stack
          adapters built by the classic boot path have no live detach path —
          ADR-0024 blocker #13).
  reload  Cache-bust re-import (verified working for a plain filesystem path;
          a file:// URL does NOT cache-bust in bun 1.3.2 — see
          src/adapters/loader.ts's reimportRendererPlugin doc) + attach the
          new instance before detaching the old one. RENDERER-ONLY in this
          slice, and only for a renderer loaded from an arc bundle (an
          in-tree renderer has no bundle to re-import — restart instead).
          Adapter reload needs GatewayAdapterFactory reconstruction
          (cortex#1896), out of scope here.
  load    Activate a renderer whose "renderers[]" config entry exists but
          failed to construct at boot (the plugin hadn't loaded yet).
          Adapter load: same #1896 rationale as reload.

Safety:
  unload / reload / load default to DRY-RUN (describe what would happen,
  touch nothing live). Pass --apply to send the mutating request.

Flags:
  --config <path>  cortex.yaml (or config-split pointer) the target daemon
                    booted from. Default: ${DEFAULT_CONFIG}.
  --apply           Send the mutating request (unload/reload/load only).
  --json            Emit a { status, items, data, error } envelope.
`;
}

if (import.meta.main) {
  const result = await dispatchPlugin(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
