/**
 * `cortex-brain/v1` — the wire protocol between cortex and an externally
 * authored agent brain (Bot Packs B-1; `docs/design-bot-packs.md` §5).
 *
 * JSONL, newline-delimited, one JSON object per line. Every line carries
 * `{ "v": 1, "type": … }`. The grammar is symmetric across both lifecycles
 * (per-task uses stdin/stdout, daemon uses a socket — B-2); only the
 * transport differs, never the message shapes.
 *
 * ## Two directions
 *
 *   - **Cortex → brain (events).** Things the host tells the brain about:
 *     a `task` to run, a follow-up `message`, a host-resolved `gate_verdict`,
 *     a `cancel`, a `shutdown` drain signal, an `effect_rejected` (cortex
 *     refused one of the brain's effects), and the daemon `hello` handshake.
 *   - **Brain → cortex (effects).** Things the brain asks the host to do:
 *     `post` to a surface, `ask_principal` (render a gate), `dispatch` fleet
 *     work, `result` (close the task), and `log`.
 *
 * The brain never sees a platform token, a NATS credential, or another
 * agent's identity (§5 property 1). It *asks* for effects; cortex *performs*
 * them under policy.
 *
 * ## Direction-asymmetric tolerance (§5 "version tolerance")
 *
 * The forward-compat rule from §5 is implemented as two codec halves with
 * opposite strictness:
 *
 *   - **Ingest (brain → cortex effects).** Cortex parses what an untrusted
 *     brain emits, so it is TOLERANT: unknown `type` ⇒ a typed
 *     `{ kind: "unknown", raw }` result the caller drops-and-logs (NEVER a
 *     throw); unknown FIELDS on a known type are ignored (Zod default strip
 *     — extras are dropped, not rejected). A brain on a newer protocol minor
 *     can add fields/types without breaking an older cortex.
 *
 *   - **Emission (cortex → brain events).** Cortex authors these, so they are
 *     STRICT-by-construction: the encoder builds them from typed inputs and
 *     Zod strips any stray keys before serialization. The brain side is the
 *     one expected to tolerate unknown event types (mirror rule), so cortex's
 *     job is only to emit clean, well-formed lines.
 *
 * This is the v1 rule that lets B-2 add events without a protocol bump.
 *
 * ## Vocabulary
 *
 * Gate/effect names use *principal* (`ask_principal`, `principal-ack`) per
 * vocabulary migration 0002 R1/R2. `gate_verdict.verdict` reuses the existing
 * gate vocabulary (`pass | fail`).
 *
 * The refusal taxonomy is DIRECTION-ASYMMETRIC, not a 1:1 mirror of the
 * dispatch nak taxonomy (§5 property 5):
 *
 *   - **Brains emit 3 kinds** (`result.failed.reason.kind`):
 *     `cant_do | not_now | wont_do`. `not_now` may carry `retry_after_ms`.
 *   - **The host may emit 5 kinds** (`effect_rejected.reason.kind`): those 3
 *     plus `policy_denied | compliance_block`, which only the host can decide.
 *
 * Compliance/policy refusals never silently flatten into a brain kind — the
 * host passes them through `effect_rejected` verbatim. The brain-side three are
 * the subset shared with the dispatch nak taxonomy
 * (`src/bus/dispatch-events.ts` `DispatchTaskFailedReason`); the protocol
 * deliberately does NOT re-flatten the kinds into one.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/** The protocol version stamped on every line as `v`. */
export const BRAIN_PROTOCOL_VERSION = 1 as const;

/** The protocol id a manifest declares (`brain.protocol`). */
export const BRAIN_PROTOCOL_ID = "cortex-brain/v1" as const;

/**
 * Inline attachment cap — 256 KiB of base64 (`post.attachment.b64`). Anything
 * larger MUST be written by the brain to its scratch dir and referenced by
 * path (`attachment: { filename, path }`), which cortex reads and uploads.
 * Enforced at parse time so an oversized payload is rejected at the seam, not
 * after a decode. (§5 "Attachments are capped at 256 KiB".)
 */
