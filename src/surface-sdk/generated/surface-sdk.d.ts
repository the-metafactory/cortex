// ============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Self-contained type artifact for the cortex plugin SDK (cortex#1950). This is
// the file out-of-tree surface-plugin bundles resolve when they
//   import type { PlatformAdapter, … } from "@the-metafactory/cortex/surface-sdk";
// (package.json exports["./surface-sdk"].types points here).
//
// Regenerate after ANY change to src/surface-sdk/index.ts or the contract types
// it re-exports:
//   bun run sdk:dts
//
// CI (.github/workflows/ci.yml → surface-sdk-dts-sync) fails on any drift between
// this committed file and a fresh regeneration, so it can never go stale.
// ============================================================================

import { z } from 'zod/v4';

export interface ContextAttachment {
	name: string;
	url: string;
	contentType: string;
	size: number;
}
export interface ContextMessage {
	role: "human" | "assistant";
	author: string;
	content: string;
	timestamp: string;
	attachments?: ContextAttachment[];
}
/** Platform-agnostic inbound message */
export interface InboundMessage {
	/** Platform identifier: "discord", "mattermost", "slack", etc. */
	platform: string;
	/** Unique adapter instance ID (e.g. "discord-pai-collab") */
	instanceId: string;
	/** Platform-native user ID */
	authorId: string;
	/** Display name for prompt context */
	authorName: string;
	/** Raw message text (with mention/trigger word stripped) */
	content: string;
	/** Platform-native channel ID */
	channelId: string;
	/** Thread/reply-chain ID (if in a thread) */
	threadId?: string;
	/** G-204c: Human-readable channel name (e.g. "grove") for context routing */
	channelName?: string;
	/** G-204c: Human-readable thread name (e.g. "grove/issue/43") for entity routing */
	threadName?: string;
	/** Platform guild/server/team ID (e.g., Discord guild ID) for network resolution */
	guildId?: string;
	/** Whether this message is from a DM channel */
	isDM?: boolean;
	/** DM classification: principal (full access) or user (standard guards) */
	dmType?: "principal" | "user";
	/**
	 * cortex#729: True when the authenticated sender is the home principal,
	 * computed for EVERY inbound message (DM and channel @mention) via the
	 * PolicyEngine principal-role check. Unlike `dmType` (DM-only), this signal
	 * is set in channels too, so the dispatch-handler's prompt-filter
	 * trust-scope can bypass the hard-block for the home principal's channel
	 * @mentions — not just their DMs. Non-spoofable (keyed on the
	 * authenticated platform author id). Defaults to false/undefined.
	 */
	authorIsPrincipal?: boolean;
	/** Inbound file attachments */
	attachments: InboundAttachment[];
	/** Message timestamp */
	timestamp: Date;
	/** Escape hatch for platform-specific data (discord.js Message, MM post, etc.) */
	_native?: unknown;
}
/** Inbound file attachment metadata */
export interface InboundAttachment {
	url: string;
	filename: string;
	contentType?: string;
	size?: number;
	/** Base64 file bytes, INLINED by the adapter when the surface needs auth to
	 *  download (Mattermost) — lets the brain consume the file without the bot
	 *  token or a host-allowlisted public URL. Absent for public-CDN surfaces
	 *  (Discord), which travel by URL. */
	content?: string;
}
/** Result of access control check */
export interface AccessDecision {
	allowed: boolean;
	features: {
		chat: boolean;
		async: boolean;
		team: boolean;
	};
	/** Disallowed MCP tools for this user */
	toolRestrictions?: string[];
	/**
	 * cortex#1167 — EXPLICIT tool ALLOWLIST. When present and non-empty, the CC
	 * session is confined to exactly these tools (anything else, including every
	 * `mcp__*`, is denied — allowlist semantics, NOT the allow-by-default of an
	 * absent/empty list). Set ONLY by the open-onboarding anon path so a
	 * zero-authority stranger never gets allow-by-default tool access. Real
	 * principal decisions leave it undefined and keep the existing deny-list
	 * (`toolRestrictions`) behaviour unchanged.
	 */
	allowedTools?: string[];
	/** Allowed working directories for this user */
	dirRestrictions?: string[];
	/** G-121: Skills this role may invoke. undefined → all; [] → none; [...] → only listed. */
	allowedSkills?: string[];
	/** Whether bash guard should be active. Default: true. Principal DM may set false. */
	bashGuard?: boolean;
	/** Override bash allowlist (DM role may specify its own) */
	bashAllowlist?: {
		rules: {
			pattern: string;
			repos?: string[];
		}[];
		repos: string[];
	};
	/** Whether this is a DM conversation */
	isDM?: boolean;
	/**
	 * cortex#741 — whether this sender is TRUSTED for the inbound prompt-injection
	 * filter. True only for the stack's home principal (the principal that
	 * `resolvePolicyAccess` resolves as holding the reserved policy-role
	 * short-circuit). The dispatch-handler consults this at the `scanPrompt` gate:
	 * a trusted sender's *direct* chat message is NOT hard-blocked on an
	 * injection-pattern match (the match is still logged / audited — never
	 * silently bypassed). Untrusted/indirect content paths (ContentFilter.hook,
	 * payload-filter, file-read scanning) ignore this flag and stay fully active.
	 * See the PR for the exemption-boundary rationale.
	 */
	trusted?: boolean;
	/** Human-readable denial reason */
	denyReason?: string;
	/**
	 * cortex#1165 — stable machine code for WHY a deny happened, so callers can
	 * branch on the *category* without brittle `denyReason` string matching.
	 * Only present when `allowed === false`.
	 *
	 *   - `no_policy`       — no policy block / engine wiring (migrate-config).
	 *   - `unmapped_sender` — the (platform, authorId) tuple maps to NO
	 *                         principal. This is the one category the Pier
	 *                         open-onboarding gate (AgentSchema.openOnboarding)
	 *                         may convert into a zero-authority anon ALLOW.
	 *   - `registry_drift`  — index resolved an id the registry lacks.
	 *   - `lockout`         — recognized principal with zero keyword caps.
	 */
	denyCode?: "no_policy" | "unmapped_sender" | "registry_drift" | "lockout";
	/**
	 * cortex#1165 — set `true` ONLY on the synthetic zero-authority anonymous
	 * principal minted by the Pier open-onboarding gate. It carries NO roles and
	 * unlocks NO privileged path; the marker exists so downstream/audit code can
	 * see "this session is an unauthenticated stranger" at a glance. Never set on
	 * a real, principal-resolved decision.
	 */
	anonPrincipal?: boolean;
	/**
	 * cortex#1165 — the synthetic principal id assigned to an open-onboarding
	 * anonymous sender (e.g. `anon:discord:<authorId>`). Present iff
	 * `anonPrincipal === true`. Used for log/audit correlation only — it is NOT
	 * a registry id and resolves to no capabilities.
	 */
	anonPrincipalId?: string;
}
/** Where to send a response */
export interface ResponseTarget {
	/** Which adapter instance to respond on */
	instanceId: string;
	/** Platform-native channel ID */
	channelId: string;
	/** Thread to reply in (if applicable) */
	threadId?: string;
	/**
	 * cortex#708 — session/correlation id for the dispatch that produced this
	 * target. Threaded from the inbound message's native id (`msg._native.id`,
	 * the same correlation `dispatch-handler` derives `inboundMessageId` from)
	 * so that per-session adapter state (e.g. the Discord progress placeholder)
	 * is keyed on the session rather than the channel/thread.
	 *
	 * Without it, two concurrent sessions landing in the same channel/DM share
	 * one channel-scoped key and collapse onto a single "working…" placeholder
	 * — the second session edits the first's message. Optional: undefined for
	 * targets that don't originate from an inbound dispatch (e.g. the
	 * surface-router's envelope render path), where channel-scoped keying is
	 * correct.
	 */
	sessionId?: string;
	/** Escape hatch for platform-specific channel objects */
	_native?: unknown;
}
/** Outbound file attachment */
export interface OutboundFile {
	content: Buffer;
	filename: string;
	contentType?: string;
}
/**
 * The core adapter interface. Each platform implements this.
 * Adapters are thin I/O wrappers — all pipeline logic lives in MessageRouter.
 */
