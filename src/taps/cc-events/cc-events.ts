/**
 * MIG-5b — `cc.*` envelope constructor for relay-side bus publishing.
 *
 * Per G-1111 §7.4 ("Relationship to existing in-process taxonomy"), the
 * pre-myelin Claude Code hook taxonomy (`agent.task.started`,
 * `tool.bash.executed`, etc.) co-exists with the cross-process G-1111
 * vocabulary. The path forward is "Some in-process events MAY be lifted to
 * the bus by grove-relay" — same correlation_id, separate vocabulary —
 * which is what this helper enables.
 *
 * The grove-relay (cc-events tap) reads CC hooks from
 * `~/.claude/events/raw/`, applies the relay policy, writes published
 * events to `~/.claude/events/published/`, and ALSO — when a
 * `MyelinRuntime` is attached — wraps each published event in a Myelin
 * envelope and publishes it to `local.{org}.{type}`.
 *
 * **Why the relay (and not the hook)?** Hooks run as standalone Bun
 * processes spawned by Claude Code (`~/.claude/hooks/EventLogger.hook.ts`).
 * They are short-lived, have no persistent NATS connection, and per
 * design must NEVER block agent work — opening a NATS connection per hook
 * invocation would add latency to every tool call. The relay is the
 * natural in-process owner: long-lived daemon, single NATS connection,
 * batched processing.
 *
 * **Shape contract** (mirrors `system-events.ts` + `dispatch-events.ts`):
 *   - `id` is a fresh `crypto.randomUUID()` per call (envelope idempotency key).
 *     The PublishedEvent's own `event_id` lives in the payload — it identifies
 *     the underlying CC event, not the bus envelope.
 *   - `timestamp` mirrors the PublishedEvent's `timestamp` so an envelope's
 *     ts equals the moment the hook fired, not the moment the relay published.
 *     Surfaces ordering hooks chronologically rather than by relay batch order.
 *   - `source` is the dotted `{org}.{agent}.{instance}` per the schema.
 *     For relay-emitted cc-events: `{org}.cortex.relay`.
 *   - `correlation_id` is the **session_id** when it's UUID-shaped — surfaces
 *     join all events from one CC session on this key. Non-UUID session ids
 *     (CC's defaults) cause the field to be omitted entirely; the
 *     `payload.session_id` always carries the original value either way.
 *   - `sovereignty` defaults to local-only / NZ / max_hop=0 / frontier_ok=false /
 *     model_class=local-only. CC events expose internal session activity
 *     (file paths, tool names, command previews) — operator-only, no
 *     federation, no frontier-model processing.
 *   - `type` is the PublishedEvent's `event_type` verbatim — it already has
 *     G-1111-grammar shape (`agent.task.started`, `tool.bash.executed`, etc.)
 *     thanks to the existing taxonomy in `hooks/lib/event-taxonomy.ts`.
 *   - `payload` carries the full PublishedEvent including its own event_id,
 *     so a downstream consumer that wants the legacy taxonomy fields can
 *     read them directly.
 */

import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { NatsLink } from "../../bus/nats/connection";
import type { PublishedEvent } from "./hooks/lib/event-types";

/**
 * Source identifier struct for CC envelope construction. Mirrors the shape
 * in `bus/system-events.ts` — three dotted segments matching the schema's
 * `org.agent.instance` form. Kept structured so callers don't string-
 * concatenate by hand.
 *
 * Defaults applied at envelope-construction time:
 *   - `agent` defaults to `"cortex"` (the M7 application emitting these events)
 *   - `instance` defaults to `"relay"` (the in-process tap responsible for
 *     lifting hooks → bus)
 */
export interface CcEventSource {
  /** `agent.operatorId` — first segment. Defaults to `"default"` if absent. */
  org?: string;
  /** Logical agent name. Defaults to `"cortex"`. */
  agent?: string;
  /** Stable instance name. Defaults to `"relay"`. */
  instance?: string;
}

function buildSource(src: CcEventSource | undefined): string {
  return `${src?.org ?? "default"}.${src?.agent ?? "cortex"}.${
    src?.instance ?? "relay"
  }`;
}

/**
 * Default sovereignty for `cc.*` envelopes. Same posture as `system.*`:
 * operator-only, local residency, no federation, no frontier-model
 * processing. Returned as a fresh literal per call so a downstream
 * mutation on one envelope's sovereignty cannot leak into a sibling
 * envelope.
 */
function defaultCcSovereignty(): Envelope["sovereignty"] {
  return {
    classification: "local",
    data_residency: "NZ",
    max_hop: 0,
    frontier_ok: false,
    model_class: "local-only",
  };
}

/**
 * UUID v4 pattern — the envelope schema's `correlation_id` field constrains
 * to UUID format. CC sessions sometimes use UUID-shaped session_ids and
 * sometimes use shorter strings ("unknown", numeric ids); only UUID-shaped
 * values are propagated to envelope.correlation_id, the rest land in payload.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface CreateCcEventEnvelopeOpts {
  /**
   * The PublishedEvent emitted by the relay's policy engine. This is the
   * filtered, consumer-safe form of the underlying CC hook event — see
   * `hooks/lib/event-types.ts` for the schema.
   */
  event: PublishedEvent;
  /**
   * Envelope source — `{org}.{agent}.{instance}` per schema. All fields
   * have sensible defaults. Callers (the relay) typically override `org`
   * to match the bot's `agent.operatorId`.
   */
  source?: CcEventSource;
}

