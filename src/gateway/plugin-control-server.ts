/**
 * cortex#1793 (S8) — the daemon-side half of the `cortex plugin` control
 * channel. Subscribes to `local.{principal}.system.plugin.control-request`
 * (via the running `MyelinRuntime` — see `src/bus/system-events.ts`'s
 * `system.plugin.control-request`/`_response` doc comment for the full
 * rationale on why this rides `runtime.publish`/`subscribe`/`onEnvelope`
 * rather than a raw NATS request/reply connection), executes the requested
 * action against {@link PluginRuntimeDeps} (`src/gateway/plugin-runtime.ts`),
 * and replies with a `control-response` carrying the same `correlation_id`.
 *
 * Wired into `src/cortex.ts` right after the renderer boot loop (once
 * `rendererHandles`/`skippedRendererConfigs` exist) and torn down in the
 * shutdown sequence alongside the other bus-side listeners.
 */

import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { Envelope } from "../bus/myelin/envelope-validator";
import {
  createSystemPluginControlResponseEvent,
  type SystemEventSource,
  type SystemPluginControlListRow,
} from "../bus/system-events";
import {
  listLivePlugins,
  loadLivePlugin,
  reloadLivePlugin,
  unloadLivePlugin,
  type PluginRuntimeDeps,
} from "./plugin-runtime";

export interface PluginControlServerHandle {
  /** Detach the subscription + handler. Idempotent. */
  stop(): Promise<void>;
}

interface ControlRequestPayload {
  request_id?: unknown;
  action?: unknown;
  instance_id?: unknown;
  bundle_name?: unknown;
}

/**
 * Start the daemon-side control listener. No-op handle (does nothing on
 * `stop()`) when `runtime.enabled` is false or `runtime.subscribe`/
 * `onEnvelope` are unavailable (a fake-runtime test double, or a stack
 * genuinely running with no NATS configured) — a plugin-control-less daemon
 * is a degraded-but-safe state (`cortex plugin list` from the CLI simply
 * times out with no responder), never a boot failure.
 */
export async function startPluginControlServer(
  runtime: MyelinRuntime,
  deps: PluginRuntimeDeps,
  systemEventSource: SystemEventSource,
): Promise<PluginControlServerHandle> {
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- the interface is async (`Promise<void>`) so callers can await uniformly whether the handle is live or a no-op; this branch has nothing to do.
  const noop: PluginControlServerHandle = { stop: async () => {} };
  if (!runtime.enabled || !runtime.subscribe) {
    return noop;
  }

  const subject = `local.${systemEventSource.principal}.system.plugin.control-request`;
  const subscriber = await runtime.subscribe(subject);
  if (!subscriber) return noop;

  const { unregister } = runtime.onEnvelope((envelope, matchedSubject) => {
    if (envelope.type !== "system.plugin.control-request") return;
    if (matchedSubject !== subject) return;
    // Fire-and-forget: `onEnvelope` handlers are synchronous per the
    // `EnvelopeHandler` type, so the async body runs detached. Every
    // failure path inside `handleOneRequest` is caught internally — nothing
    // here can produce an unhandled rejection.
    void handleOneRequest(runtime, deps, systemEventSource, envelope);
  });

  return {
    stop: async () => {
      unregister();
      await subscriber.stop();
    },
  };
}

async function handleOneRequest(
  runtime: MyelinRuntime,
  deps: PluginRuntimeDeps,
  systemEventSource: SystemEventSource,
  envelope: Envelope,
): Promise<void> {
  const payload = envelope.payload as ControlRequestPayload;
  const requestId = typeof payload.request_id === "string" ? payload.request_id : envelope.id;
  const action = payload.action;

  let response: { ok: boolean; rows?: SystemPluginControlListRow[]; detail?: string };
  try {
    response = await dispatchAction(deps, action, payload);
  } catch (err) {
    response = {
      ok: false,
      detail: `plugin-control-server: unhandled error executing "${String(action)}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    await runtime.publish(
      createSystemPluginControlResponseEvent({
        source: systemEventSource,
        requestId,
        ok: response.ok,
        ...(response.rows !== undefined && { rows: response.rows }),
        ...(response.detail !== undefined && { detail: response.detail }),
      }),
    );
  } catch (err) {
    // The request came from a live CLI process waiting on this exact reply
    // — a publish failure here just means that CLI invocation times out
    // rather than getting the underlying reason. Logged for the daemon
    // principal; never thrown (this runs detached from any caller).
    process.stderr.write(
      `cortex plugin-control-server: failed to publish control-response for request "${requestId}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function dispatchAction(
  deps: PluginRuntimeDeps,
  action: unknown,
  payload: ControlRequestPayload,
): Promise<{ ok: boolean; rows?: SystemPluginControlListRow[]; detail?: string }> {
  if (action === "list") {
    return { ok: true, rows: listLivePlugins(deps) };
  }
  if (action === "unload") {
    const instanceId = typeof payload.instance_id === "string" ? payload.instance_id : undefined;
    if (!instanceId) return { ok: false, detail: `"unload" requires instance_id` };
    return unloadLivePlugin(deps, instanceId);
  }
  if (action === "reload") {
    const instanceId = typeof payload.instance_id === "string" ? payload.instance_id : undefined;
    if (!instanceId) return { ok: false, detail: `"reload" requires instance_id` };
    return reloadLivePlugin(deps, instanceId);
  }
  if (action === "load") {
    const bundleName = typeof payload.bundle_name === "string" ? payload.bundle_name : undefined;
    if (!bundleName) return { ok: false, detail: `"load" requires bundle_name` };
    return loadLivePlugin(deps, bundleName);
  }
  return { ok: false, detail: `unknown action "${String(action)}" — expected list | unload | reload | load` };
}
