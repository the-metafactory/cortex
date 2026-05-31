/**
 * MIG-5b — `cc.*` envelope constructor for relay-side bus publishing.
 *
 * Per G-1111 §7.4 ("Relationship to existing in-process taxonomy"), the
 * pre-myelin Claude Code hook taxonomy (`agent.task.started`,
 * `tool.bash.executed`, etc.) co-exists with the cross-process G-1111
 * vocabulary. The path forward is "Some in-process events MAY be lifted to
 * the bus by cortex-relay" — same correlation_id, separate vocabulary —
 * which is what this helper enables.
 *
 * The cortex-relay (cc-events tap) reads CC hooks from
 * `~/.claude/events/raw/`, applies the relay policy, writes published
 * events to `~/.claude/events/published/`, and ALSO — when a
 * `MyelinRuntime` is attached — wraps each published event in a Myelin
 * envelope and publishes it to `local.{principal}.{type}`.
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
 *   - `source` is the dotted `{principal}.{agent}.{instance}` per the schema.
 *     For relay-emitted cc-events: `{principal}.cortex.relay`.
 *   - `correlation_id` is the **session_id** when it's UUID-shaped — surfaces
 *     join all events from one CC session on this key. Non-UUID session ids
 *     (CC's defaults) cause the field to be omitted entirely; the
 *     `payload.session_id` always carries the original value either way.
 *   - `sovereignty` defaults to local-only / NZ / max_hop=0 / frontier_ok=false /
 *     model_class=local-only. CC events expose internal session activity
 *     (file paths, tool names, command previews) — principal-only, no
 *     federation, no frontier-model processing.
 *   - `type` is the PublishedEvent's `event_type` verbatim — it already has
 *     G-1111-grammar shape (`agent.task.started`, `tool.bash.executed`, etc.)
 *     thanks to the existing taxonomy in `hooks/lib/event-taxonomy.ts`.
 *   - `payload` carries the full PublishedEvent including its own event_id,
 *     so a downstream consumer that wants the legacy taxonomy fields can
 *     read them directly.
 */

import {
  deriveNatsSubject,
  type Classification,
  type Envelope,
} from "../../bus/myelin/envelope-validator";
import { buildBaseEnvelope } from "../../bus/envelope-builder";
import { isUuid } from "../../common/types/uuid";
import type { NatsLink } from "../../bus/nats/connection";
import type { PublishedEvent } from "./hooks/lib/event-types";

/**
 * Source identifier struct for CC envelope construction. Mirrors the shape
 * in `bus/system-events.ts` — three dotted segments matching the schema's
 * `{principal}.{assistant}.{instance}` form (R4 vocabulary migration;
 * myelin#185 tightened this to exactly 3 segments). Kept structured so
 * callers don't string-concatenate by hand.
 *
 * Defaults applied at envelope-construction time:
 *   - `agent` defaults to `"cortex"` (the M7 application emitting these events)
 *   - `instance` defaults to `"relay"` (the in-process tap responsible for
 *     lifting hooks → bus)
 */
export interface CcEventSource {
  /** Boot-resolved `principal.id` — first segment (principal slug). Defaults to `"default"` if absent. */
  principal?: string;
  /** Logical agent name. Defaults to `"cortex"`. */
  agent?: string;
  /** Stable instance name. Defaults to `"relay"`. */
  instance?: string;
  /**
   * Principal residency code stamped into `envelope.sovereignty.data_residency`.
   * Defaults to `"NZ"` when omitted — matches the original cortex deployment.
   * Operators in other jurisdictions pass their own ISO-3166-style code so
   * envelopes accurately reflect data residency. Mirrors the parameterisation
   * pattern in `bus/system-events.ts` and `bus/dispatch-events.ts`.
   */
  dataResidency?: string;
}

function buildSource(src: CcEventSource | undefined): string {
  return `${src?.principal ?? "default"}.${src?.agent ?? "cortex"}.${
    src?.instance ?? "relay"
  }`;
}

/**
 * Default sovereignty for `cc.*` envelopes. Same posture as `system.*`:
 * principal-only by default, local residency, no frontier-model
 * processing. `data_residency` reads from `source.dataResidency`
 * (defaulting to `"NZ"`). Returned as a fresh literal per call so a
 * downstream mutation on one envelope's sovereignty cannot leak into
 * a sibling envelope.
 *
 * **IAW Phase A.3:** `classification` is now an optional parameter
 * (defaulting to `"local"` for back-compat). Cortex's hook stream carries
 * internal session activity (file paths, tool names, command previews);
 * principal-private is the right default. Callers may opt into
 * `"federated"` or `"public"` for explicit cross-principal visibility
 * scenarios. Default preserves the prior posture.
 */
function defaultCcSovereignty(
  source: CcEventSource | undefined,
  classification: Classification = "local",
): Envelope["sovereignty"] {
  return {
    classification,
    data_residency: source?.dataResidency ?? "NZ",
    max_hop: 0,
    frontier_ok: false,
    model_class: "local-only",
  };
}

