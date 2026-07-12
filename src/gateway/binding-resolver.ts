/**
 * GW.a.1 — Gateway binding resolver (cortex#524).
 *
 * Pure, zero-I/O module that builds a fast lookup index from the validated
 * `Surfaces` config map and resolves an `InboundMessage` to the one binding
 * entry that should receive it.
 *
 * ## Real schema vs design §3.2 proposal
 *
 * `docs/design-shared-surface-gateway.md` §3.2 proposed a YAML shape with
 * per-channel `match` rules, explicit `instance` ids, and an `assistant`
 * field.  What CFG.c ACTUALLY shipped (see `src/common/types/surfaces.ts`) is
 * considerably flatter:
 *
 *   - Each platform key holds `Array<{ agent, stack?, binding }>`.
 *   - `binding` carries platform-credential fields only (`guildId` for Discord,
 *     `workspaceId` for Slack, `apiUrl`+`apiToken` for Mattermost).
 *   - There is NO per-channel `match` block, NO explicit `instance` id field,
 *     and NO `assistant` field on the binding.
 *
 * This resolver is grounded in the REAL shipped schema.
 *
 * ## Schema gaps surfaced (follow-ups)
 *
 * 1. **No per-channel `match`** — the real schema has no `match: { guildId,
 *    channelName }` block.  Demux is guild-granularity only (Discord guildId,
 *    Slack workspaceId).  Per-channel routing within a guild is deferred.
 *
 * 2. **No explicit `instance` id** — `surfaces.yaml` carries no stable
 *    `instance` field (the §3.2 proposal had one).  This resolver derives an
 *    INTERIM id as `"${platform}:${demuxKey}"` (see `GatewayBindingMatch.instance`
 *    below).  When the schema grows an explicit field this derivation should be
 *    replaced.  Tracked: design §3.3 / OQ4.
 *
 * 3. **`assistant` not on the binding** — the GW needs to know which assistant
 *    a binding targets so it can build a Direct dispatch subject
 *    (`tasks.@{did-encoded-assistant}.chat`).  The real schema only carries
 *    `agent` (the stack-local agent id, the fold-join key against `agents[].id`).
 *    Agent → assistant resolution is deferred to the stack config lookup that
 *    the caller performs after resolving the binding.
 *
 * 4. **`stack` is optional** — the binding's `stack: "{principal}/{stack}"` field
 *    is optional.  When absent, `principal` and `stack` on the returned match
 *    are `undefined`.  The caller must handle the absent-stack case (e.g.
 *    by falling back to the stack the GW itself runs as).
 *
 * ## v1 decisions baked in
 *
 * - **Connection dedup / demux key = `(platform, guildId|workspaceId)`** —
 *   OQ1 option (a): operational truth as of today.
 * - **Single-principal v1** — cross-principal (`federated.`) bindings are out
 *   of scope.  OQ3 deferred.
 * - **Read from the validated `Surfaces` type** (composed config, not a
 *   separate raw file).  OQ7 → composed.
 * - **Mattermost has no per-message server id** on `InboundMessage`: if exactly
 *   one Mattermost binding exists in the config, it is the single-binding
 *   fallback and is used unconditionally; if more than one binding exists the
 *   inbound cannot be demuxed, and `resolveBinding` returns `null` with the
 *   ambiguity recorded in the index.
 */

import type { Surfaces } from "../common/types/surfaces";
import type { InboundMessage } from "../adapters/types";

// =============================================================================
// Public types
// =============================================================================

/**
 * A resolved binding match — everything the gateway needs to route one
 * inbound message to the right stack and build its dispatch envelope.
 */
export interface GatewayBindingMatch {
  /** Platform the inbound message arrived on. */
  platform: "discord" | "slack" | "mattermost" | "web";

  /**
   * The `agent` id from the binding entry — the stack-local agent id that
   * hosts the target assistant.  Caller resolves agent → assistant via the
   * stack config.
   */
  agent: string;