export interface PlatformAdapter {
	/** Platform identifier: "discord", "mattermost", "slack", etc. */
	readonly platform: string;
	/** Unique instance ID across all adapters */
	readonly instanceId: string;
	/**
	 * cortex#2002 (C-1853) — the maximum size (bytes) of a SINGLE outbound file
	 * this platform accepts. Platform-specific, so it **travels with the
	 * adapter**: platform-neutral core (`src/runner/attachments.ts`, `src/bus/`)
	 * must never name a platform's ceiling. `collectOutputFiles()` takes this as
	 * an argument rather than reading a platform-named constant.
	 *
	 * **OPTIONAL and additive** (the backward-compatible cortex-only slice of
	 * #2002, superseding the required-field #1890). An adapter bundle that does
	 * NOT declare it keeps compiling and the host falls back to
	 * `ATTACHMENT_LIMITS.defaultMaxUploadBytes` — behaviour is unchanged for
	 * every existing bundle. Per-bundle adoption (each
	 * `metafactory-cortex-adapter-*` supplying its platform's documented
	 * ceiling) is incremental follow-up work.
	 *
	 * Adapters that DO declare it MUST source the value from the platform's
	 * documented ceiling, not a guess, and SHOULD err low: an under-estimate
	 * only filters an extra file out, whereas an over-estimate makes the
	 * platform reject the upload at post time.
	 */
	readonly maxUploadBytes?: number;
	/** Connect to the platform and start listening for messages */
	start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
	/** Disconnect and clean up resources */
	stop(): Promise<void>;
	/**
	 * MIG-7.2c-binding: Return the platform user id of the bot account this
	 * adapter is connected as. Required for `PresenceBinding` to register the
	 * adapter with the process-wide `TrustResolver` so inbound messages from
	 * peer agents are resolvable by their platform id (§9.3).
	 *
	 * Contract: callable only after `start()` has completed. Adapters that
	 * learn their bot id at connect-time (e.g. Discord via `client.user`)
	 * MUST throw if called pre-start; adapters that fetch on demand (e.g.
	 * Mattermost via `/api/v4/users/me`) MAY cache the result.
	 */
	getPlatformUserId(): Promise<string>;
	/** Fetch conversation history for context */
	fetchContext(msg: InboundMessage, depth: number): Promise<ContextMessage[]>;
	/** Check if the message author has access */
	resolveAccess(msg: InboundMessage): AccessDecision;
	/** Post a response (handles platform-specific splitting/formatting) */
	postResponse(target: ResponseTarget, text: string, files?: OutboundFile[]): Promise<void>;
	/** Show typing indicator */
	sendTyping(target: ResponseTarget): Promise<void>;
	/** Post or update a progress message (edit-in-place, one message per target) */
	sendProgress(target: ResponseTarget, text: string): Promise<void>;
	/** Delete the progress message for a target */
	clearProgress(target: ResponseTarget): Promise<void>;
	/** Create a thread from a message */
	createThread(msg: InboundMessage, name: string): Promise<ResponseTarget>;
	/**
	 * cortex#502 — resolve a LOGICAL surface address (the review-path
	 * `response_routing` shape) to a native {@link ResponseTarget}.
	 *
	 * The review wire stays platform-NEUTRAL (`{ surface, channel, thread? }`
	 * — repo short name + `{repo}/{entity-type}/{number}` logical key per the
	 * channel-routing SOP) so the same `review.verdict.*` / `dispatch.task.*`
	 * envelope routes on Discord/Mattermost/Slack unchanged. Each adapter
	 * implements this seam to map logical→native:
	 *
	 *   - Returns `null` when `addr.surface` is NOT this adapter's platform
	 *     (the review sink then skips this adapter — no cross-surface posting).
	 *   - Otherwise resolves `addr.channel` (repo short name) to the platform
	 *     channel and, when `addr.thread` is present, the platform thread
	 *     primitive (Discord reuses `findOrCreateThreadByName`).
	 *   - Returns `null` when the channel/thread can't be resolved (caller
	 *     falls back to ignoring the envelope rather than mis-posting).
	 *
	 * Mattermost/Slack implement the same method later with their own
	 * name→primitive mapping; the wire never changes.
	 */
	resolveLogicalTarget(addr: {
		surface: string;
		channel: string;
		thread?: string;
	}): Promise<ResponseTarget | null>;
	/** Send a notification to the principal */
	notifyPrincipal(text: string): Promise<void>;
	/** F-092: Hot-reload adapter config (optional, for adapters that support it) */
	updateConfig?(config: unknown): void;
	/**
	 * Two-phase inbound registration (optional). `start()` connects + stores the
	 * `onMessage` callback; this SECOND call registers the platform's message
	 * listener so inbound events actually dispatch. Discord + Slack split start
	 * from listen (the per-stack boot defers this until after Pass-2 trust merge);
	 * single-phase adapters (Mattermost) register inside `start()` and omit it.
	 *
	 * Callers that drive an adapter directly (the shared surface gateway,
	 * cortex#524) MUST call this after `start()` or no inbound is ever delivered.
	 * Idempotent — adapters latch on first attach so re-calls are no-ops.
	 */
	attachInboundDispatch?(): void;
}
/**
 * Hand-typed Envelope shape matching the JSON Schema. We hand-write rather
 * than codegen because (a) the schema is small and stable, (b) the manual
 * type doubles as documentation for callers, (c) avoiding a build step keeps
 * the import-safe / zero-side-effect property of this module.
 */