export const MAX_ATTACHMENT_B64_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * The typed refusal taxonomy. The mapping onto the dispatch nak taxonomy is
 * NOT 1:1 — it is direction-asymmetric (§5 property 5):
 *
 *   - **Brains emit 3 kinds** (`result.failed.reason.kind`): a brain can only
 *     describe its OWN inability or unwillingness.
 *       - `cant_do` — structurally unable (missing skill / capability).
 *       - `not_now` — transient; the same request might succeed later
 *         (backpressure). May carry `retry_after_ms` as a hint.
 *       - `wont_do` — the brain's own will refusal; will not succeed on retry.
 *   - **The HOST may emit 5 kinds** (`effect_rejected.reason.kind`): the host
 *     refuses an effect for the 3 brain reasons PLUS two it alone can decide.
 *       - `policy_denied` — a policy / sovereignty rule refused the effect.
 *       - `compliance_block` — a compliance gate blocked the effect.
 *
 * Compliance/policy refusals NEVER silently flatten into the brain's 3 kinds:
 * the host passes them through `effect_rejected` verbatim with their own kind,
 * so the brain can distinguish "I won't" from "the host's policy won't".
 */

/** Brain-emitted refusal kinds (`result.failed`) — the brain's own 3. */
export const BrainReasonKindSchema = z.enum(["cant_do", "not_now", "wont_do"]);
export type BrainReasonKind = z.infer<typeof BrainReasonKindSchema>;

/**
 * Host-emitted refusal kinds (`effect_rejected`) — the brain's 3 plus the two
 * only the host can decide (`policy_denied`, `compliance_block`).
 */
export const HostReasonKindSchema = z.enum([
  "cant_do",
  "not_now",
  "wont_do",
  "policy_denied",
  "compliance_block",
]);
export type HostReasonKind = z.infer<typeof HostReasonKindSchema>;

/**
 * A brain-emitted refusal reason: `{ kind, detail }`, with an optional
 * `retry_after_ms` hint that is only meaningful when `kind === "not_now"`.
 */
export const BrainReasonSchema = z.object({
  kind: BrainReasonKindSchema,
  detail: z.string(),
  /** Retry hint (ms); only meaningful for `not_now`. */
  retry_after_ms: z.number().int().nonnegative().optional(),
});
export type BrainReason = z.infer<typeof BrainReasonSchema>;

/**
 * A host-emitted refusal reason (`effect_rejected`): the wider 5-kind taxonomy.
 * `retry_after_ms` is likewise only meaningful for `not_now`.
 */
export const HostReasonSchema = z.object({
  kind: HostReasonKindSchema,
  detail: z.string(),
  /** Retry hint (ms); only meaningful for `not_now`. */
  retry_after_ms: z.number().int().nonnegative().optional(),
});
export type HostReason = z.infer<typeof HostReasonSchema>;

/**
 * Gate verdict vocabulary — reuses the existing gate vocabulary (`pass | fail`)
 * rather than the governance allow/deny/defer enum. Aligning the two is a
 * B-1 audit item flagged in §5, NOT a B-1 change.
 */
export const GateVerdictValueSchema = z.enum(["pass", "fail"]);
export type GateVerdictValue = z.infer<typeof GateVerdictValueSchema>;

/**
 * Where a task originated. The brain sees this only as metadata — it is
 * surface-agnostic (§5 property 3). Mattermost today, Discord tomorrow, with
 * zero brain changes; cortex's adapters own the mapping both ways.
 */
export const TaskSourceSchema = z.object({
  surface: z.string(),
  channel: z.string(),
  thread: z.string(),
  user: z.string(),
  /**
   * Host-routing metadata (cortex#1038): the adapter instance id the task
   * arrived on, when the source is a live surface. The brain treats it as
   * opaque (it never chooses a channel — §5 property 1); cortex uses it to
   * route a brain `post` back to the originating adapter via the chat
   * dispatch-sink's `adapter_instance` filter (a bus-originated task has no
   * adapter, so it is absent then). Optional + ignored by the brain.
   */
  adapter_instance: z.string().optional(),
});
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/**
 * Sovereignty constraint on a `dispatch` effect.
 *
 * **Downgrade-only.** The manifest is the ceiling cortex enforces; a brain's
 * `sovereignty` field may only TIGHTEN it (e.g. request `local-only` although
 * `any` is allowed), never loosen it. Policy is never the bot's own claim
 * (§2, §5 property 6). This schema captures the brain's REQUEST; the
 * downgrade-only enforcement happens host-side against the manifest, not here.
 */
export const DispatchSovereigntySchema = z.object({
  model_class: z.string(),
});
export type DispatchSovereignty = z.infer<typeof DispatchSovereigntySchema>;

// ---------------------------------------------------------------------------
// Cortex → brain events
// ---------------------------------------------------------------------------