  /**
   * Principal parsed from the binding's `stack` field (`{principal}/{stack}`).
   * `undefined` when the binding carries no `stack` field (gap 4 above).
   */
  principal?: string;

  /**
   * Stack leaf parsed from the binding's `stack` field.
   * `undefined` when the binding carries no `stack` field (gap 4 above).
   */
  stack?: string;

  /**
   * Stable derived id used as `response_routing.instance` on every dispatch
   * envelope the gateway publishes for this binding.
   *
   * INTERIM — derived as `"${platform}:${demuxKey}"` until the `surfaces.yaml`
   * schema carries an explicit `instance` field (design §3.3 / OQ4, gap 2
   * above).  When the schema adds the field, replace this derivation with the
   * explicit value so the id becomes config-stable across platform credential
   * rotations.
   *
   * For Discord/Slack: demuxKey = guildId / workspaceId.
   * For Mattermost (single-binding fallback): demuxKey = binding.apiUrl.
   */
  instance: string;
}

/**
 * Internal entry stored in each per-platform bucket.
 * Carries everything needed by `resolveBinding` without re-parsing.
 */
interface IndexEntry {
  agent: string;
  principal: string | undefined;
  stack: string | undefined;
  /** Pre-computed interim instance id */
  instance: string;
}

/**
 * The pre-built index produced by `buildBindingIndex`.
 *
 * Keyed lookup is the hot path on every inbound message; the index must be
 * built ONCE at startup and reused.
 *
 * Mattermost is special-cased because `InboundMessage` carries no per-message
 * server id — the demux is handled via a single-binding slot or an ambiguity
 * flag.
 */
export interface GatewayBindingIndex {
  /** Discord: keyed by `binding.guildId` */
  discord: Map<string, IndexEntry>;
  /** Slack: keyed by `binding.workspaceId` */
  slack: Map<string, IndexEntry>;
  /** Web: keyed by the adapter instanceId stamped on InboundMessage (e.g. `web:acme`). */
  web: Map<string, IndexEntry>;
  /**
   * Mattermost single-binding fallback.
   * `null`  → no mattermost bindings.
   * non-null → exactly one binding (safe to use as fallback).
   */
  mattermostSingle: IndexEntry | null;
  /**
   * `true` when more than one Mattermost binding exists — inbound is
   * unresolvable because there is no per-message server id to discriminate.
   * Documented here so `resolveBinding` returns `null` with a clear reason
   * rather than guessing.
   */
  mattermostMulti: boolean;
}

// =============================================================================
// Stack-string parsing
// =============================================================================

/**
 * Parse `"{principal}/{stack}"` into its two parts.
 *
 * - Splits on the FIRST `/` only; a stack id may itself contain slashes
 *   (e.g. `"x/y/z"` → principal `"x"`, stack `"y/z"`).
 * - Returns `{ principal: undefined, stack: undefined }` when the input is
 *   absent (gap 4 — `stack` is optional on the binding).
 */
/**
 * cortex#1793 (S8) — exported (was module-private) so `SurfaceGateway`'s
 * runtime `attachAdapter`/`detachAdapter` (`surface-gateway.ts`) can parse a
 * seed's `stack` field with the EXACT same `{principal}/{stack}` splitting
 * `buildBindingIndex` uses for the boot-time path — one parser, no drift
 * between boot-built and runtime-attached index entries.
 */
export function parseStack(raw: string | undefined): {
  principal: string | undefined;
  stack: string | undefined;
} {
  if (!raw) return { principal: undefined, stack: undefined };
  const idx = raw.indexOf("/");
  if (idx === -1) return { principal: raw, stack: undefined };
  // Empty halves (a leading/trailing or lone "/") collapse to undefined so the
  // {principal,stack}-absent contract holds for degenerate inputs the schema's
  // `.min(1)` still admits (e.g. "/").
  return {
    principal: raw.slice(0, idx) || undefined,
    stack: raw.slice(idx + 1) || undefined,
  };
}