/**
 * Wrap a PublishedEvent in a Myelin envelope suitable for publishing on
 * `local.{org}.{type}`. The MyelinRuntime.publish contract (G-1100.E)
 * expects the type field to be the dotted `domain.entity.action` form;
 * PublishedEvent's `event_type` already conforms.
 *
 * **No validation against the JSON Schema is performed here.** The downstream
 * MyelinRuntime.publish path serialises and publishes; if a future hardening
 * pass requires pre-publish validation, it lives at the runtime layer (one
 * place, one decision), not here per-helper.
 */
export function createCcEventEnvelope(
  opts: CreateCcEventEnvelopeOpts,
): Envelope {
  const { event } = opts;
  const envelope: Envelope = {
    id: crypto.randomUUID(),
    source: buildSource(opts.source),
    type: event.event_type,
    // Mirror the published event's timestamp so envelope ts == hook ts.
    // The relay may batch-process; using `now()` would smear chronology
    // across batched events.
    timestamp: event.timestamp,
    sovereignty: defaultCcSovereignty(),
    payload: {
      // Flatten the PublishedEvent into the envelope payload. Downstream
      // consumers who want the legacy taxonomy can read these fields
      // directly without re-parsing the envelope type.
      event_id: event.event_id,
      session_id: event.session_id,
      ...(event.grove_channel !== undefined && { grove_channel: event.grove_channel }),
      ...(event.agent_id !== undefined && { agent_id: event.agent_id }),
      ...(event.agent_name !== undefined && { agent_name: event.agent_name }),
      ...(event.network_id !== undefined && { network_id: event.network_id }),
      // Spread the original payload last so per-event payload keys survive
      // — they're the actual interesting bits (tool_name, prompt_preview,
      // file path, etc.). Reserved keys above won't collide because they
      // live at top-level on the PublishedEvent, not inside payload.
      ...event.payload,
    },
  };

  // Only set correlation_id when session_id has the UUID shape the schema
  // requires. Non-UUID session ids fall through to payload.session_id only.
  if (isUuid(event.session_id)) {
    envelope.correlation_id = event.session_id;
  }

  return envelope;
}

/**
 * Options for `createCcEventPublisher` — the factory that builds the
 * `onPublished` callback the relay's `EventProcessor` consumes.
 */
export interface CreateCcEventPublisherOpts {
  /** Live NATS connection. Caller owns the lifecycle. */
  link: NatsLink;
  /**
   * Operator/org segment used in the published subject. Forms the second
   * segment of `local.{org}.{type}`. Defaults to `"default"` to mirror the
   * MyelinRuntime convention when `agent.operatorId` is absent.
   */
  org?: string;
  /**
   * Override the envelope `source.agent` segment. Defaults to `"cortex"`.
   */
  agent?: string;
  /**
   * Override the envelope `source.instance` segment. Defaults to `"relay"`.
   */
  instance?: string;
  /**
   * Override the envelope-construction helper. Lets tests assert on the
   * envelope shape without needing a real NATS connection. Defaults to
   * `createCcEventEnvelope`.
   */
  buildEnvelope?: (event: PublishedEvent, source: CcEventSource) => Envelope;
}

/**
 * Build an `onPublished` callback that wraps each PublishedEvent in a
 * Myelin envelope and publishes it on `local.{org}.{type}`.
 *
 * Returned callback is **synchronous from the relay's perspective** —
 * Core NATS publishes are fire-and-forget at the client layer. Errors
 * surface to the EventProcessor's logging path but never throw out;
 * a flaky NATS must not break the JSONL pipeline.
 *
 * Subject form mirrors the MyelinRuntime.publish contract (G-1100.E):
 * `local.{org}.{envelope.type}`. Symmetry with subscribe-side patterns
 * means a `local.{org}.>` subscriber sees these CC-lifted events out
 * of the box.
 */
export function createCcEventPublisher(
  opts: CreateCcEventPublisherOpts,
): (event: PublishedEvent) => void {
  const org = opts.org ?? "default";
  const source: CcEventSource = {
    org,
    agent: opts.agent ?? "cortex",
    instance: opts.instance ?? "relay",
  };
  const buildEnvelope =
    opts.buildEnvelope ??
    ((event: PublishedEvent, src: CcEventSource) =>
      createCcEventEnvelope({ event, source: src }));

  return (event: PublishedEvent) => {
    const envelope = buildEnvelope(event, source);
    const subject = `local.${org}.${envelope.type}`;
    try {
      opts.link.publish(subject, JSON.stringify(envelope));
    } catch (err) {
      // Mirror MyelinRuntime.publish's swallow-and-log policy. The relay's
      // primary path is JSONL append; bus is best-effort. Logging here is
      // operator-facing — when a publish fails repeatedly the operator
      // sees it in launchd output and can investigate the NATS server.
      process.stderr.write(
        `grove-relay: nats publish failed for subject=${subject} id=${envelope.id} type=${envelope.type}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  };
}