export interface Envelope {
	/** UUID v4 — unique per envelope. */
	id: string;
	/** `{principal}.{stack}.{assistant}` — exactly 3 dotted segments (myelin#185 breaking cut). */
	source: string;
	/** `domain.entity.action` — what kind of signal this is. */
	type: string;
	/** ISO-8601 timestamp. */
	timestamp: string;
	/** UUID v4 — links related envelopes across a workflow. Optional. */
	correlation_id?: string;
	/** The message's passport. Sovereignty travels with the envelope. */
	sovereignty: {
		classification: "local" | "federated" | "public";
		/** ISO 3166-1 alpha-2 country code (e.g. "NZ", "DE"). */
		data_residency: string;
		/** Maximum number of hops the envelope may traverse. ≥ 0. */
		max_hop: number;
		/** Whether the envelope's payload may be processed by frontier models. */
		frontier_ok: boolean;
		/** Constraint on which model class may process the payload. */
		model_class: "local-only" | "frontier" | "any";
	};
	/**
	 * F-15 economics block — token budget, actual usage, billing attribution.
	 * Mutable annotation field; intermediaries may aggregate. Per myelin
	 * `architecture.md` §5.2 this field MUST NOT inform security or trust
	 * decisions — surface it for observability and cost accounting only.
	 */
	economics?: Economics;
	/** Forward-compatible metadata. Optional. */
	extensions?: Record<string, unknown>;
	/** Arbitrary signal content. */
	payload: Record<string, unknown>;
	/**
	 * Identity attestation — proves who sent this envelope. Optional in the
	 * schema (envelopes predate MY-400 identity layer).
	 *
	 * **Wire shapes accepted (myelin#31 chain-of-stamps):**
	 *   - Single stamp object (legacy back-compat shim, single signer).
	 *   - Array of stamps (canonical post-#31 chain form). Each stamp signs
	 *     the canonical bytes of the envelope *including the prior chain* —
	 *     tampering with any earlier stamp invalidates every subsequent
	 *     stamp's signature.
	 *
	 * Cortex callers that want a uniform view should use
	 * {@link getSignedByChain} to normalise both shapes to `SignedBy[]`.
	 *
	 * IAW Phase A.2: `signed_by` is **surfaced but not yet consumed for
	 * trust decisions** — that wiring lands in IAW Phase B (cortex#102).
	 */
	signed_by?: SignedBy | SignedBy[];
	/**
	 * F-021 — capability tags the task needs. Matched against AGENT_CAPABILITIES
	 * (myelin#11). Empty array = no filter. Pattern parallels DID_RE: no
	 * trailing or consecutive hyphens.
	 */
	requirements?: string[];
	/**
	 * F-021 — minimum agent sovereignty mode required to ack the task.
	 *
	 * | mode | semantics |
	 * |---|---|
	 * | `open` | ack all |
	 * | `selective` | evaluate-and-may-nak |
	 * | `strict` | explicit capability + sovereignty match |
	 * | `bidding` | F-10 broadcast bid-request, collect signed responses, select winner |
	 */
	sovereignty_required?: SovereigntyRequirement;
	/** F-021 — ISO-8601 absolute soft deadline. Informs nak `not-now` decisions. */
	deadline?: string;
	/**
	 * F-021 — principal-facing routing semantics. Vocabulary migration
	 * 2026-05 R11 renamed `broadcast` → `offer` on the wire; the transition
	 * schema accepts both. New publishers emit `offer`.
	 *
	 * | mode | semantics |
	 * |---|---|
	 * | `offer` | competing consumers — first ack wins (R11 canonical) |
	 * | `broadcast` | deprecated alias of `offer` (accepted on read) |
	 * | `direct` | named recipient — requires `target_assistant` |
	 * | `delegate` | outcome handoff (multi-step orchestration) — requires `target_assistant` |
	 */
	distribution_mode?: DistributionMode;
	/**
	 * F-021 — required when `distribution_mode` is `direct` or `delegate`.
	 * DID of the receiving assistant (`did:mf:<name>`). Vocabulary migration
	 * 2026-05 R13 (breaking cut myelin#184) renamed from `target_principal`;
	 * the deprecated key was dropped from the wire — envelopes carrying it
	 * are rejected by the schema. Resolve via {@link getTargetAssistant}.
	 */
	target_assistant?: string;
	/**
	 * myelin#161 — policy-level actor identity, separate from the
	 * cryptographic `signed_by[]` chain. The chain proves WHO signed; the
	 * originator names WHO the signer claims to be acting on behalf of.
	 *
	 * `originator` IS covered by the envelope signature (a signable field —
	 * see myelin canonicalize SIGNABLE_FIELDS). Tampering with `originator`
	 * invalidates every subsequent stamp.
	 *
	 * Cortex callers should resolve the policy actor via the upstream
	 * `getActorPrincipal(envelope)` helper rather than reading this field
	 * directly — that helper falls back to `signed_by[0].identity` for
	 * legacy envelopes that pre-date myelin#161.
	 */
	originator?: Originator;
}
/**
 * myelin#161 — policy-attribution claim that travels next to the
 * `signed_by[]` chain. The signer commits to the attribution claim by
 * including the field in the canonical signature input.
 */
export interface Originator {
	/**
	 * DID of the actor whose capabilities this envelope asserts.
	 * Vocabulary migration 2026-05 R2 — canonical key is `identity`;
	 * the transition schema accepts `principal` too. Readers should use
	 * {@link getActorPrincipal} which dual-reads.
	 */
	identity?: string;
	/**
	 * @deprecated Renamed to `identity` (vocabulary migration 2026-05, R2).
	 * Pre-migration envelopes carry this key; accepted on read through the
	 * transition window. Removed in the breaking major.
	 */
	principal?: string;
	/**
	 * How the signer learned the originator identity:
	 *   - `adapter-resolved` — adapter (Discord/Slack/Mattermost/HTTP/cc-events)
	 *     mapped a non-myelin identifier (platform id, OS user) to a myelin
	 *     principal at sign time.
	 *   - `federated` — the originator claim was relayed from another
	 *     principal; the chain proves the cross-principal hop.
	 *   - `delegated` — the signer holds delegation credentials for the
	 *     originator (service principal acting on behalf of a principal).
	 */
	attribution: AttributionMode;
}
/** myelin#161 — see {@link Originator}. */
export type AttributionMode = "adapter-resolved" | "federated" | "delegated";
/**
 * Discriminated stamp shape — one entry in an envelope's `signed_by` chain.
 * `method` selects which fields are present:
 *   - `"ed25519"` — bare per-bot signature; intra-org trust.
 *   - `"hub-stamp"` — federation hub re-signature for cross-org trust.
 *
 * Optional `role` (myelin#31) is the semantic position of the stamp in the
 * chain (`origin` / `transit` / `accountability` / `sovereignty` / `notary`).
 * Consumers that need role-aware predicates MUST handle the undefined case
 * — pre-#31 stamps and the legacy shim do not carry a role.
 */
