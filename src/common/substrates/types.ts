/**
 * IAW Phase A.1 (cortex#113) — Substrate harness protocol types.
 *
 * Origin: cortex#91 — "design: SessionHarness interface — multi-substrate
 * agent dispatch". Synthesis: cortex#110 / cortex#112 / the IAW design doc
 * (`docs/design-internet-of-agentic-work.md`) §3.1, §4 "cortex#91".
 *
 * **What this file is.** A pure-type contract that lets cortex's runner
 * dispatch a task to an execution substrate (Claude Code in-process, an
 * out-of-process bus peer like sage, a future Codex/Cursor/Gemini/Mistral
 * CLI, a direct pi.dev call) without the caller knowing which one is
 * actually on the other side. The shape mirrors `MyelinRuntime` so the
 * dispatch contract reads symmetrically across substrate boundaries.
 *
 * **Why types-only.** Phase A.1 freezes the interface; Phase A.1b flips
 * dispatch-listener over; Phases A.2–A.5 evolve the envelope/subject layer
 * underneath. Keeping types and implementation in separate PRs limits the
 * blast radius of each cutover.
 *
 * **OSI/M1–M7 layering** (design doc §1):
 *   - This protocol sits at **M6 (composition)**. It's application-layer
 *     glue between the runner (M7) and any execution substrate. It does
 *     NOT define wire format (that's M3 — myelin envelope) and does NOT
 *     define transport (that's M2 — `MyelinRuntime`). It only defines the
 *     *function-call shape* between a cortex agent and its substrate.
 *   - The async-iterable yield contract is what makes the protocol
 *     symmetric between in-process spawn substrates (events arrive as
 *     stream-json from a child) and bus-peer substrates (envelopes arrive
 *     via NATS subscription on `local.{op}.{stack}.dispatch.<id>.>`).
 *
 * **Q-lock-ins consulted (design doc §5, 2026-05-13 Andreas):**
 *   - **Q1-α (tool capability format).** `ToolCapability.allow[]` is
 *     harness-native strings — no cross-substrate translation layer in
 *     cortex. Claude Code sees `["Bash", "Edit", "Write"]`, a future
 *     Codex harness would see `["exec"]`. Cortex stays out of the
 *     translation business. See `ToolCapability` doc.
 *   - **Q1 (stack identity).** `agent.id` accepts a string today; the
 *     `{principal_id}/{stack_id}` shape is enforced by cortex.yaml's
 *     `stack:` block in Phase A.5 — not at this protocol layer. A.1 only
 *     needs the type to *carry* the identity.
 *   - **Q5 (streaming subject convention).** `DispatchRequest.requestId`
 *     is the subject suffix for `local.{op}.{stack}.dispatch.<harnessId>.<requestId>.{progress|complete|error|timeout}`.
 *     This file types the semantic but does NOT wire NATS publishing —
 *     that's Phase B's NKey-signed envelope work.
 *   - **Q6 (timeout semantics).** Two caps that race, first-to-expire
 *     wins: wall-clock (default 300_000ms) AND inactivity between
 *     envelopes (default 60_000ms). See `DispatchRequest.timeoutMs` /
 *     `inactivityMs` docs.
 *   - **Q7 (stack as protocol primitive).** Subject namespace gains a
 *     `{stack}` segment — typed via the implicit shape of `requestId`'s
 *     position in the subject. A.5 work materialises the cortex.yaml side.
 *
 * **What this file is NOT.**
 *   - NOT a transport — `MyelinRuntime.publish()` and `subscribe()` still
 *     own NATS publishing. Harnesses produce envelopes; the surface-router
 *     decides where (and whether) to publish them.
 *   - NOT an envelope schema — `MyelinEnvelope` (alias for `Envelope` in
 *     `src/bus/myelin/envelope-validator.ts`) is the wire schema. This
 *     file types the *flow* by which envelopes get produced.
 *   - NOT a runtime registry — there's no `HarnessRegistry` here. Wiring
 *     a concrete `SessionHarness` instance into the runner is A.1b work
 *     (the dispatch-listener flip).
 *   - NOT a policy engine — `tools.allow[]` is a substrate-native ACL.
 *     Cross-principal authorisation lives in cortex#107's PolicyEngine,
 *     consumed by the runner BEFORE calling `dispatch()`.
 */