export const BRAIN_EVENT_TASK = "task" as const;
export const BRAIN_EVENT_MESSAGE = "message" as const;
export const BRAIN_EVENT_GATE_VERDICT = "gate_verdict" as const;
export const BRAIN_EVENT_CANCEL = "cancel" as const;
export const BRAIN_EVENT_SHUTDOWN = "shutdown" as const;
export const BRAIN_EVENT_EFFECT_REJECTED = "effect_rejected" as const;
export const BRAIN_EVENT_HELLO = "hello" as const;

/**
 * `task` — start a unit of work. Per-task brains receive `persona` here (§5
 * "Persona delivery"); daemons receive it once in `hello` instead, so it is
 * optional on the task event.
 */
export const TaskEventSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EVENT_TASK),
  task_id: z.string().min(1),
  capability: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  source: TaskSourceSchema,
  /** Per-task lifecycle: the brain's persona text, delivered on the task. */
  persona: z.string().optional(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

/** `message` — a follow-up in an open task's thread. */
export const MessageEventSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EVENT_MESSAGE),
  task_id: z.string().min(1),
  text: z.string(),
  user: z.string(),
});
export type MessageEvent = z.infer<typeof MessageEventSchema>;

/**
 * `gate_verdict` — the answer to an `ask_principal`.
 *
 * Carries the HOST-RESOLVED `principal`, not whatever was typed in a chat
 * thread. The brain must never infer a verdict from `message` text — the host
 * performs the principal check (the pulse#47 lesson) and only then forwards
 * this event. (§5 "Protocol contract details".)
 */
export const GateVerdictEventSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EVENT_GATE_VERDICT),
  task_id: z.string().min(1),
  gate: z.string().min(1),
  verdict: GateVerdictValueSchema,
  notes: z.string().optional(),
  /** The host-resolved principal id — authoritative, not chat-inferred. */
  principal: z.string().min(1),
});
export type GateVerdictEvent = z.infer<typeof GateVerdictEventSchema>;

/** `cancel` — abandon an in-flight task. */
export const CancelEventSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EVENT_CANCEL),
  task_id: z.string().min(1),
});
export type CancelEvent = z.infer<typeof CancelEventSchema>;

/**
 * `shutdown` — drain signal (hot-swap). The brain has `deadline_ms` to finish
 * in-flight work before SIGTERM; per §7 escalation, deadline → SIGTERM, +5s →
 * SIGKILL.
 */
export const ShutdownEventSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EVENT_SHUTDOWN),
  deadline_ms: z.number().int().nonnegative(),
});
export type ShutdownEvent = z.infer<typeof ShutdownEventSchema>;

/**
 * `effect_rejected` — cortex refused one of the brain's effects (e.g. a
 * `dispatch` for a capability outside the manifest, a foreign `task_id`, or a
 * scratch-path escape). The brain decides how to degrade. Carries the WIDER
 * HOST taxonomy ({@link HostReasonSchema}): the brain's 3 kinds plus
 * `policy_denied | compliance_block`, which only the host can decide (§5
 * property 5). A policy/compliance refusal is passed through verbatim, never
 * flattened into a brain kind.
 */
export const EffectRejectedEventSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EVENT_EFFECT_REJECTED),
  task_id: z.string().min(1),
  /** The effect type cortex refused (e.g. `"dispatch"`, `"post"`). */
  effect: z.string().min(1),
  reason: HostReasonSchema,
});
export type EffectRejectedEvent = z.infer<typeof EffectRejectedEventSchema>;

/**
 * `hello` — daemon handshake, emitted once at start. Carries the persona
 * (daemon brains do not get it per-task) plus the agent id and protocol
 * version. (§5 "Persona delivery"; daemon path is B-2 but the shape is fixed
 * here so the codec is complete.)
 *
 * **Agent identity is HOST-AUTHORITATIVE.** `hello` is a cortex → brain event:
 * the host TELLS the brain which agent identity it has been spawned as. It is
 * NOT a brain-asserted name. The brain never emits `hello` (it lives in the
 * EVENT union cortex encodes, never the EFFECT union the brain emits), so there
 * is no codec path by which a brain could assert its own `agent` and have the
 * host trust it. The identity source is host config, full stop; this field is
 * informational, host → brain.
 */
export const HelloEventSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EVENT_HELLO),
  persona: z.string(),
  agent: z.string().min(1),
  protocol: z.literal(BRAIN_PROTOCOL_ID),
});
export type HelloEvent = z.infer<typeof HelloEventSchema>;