export type SignedBy = SignedByEd25519 | SignedByHubStamp;
/**
 * Bare ed25519 signature — the principal signs the envelope directly.
 * Used for intra-org traffic where every bot's `did:mf:*` principal is
 * trusted and key material is held locally.
 */
export interface SignedByEd25519 {
	method: "ed25519";
	/**
	 * Stamp DID — `did:mf:<name>` per myelin convention. Vocabulary
	 * migration 2026-05 R2 (breaking cut myelin#182): canonical key is
	 * `identity`; the deprecated `principal` key was dropped from the wire
	 * — stamps carrying it are rejected by the schema.
	 */
	identity?: string;
	/** Base64-encoded ed25519 signature (88+ chars). */
	signature: string;
	/** ISO-8601 timestamp the signature was produced. */
	at: string;
	/** Optional semantic role of this stamp in the chain (myelin#31). */
	role?: StampRole;
}
/**
 * Hub-stamped signature — a federation hub re-signs after verifying the
 * principal's bare signature. Used for cross-org traffic where the
 * receiver trusts the hub but not necessarily the originating bot.
 */
export interface SignedByHubStamp {
	method: "hub-stamp";
	/**
	 * Originating identity — `did:mf:<name>`. Vocabulary migration 2026-05
	 * R2 (breaking cut myelin#182): canonical key is `identity`; the
	 * deprecated `principal` key was dropped from the wire — stamps
	 * carrying it are rejected by the schema.
	 */
	identity?: string;
	/** Hub identity that re-signed — `did:mf:<hub-name>`. */
	stamped_by: string;
	/** Base64-encoded ed25519 signature from the hub. */
	signature: string;
	/** ISO-8601 timestamp the hub signed. */
	at: string;
	/** Optional semantic role of this stamp in the chain (myelin#31). */
	role?: StampRole;
}
/**
 * Semantic position of a stamp inside a chain (myelin#31). Roles describe
 * what the stamp ATTESTS, not what the principal IS. Optional for
 * back-compat — pre-#31 stamps do not carry a role.
 */
export type StampRole = "origin" | "transit" | "accountability" | "sovereignty" | "notary";
/**
 * F-021 — `sovereignty_required` enum. Determines how aggressively
 * candidates may decline a task before nakking.
 */
export type SovereigntyRequirement = "open" | "selective" | "strict" | "bidding";
/**
 * F-021 — `distribution_mode` enum. Vocabulary migration 2026-05 R11
 * renamed `broadcast` → `offer` on the wire; the transition schema
 * accepts both. Emitters publish `offer`; readers tolerate `broadcast`
 * for JetStream replay of pre-migration envelopes.
 */
export type DistributionMode = "broadcast" | "offer" | "direct" | "delegate";
/**
 * F-15 economics — token budget, actual usage, billing attribution.
 *
 * Per myelin `architecture.md` §5.2, this is a **mutable annotation field**
 * sitting intentionally outside the L4 signature so intermediaries can
 * accumulate cost without invalidating attestations. It MUST NOT inform
 * security or trust decisions — surface it for observability only.
 */
export interface Economics {
	/** Publisher-set constraints on resource usage. */
	budget?: EconomicsBudget;
	/** Actual usage populated by executor; aggregated by hubs in delegate chains. */
	actual?: EconomicsActual;
	/** DID of principal receiving/paying for this work. */
	wallet?: string;
	/** External invoice or tracking reference. */
	billing_ref?: string;
	/** ISO 4217 currency code when not USD. */
	currency?: string;
	/** Forward-compatible — schema allows additional properties. */
	[key: string]: unknown;
}
export interface EconomicsBudget {
	/** Maximum total tokens (input + output) permitted. */
	max_tokens?: number;
	/** Maximum cost in USD. */
	max_cost_usd?: number;
	[key: string]: unknown;
}
export interface EconomicsActual {
	/** LLM input tokens consumed. */
	input_tokens?: number;
	/** LLM output tokens generated. */
	output_tokens?: number;
	/** Convenience total — may equal input + output, may not (delegate aggregation). */
	total_tokens?: number;
	/** Lowercase model identifier (e.g. `claude-sonnet-4`, `gpt-4o`). */
	model?: string;
	/** Execution duration in milliseconds. */
	duration_ms?: number;
	/** Computed cost in USD. */
	cost_usd?: number;
	[key: string]: unknown;
}
declare const RendererKindSchema: z.ZodString;
export type RendererKind = z.infer<typeof RendererKindSchema>;
declare const RendererVisibilitySchema: z.ZodObject<{
	hide_residency_outside: z.ZodOptional<z.ZodArray<z.ZodString>>;
	require_model_class: z.ZodOptional<z.ZodArray<z.ZodEnum<{
		"local-only": "local-only";
		frontier: "frontier";
		any: "any";
	}>>>;
	max_classification: z.ZodOptional<z.ZodEnum<{
		local: "local";
		federated: "federated";
		public: "public";
	}>>;
}, z.core.$strip>;
export type RendererVisibility = z.infer<typeof RendererVisibilitySchema>;
/**
 * One acceptable form for a leaf in a payload-filter pattern. Strings,
 * numbers, and booleans are exact-match literals; the object forms are
 * the EventBridge-style operators.
 */
export type FilterValue = string | number | boolean | {
	"anything-but": string | number | boolean | (string | number | boolean)[];
} | {
	prefix: string;
} | {
	exists: boolean;
} | {
	"equals-ignore-case": string;
};
/**
 * A pattern matches a JSON object. Nesting follows the JSON structure of
 * the value being matched: a key whose value is an array of FilterValue
 * is a leaf; a key whose value is another PayloadFilterPattern descends
 * into that subtree.
 */
export interface PayloadFilterPattern {
	[key: string]: FilterValue[] | PayloadFilterPattern;
}
/**
 * A surface-adapter's full filter. The `envelope` pattern matches the
 * outer envelope context (type, source, correlation_id, etc.); the
 * `payload` pattern matches the envelope's payload object. Both are
 * optional — a filter with neither key matches everything (degenerate but
 * legal).
 */
export interface PayloadFilter {
	envelope?: PayloadFilterPattern;
	payload?: PayloadFilterPattern;
}
/**
 * One surface adapter. Adapters are dumb-by-design — they declare their
 * NATS subject patterns + an optional payload filter and a `render()`
 * function. The router does the matching + isolation; the adapter just
 * renders.
 */