// =============================================================================
// distinctBoundStacks  (a.3d outbound — cortex#524)
// =============================================================================

/**
 * The distinct set of bound stack leaves across every surface binding.
 *
 * The shared surface gateway serves many bound stacks under ONE principal.
 * Its OUTBOUND dispatch sink (cortex#491 `createDispatchSink`, reused here per
 * a.3d) must subscribe to the lifecycle subject of EVERY bound stack — the
 * bound stack's OWN runner republishes `dispatch.task.*` on
 * `local.{principal}.{stack}.dispatch.task.>`, stamping its own runtime
 * principal (which EQUALS the gateway principal under single-principal v1 — the
 * gateway is a separate process and does not stamp the reply) and its stack
 * leaf. A stack whose subject the sink never subscribes to would have its
 * replies silently dropped.
 *
 * Returns one entry per DISTINCT parsed `stack` leaf (re-using `parseStack`,
 * the single source of `{principal}/{stack}` parsing — no drift). A gap-4
 * binding (no `stack` field, §4 above) yields a single `undefined` entry,
 * which the sink turns into the 5-segment legacy subject
 * `local.{principal}.dispatch.task.>` — the shape such a binding publishes on.
 *
 * Single-principal v1 (§ "v1 decisions" above): the principal segment is the
 * gateway's own principal, supplied by the caller; cross-principal bindings are
 * rejected loudly at boot ({@link crossPrincipalBindings}), so this safely
 * returns stack leaves only.
 */
export function distinctBoundStacks(
  surfaces: Surfaces,
): (string | undefined)[] {
  const seen = new Set<string>();
  let sawUndefined = false;
  const out: (string | undefined)[] = [];
  const add = (raw: string | undefined): void => {
    const { stack } = parseStack(raw);
    if (stack === undefined) {
      // gap-4 binding (no stack field) → a single `undefined` bucket, tracked
      // with a boolean so it never collides with any real stack name.
      if (sawUndefined) return;
      sawUndefined = true;
      out.push(undefined);
      return;
    }
    if (seen.has(stack)) return;
    seen.add(stack);
    out.push(stack);
  };
  for (const e of surfaces.discord ?? []) add(e.stack);
  for (const e of surfaces.slack ?? []) add(e.stack);
  for (const e of surfaces.mattermost ?? []) add(e.stack);
  for (const e of surfaces.web ?? []) add(e.stack);
  return out;
}

// =============================================================================
// distinctBoundPrincipalStacks  (F-1 multi-principal subjects — cortex#629)
// =============================================================================

/**
 * One distinct `(principal, stack)` pair the gateway's outbound dispatch sink
 * must subscribe to. The bound stack's OWN runner republishes
 * `dispatch.task.*` on `local.{principal}.{stack}.dispatch.task.>`, stamping
 * its own runtime principal + stack leaf — so the sink needs one subscribe
 * subject per distinct `(principal, stack)` pair across every binding.
 */
export interface BoundPrincipalStack {
  /**
   * Principal segment of the lifecycle subject. Parsed from the binding's
   * `{principal}/{stack}` field; falls back to the gateway's own principal for
   * a gap-4 binding (no `stack` field — §4 above), which publishes on the
   * gateway principal's namespace.
   */
  principal: string;
  /**
   * Stack leaf, or `undefined` for a gap-4 binding (the 5-segment legacy
   * subject `local.{principal}.dispatch.task.>`).
   */
  stack: string | undefined;
}

