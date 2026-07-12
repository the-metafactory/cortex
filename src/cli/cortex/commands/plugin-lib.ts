/**
 * `cortex plugin list|load|unload|reload` — cortex#1793 (S8, ADR-0024 D3).
 *
 * The CLI-side half of the runtime plugin control channel. Mirrors
 * `cortex network ping`'s pattern for a short-lived CLI process talking to
 * the live daemon over the bus (`network-ping-adapters.ts`:
 * `startMyelinRuntime(config, …)` against the SAME `cortex.yaml` the daemon
 * booted from) — see `src/bus/system-events.ts`'s
 * `system.plugin.control-request`/`_response` doc comment for why this rides
 * `runtime.publish`/`subscribe`/`onEnvelope` rather than a raw NATS
 * request/reply connection.
 *
 * `list` is read-only and always safe. `unload`/`reload`/`load` are
 * DRY-RUN BY DEFAULT (repo convention — `cortex network`/`cortex stack`):
 * the CLI first runs `list` to describe what the mutation WOULD do without
 * sending it; `--apply` is required to actually send the mutating request.
 */

import { loadConfigWithAgents } from "../../../common/config/loader";
import { startMyelinRuntime, type MyelinRuntime } from "../../../bus/myelin/runtime";
import {
  createSystemPluginControlRequestEvent,
  type SystemEventSource,
  type SystemPluginControlListRow,
} from "../../../bus/system-events";

// =============================================================================
// Live round trip
// =============================================================================

export type PluginControlAction = "list" | "unload" | "reload" | "load";

export interface PluginControlRequest {
  action: PluginControlAction;
  instanceId?: string;
  bundleName?: string;
}

export type PluginControlResult =
  | { ok: true; rows?: SystemPluginControlListRow[]; detail?: string }
  | { ok: false; reason: string };

/** Resolve the principal id the SAME way the daemon does (`cortex.ts`'s
 *  `resolvePrincipalId`) — the request/response subject's `{principal}`
 *  segment must match exactly or the daemon never sees the request. */
export function resolvePrincipalIdForCli(principal: { id?: string } | undefined): string {
  const id = principal?.id;
  if (id !== undefined && id !== "") return id;
  throw new Error(
    "cortex plugin: cannot resolve principal id — cortex.yaml must declare `principal.id`. " +
      "Run `cortex migrate-config` if upgrading from a v2 config.",
  );
}

/**
 * Send one control request and await the matching response (by
 * `correlation_id`), or time out. Opens its OWN short-lived `MyelinRuntime`
 * against `configPath` — reused across a single CLI invocation only; always
 * stopped before returning.
 */
export async function sendPluginControlRequest(
  configPath: string,
  request: PluginControlRequest,
  opts?: { timeoutMs?: number },
): Promise<PluginControlResult> {
  const loaded = loadConfigWithAgents(configPath);
  const principalId = resolvePrincipalIdForCli(loaded.principal);
  const systemEventSource: SystemEventSource = {
    principal: principalId,
    agent: "cortex",
    // Distinct instance name from the daemon's "local" — this is a
    // short-lived CLI-side connection, not the daemon's own emission
    // identity. Purely cosmetic (never read for routing).
    instance: "cli",
  };

  const runtime: MyelinRuntime = await startMyelinRuntime(loaded.config);
  try {
    if (!runtime.enabled || !runtime.subscribe) {
      return {
        ok: false,
        reason: "cortex plugin: NATS is not configured for this stack (runtime disabled) — nothing to talk to.",
      };
    }

    const requestId = crypto.randomUUID();
    const responseSubject = `local.${principalId}.system.plugin.control-response`;
    const subscriber = await runtime.subscribe(responseSubject);
    if (!subscriber) {
      return { ok: false, reason: "cortex plugin: failed to subscribe for the daemon's response." };
    }

    const timeoutMs = opts?.timeoutMs ?? 5000;
    const result = await new Promise<PluginControlResult>((resolve) => {
      let settled = false;
      const finish = (r: PluginControlResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregister();
        resolve(r);
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          reason:
            `cortex plugin: no response from the daemon within ${timeoutMs}ms — is a cortex daemon ` +
            `running for this config (with a live NATS connection)?`,
        });
      }, timeoutMs);
      const { unregister } = runtime.onEnvelope((envelope, matchedSubject) => {
        if (matchedSubject !== responseSubject) return;
        if (envelope.type !== "system.plugin.control-response") return;
        const payload = envelope.payload as {
          request_id?: unknown;
          ok?: unknown;
          rows?: unknown;
          detail?: unknown;
        };
        if (payload.request_id !== requestId) return;
        if (payload.ok === true) {
          finish({
            ok: true,
            ...(Array.isArray(payload.rows) && { rows: payload.rows as SystemPluginControlListRow[] }),
            ...(typeof payload.detail === "string" && { detail: payload.detail }),
          });
        } else {
          finish({
            ok: false,
            reason: typeof payload.detail === "string" ? payload.detail : "cortex plugin: request refused (no reason given).",
          });
        }
      });

      runtime
        .publish(
          createSystemPluginControlRequestEvent({
            source: systemEventSource,
            requestId,
            action: request.action,
            ...(request.instanceId !== undefined && { instanceId: request.instanceId }),
            ...(request.bundleName !== undefined && { bundleName: request.bundleName }),
          }),
        )
        .catch((err: unknown) => {
          finish({
            ok: false,
            reason: `cortex plugin: failed to publish the request: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    });

    await subscriber.stop();
    return result;
  } finally {
    await runtime.stop();
  }
}

// =============================================================================
// Rendering
// =============================================================================

export function renderPluginList(rows: SystemPluginControlListRow[]): string {
  if (rows.length === 0) return "(no live adapter or renderer instances)\n";
  const header = ["KIND", "PLATFORM/KIND", "INSTANCE ID", "BUNDLE", "RUNNING"];
  const lines = rows.map((r) => [r.kind, r.platformOrKind, r.instanceId, r.bundleName, r.running ? "yes" : "no"]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? "").length)));
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), ...lines.map(fmt)].join("\n") + "\n";
}

/** Dry-run preview text for `unload`/`reload` — describes the target instance
 *  found in `rows` (or notes it's absent) without mutating anything. */
export function renderMutationPreview(
  verb: "unload" | "reload",
  instanceId: string,
  rows: SystemPluginControlListRow[],
): string {
  const target = rows.find((r) => r.instanceId === instanceId);
  if (!target) {
    return (
      `(dry-run) no live instance "${instanceId}" found — "cortex plugin ${verb} ${instanceId} --apply" ` +
      `would be refused by the daemon.\n`
    );
  }
  return (
    `(dry-run) would ${verb} ${target.kind} "${instanceId}" (${target.platformOrKind}, bundle "${target.bundleName}").\n` +
    `Re-run with --apply to do it.\n`
  );
}

/** Dry-run preview text for `load` — describes what a live daemon check would
 *  need to confirm; `load` doesn't have a pre-check as cheap as `list`
 *  (the bundle may not be live yet, which is the whole point), so the
 *  preview is a plain statement of intent. */
export function renderLoadPreview(bundleName: string): string {
  return `(dry-run) would load renderer bundle "${bundleName}". Re-run with --apply to do it.\n`;
}