interface SurfaceAdapter {
	/** Stable identifier — used in error reporting and metrics. */
	id: string;
	/** One or more NATS subject patterns (union — match ANY). */
	subjects: string[];
	/** Optional client-side filter applied AFTER subject match. */
	filter?: PayloadFilter;
	/**
	 * IAW Phase A.4 — optional visibility constraints. When set, the router
	 * evaluates the envelope's `sovereignty` against each active rule
	 * (residency / model_class / max_classification) BEFORE invoking
	 * `render()`. Drops emit a `system.access.filtered` envelope so principals
	 * can observe access decisions.
	 *
	 * Unset (the v1 default) means "no visibility filter" — the adapter
	 * receives every envelope that passes subject + payload filters, matching
	 * pre-A.4 behaviour exactly. See {@link RendererVisibility} for rule
	 * semantics.
	 */
	visibility?: RendererVisibility;
	/**
	 * Adapter-specific rendering. Bounded by router's renderTimeoutMs.
	 *
	 * `signal` is an opt-in `AbortSignal` that fires when the router's per-render
	 * timeout elapses. Adapters that issue I/O (HTTP, NATS, sub-process) SHOULD
	 * forward the signal to those calls so the loser of `Promise.race` is
	 * actually cancelled — without it, the timed-out work keeps running in the
	 * background, holding sockets and spending quota. Adapters that do nothing
	 * but synchronous CPU (mocks, formatters) MAY accept the parameter and
	 * ignore it; the contract is opt-in for backwards compatibility with
	 * existing render functions.
	 *
	 * **IAW Phase D.3 (cortex#116) — `subject`.** Optional third argument
	 * carrying the matched NATS subject. Adapters that need to derive
	 * federation context from the wire path (e.g. the dispatch-listener
	 * deriving `source_network` from `federated.{network_id}.>`) read
	 * this directly rather than re-parsing the envelope. Existing
	 * adapters that match `(envelope, signal)` continue to work — the
	 * parameter is additive and ignored by adapters that don't accept
	 * it.
	 */
	render(envelope: Envelope, signal?: AbortSignal, subject?: string): Promise<void>;
	/** Optional liveness probe. Currently unused by the router; reserved
	 *  for the dashboard's adapter-health panel (G-1111.E follow-on). */
	health?(): Promise<{
		ok: boolean;
		lag?: number;
	}>;
}
/**
 * A non-agent-bound surface that subscribes to bus subjects and projects
 * envelopes into a sink (UI, external API, log stream). Implementations
 * MUST satisfy three contracts:
 *
 *   1. `start()` is idempotent and synchronous-or-fast. Heavy I/O at
 *      construction is fine; lifecycle hooks should not block cortex
 *      startup for more than a few hundred ms.
 *   2. `render()` MUST NOT throw. Failed delivery logs + drops; the
 *      surface-router wraps every `render()` in a per-call timeout +
 *      `Promise.allSettled` regardless, but renderers carry the moral
 *      obligation to not poison the dispatch path.
 *   3. `render()` MUST NOT publish on the bus as a side effect.
 *      Principal-input emitted from a renderer (e.g., a dashboard
 *      "approve" click) goes through the bus as a logical envelope
 *      from the principal, not from any agent (architecture §9.3).
 *
 * **REVERSED — renderers are NOT static across hot-reload.** [ADR-0024](../../docs/adr/0024-pluggable-surface-adapters.md)
 * (cortex#1793, S8) reverses the "Renderers are static across hot-reload"
 * decision this comment used to make, on its own stated terms (ADR-0024
 * §Consequences: "⚠ REVERSAL"). The original three premises and what
 * changed:
 *
 *   1. *"A restart is cheap enough"* — no longer true once a renderer is a
 *      separately-installable bundle (ADR-0024 D5): forcing a full daemon
 *      restart to activate one new renderer drags every live adapter
 *      connection and in-flight dispatch through it for an unrelated plugin.
 *   2. *"Partial hot-reload is harder to reason about"* — honoured, not
 *      contradicted. There is still no `updateConfig(RendererConfig)` hook
 *      and no mid-flight routing-key swap. What changed is the GRANULARITY
 *      of the stop/start cycle: **detach → destroy → construct → attach**
 *      via the `{ unregister }` handle `SurfaceRouter.register()` already
 *      returned (`src/bus/surface-router.ts`) — the renderer boot loop used
 *      to discard that handle; S8 retains it. The target leaves the
 *      router's dispatch list *before* teardown, so no render ever observes
 *      a half-swapped renderer. Full stop/start remains the semantic; its
 *      blast radius shrinks from *the daemon* to *one renderer*.
 *   3. *"A renderer's resources are scoped to its lifetime"* — still true,
 *      and it's exactly what makes per-instance destroy-and-reconstruct safe
 *      here (a renderer owns nothing durable and never publishes) where it
 *      would NOT be safe for a platform adapter (which drops a live
 *      connection and orphans progress placeholders).
 *
 * State loss on detach/reload is intentional and, per the above, harmless:
 * the dashboard ring buffer resets (nothing reads it — ADR-0024 D2/OQ8); a
 * renderer with a stable per-envelope derivation (e.g. PagerDuty's
 * `dedup_key`, `src/renderers/pagerduty.ts`) is reload-stable by
 * construction. `cortex plugin reload` (cortex#1793) is the runtime verb;
 * `docs/plugin-sdk.md` documents the state-loss contract a plugin author
 * must design for.
 */
export interface Renderer {
	/** Discriminator matching `RendererKind`. */
	readonly kind: RendererKind;
	/** Stable identifier, used in surface-router metrics + error reporting. */
	readonly id: string;
	/** NATS subject patterns this renderer wants to receive. Empty means
	 *  the surface-router never invokes `render()`. */
	readonly subjects: string[];
	/** Bring the renderer to a state where `render()` calls can succeed.
	 *  May open HTTP clients, allocate buffers, register internal handlers.
	 *  Idempotent. */
	start(): Promise<void>;
	/** Tear down resources. After `stop()`, `render()` calls SHOULD be no-ops
	 *  rather than throw — adapter-lifecycle race conditions are common at
	 *  shutdown and an error here would pollute the shutdown log. */
	stop(): Promise<void>;
	/** Project a single envelope onto the renderer's sink. The surface-router
	 *  wraps this call with a timeout + isolation; implementations focus on
	 *  the projection, not the dispatch plumbing. */
	render(envelope: Envelope, signal?: AbortSignal): Promise<void>;
	/** Return the `SurfaceAdapter` face the surface-router consumes. Wired
	 *  exactly once at startup via `router.register(renderer.surfaceConfig)`. */
	readonly surfaceConfig: SurfaceAdapter;
}
export type PluginKind = "adapter" | "renderer";
/**
 * A `surfaces.{platform}[]` entry — `{ agent, stack?, binding }`. Structurally
 * matches every platform's array element in `Surfaces`
 * (`src/common/types/surfaces.ts`); kept loosely typed here (`binding` as a
 * plain record) so the registry has no compile-time dependency on any one
 * platform's Zod-inferred binding shape.
 */