/**
 * The distinct set of `(principal, stack)` pairs across every surface binding.
 *
 * **F-1 (cortex#629) — multi-principal subjects.** {@link distinctBoundStacks}
 * collapses every binding onto the gateway's single principal (single-principal
 * v1). When the gateway serves MULTIPLE principals on a shared bus (F-1, with
 * signing OFF), each binding's reply lands on ITS OWN principal's namespace —
 * `local.{thatPrincipal}.{stack}.dispatch.task.>` — not the gateway principal's.
 * The outbound sink therefore needs one subscribe subject per distinct
 * `(principal, stack)` pair, derived HERE from each binding's PARSED principal.
 *
 * Derivation (re-uses `parseStack`, the single `{principal}/{stack}` source —
 * no drift):
 *   - A binding with a `stack` field yields `{ principal: <parsed>, stack:
 *     <parsed leaf> }`.
 *   - A gap-4 binding (no `stack` field, §4 above) carries no principal, so it
 *     falls back to the gateway's own `principal` with `stack: undefined` — the
 *     5-segment legacy subject it publishes on.
 *
 * Pairs are deduped on `(principal, stack)` (with `undefined` stack as its own
 * bucket per principal), preserving binding iteration order across discord →
 * slack → mattermost.
 *
 * Cross-principal bindings are UNSIGNED/UNAUTHENTICATED in F-1 (dev/trusted
 * only); the boot path WARNS rather than throwing ({@link
 * crossPrincipalBindings} stays the detector — only the consumer changed from
 * throw→warn). Signing is layered on later (cortex#552 / cortex#635).
 */