/**
 * Discriminated union of every cortex → brain event. Used for the tolerant
 * INGEST direction (a brain decoding what cortex sent it) — but cortex itself
 * only ever ENCODES these, so within cortex this union is the input domain of
 * {@link encodeBrainEvent}.
 */
export const BrainEventSchema = z.discriminatedUnion("type", [
  TaskEventSchema,
  MessageEventSchema,
  GateVerdictEventSchema,
  CancelEventSchema,
  ShutdownEventSchema,
  EffectRejectedEventSchema,
  HelloEventSchema,
]);
export type BrainEvent = z.infer<typeof BrainEventSchema>;

// ---------------------------------------------------------------------------
// Brain → cortex effects
// ---------------------------------------------------------------------------

export const BRAIN_EFFECT_POST = "post" as const;
export const BRAIN_EFFECT_ASK_PRINCIPAL = "ask_principal" as const;
export const BRAIN_EFFECT_DISPATCH = "dispatch" as const;
export const BRAIN_EFFECT_RESULT = "result" as const;
export const BRAIN_EFFECT_LOG = "log" as const;

/**
 * `post` attachment — inline base64 XOR a scratch-dir path, never both.
 *
 *   - `{ filename, b64 }` — inline, capped at {@link MAX_ATTACHMENT_B64_BYTES}
 *     (256 KiB) enforced at parse time.
 *   - `{ filename, path }` — a path in the brain's scratch dir; cortex reads
 *     and uploads it. The over-256-KiB escape hatch. Host-side scratch
 *     confinement (the resolved path must stay within THIS task's scratch
 *     dir) is enforced by the runner, NOT here — the codec only validates
 *     SHAPE; the runner owns the filesystem boundary (see
 *     `exec-brain-runner.ts` `confineScratchPath`).
 *
 * EXCLUSIVE on the discriminating keys, TOLERANT on everything else: exactly
 * one of `b64` / `path` must be present — both (or neither) fails validation,
 * never silent stripping of the loser. Unknown EXTRA fields (future
 * attachment metadata) are ignored per the codec's tolerant-ingest rule —
 * which is why these are NOT strict objects.
 */
const attachmentXor = (a: { b64?: unknown; path?: unknown }) =>
  (a.b64 !== undefined) !== (a.path !== undefined);

export const PostAttachmentSchema = z
  .object({
    filename: z.string().min(1),
    b64: z
      .string()
      .refine(
        (s) => Buffer.byteLength(s, "utf8") <= MAX_ATTACHMENT_B64_BYTES,
        {
          message: `inline attachment b64 exceeds ${MAX_ATTACHMENT_B64_BYTES} bytes (256 KiB); write it to the scratch dir and use { filename, path } instead`,
        },
      )
      .optional(),
    path: z.string().min(1).optional(),
  })
  .refine(attachmentXor, {
    message: "attachment must carry exactly one of `b64` or `path`",
  });
export type PostAttachment = z.infer<typeof PostAttachmentSchema>;

/**
 * `post` — cortex posts `text` (and optional `attachment`) to the task's
 * surface/thread. A brain cannot choose the channel — it is bound to the task
 * source (§5 property 1).
 */
export const PostEffectSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EFFECT_POST),
  task_id: z.string().min(1),
  text: z.string(),
  attachment: PostAttachmentSchema.optional(),
});
export type PostEffect = z.infer<typeof PostEffectSchema>;

/**
 * `ask_principal` — render a gate. Cortex enforces the principal check; the
 * brain only supplies the prompt and the gate name. The answer comes back as
 * a {@link GateVerdictEvent}.
 */
export const AskPrincipalEffectSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EFFECT_ASK_PRINCIPAL),
  task_id: z.string().min(1),
  gate: z.string().min(1),
  prompt: z.string(),
});
export type AskPrincipalEffect = z.infer<typeof AskPrincipalEffectSchema>;

/**
 * `dispatch` — fleet work; cortex publishes the myelin envelope. The optional
 * `sovereignty` field is DOWNGRADE-ONLY: it may only tighten the manifest
 * ceiling, never loosen it (enforced host-side — §5 property 6). See
 * {@link DispatchSovereigntySchema}.
 */
export const DispatchEffectSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EFFECT_DISPATCH),
  task_id: z.string().min(1),
  capability: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sovereignty: DispatchSovereigntySchema.optional(),
});
export type DispatchEffect = z.infer<typeof DispatchEffectSchema>;

/**
 * `result` — closes the task. `complete` carries an optional `summary`;
 * `failed` carries the typed `reason` (cant_do | not_now | wont_do — §5
 * property 5). Modeled as a `status`-discriminated union so a `failed` result
 * MUST carry a reason and a `complete` result must not pretend to.
 */