export interface SurfaceBindingEntry {
	readonly agent: string;
	readonly stack?: string;
	readonly binding: Record<string, unknown>;
}
/**
 * One construction group — the binding entries that share ONE live
 * connection, plus the instance id that connection registers under. Mirrors
 * `DiscordTokenGroup` (`src/gateway/discord-token-groups.ts`), generalised:
 * every platform's default (ungrouped) case is a one-entry group whose
 * `instanceId` is `{platform}:{demuxKey(binding)}`; Discord's `groupBindings`
 * returns the token-keyed groups computed today.
 */
export interface BindingGroup {
	readonly entries: readonly SurfaceBindingEntry[];
	readonly instanceId: string;
}
/** The fields `buildGatewayAdapters`' generic loop threads into
 *  {@link AdapterPlugin.buildGatewayConstructArgs} for every platform. */
export interface GatewayConstructBase {
	readonly instanceId: string;
	readonly source: unknown;
	readonly runtime: unknown;
	/**
	 * cortex#1794 (S9b) — a host-bound `AdapterPolicyPort` (`surface-sdk`),
	 * typed `unknown` here for the SAME reason `source`/`runtime` are: this
	 * registry module has no compile-time dependency on `surface-sdk` or
	 * `common/policy`, so each plugin's `buildGatewayConstructArgs` casts
	 * internally (the convention `AdapterPlugin`'s docstring already
	 * establishes for `createAdapter`'s args). Forwarded by both the `web`
	 * plugin (`metafactory-cortex-adapter-web`'s `src/plugin.ts`, relocated
	 * out-of-tree cortex#1794 S9 MOVE) and the `slack` plugin
	 * (`metafactory-cortex-adapter-slack`'s `src/plugin.ts`, cortex#1795 S10).
	 */
	readonly policy?: unknown;
	/**
	 * cortex#1795 (S10) — a host-bound `AdapterSystemEventPort` (`surface-sdk`),
	 * typed `unknown` for the same reason `policy` is. Currently only the
	 * slack plugin forwards it.
	 */
	readonly systemEvents?: unknown;
	/**
	 * cortex#1795 (S10) — the host-bound envelope→markdown renderer (the
	 * shared `adapters/envelope-renderer.ts`'s `formatEnvelopeAsMarkdown`),
	 * typed `unknown` for the same reason `policy` is. Currently only the
	 * slack plugin forwards it.
	 */
	readonly formatEnvelope?: unknown;
}
/**
 * Per-platform adapter plugin descriptor. `createAdapter`'s args type is
 * intentionally loose (`Record<string, unknown>`, cast internally to the
 * platform's own Factory-args shape) — the registry stores plugins for every
 * platform in one map, and each platform's construction args genuinely
 * diverge (Discord needs `allowedGuildIds` + `presenceByGuildId`; Slack/
 * Mattermost/Web don't). Each plugin module owns the single internal cast,
 * the same convention `wireSurfaceAdapters` already uses for its concrete-
 * adapter casts (`as DiscordAdapter` etc.) — never unsafe in practice because
 * a plugin is only ever invoked with the args its own call sites build for it.
 */
export interface AdapterPlugin {
	readonly kind: "adapter";
	/** Registry key. Equals `platform`. */
	readonly id: string;
	/** `surfaces.{platform}` key (e.g. "discord"). */
	readonly platform: string;
	/**
	 * cortex#1789 (S4) — the schema this platform's `surfaces.{platform}[].binding`
	 * must satisfy. Consumed by {@link resolveAdapterPluginOrThrow} /
	 * {@link validateSurfacesAgainstRegistry} (the REGISTRY pass) — the
	 * structural pass (`SurfacesSchema`) only checks the generic
	 * `{agent, stack?, binding}` shape; this schema is where the real
	 * per-platform field validation (required tokens, regex-checked ids, …)
	 * happens. For the four in-tree platforms this is the EXACT schema
	 * `SurfacesSchema`'s old `.strict()` object used pre-S4
	 * (`DiscordBindingSchema`/`SlackBindingSchema`/`MattermostBindingSchema`/
	 * `WebBindingSchema`, `src/common/types/surfaces.ts`) — byte-identical
	 * validation, only the call site moved.
	 */
	readonly bindingSchema: z.ZodType;
	/**
	 * cortex#1789 (S4, ADR-0024 D5 scope item 3) — does this platform's
	 * `surfaces.{platform}[]` fold into `agents[*].presence.{platform}` at
	 * config-compose time (`foldSurfaceBindings`)? `true` for discord/slack/
	 * mattermost (a legacy inline-presence shape exists to fold into); `false`
	 * for web (there is no legacy web presence shape — the gateway factory
	 * consumes `surfaces.web[]` directly). Replaces the hardcoded `PLATFORMS`
	 * fold-list constant in `surfaces.ts` — `loader.ts` derives the fold list
	 * from `registry.listAdapters().filter(p => p.foldsIntoPresence)` instead
	 * of a second list that could drift from the registry.
	 */
	readonly foldsIntoPresence: boolean;
	/**
	 * Binding fields that must be free of unresolved `__ENV__` placeholders
	 * before construction (cortex#1209 belt-and-suspenders) — checked against
	 * the RAW binding value on every entry in a construction group.
	 */
	readonly secretFields: readonly string[];
	/** binding → demux key. Used to build the default `{platform}:{demuxKey}`
	 *  instance id when {@link groupBindings} is absent. */
	demuxKey(binding: Record<string, unknown>): string;
	/**
	 * Optional: platforms that group multiple bindings onto ONE live
	 * connection (Discord's token grouping — one gateway session per bot
	 * token, not per guild). Absent = one adapter per binding entry, using
	 * `demuxKey` to build the instance id.
	 */
	groupBindings?(entries: readonly SurfaceBindingEntry[]): BindingGroup[];
	/**
	 * Gateway-path ONLY. `buildGatewayAdapters`' generic loop calls this to
	 * turn a raw-binding construction group into {@link createAdapter}'s args.
	 * The per-stack boot path (`wireSurfaceAdapters`) NEVER calls this — it
	 * already holds a fully-typed presence built from the richer `AgentConfig`
	 * shape (`contextDepth`, `enableAgentLog`, `trust`, …) that a raw binding
	 * does not carry, and calls {@link createAdapter} directly with its own
	 * hand-built args (see `surface-adapter-boot.ts`'s `baseFactoryArgs`).
	 */
	buildGatewayConstructArgs(group: BindingGroup, base: GatewayConstructBase): Record<string, unknown>;
	/** Construct (never start) the adapter. */
	createAdapter(args: Record<string, unknown>): PlatformAdapter;
}
/**
 * Per-kind renderer plugin descriptor (ADR-0024 D5). `configSchema` mirrors
 * {@link AdapterPlugin.bindingSchema} — carried for S4, inert until then
 * (`RendererSchema` stays the fixed discriminated union it is today,
 * `src/common/types/cortex-config.ts:1193`).
 */