// cortex#196 — UUID v1-v5 check (`isUuid`) is shared in
// `src/common/types/uuid.ts`. CC sessions sometimes use
// UUID-shaped session_ids and sometimes use shorter strings
// ("unknown", numeric ids); only UUID-shaped values are
// propagated to envelope.correlation_id, the rest land in
// payload.

export interface CreateCcEventEnvelopeOpts {
  /**
   * The PublishedEvent emitted by the relay's policy engine. This is the
   * filtered, consumer-safe form of the underlying CC hook event — see
   * `hooks/lib/event-types.ts` for the schema.
   */
  event: PublishedEvent;
  /**
   * Envelope source — `{principal}.{agent}.{instance}` per schema. All fields
   * have sensible defaults. Callers (the relay) typically override `principal`
   * to match the bot's boot-resolved `principal.id`.
   */
  source?: CcEventSource;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"`. CC hook events carry internal session activity (file paths,
   * tool names); principal-private is the sensible default. Callers may opt
   * into `"federated"` or `"public"` for explicit cross-principal scenarios
   * (e.g. a public demo session whose events should reach a community
   * dashboard). Mismatch with the publish-time subject is a protocol
   * violation (see {@link validateSubjectEnvelopeAlignment}).
   */
  classification?: Classification;
  /**
   * cortex#346 / myelin#161 — optional originator principal DID
   * (`did:mf:<name>`). When supplied, every emitted envelope carries
   *
   *   `originator: { principal, attribution: "adapter-resolved" }`
   *
   * The cc-events tap IS the adapter for the Claude-Code substrate: it
   * lifts hook events from the principal's own stack into the bus.
   * Attribution is always `"adapter-resolved"` because the relay maps the
   * running CC session (a non-myelin identifier) to the stack's myelin
   * principal at sign time.
   *
   * Omit (or pass `undefined`) to preserve pre-#346 behaviour — no
   * `originator` field on the envelope. Legacy consumers that fall back
   * to `signed_by[0].principal` keep working unchanged.
   */
  originatorPrincipal?: string;
}

/**
 * Wrap a PublishedEvent in a Myelin envelope suitable for publishing on
 * `local.{principal}.{type}`. The MyelinRuntime.publish contract (G-1100.E)
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
  // Use the shared envelope builder for the skeleton, then override
  // `timestamp` with the PublishedEvent's hook timestamp so envelope ts ==
  // hook ts (the relay may batch-process; using `now()` from the shared
  // helper would smear chronology across batched events). The override is
  // a single line and preserves the rule-of-three extraction for the rest
  // of the skeleton.
  const envelope = buildBaseEnvelope({
    type: event.event_type,
    source: buildSource(opts.source),
    sovereignty: defaultCcSovereignty(opts.source, opts.classification),
    // Only set correlation_id when session_id has the UUID shape the schema
    // requires. Non-UUID session ids fall through to payload.session_id only.
    ...(isUuid(event.session_id) && { correlationId: event.session_id }),
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
  });
  envelope.timestamp = event.timestamp;
  // cortex#346 / myelin#161 — attach the originator block when configured.
  // Mutation-after-build is fine here: `buildBaseEnvelope` returns a fresh
  // object per call (no aliasing risk), and the field lives at the top
  // level so JSON serialisation picks it up downstream.
  if (opts.originatorPrincipal !== undefined) {
    envelope.originator = {
      principal: opts.originatorPrincipal,
      attribution: "adapter-resolved",
    };
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
   * Principal segment used in the envelope `source` and (when
   * classification is `local` or `federated`) the published NATS subject.
   * Defaults to `"default"` to mirror the MyelinRuntime convention when
   * the boot-resolved `principal.id` is absent.
   */
  principal?: string;
  /**
   * Principal stack segment slotted between `{principal}` and `{type}` on the
   * derived NATS subject (myelin#113 — IAW Phase A.5; closes cortex#266).
   * When supplied, relay-lifted cc-events publish on the 6-segment shape
   * `local.{principal}.{stack}.{type}` matching sage's bridge subscription
   * and the MyelinRuntime.publish path post-cortex#262. When undefined,
   * the legacy 5-segment form `local.{principal}.{type}` is emitted —
   * bit-identical to today's output, so callers that haven't wired
   * stack identity see no change.
   *
   * Production callers (the cortex boot path in `src/cortex.ts`) source
   * this from `deriveStackId(loadedConfig).stack` — the same value
   * `MyelinRuntime.publish` receives, so the runtime path and the
   * cc-events relay agree on the wire grammar for one principal instance.
   * `public.` classification ignores `stack` (per myelin's
   * `deriveNatsSubject` semantics — `public` subjects carry no principal or
   * stack segments).
   */
  stack?: string;
  /**
   * Override the envelope `source.agent` segment. Defaults to `"cortex"`.
   */
  agent?: string;
  /**
   * Override the envelope `source.instance` segment. Defaults to `"relay"`.
   */
  instance?: string;
  /**
   * Principal residency stamped into envelope sovereignty. Defaults to `"NZ"`.
   */
  dataResidency?: string;
  /**
   * IAW Phase A.3 — optional sovereignty classification. Defaults to
   * `"local"` for back-compat. Set `"federated"` or `"public"` to scope
   * relay-lifted CC hooks beyond the principal. Applied to every envelope
   * this publisher produces.
   */
  classification?: Classification;
  /**
   * Override the envelope-construction helper. Lets tests assert on the
   * envelope shape without needing a real NATS connection. Defaults to
   * `createCcEventEnvelope`.
   *
   * **Caller owns classification when overriding.** The closure-captured
   * `opts.classification` is applied by the default-path helper only.
   * If you pass `buildEnvelope`, the override is fully responsible for
   * setting `envelope.sovereignty.classification` to whatever value you
   * configured via `opts.classification` — otherwise the subject
   * (derived from the envelope) and the principal-intended classification
   * can silently diverge (cortex#130 item 3, Echo's suggestion).
   *
   * **Caller also owns `originator` when overriding** — see
   * `originatorPrincipal` below. The default helper applies it; an
   * override must wire it through itself, otherwise published events
   * silently drop the attribution claim.
   */
  buildEnvelope?: (event: PublishedEvent, source: CcEventSource) => Envelope;
  /**
   * cortex#346 / myelin#161 — optional originator principal DID. When set,
   * every envelope this publisher emits carries
   *
   *   `originator: { principal: <originatorPrincipal>, attribution: "adapter-resolved" }`
   *
   * The cc-events tap IS the adapter for the Claude-Code substrate, and
   * the relay maps the running CC session to the stack's myelin principal
   * at sign time — hence the `adapter-resolved` attribution mode.
   *
   * Production callers source this from the principal's stack principal
   * id (e.g. `did:mf:<stack-principal>` derived from cortex config).
   * Omit to preserve pre-#346 behaviour (no originator field; receivers
   * fall back to `signed_by[0].principal` for policy attribution).
   */
  originatorPrincipal?: string;
}