export const ResultEffectSchema = z.discriminatedUnion("status", [
  z.object({
    v: z.literal(BRAIN_PROTOCOL_VERSION),
    type: z.literal(BRAIN_EFFECT_RESULT),
    task_id: z.string().min(1),
    status: z.literal("complete"),
    summary: z.string().optional(),
    // A `complete` result carrying a `reason` is ambiguous, not tolerable —
    // reject it instead of silently stripping (sage round 3).
    reason: z.undefined().optional(),
  }),
  z.object({
    v: z.literal(BRAIN_PROTOCOL_VERSION),
    type: z.literal(BRAIN_EFFECT_RESULT),
    task_id: z.string().min(1),
    status: z.literal("failed"),
    reason: BrainReasonSchema,
  }),
]);
export type ResultEffect = z.infer<typeof ResultEffectSchema>;

/** `log` — diagnostic line; not surfaced to the principal. */
export const LogEffectSchema = z.object({
  v: z.literal(BRAIN_PROTOCOL_VERSION),
  type: z.literal(BRAIN_EFFECT_LOG),
  level: z.enum(["debug", "info", "warn", "error"]),
  text: z.string(),
});
export type LogEffect = z.infer<typeof LogEffectSchema>;

/**
 * Discriminated union of every brain → cortex effect. This is the INGEST
 * domain within cortex — what {@link parseBrainEffect} validates a single
 * line against before the tolerant unknown-type fallback.
 */
export const BrainEffectSchema = z.discriminatedUnion("type", [
  PostEffectSchema,
  AskPrincipalEffectSchema,
  DispatchEffectSchema,
  ResultEffectSchema,
  LogEffectSchema,
]);
export type BrainEffect = z.infer<typeof BrainEffectSchema>;

// ---------------------------------------------------------------------------
// Parse results — tolerant ingest
// ---------------------------------------------------------------------------

/**
 * The result of tolerantly parsing one ingest line. Forward-compat (§5
 * "version tolerance"): an unknown `type` is never a throw — it surfaces as
 * `{ kind: "unknown", raw }` the caller can drop-and-log.
 *
 *   - `ok`       — a well-formed, known effect.
 *   - `unknown`  — well-formed JSON `{ v, type, … }` but an unrecognised
 *                  `type`; `raw` is the parsed object for logging.
 *   - `invalid`  — malformed JSON, or a known type that failed validation
 *                  (e.g. an oversized attachment, a missing required field).
 */
export type ParseBrainEffectResult =
  | { kind: "ok"; effect: BrainEffect }
  | { kind: "unknown"; raw: Record<string, unknown> }
  | { kind: "invalid"; detail: string; raw?: unknown };

/** The known brain → cortex effect `type` literals, for the tolerance gate. */
const KNOWN_EFFECT_TYPES: ReadonlySet<string> = new Set([
  BRAIN_EFFECT_POST,
  BRAIN_EFFECT_ASK_PRINCIPAL,
  BRAIN_EFFECT_DISPATCH,
  BRAIN_EFFECT_RESULT,
  BRAIN_EFFECT_LOG,
]);

// ---------------------------------------------------------------------------
// Codec — single JSON lines
// ---------------------------------------------------------------------------

/**
 * Encode a cortex → brain event as a single JSONL line (no trailing newline).
 * STRICT emission: the event is validated and stray keys are stripped (Zod
 * default) before serialization, so cortex never leaks an internal field onto
 * the wire. Throws on an event that fails its own schema — that is a cortex
 * bug, not untrusted input.
 */
export function encodeBrainEvent(event: BrainEvent): string {
  const parsed = BrainEventSchema.parse(event);
  return JSON.stringify(parsed);
}

/**
 * Parse a single JSONL line the brain sent cortex into a tolerant result.
 * NEVER throws (§5 forward-compat) — malformed JSON, unknown types, and
 * validation failures all return a typed variant.
 *
 * Tolerance order:
 *   1. JSON parse fails            → `invalid`.
 *   2. not an object / no `type`   → `invalid`.
 *   3. `type` not in known set     → `unknown` (drop-and-log).
 *   4. known `type`, fails schema  → `invalid` (e.g. oversized attachment).
 *   5. known `type`, valid         → `ok`.
 *
 * Unknown FIELDS on a known type are ignored (Zod strips them by default).
 */