export interface RendererPlugin {
	readonly kind: "renderer";
	/** Registry key. Equals `rendererKind`. */
	readonly id: string;
	/** `renderers[].kind` discriminant (e.g. "pagerduty"). */
	readonly rendererKind: string;
	/**
	 * cortex#1789 (S4) — the schema a `renderers[]` entry of this kind must
	 * satisfy. Consumed by `src/renderers/index.ts`'s `resolveRendererPluginAndConfig`
	 * (the REGISTRY pass) — the structural pass (`RendererSchema` in
	 * `cortex-config.ts`) only checks `{kind, ...}`; this is the real per-kind
	 * schema (`DashboardRendererSchema`/`PagerDutyRendererSchema`/etc,
	 * `src/common/types/cortex-config.ts`) — byte-identical to what the old
	 * discriminated union validated, only the call site moved (and now runs
	 * with the RAW entry, so `parse()` still applies field defaults).
	 */
	readonly configSchema: z.ZodType;
	/** Construct (never start) the renderer. */
	createRenderer(config: unknown): Renderer;
}
export type SurfacePlugin = AdapterPlugin | RendererPlugin;
/**
 * cortex#1790 (S5, ADR-0024 D5) — the plugin SDK barrel.
 *
 * `CONTEXT.md` §Adapter/renderer SDK is authoritative vocabulary: "the
 * stable, versioned contract surface a surface plugin compiles against —
 * the one barrel of types (`PlatformAdapter`, `Renderer`, and the
 * envelope/target types they need) plus the version constant the loader
 * gates on. An out-of-tree plugin imports from here and nowhere else in
 * cortex."
 *
 * ## What belongs here (and what doesn't)
 *
 * This barrel re-exports ONLY the shared plugin CONTRACT — the types a
 * plugin author needs to implement `PlatformAdapter` or `Renderer` and to
 * describe either as a `SurfacePlugin` the registry can load. It does NOT
 * re-export cortex's internal implementation machinery (`MyelinRuntime`,
 * `PolicyEngine`, `SystemEventSource`, config/presence types, per-kind
 * renderer config schemas, tap readers, formatting helpers, …) — those are
 * genuine cross-boundary imports the four in-tree adapters and the two
 * in-tree renderers still reach for today (ADR-0024 residual couplings
 * #5–#8/#13), and folding them into "the SDK" would make a breaking change
 * to any of THEM force a plugin-SDK major bump, which is not what D1/D5
 * pin: only a breaking change to `PlatformAdapter`, `Renderer`, or the
 * `SurfacePlugin` descriptor shapes is a major bump. Full decoupling of the
 * in-tree adapters from cortex internals is the S9–S12 extraction work,
 * not this slice.
 *
 * The audit that produced this export list: every `../../` import in
 * `src/adapters/{discord,slack,mattermost,web}/*.ts` and every `../`
 * cross-boundary import in `src/renderers/*.ts`, intersected with the
 * types actually referenced by the `PlatformAdapter` / `Renderer` /
 * `SurfacePlugin` contracts (`adapters/types.ts`, `renderers/types.ts`,
 * `bus/surface-router.ts`'s `SurfaceAdapter`, `bus/myelin/envelope-validator.ts`'s
 * `Envelope`, `adapters/registry.ts`'s descriptor types). See
 * `docs/plugin-sdk.md` for the worked audit command and the full list of
 * cross-boundary imports that were deliberately left OUT.
 *
 * ## Compat rule (ADR-0024 D1, D5 — pinned)
 *
 * `SURFACE_SDK_VERSION` is a single-integer-major semver string. A plugin
 * declares an `sdkRange` (e.g. `"^1"`) in its default-exported
 * `SurfacePlugin`; the S6 loader is the SOLE authoritative gate — it checks
 * `satisfies(SURFACE_SDK_VERSION, plugin.sdkRange)` at `import()` time and
 * refuses a non-satisfying plugin with a `system.error` event, leaving the
 * daemon and every other plugin live. **One SDK, one gate, both kinds**
 * (D5): a breaking change to `PlatformAdapter` OR to `Renderer` bumps the
 * SAME major, even though that conservatively refuses plugins of the
 * *other*, unaffected kind — accepted as coarse-but-honest so two
 * independently-versioned SDKs never reintroduce the two-loaders problem
 * D5 exists to prevent. A `cortex: >=X <Y` range MAY appear in a bundle's
 * `cortex-plugin.yaml` as ADVISORY metadata (arc install may surface it)
 * but is never the load gate — only the running daemon's true
 * `SURFACE_SDK_VERSION` is authoritative.
 *
 * Bumping this value is a disciplined act: a breaking change to
 * `PlatformAdapter`, `Renderer`, `SurfacePlugin`/`AdapterPlugin`/
 * `RendererPlugin`, or any type transitively exported below is a MAJOR
 * bump with a documented plugin-author migration note (OQ5 — SDK changelog
 * ownership, ratified "as recommended", still applies: record the
 * migration in this file's history, not just the commit message).
 *
 * ## Changelog (OQ5 — plugin-author migration notes)
 *
 * - **1.1.0** (cortex#2002, C-1853) — ADDITIVE, non-breaking. `PlatformAdapter`
 *   gains an OPTIONAL `readonly maxUploadBytes?: number` (a platform's single
 *   outbound-file ceiling in bytes). No migration required: a bundle that does
 *   not declare it keeps compiling and the host falls back to its default
 *   ceiling. Bundles SHOULD adopt it to advertise their platform's real limit
 *   (Discord ~25 MB boosted, Slack 1 GB, Mattermost `FileSettings.MaxFileSize`
 *   default 100 MB, web N/A). Minor bump — no `sdkRange` change needed for
 *   existing plugins.
 * - **1.0.0** — initial versioned SDK barrel (cortex#1790, S5).
 */