export function distinctBoundPrincipalStacks(
  surfaces: Surfaces,
  gatewayPrincipal: string,
): BoundPrincipalStack[] {
  const seen = new Set<string>();
  const out: BoundPrincipalStack[] = [];
  const add = (raw: string | undefined): void => {
    const parsed = parseStack(raw);
    // Gap-4 (no stack field) → the binding has no principal of its own and
    // publishes on the gateway principal's 5-segment legacy subject.
    const principal = parsed.principal ?? gatewayPrincipal;
    const stack = parsed.stack;
    // Dedup key: a ` ` separator keeps the principal/stack boundary
    // unambiguous, and a distinct sentinel for the undefined-stack bucket so it
    // never collides with a real stack name.
    const key = `${principal} ${stack ?? "undefined"}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ principal, stack });
  };
  for (const e of surfaces.discord ?? []) add(e.stack);
  for (const e of surfaces.slack ?? []) add(e.stack);
  for (const e of surfaces.mattermost ?? []) add(e.stack);
  for (const e of surfaces.web ?? []) add(e.stack);
  return out;
}

// =============================================================================
// crossPrincipalBindings  (single-principal v1 enforcement — a.3d review)
// =============================================================================

/**
 * The `stack` ids of any bindings whose parsed principal differs from the
 * gateway's own principal — i.e. cross-principal bindings.
 *
 * **Why this exists (a.3d review finding).** The gateway is single-principal
 * in v1 (§ "v1 decisions" above): both the inbound publisher and the outbound
 * dispatch sink key off the gateway's OWN principal and discard each binding's
 * parsed principal. That makes the single-principal rule an *assumption*. A
 * binding that declared `{otherPrincipal}/{stack}` would then be silently
 * absorbed into the gateway principal's namespace on both legs — the exact
 * latent cross-principal leak single-principal v1 is meant to exclude.
 *
 * This helper turns the assumption into an enforceable gate: the caller throws
 * a loud boot error when the result is non-empty (same loud-validation style as
 * {@link buildBindingIndex}'s duplicate-key throw), so a cross-principal
 * misconfig fails at startup rather than mis-routing at runtime. Bindings with
 * no `stack` field (gap-4) carry no principal and are never flagged.
 *
 * Returns the offending raw `stack` values (deduped, in iteration order) so the
 * error message can name them.
 */
export function crossPrincipalBindings(
  surfaces: Surfaces,
  principal: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const check = (raw: string | undefined): void => {
    // Narrow `raw` to a string up front: a gap-4 binding (no `stack`) carries
    // no principal and can never be cross-principal, so skip it. This also
    // lets us push `raw` without a non-null assertion.
    if (raw === undefined) return;
    const parsed = parseStack(raw);
    if (parsed.principal !== undefined && parsed.principal !== principal) {
      if (seen.has(raw)) return;
      seen.add(raw);
      out.push(raw);
    }
  };
  for (const e of surfaces.discord ?? []) check(e.stack);
  for (const e of surfaces.slack ?? []) check(e.stack);
  for (const e of surfaces.mattermost ?? []) check(e.stack);
  for (const e of surfaces.web ?? []) check(e.stack);
  return out;
}

// =============================================================================
// buildBindingIndex
// =============================================================================

/**
 * Fold the validated `Surfaces` map into a fast-lookup `GatewayBindingIndex`.
 *
 * This is the loud-validation seam: config invariants (duplicate demux keys)
 * are detected here and thrown as hard `Error`s — the same loud-error style
 * as `foldSurfaceBindings` in `surfaces.ts`.  `resolveBinding` (the per-message
 * hot path) never throws; index build is where we fail fast at startup.
 *
 * @throws `Error` when two bindings collide on the same `(platform, demuxKey)`.
 */
export function buildBindingIndex(surfaces: Surfaces): GatewayBindingIndex {
  const discord = new Map<string, IndexEntry>();
  const slack = new Map<string, IndexEntry>();
  const web = new Map<string, IndexEntry>();
  let mattermostSingle: IndexEntry | null = null;
  let mattermostMulti = false;

  // ── Discord ─────────────────────────────────────────────────────────────
  for (const entry of surfaces.discord ?? []) {
    const demuxKey = entry.binding.guildId;
    if (discord.has(demuxKey)) {
      throw new Error(
        `gateway binding-resolver: ambiguous discord config — two bindings share guildId "${demuxKey}". ` +
          `Each (platform, guildId) pair must map to exactly one binding. ` +
          `Fix the surfaces.yaml discord bindings to remove the duplicate.`,
      );
    }
    const { principal, stack } = parseStack(entry.stack);
    discord.set(demuxKey, {
      agent: entry.agent,
      principal,
      stack,
      instance: `discord:${demuxKey}`,
    });
  }

  // ── Slack ────────────────────────────────────────────────────────────────
  for (const entry of surfaces.slack ?? []) {
    const demuxKey = entry.binding.workspaceId;
    if (slack.has(demuxKey)) {
      throw new Error(
        `gateway binding-resolver: ambiguous slack config — two bindings share workspaceId "${demuxKey}". ` +
          `Each (platform, workspaceId) pair must map to exactly one binding. ` +
          `Fix the surfaces.yaml slack bindings to remove the duplicate.`,
      );
    }
    const { principal, stack } = parseStack(entry.stack);
    slack.set(demuxKey, {
      agent: entry.agent,
      principal,
      stack,
      instance: `slack:${demuxKey}`,
    });
  }

  // ── Mattermost ───────────────────────────────────────────────────────────
  //
  // Mattermost has no per-message server id on `InboundMessage` — the demux
  // key is not available at message time.  Strategy:
  //
  //   - Exactly one binding → single-binding fallback (safe, unambiguous).
  //   - More than one binding → record the ambiguity; `resolveBinding` returns
  //     null with a clear reason.  This is a config gap, not a runtime error:
  //     a deployment with two Mattermost servers needs the schema to gain a
  //     per-message server id before it can be demuxed (gap 1, OQ1).
  //
  // Note: duplicate Mattermost apiUrl across bindings is NOT flagged here as a
  // collision, because Mattermost demux does NOT use apiUrl as a per-message
  // key.  The single-vs-multi distinction is the only thing the inbound path
  // can act on.
  const mmEntries = surfaces.mattermost ?? [];
  // `soleMm` narrows to a real entry only in the exactly-one case (avoids a
  // non-null assertion under noUncheckedIndexedAccess).
  const soleMm = mmEntries.length === 1 ? mmEntries[0] : undefined;
  if (soleMm) {
    const { principal, stack } = parseStack(soleMm.stack);
    // Use apiUrl as the demux key for the interim instance id (the only stable
    // per-binding identifier Mattermost surfaces carry).
    mattermostSingle = {
      agent: soleMm.agent,
      principal,
      stack,
      instance: `mattermost:${soleMm.binding.apiUrl}`,
    };
  } else if (mmEntries.length > 1) {
    mattermostMulti = true;
    // mattermostSingle stays null — resolveBinding will return null with the
    // mattermostMulti flag as the documented reason.
  }

  // ── Web ──────────────────────────────────────────────────────────────────
  // Demux key = the adapter instanceId the WebAdapter stamps on every
  // InboundMessage (`web:${binding.instanceId}`), matched verbatim in
  // resolveBinding. Web carries no platform-native guild/server id.
  for (const entry of surfaces.web ?? []) {
    const demuxKey = `web:${entry.binding.instanceId}`;
    if (web.has(demuxKey)) {
      throw new Error(
        `gateway binding-resolver: ambiguous web config — two bindings share instanceId "${entry.binding.instanceId}". ` +
          `Each (platform, instanceId) pair must map to exactly one binding. ` +
          `Fix the surfaces.yaml web bindings to remove the duplicate.`,
      );
    }
    const { principal, stack } = parseStack(entry.stack);
    web.set(demuxKey, {
      agent: entry.agent,
      principal,
      stack,
      instance: demuxKey,
    });
  }

  return { discord, slack, web, mattermostSingle, mattermostMulti };
}

// =============================================================================
// resolveBinding
// =============================================================================

/** Build the public match from a platform + its resolved index entry. */
function matchFrom(
  platform: GatewayBindingMatch["platform"],
  entry: IndexEntry,
): GatewayBindingMatch {
  return {
    platform,
    agent: entry.agent,
    principal: entry.principal,
    stack: entry.stack,
    instance: entry.instance,
  };
}

/**
 * Resolve one `InboundMessage` to a `GatewayBindingMatch` using the pre-built
 * index.
 *
 * Pure lookup — never throws.  Returns `null` when:
 *   - The platform has no bindings in the index.
 *   - No binding matches the inbound's demux key (Discord/Slack: guildId /
 *     workspaceId is absent or not in the index).
 *   - Inbound is a DM (no guildId) with no single-binding fallback available.
 *   - Mattermost multi-binding ambiguity (no per-message server id to
 *     discriminate — see `mattermostMulti` flag in `GatewayBindingIndex`).
 */
export function resolveBinding(
  index: GatewayBindingIndex,
  inbound: InboundMessage,
): GatewayBindingMatch | null {
  const { platform } = inbound;

  if (platform === "discord") {
    const demuxKey = inbound.guildId;
    if (!demuxKey) {
      // DM — no guild context; guild-granularity demux only in v1.
      return null;
    }
    const entry = index.discord.get(demuxKey);
    if (!entry) return null;
    return matchFrom("discord", entry);
  }

  if (platform === "slack") {
    // Slack surfaces the workspace/team id on InboundMessage.guildId
    // (per its doc comment: "Platform guild/server/team ID").
    const demuxKey = inbound.guildId;
    if (!demuxKey) return null;
    const entry = index.slack.get(demuxKey);
    if (!entry) return null;
    return matchFrom("slack", entry);
  }

  if (platform === "mattermost") {
    if (index.mattermostMulti) {
      // More than one Mattermost binding — unresolvable without a per-message
      // server id.  Caller should log this as a config gap.
      return null;
    }
    if (!index.mattermostSingle) {
      // No Mattermost bindings at all.
      return null;
    }
    return matchFrom("mattermost", index.mattermostSingle);
  }

  if (platform === "web") {
    // Web demuxes by the adapter instanceId stamped on the InboundMessage
    // (`web:${binding.instanceId}`) — no platform-native guild/server id.
    const entry = index.web.get(inbound.instanceId);
    if (!entry) return null;
    return matchFrom("web", entry);
  }

  // Unknown platform — no bindings.
  return null;
}