export function parseBrainEffect(line: string): ParseBrainEffectResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "invalid", detail: `malformed JSON: ${detail}`, raw: line };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "invalid",
      detail: "line is not a JSON object",
      raw,
    };
  }

  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") {
    return {
      kind: "invalid",
      detail: "missing or non-string `type` field",
      raw: obj,
    };
  }

  // Forward-compat: an unrecognised type is dropped-and-logged, never thrown.
  if (!KNOWN_EFFECT_TYPES.has(type)) {
    return { kind: "unknown", raw: obj };
  }

  const result = BrainEffectSchema.safeParse(obj);
  if (!result.success) {
    return {
      kind: "invalid",
      detail: result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
      raw: obj,
    };
  }
  return { kind: "ok", effect: result.data };
}

/**
 * Encode a brain → cortex effect as a single JSONL line. Provided for symmetry
 * (and so a TS-authored brain or test fixture can emit effects through the same
 * schema cortex validates with). Validates + strips before serializing.
 */
export function encodeBrainEffect(effect: BrainEffect): string {
  const parsed = BrainEffectSchema.parse(effect);
  return JSON.stringify(parsed);
}

/**
 * Parse a single JSONL line cortex sent the brain into a tolerant result.
 * The inverse of {@link parseBrainEffect}, for the brain side / tests: cortex
 * itself only ever encodes events, but a brain decoding them needs the same
 * unknown-type tolerance (the mirror of §5's "brains MUST ignore unknown
 * cortex→brain event types").
 */
export type ParseBrainEventResult =
  | { kind: "ok"; event: BrainEvent }
  | { kind: "unknown"; raw: Record<string, unknown> }
  | { kind: "invalid"; detail: string; raw?: unknown };

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  BRAIN_EVENT_TASK,
  BRAIN_EVENT_MESSAGE,
  BRAIN_EVENT_GATE_VERDICT,
  BRAIN_EVENT_CANCEL,
  BRAIN_EVENT_SHUTDOWN,
  BRAIN_EVENT_EFFECT_REJECTED,
  BRAIN_EVENT_HELLO,
]);

export function parseBrainEvent(line: string): ParseBrainEventResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: "invalid", detail: `malformed JSON: ${detail}`, raw: line };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", detail: "line is not a JSON object", raw };
  }

  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") {
    return {
      kind: "invalid",
      detail: "missing or non-string `type` field",
      raw: obj,
    };
  }

  if (!KNOWN_EVENT_TYPES.has(type)) {
    return { kind: "unknown", raw: obj };
  }

  const result = BrainEventSchema.safeParse(obj);
  if (!result.success) {
    return {
      kind: "invalid",
      detail: result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; "),
      raw: obj,
    };
  }
  return { kind: "ok", event: result.data };
}

// ---------------------------------------------------------------------------
// Incremental decoder — chunked stream input
// ---------------------------------------------------------------------------

/**
 * Incremental newline-delimited JSON decoder. Feeds it arbitrary chunks
 * (which may split a line anywhere, including mid-multibyte) and it yields
 * complete lines, buffering the partial tail across calls.
 *
 * It is transport-agnostic: it does not know about events vs effects — it
 * only splits on `\n` and hands whole lines back. The runner pairs it with
 * {@link parseBrainEffect} (cortex reading a brain's stdout); a brain pairs
 * it with {@link parseBrainEvent}.
 *
 * Decoding is UTF-8 streaming (`TextDecoder({ stream: true })`) so a chunk
 * boundary in the middle of a multibyte codepoint is handled correctly.
 */
export class JsonlDecoder {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  /**
   * Push a chunk and return every COMPLETE line it produced (without the
   * trailing `\n`). A trailing partial line is buffered for the next call.
   * Empty lines (blank `\n\n`) are skipped — they carry no JSON object.
   */
  push(chunk: Uint8Array | string): string[] {
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });

    const lines: string[] = [];
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      // Tolerate CRLF and skip blank lines.
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length > 0) {
        lines.push(trimmed);
      }
      newlineIdx = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /**
   * Flush any buffered tail at end-of-stream. Returns the final line if the
   * stream ended without a trailing newline (and it is non-empty), else `[]`.
   * Also flushes any pending multibyte state from the UTF-8 decoder.
   */
  flush(): string[] {
    // Drain any final bytes held by the streaming UTF-8 decoder.
    this.buffer += this.decoder.decode();
    const tail = this.buffer;
    this.buffer = "";
    const trimmed = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
    return trimmed.length > 0 ? [trimmed] : [];
  }
}