export declare const SURFACE_SDK_VERSION = "1.1.0";
/**
 * cortex#1794 (S9b) — the narrow, TYPE-ONLY behavioral contract an adapter
 * uses to authorise an inbound message, in place of importing cortex's
 * `PolicyEngine` / `PlatformPrincipalIndex` / `PrincipalRegistry`
 * (`common/policy`) directly. Those three types are cortex-internal runtime
 * machinery — genuinely out of scope for the SDK barrel (same reasoning as
 * `MyelinRuntime`/`SystemEventSource`, see the module doc above) — so rather
 * than re-export them, the SDK exposes only the SHAPE an adapter needs: given
 * an inbound message (or a `(platform, platformId)` pair), decide access.
 *
 * The host binds both closures over its real `PolicyEngine` + index +
 * registry at adapter-construction time (`adapters/plugin-support.ts`'s
 * `buildAdapterPolicyPort`, cortex-side) and hands the bound port through
 * `AdapterPlugin.createAdapter`'s `args` — the adapter body never imports
 * `common/policy` itself, so it stays compilable against `surface-sdk` alone
 * whether it lives in-tree or, after extraction, in its own package. This is
 * a dependency-inversion PORT (Hexagonal architecture sense), not a data
 * type: no `PolicyEngine`-shaped value crosses the barrel, only a bound
 * behavior.
 *
 * First consumer: `WebAdapterInfra.policy`, originally at cortex's
 * `src/adapters/web/index.ts` — relocated cortex#1794 (S9 MOVE) to the
 * `metafactory-cortex-adapter-web` bundle's `src/index.ts`, which now
 * imports this port from a vendored copy of this barrel (see that repo's
 * `src/vendor/surface-sdk.ts`). cortex#1795 (S10) closed the SAME coupling
 * for `slack` (now `metafactory-cortex-adapter-slack`). Discord/Mattermost
 * still import `common/policy` directly — their dependency-inversion pass
 * is a later slice (cortex#1896).
 */
export interface AdapterPolicyPort {
	/** Resolve `msg` to an `AccessDecision` via the host's bound policy engine
	 *  (mirrors `common/policy`'s `resolvePolicyAccess`). */
	resolveAccess(msg: InboundMessage): AccessDecision;
	/** Whether `(platform, platformId)` maps to a principal holding the
	 *  `operator` capability (mirrors `common/policy`'s `isOperatorPrincipal`). */
	isOperatorPrincipal(platform: string, platformId: string): boolean;
}
/**
 * cortex#1795 (S10) — the narrow, TYPE-ONLY behavioral contract an adapter
 * uses to emit `system.adapter.recovered` / `system.adapter.disconnected`
 * envelopes, in place of importing cortex's `MyelinRuntime` (`bus/myelin/runtime`)
 * and `createSystemAdapterRecoveredEvent`/`createSystemAdapterDisconnectedEvent`
 * (`bus/system-events`) directly. Those are genuine cortex-internal runtime
 * machinery (envelope construction + bus publish semantics) — out of scope
 * for the SDK barrel for the same reason `MyelinRuntime`/`SystemEventSource`
 * are (see the module doc above) — so rather than re-export them, the SDK
 * exposes only the SHAPE an adapter needs: "tell the host I recovered/
 * disconnected"; the host decides whether/how that becomes a published
 * envelope.
 *
 * The host binds both closures over its real `MyelinRuntime` + bound
 * `SystemEventSource` at adapter-construction time
 * (`adapters/plugin-support.ts`'s `buildAdapterSystemEventPort`, cortex-side)
 * and hands the bound port through `AdapterPlugin.createAdapter`'s `args` —
 * the adapter body never imports `bus/myelin/runtime` or `bus/system-events`
 * itself, so it stays compilable against `surface-sdk` alone whether it
 * lives in-tree or, after extraction, in its own package. Both methods are
 * safe no-ops when the host has no live runtime/source wired (mirrors the
 * pre-extraction `canPublishSystemEvent()` gate exactly, including its
 * "runtime configured but source missing" one-time warning).
 *
 * First consumer: `SlackAdapterInfra.systemEvents`, `src/adapters/slack/index.ts`
 * (cortex#1795 S10). cortex#1797 (S12) widened this port with `degraded`/
 * `untrustedBotDenied` for Discord's extraction — see those methods' docs.
 * Mattermost still calls `bus/system-events` directly for its (currently
 * unused) `runtime` field — its own inversion pass already extracted, and
 * simply never wired a system-events port; a follow-up would just plumb it.
 */
export interface AdapterSystemEventPort {
	/** Emit `system.adapter.recovered` for `adapterId`/`platform`. No-op if
	 *  the host has no runtime/source wired (mirrors `resolveAccess`'s
	 *  deny-by-default posture: absent wiring never throws). */
	recovered(opts: {
		adapterId: string;
		platform: string;
		disconnectedSince: Date;
		degradedForMs: number;
		reconnectAttempts?: number;
	}): void;
	/** Emit `system.adapter.disconnected` for `adapterId`/`platform`. No-op if
	 *  the host has no runtime/source wired. */
	disconnected(opts: {
		adapterId: string;
		platform: string;
		disconnectedSince: Date;
		wasClean: boolean;
		shardId?: number;
		closeCode?: number;
		closeReason?: string;
	}): void;
	/**
	 * cortex#1797 (S12) — emit `system.adapter.degraded` for `adapterId`/
	 * `platform`: an adapter has been disconnected long enough to cross the
	 * principal-configured threshold. First consumer: `DiscordAdapter`
	 * (`src/adapters/discord/index.ts`'s `publishAdapterDegraded`, mirroring
	 * the discord.js per-shard degraded-timer path in `client.ts`). No-op if
	 * the host has no runtime/source wired.
	 */
	degraded(opts: {
		adapterId: string;
		platform: string;
		disconnectedSince: Date;
		thresholdMs: number;
		reconnectAttempts?: number;
	}): void;
	/**
	 * cortex#1797 (S12) — emit `system.access.denied` for an inbound message
	 * dropped by an adapter-side trust gate (e.g. an un-trusted bot author),
	 * BEFORE the message ever reaches the policy engine. Distinct from
	 * `AdapterPolicyPort.resolveAccess` (which gates messages that DO reach
	 * the policy engine) — this is the adapter's own pre-gate rejection.
	 * `sovereignty`/`signedBy`/`capability` are host-synthesised from
	 * `platform`+`source` (the same fixed "local inbound deny" shape the
	 * pre-extraction `DiscordAdapter.publishUntrustedBotDenied` built inline)
	 * so the adapter body never needs to construct a `SystemAccessSovereignty`
	 * itself. First consumer: `DiscordAdapter`'s trusted-bot-id gate. No-op if
	 * the host has no runtime/source wired.
	 */
	untrustedBotDenied(opts: {
		platform: string;
		principalId: string;
		correlationId: string;
		envelopeSubject: string;
		envelopeId: string;
		/** Structured deny reason — `kind` is the discriminator (mirrors
		 *  cortex's internal `SystemAccessDeniedReason`); other fields ride
		 *  through verbatim. */
		reason: {
			kind: string;
			[k: string]: unknown;
		};
	}): void;
}

export {
	SurfaceAdapter as RenderTarget,
};

export {};