import type { Envelope } from "../../bus/myelin/envelope-validator";
import type { Principal } from "../policy/types";

// ---------------------------------------------------------------------------
// MyelinEnvelope alias
// ---------------------------------------------------------------------------

/**
 * Alias for the canonical envelope type from `bus/myelin/envelope-validator`.
 * Re-exported under the `MyelinEnvelope` name to make the substrate protocol
 * read closer to the design-doc prose (which always says "MyelinEnvelope")
 * without forcing the rest of the codebase to migrate its `Envelope` imports.
 */
export type MyelinEnvelope = Envelope;

// ---------------------------------------------------------------------------
// HarnessId — closed enum of known substrates
// ---------------------------------------------------------------------------

/**
 * Closed enum of substrate harness implementations cortex knows about.
 *
 * Spelled out as a string-literal union (rather than a const-string array)
 * so a `switch (harness.id)` statement in the runner gets exhaustiveness
 * checking from `tsc`. Adding a new substrate is a typed change at every
 * dispatch decision point — the compiler enumerates the work for you.
 *
 * The eight known substrates (per cortex#91 §"Implementations" and
 * §"Future harnesses"):
 *
 *   - `"claude-code"`   — in-process child via `claude --print
 *                         --output-format stream-json`. The first
 *                         implementation (this PR).
 *   - `"bus-peer"`      — out-of-process daemon reachable via NATS,
 *                         using the publish-dispatch + subscribe-reply
 *                         pattern sage already implements. Lands in
 *                         the A.1b follow-up alongside the dispatch flip.
 *   - `"openai-codex"`  — Codex CLI child process. Stubbed in cortex#91 §F.
 *   - `"cursor"`        — Cursor CLI child process. Tracked via cortex#70.
 *   - `"gemini"`        — gemini-cli child process.
 *   - `"mistral"`       — Mistral CLI / API.
 *   - `"pi-dev"`        — direct pi.dev call without bus indirection;
 *                         used for cortex-co-located agents.
 *   - `"agent-team"`    — meta-harness that coordinates a moderator plus
 *                         multiple participant harnesses for delegate mode.
 *
 * **Why not `string`?** Because the runtime needs to refuse the unknown.
 * A new harness must be a typed registration, not a free-form string,
 * so any agent config referencing an unimplemented substrate fails fast.
 */
export type HarnessId =
  | "claude-code"
  | "bus-peer"
  | "openai-codex"
  | "cursor"
  | "gemini"
  | "mistral"
  | "pi-dev"
  | "agent-team";

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * Self-described capability a harness can provide. Used by the future
 * capability registry (Q2 lock-in, A.6 work) and by orchestrator agents
 * (design doc §3.6) to reason about delegation.
 *
 * **Q2 lock-in shape note.** A.1 ships a SUBSET of the constrained schema
 * from §5/Q2 (`id`, `description`, optional `tags`). Phase A.6 grows it
 * to add `provided_by[]`, optional `rate`, optional `cost`. We ship the
 * subset today so the harness protocol doesn't block on the full schema
 * roll-out — the additional fields are purely metadata for the capability
 * registry, not for dispatch decisions.
 *
 * **What this is NOT.** Not a runtime claim — a `Capability` listed here
 * is a *declaration* about what the harness can do. Whether a given
 * dispatch is allowed to use it is governed by `DispatchRequest.tools`
 * (substrate-side ACL) and cortex#107's PolicyEngine (principal-side ACL).
 */