/**
 * Build an `onPublished` callback that wraps each PublishedEvent in a
 * Myelin envelope and publishes it.
 *
 * Returned callback is **synchronous from the relay's perspective** —
 * Core NATS publishes are fire-and-forget at the client layer. Errors
 * surface to the EventProcessor's logging path but never throw out;
 * a flaky NATS must not break the JSONL pipeline.
 *
 * **IAW Phase A.3:** subject derivation now mirrors
 * `envelope.sovereignty.classification` via `deriveNatsSubject`:
 *
 *   - `classification === "local"`     → `local.{principal}.{type}`
 *   - `classification === "federated"` → `federated.{principal}.{type}`
 *   - `classification === "public"`    → `public.{type}` (no `{principal}` segment)
 *
 * Prior code hardcoded `local.{principal}.{type}` here regardless of
 * classification. The 1:1 subject↔classification invariant
 * ({@link validateSubjectEnvelopeAlignment}) now holds for relay-lifted
 * CC events too. The default `classification: "local"` keeps existing
 * subscribers behaving identically.
 */
export function createCcEventPublisher(
  opts: CreateCcEventPublisherOpts,
): (event: PublishedEvent) => void {
  const principal = opts.principal ?? "default";
  const stack = opts.stack;
  const source: CcEventSource = {
    principal,
    agent: opts.agent ?? "cortex",
    instance: opts.instance ?? "relay",
    ...(opts.dataResidency !== undefined && { dataResidency: opts.dataResidency }),
  };
  const classification: Classification = opts.classification ?? "local";
  const originatorPrincipal = opts.originatorPrincipal;
  const buildEnvelope =
    opts.buildEnvelope ??
    ((event: PublishedEvent, src: CcEventSource) =>
      createCcEventEnvelope({
        event,
        source: src,
        classification,
        ...(originatorPrincipal !== undefined && { originatorPrincipal }),
      }));

  return (event: PublishedEvent) => {
    const envelope = buildEnvelope(event, source);
    // IAW A.3 classification + A.5 stack — see `CreateCcEventPublisherOpts.stack`.
    const subject = deriveNatsSubject(envelope, stack);
    try {
      opts.link.publish(subject, JSON.stringify(envelope));
    } catch (err) {
      // Mirror MyelinRuntime.publish's swallow-and-log policy. The relay's
      // primary path is JSONL append; bus is best-effort. Logging here is
      // principal-facing — when a publish fails repeatedly the principal
      // sees it in launchd output and can investigate the NATS server.
      process.stderr.write(
        `cortex-relay: nats publish failed for subject=${subject} id=${envelope.id} type=${envelope.type}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  };
}