export interface Capability {
  /**
   * Capability id — slug, network-stable. Examples: `"code-review"`,
   * `"design-doc-review"`, `"code-review.typescript"`. Must match
   * `[a-z0-9.-]+` once Q2 §A.6 lands; A.1 enforces no format constraint.
   */
  id: string;
  /** Short human-readable summary. Rendered in dashboard agent cards. */
  description: string;
  /**
   * Optional taxonomic tags — language (`"typescript"`, `"python"`),
   * domain (`"security"`, `"perf"`), modality (`"async"`, `"streaming"`).
   * Order is not semantic.
   */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// ToolCapability
// ---------------------------------------------------------------------------

/**
 * Substrate-native tool ACL for a single dispatch.
 *
 * **Q1-α lock-in (2026-05-13 Andreas, design doc §5).** Strings in
 * `allow[]` / `deny[]` are *substrate-native* — Claude Code sees
 * `["Bash", "Edit", "Write"]`, a future Codex harness would see
 * `["exec"]`. Cortex deliberately does NOT translate across substrates.
 * The harness is the authority on what its substrate's tool vocabulary
 * looks like; cortex passes the strings through.
 *
 * **Why a negative deny-list in addition to allow?** Some substrates
 * expose a wildcard `*` allow-by-default mode (e.g. CC's hook-free runs).
 * In those cases, `deny[]` is the only practical surface for an
 * principal-side ACL — "let it do anything except this specific tool".
 * Most call sites set only `allow[]` and leave `deny[]` undefined.
 */
export interface ToolCapability {
  /**
   * Allowed tools — substrate-native strings. Empty array = no tools
   * (the harness should refuse to dispatch). For wildcard "all tools",
   * pass `["*"]` if the substrate recognises it; otherwise enumerate.
   */
  allow: string[];
  /**
   * Optional deny-list. Intersection with `allow[]` resolves to "denied".
   * Used when `allow[]` is a wildcard and the principal wants to subtract
   * specific tools. Most dispatches leave this undefined.
   */
  deny?: string[];
}

// ---------------------------------------------------------------------------
// DispatchRuntime — optional substrate-runtime knobs
// ---------------------------------------------------------------------------

/**
 * Optional substrate-runtime hints carried alongside the core dispatch
 * inputs.
 *
 * These are *harness-internal* concerns (cwd, allowedDirs, bash allowlist,
 * grove channel/network labels, resume tokens, extra CLI args) that the
 * runner historically built directly into `CCSessionOpts` inside
 * `dispatch-listener.ts` (A.1b folds that mapping in here). Putting them
 * on the request keeps every future harness reading the same shape:
 * CC-specific harnesses consume the CC-specific fields, future harnesses
 * silently ignore knobs they don't understand.
 *
 * **Why optional everywhere.** Phase A.1b is a behaviour-preserving
 * refactor: dispatch-listener supplies whatever the legacy payload
 * carries, and the harness applies what it understands. Required fields
 * would force every test, every future caller, and every other harness
 * implementation to populate CC-specific knobs they don't care about.
 *
 * **What does NOT live here.** Tool ACLs (`tools`) stay on `DispatchRequest`
 * top-level — every harness needs them and they're an explicit ACL surface.
 * Persona content stays on the request top-level — it's the system prompt
 * regardless of substrate. The fields here are the residual *runtime
 * knobs* that historically traveled with the `CCSession` constructor but
 * are NOT part of the conceptual dispatch contract.
 *
 * **Schema growth path.** Adding a new field here is a non-breaking
 * change — all fields are optional and unknown fields are simply ignored
 * by any harness that doesn't read them. A.3 / A.5 / B may introduce
 * stack-aware fields (principal id, stack id, signing key hint) into this
 * same block.
 */
export interface DispatchRuntime {
  /**
   * Working directory for the substrate process. Substrates that don't
   * spawn child processes (`bus-peer`, `pi-dev`) MAY ignore this.
   *
   * Carried from the legacy `CCSessionOpts.cwd` — historically derived
   * from `access.dirRestrictions[0]` or the agent's `claude.allowedDirs`
   * config block.
   */
  cwd?: string;
  /**
   * Filesystem read/write allowlist. Substrates that enforce a
   * filesystem boundary (CC's `--add-dir`) consume this; others ignore.
   *
   * Per Q1-α lock-in, these are substrate-native path strings. Cortex
   * does NOT translate across substrates.
   */
  allowedDirs?: string[];
  /**
   * Bash guard allowlist config. CC's `bash-guard.hook.ts` reads this
   * via the `CORTEX_BASH_GUARD` env var and refuses any `Bash` tool
   * invocation whose command doesn't match the allowlist. Future
   * non-CC harnesses ignore this field.
   */
  bashAllowlist?: {
    rules: { pattern: string; repos?: string[] }[];
    repos: string[];
  };
  /**
   * When `true`, disables the bash guard entirely. Used by principal DMs
   * (the highest-privilege role) where the principal is trusted to run
   * arbitrary commands. Future non-CC harnesses ignore.
   */
  bashGuardDisabled?: boolean;
  /**
   * Extra CLI args appended to the substrate's invocation. CC consumes
   * these as `claude … <additional_args>`; other substrates may use
   * them for their own CLI flag passthrough.
   */
  additionalArgs?: string[];
  /**
   * Grove channel/network labels stamped onto downstream events (for
   * the dashboard's per-channel grouping). Carried via `GROVE_CHANNEL`
   * / `GROVE_NETWORK` env vars on the CC child process; future
   * substrates may surface the same labels through their own event-tap
   * mechanism.
   */
  groveChannel?: string;
  groveNetwork?: string;
  /**
   * Resume token for substrates that support stateful resumption (CC's
   * `--resume <session-id>`). Future stateless substrates (`bus-peer`
   * for one-shot delegations) ignore this. Optional everywhere — the
   * runner only sets this on thread continuations.
   */
  resumeSessionId?: string;
}

// ---------------------------------------------------------------------------
// DispatchRequest
// ---------------------------------------------------------------------------

/**
 * The full input to `SessionHarness.dispatch()` — everything a substrate
 * needs to do one task end-to-end and emit lifecycle envelopes.
 *
 * **Naming convention.** camelCase on this interface; envelope payloads
 * are snake_case per G-1100.B schema. The harness is the translation
 * layer — runner code writes camelCase; envelopes that flow back on the
 * bus carry snake_case fields.
 *
 * **Per-field design-doc anchors:**
 *   - `persona` — design doc §2 (M7 persona files), `architecture.md` §9.3.
 *     **Optional in A.1b** (Echo cortex#125 review): today the runner
 *     injects persona via the prompt-builder path BEFORE constructing
 *     the request, so the harness layer doesn't itself need to surface
 *     the persona file. Kept as an optional provenance hint and a
 *     forward door for substrates that DO inject the persona themselves
 *     at dispatch time.
 *   - `prompt` — the principal-or-agent-generated work request.
 *   - `tools` — Q1-α lock-in (substrate-native tool strings).
 *   - `context` — pluggable context bundle: discord-history, attachments,
 *     env vars, prior session state. Harness consumes whichever kinds it
 *     understands; unknown kinds are ignored, not errored.
 *   - `agent` — logical agent id + display + optional runtime hint. The
 *     `runtime.harness` field is informational — `SessionHarness.id`
 *     is the authoritative substrate the dispatch is running on.
 *   - `requestId` — Q5 lock-in subject suffix; correlates progress /
 *     complete / error / timeout envelopes for one dispatch.
 *   - `runtime` — optional substrate-runtime knobs (cwd, allowedDirs,
 *     bash allowlist, grove channel labels, resume tokens, extra CLI
 *     args). See `DispatchRuntime` doc for the per-field rationale.
 *   - `timeoutMs` / `inactivityMs` — Q6 lock-in (two caps race).
 */
export interface DispatchRequest {
  /**
   * Agent persona. `path` is the resolved file path (for provenance in
   * envelopes and dashboard renderers); `content` is the resolved
   * markdown body. Optional in A.1b — see interface doc.
   *
   * When present, the substrate may inject `content` as a system
   * prompt; when omitted, the caller (typically `dispatch-handler`) has
   * already inlined the persona into `prompt` via the prompt-builder.
   */
  persona?: {
    /** Absolute or repo-relative path. Used for provenance only. */
    path: string;
    /** Resolved markdown content — what the substrate actually injects. */
    content: string;
  };
  /**
   * The work request itself. The substrate is free to embed this in
   * whatever prompt-engineering scaffold it requires (security
   * preamble, examples, etc.) — the contents are NOT mutated by the
   * runner before this point.
   */
  prompt: string;
  /**
   * Substrate-native tool ACL. See `ToolCapability` doc.
   *
   * The runner builds this from the agent's role + the principal's
   * policy decision (cortex#107). By the time it reaches the harness,
   * all policy work is done — the harness MUST NOT widen the set.
   */
  tools: ToolCapability;
  /**
   * cortex#710 — per-skill grant list. Distinct from `tools`: skills are a
   * Claude-Code-specific capability gated by a PreToolUse hook, not by the
   * `allowedTools`/`disallowedTools` permission lists (Claude Code's `Skill`
   * tool has no `Skill(<name>)` specifier syntax, so the grant can't be
   * expressed as a tool rule — see cortex#706/#710).
   *
   * Semantics, mirroring `AccessDecision.allowedSkills`:
   *   - `undefined` → no decision carried; the harness applies its default
   *     (which, for the CC harness, is the default-deny `disallowedTools:
   *     ["Skill"]` posture — no skills).
   *   - `[]` → explicit default-deny: no skills (no Skill tool).
   *   - `[...]` → grant exactly those skills via the Skill Guard PreToolUse
   *     hook + a broad `Skill` allow.
   *
   * Non-CC harnesses (bus-peer, future) ignore this field.
   */
  allowedSkills?: string[];
  /**
   * Pluggable context bundle. The runner attaches whatever the agent's
   * trigger source produced (Discord message history, GitHub PR diffs,
   * attachments, environment hints). The harness handles whichever
   * `kind` values it recognises; unknown kinds are silently dropped.
   *
   * Common kinds in v1:
   *   - `"discord-history"` — array of recent messages in the thread
   *   - `"attachments"` — list of `AttachmentInfo` objects
   *   - `"env"` — principal-and-entity hints (principal id, repo, entity)
   *
   * The shape is `unknown` because we deliberately don't constrain
   * extensibility — adding a new context kind should not require a
   * protocol-layer schema change. Validation, if any, is harness-side.
   */
  context: { kind: string; data: unknown }[];
  /**
   * Agent identity for the dispatch. `id` and `displayName` are the
   * minimum the runner needs for envelope provenance; `runtime.harness`
   * is an informational hint — the *actual* substrate is whichever
   * `SessionHarness` instance the runner picked.
   */
  agent: {
    /** Logical agent id — must match `agents[].id` in cortex.yaml. */
    id: string;
    /** Display name surfaced to humans on dashboard / Discord. */
    displayName: string;
    /**
     * Optional runtime hint. The `harness` field is informational —
     * the actual substrate is determined by which `SessionHarness`
     * instance the runner resolves at dispatch time. Present here so
     * the harness can short-circuit on a mismatch ("you told me you
     * want claude-code but you're calling a bus-peer harness").
     *
     * Stack identity (Q1) is NOT carried here — it's a property of
     * the principal's cortex.yaml `stack:` block (A.5 work). The
     * harness receives stack identity via the runner's outer scope,
     * not as a per-dispatch parameter.
     */
    runtime?: {
      harness?: HarnessId;
    };
  };
  /**
   * IAW Phase C.3.2 — the authenticated principal whose authority
   * this dispatch carries. Populated by the dispatch-listener after
   * the PolicyEngine accepts the call; absent when the runner is
   * booted without a `policy:` block (legacy / dev path) so the
   * existing test surface keeps compiling unchanged.
   *
   * Shape mirrors `src/common/policy/types.ts` Principal. We import
   * the type from there to keep the engine and the harness on one
   * definition of "who is acting" — the harness can read
   * `principal.home_principal` / `home_stack` for sovereignty-aware
   * substrate decisions without re-parsing the envelope.
   */
  principal?: Principal;
  /**
   * Q5 lock-in (design doc §5, 2026-05-13).
   *
   * Subject suffix for streaming envelopes. The full subject is
   *   `local.{principal}.{stack}.dispatch.<harnessId>.<requestId>.progress`
   *   `local.{principal}.{stack}.dispatch.<harnessId>.<requestId>.complete`
   *   `local.{principal}.{stack}.dispatch.<harnessId>.<requestId>.error`
   *   `local.{principal}.{stack}.dispatch.<harnessId>.<requestId>.timeout`
   *
   * A.1 types the convention but does NOT wire NATS publishing — the
   * harness emits envelopes via the async-iterable yield, and the
   * caller (runner / dispatch-listener flip in A.1b) is responsible
   * for translating yields into `runtime.publish(envelope)` on the
   * correct subject. Wiring at the publish layer is Phase B work
   * (NKey-signed envelopes).
   *
   * Format: a UUID v4 is recommended (matches `Envelope.id` shape).
   * Required because all four terminal envelope subjects need it.
   */
  requestId: string;
  /**
   * Optional substrate-runtime knobs. See `DispatchRuntime` for the
   * per-field rationale.
   *
   * **Why a sub-object instead of flat fields.** Grouping keeps the
   * `DispatchRequest` surface tidy as the list grows (A.3 / A.5 / B
   * will add stack-aware fields here). It also makes it obvious which
   * fields are "substrate-runtime" vs "core dispatch contract" at the
   * call site — `req.runtime.cwd` vs `req.prompt` reads correctly.
   *
   * **Why optional.** Cortex's IAW design treats this as a forward door:
   * a minimal dispatch (just persona + prompt + tools) is valid; the
   * runtime block is a layered escape-hatch for the residual harness-
   * specific knobs.
   */
  runtime?: DispatchRuntime;
  /**
   * Q6 lock-in (design doc §5, 2026-05-13).
   *
   * Wall-clock cap. Hard upper bound on dispatch duration — once the
   * substrate has been running this long, the harness MUST emit a
   * `timeout` terminal envelope and shut the substrate down. Defaults
   * to 300_000ms (5 minutes) when omitted; harness implementations
   * read the default from their own constants if unset.
   *
   * Races with `inactivityMs`; first-to-expire wins.
   */
  timeoutMs?: number;
  /**
   * Q6 lock-in (design doc §5, 2026-05-13).
   *
   * Inactivity cap. If no envelope has been yielded for this many
   * milliseconds, the harness MUST emit a `timeout` terminal envelope
   * and shut down. Defaults to 60_000ms (60 seconds) when omitted.
   *
   * Distinct from `timeoutMs`: a long-running substrate that emits a
   * progress envelope every 30s never trips `inactivityMs` but will
   * trip `timeoutMs` after 5 minutes. A wedged substrate that emits
   * nothing trips `inactivityMs` first.
   */
  inactivityMs?: number;
}

// ---------------------------------------------------------------------------
// SessionHarness
// ---------------------------------------------------------------------------

/**
 * The substrate harness interface — cortex's single abstraction over any
 * agent execution engine.
 *
 * **Contract:**
 *   1. Constructor wiring (substrate-specific) is the responsibility of
 *      each implementation. The runner instantiates a harness with
 *      whatever dependencies it needs (CC CLI path, NATS link, etc.).
 *   2. `dispatch(req)` produces an `AsyncIterable<MyelinEnvelope>`. The
 *      harness MUST yield at least one terminal envelope (`completed`,
 *      `failed`, `aborted`, or a Q5 `timeout`) before the iterator
 *      closes. Yielding nothing is a protocol violation.
 *   3. Yields between dispatch and terminal are *progress* envelopes —
 *      typically `dispatch.task.started` plus any substrate-specific
 *      streaming events (tool-use lines, partial text, etc.).
 *   4. `shutdown(opts)` is optional. When present, callers invoke it
 *      during graceful runner shutdown. `opts.graceful = false` means
 *      "abort active dispatches immediately"; `true` means "let
 *      in-flight dispatches finish, refuse new ones".
 *
 * **What this interface does NOT prescribe:**
 *   - Whether the harness publishes envelopes itself — caller responsibility.
 *   - Whether yields are 1:1 with bus envelopes — fine to yield
 *     coalesced/filtered envelopes if the harness has substrate-specific
 *     reason to (e.g. CC's `text` events coalesce into one summary line).
 *   - The wire format of context kinds — `context[].data` is `unknown`.
 *   - Authorization — the runner gates dispatch via cortex#107 before
 *     calling `dispatch()`. The harness trusts its input.
 *
 * **Cross-references:**
 *   - cortex#91 §"Proposed interface" — the canonical spec.
 *   - design doc §3.1 ("multi-stack per principal") — why this is M6.
 *   - design doc §4 "cortex#91" — dependency graph.
 *   - plan doc §2 Phase A.1 — implementation slice.
 */
export interface SessionHarness {
  /**
   * Substrate identifier. Must be one of `HarnessId`'s known values.
   * Used by the runner to log "dispatching task X to substrate Y" and
   * to derive the Q5 subject prefix `dispatch.<harnessId>.<requestId>.>`.
   */
  readonly id: HarnessId;
  /**
   * Capabilities this harness provides. The capability registry (A.6)
   * aggregates across all harnesses cortex has registered. Each harness
   * declares its own capabilities at construction time and surfaces
   * them here; the registry never mutates this list.
   */
  readonly capabilities: Capability[];
  /**
   * Dispatch a task. Returns an async iterable of myelin envelopes
   * representing the dispatch's lifecycle: zero-or-more progress
   * envelopes followed by exactly one terminal envelope.
   *
   * **Iteration semantics.**
   *   - `for await (const env of harness.dispatch(req)) { ... }` is the
   *     canonical consumption pattern.
   *   - The iterable MUST close after yielding a terminal envelope —
   *     callers rely on iterator close to free resources.
   *   - If the caller breaks early, the harness MUST shut the substrate
   *     down (no orphaned child processes / NATS subscriptions).
   *
   * **Error propagation.**
   *   - Harness throwing during `dispatch()` setup (e.g. spawn fails) is
   *     a hard error — caller catches it and emits its own envelope.
   *   - Harness yielding an `error` terminal envelope is the normal
   *     path for runtime failures inside the substrate.
   */
  dispatch(req: DispatchRequest): AsyncIterable<MyelinEnvelope>;
  /**
   * Optional graceful-shutdown hook. Called during cortex daemon
   * shutdown to give the harness a chance to drain in-flight dispatches
   * (or abort them). When omitted, the caller treats the harness as
   * stateless across dispatches (no shutdown needed).
   *
   * @param opts.graceful  `true` = let in-flight dispatches finish,
   *                       refuse new ones. `false` = abort everything
   *                       in-flight immediately (SIGTERM equivalent).
   */
  shutdown?(opts: { graceful: boolean }): Promise<void>;
}
