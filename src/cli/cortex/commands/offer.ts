#!/usr/bin/env bun
/**
 * `cortex offer <subcommand>` — CO-3 (epic cortex#939) — the third
 * control-plane leg (DD-CO-5): `cortex stack` (exists) → `cortex network`
 * (federated) → **`cortex offer`** (capabilities exposed).
 *
 * WHY THIS EXISTS
 * ---------------
 * CO-1 delivered the **capability offering** model (`src/common/types/
 * offering.ts`): the provider-side `(capability, offer-scope, accept-policy)`
 * triple that elevates a flat `runtime.capabilities[]` tag into *exposed work*
 * (CONTEXT.md §Capability offering). CO-1 is inert data + a pure resolver. This
 * slice is the ergonomic front-end that EDITS that policy on a stack's own
 * `stacks/<id>.yaml` `policy.offerings[]` (ADR-0009 — per-stack, no shared
 * layer) and **reconciles the federation-config projections** the offering
 * GENERATES (DD-CO-2 — unify, don't rebuild).
 *
 * THE THREE SUBCOMMANDS (design §4)
 * ---------------------------------
 *   offer <capability> --scope <local|federated|public> [--accept …]
 *       Set/WIDEN a capability's offering. Validates against CO-1's schema
 *       (federated-requires-naming; public predicate metadata-only). Default-
 *       deny is preserved: a capability with no offering resolves `local`-only.
 *   offer list
 *       The "what do I expose, to whom" view: every capability the stack's
 *       agents hold (the top-level `capabilities[]` catalog) × its resolved
 *       offering (offer-scope + accept-policy + provider agents), via CO-1's
 *       `resolveOffering`.
 *   offer revoke <capability> [--scope <s>]
 *       Narrow back toward `local`. Idempotent. `--scope` drops just that scope
 *       (and its accept when no widened scope remains); no `--scope` removes the
 *       whole offering entry (→ default-deny local).
 *
 * THE UNIFY MECHANISM (DD-CO-2 — what `--apply` GENERATES)
 * --------------------------------------------------------
 * The offering is the SINGLE SOURCE OF TRUTH; `announce_capabilities` /
 * `accept_subjects` on `policy.federated.networks[]` are its PROJECTIONS. On
 * `--apply` (after the offerings edit), `projectFederationConfig` recomputes,
 * for each declared federated network, the `announce_capabilities` +
 * `accept_subjects` entries IMPLIED by the offerings whose scope includes
 * `federated`/`public` and whose `network` selects that network. The generated
 * `accept_subjects` carry the RECEIVING stack's own identity
 * (`federated.{principal}.{stack}.tasks.{capability}.>`) — ADR-0001: the network
 * is never on the wire, federated subjects carry `{principal}.{stack}` (the same
 * grammar `CortexConfigSchema`'s subject-scope superRefine validates). We do NOT
 * duplicate the federation config by hand; we GENERATE it from the offerings.
 *
 * REGISTRY PUSH — DEFERRED (flagged, not half-done)
 * -------------------------------------------------
 * Design §7 lists THREE projections of an offering: `announce_capabilities`,
 * `accept_subjects`, AND registry `provision-stack register`. CO-3 generates the
 * first two (local config the daemon reads at boot). The registry re-registration
 * (pushing the publicly/federated-offered capability subset to the network
 * registry over the wire) is a SEPARATE, network-touching action with its own
 * signing + proof-of-possession flow (`cortex provision-stack register`,
 * sop-network-join.md). It is **out of scope for CO-3** and surfaced as a
 * follow-up hint on `--apply` rather than silently omitted — see
 * `REGISTRY_PUSH_FOLLOWUP`. (Tracked for CO-4 gate-posture / a dedicated slice.)
 *
 * SAFETY POSTURE (mirrors `cortex stack` / `cortex network` / config-merge)
 * ------------------------------------------------------------------------
 * **Dry-run by DEFAULT.** `offer <capability>` / `offer revoke` print the
 * intended offerings edit + the federation-config projection diff and touch
 * NOTHING; `--apply` opts into the write. The write is guarded exactly like
 * config-merge: a timestamped backup, validate-the-composed-WHOLE-before-write
 * (`CortexConfigSchema`), in-place write, then re-compose-from-disk + re-validate
 * with restore-on-failure. `offer list` is read-only.
 *
 * Refs: docs/design-capability-offering.md §4/§6/§7/§9 (CO-3) ·
 *       docs/adr/0008-capability-offering-scope.md (DD-CO-2/5) ·
 *       docs/adr/0009-offerings-per-stack-no-shared-layer.md ·
 *       docs/adr/0010-public-accept-gate-two-stage.md ·
 *       CONTEXT.md §Capability offering · CO-1 src/common/types/offering.ts.
 *
 * Exit codes: 0 success · 1 operational failure (target/validation/write) · 2 usage.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import YAML from "yaml";

import { composeRawConfig, loadAgentsDirectory } from "../../../common/config/loader";
import { resolveConfigDir } from "../../../common/config/config-path";
import { deriveEffectiveCapabilityCatalog } from "../../../common/agents/capability-catalog";
import type { Agent } from "../../../common/types/cortex-config";
import type { Capability } from "../../../common/types/capability";
import {
  type AcceptPolicy,
  type Offering,
  OfferingSchema,
  type OfferScope,
  type PublicPredicate,
  resolveOffering,
  superRefineOfferings,
} from "../../../common/types/offering";
import { CortexConfigSchema, isFederatedSubjectInOwnScope } from "../../../common/types/cortex-config";
import { deriveStackId } from "../../../common/types/stack";

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type FlagMap, type SubcommandSpec } from "./_shared/parser";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type OfferSubcommand = "list" | "revoke";

/**
 * The set subcommand is the BARE positional form `offer <capability> …` — the
 * design's headline `cortex offer <capability> --scope …`. The parser treats
 * the first positional as the subcommand selector, so a capability id that is
 * not `list`/`revoke` lands as `subcommand: "unknown"` with `rawSubcommand` =
 * the capability id; the dispatcher routes that to the set path. (The capability
 * grammar — dot-separated lowercase segments — can never collide with the
 * reserved `list`/`revoke` words, which are single bare lowercase tokens.)
 */
/** The config-dir default resolved at CALL time — fallback-aware (canonical
 *  `~/.config/metafactory/cortex` → legacy `~/.config/cortex` → grove) so an
 *  un-migrated host reads the legacy tree (cortex#1869, XDG wave-4). */
function defaultConfigDir(): string {
  return resolveConfigDir();
}

/** Capability id grammar — mirrors CO-1's `OfferingCapabilityIdSchema` (the
 *  `*` quantifier admits SINGLE-segment ids like `chat`). */
// TODO(#2034/flag-day): replace with @the-metafactory/myelin/wire capability
// terminal once RFC-0001 lands (blocked-on #2020 capability-regex tightening).
const CAPABILITY_ID_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

/**
 * The DOTTED-capability grammar `announce_capabilities[]` requires (the `+`
 * quantifier — at LEAST one dot), mirrored from `cortex-config.ts`. CO-1's
 * offering grammar is WIDER (it admits single-segment ids), so a single-segment
 * capability offered at federated/public scope would project a value the
 * `announce_capabilities[]` schema rejects with an opaque error at
 * validate-composed time. `buildOffering` pre-flights against this so the
 * principal gets a CLEAR message instead. (PR #967 review BLOCKER 2.)
 */
const ANNOUNCEABLE_CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Network / principal id grammar — letter-prefixed lowercase + hyphen. */
const LETTER_PREFIX_RE = /^[a-z][a-z0-9-]*$/;

const SPEC: SubcommandSpec<OfferSubcommand> = {
  cliName: "offer",
  subcommands: {
    list: {
      positionals: [],
      flags: {
        "--config": "value",
        "--config-dir": "value",
        "--stack": "value",
      },
    },
    revoke: {
      positionals: ["capability"],
      flags: {
        "--config": "value",
        "--config-dir": "value",
        "--stack": "value",
        "--scope": "value",
        "--apply": "bool",
        "--dry-run": "bool",
      },
    },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

/** The set-path flag allowlist (the bare-positional `offer <capability> …`
 *  form the generic parser can't model as a named subcommand). Parsed by the
 *  dedicated `parseSetArgs` below. */

// =============================================================================
// Offering-projection core — PURE (no file I/O). The DD-CO-2 unify mechanism.
// =============================================================================

/**
 * A federation-config projection for ONE network: the `announce_capabilities`
 * + `accept_subjects` entries IMPLIED by the stack's offerings. The single
 * source of truth is `policy.offerings[]`; this is its generated shadow on a
 * `policy.federated.networks[]` entry (design §7, DD-CO-2).
 */
export interface NetworkProjection {
  /** The network id these entries belong on. */
  networkId: string;
  /** Capability ids to announce on this network (sorted, de-duped). */
  announce_capabilities: string[];
  /** Accept-subject patterns scoped to the RECEIVING stack's identity
   *  (`federated.{principal}.{stack}.tasks.{capability}.>`), ADR-0001. */
  accept_subjects: string[];
}

/**
 * Turn a capability id into the trailing subject segment(s) of a `tasks.*`
 * subject. Capability ids are already dot-separated lowercase segments — the
 * SAME grammar as NATS subject segments — so the id maps 1:1 onto the wire
 * (CONTEXT.md §Capability: `tasks.{capability}.{subcapability}`). We append a
 * trailing `>` so the accept pattern admits the capability AND any sub-action
 * beneath it (`code-review` → `…tasks.code-review.>`).
 */
function capabilityAcceptSubject(
  principal: string,
  stack: string,
  capability: string,
): string {
  return `federated.${principal}.${stack}.tasks.${capability}.>`;
}

/**
 * cortex#1097 (umbrella #1084 P2.1) — the prefix the offer-mode DISPATCH writer
 * OWNS on `accept_subjects`: this stack's OWN-identity tasks subtree
 * `federated.{me}.{stack}.tasks.`. Every row beginning with this prefix is a
 * capability-dispatch accept-subject GENERATED from the offerings; the offer
 * writer regenerates exactly these and PRESERVES everything else.
 */
function ownDispatchPrefix(principal: string, stack: string): string {
  return `federated.${principal}.${stack}.tasks.`;
}

/**
 * cortex#1097 (umbrella #1084 P2.1) — merge the offer-mode capability-DISPATCH
 * projection into the network's EXISTING `accept_subjects` WITHOUT clobbering
 * the rows the PRESENCE-wiring writer owns.
 *
 * ## Why a merge, not an overwrite (the investigation finding)
 *
 * `policy.federated.networks[].accept_subjects` has TWO independent writers that
 * share ONE array:
 *
 *   - the **presence** path (`cortex network join`, #1087/#1105). Post-#1361 it
 *     PERSISTS the OWN `.>` subtree ONLY; each roster peer's PRESENCE-only
 *     `.agent.>` subtree (source-addressed presence FROM peers, ADR-0007) is
 *     re-derived by the federation reconciler IN-MEMORY at runtime, never written
 *     to disk (persisting a peer subtree fails the boot validator, #1220/#1361).
 *   - this **offer-mode dispatch** writer regenerates the capability rows
 *     `federated.{me}.{stack}.tasks.{cap}.>` (receiver-addressed dispatch TO me).
 *
 * Offer-mode dispatch is purely RECEIVER-addressed — it never legitimately
 * RECEIVES a peer-SOURCED subject (the verdict a provider emits is an OUTBOUND
 * publish to the requester's subtree, not an accept; probe-responder + the
 * federated review consumer both subscribe the stack's OWN subtree). So the
 * offer writer's OWN-only `…tasks.{cap}.>` rows are already the least-privilege
 * accept-list for dispatch — they must NOT widen to a peer's full `.>`. The bug
 * #1097 fixes is that the old overwrite ALSO erased the presence writer's rows,
 * silently regressing peer-presence admission (P2/#1105) after any `offer --apply`.
 *
 * The merge rule is least-privilege on BOTH sides: the offer writer owns ONLY the
 * own-identity `…tasks.` dispatch rows (it regenerates exactly those, dropping a
 * capability that's no longer offered), and preserves every OTHER **own-scope**
 * row verbatim — the OWN `.>` subtree and any own-scope hand-pin. It never
 * invents a peer subtree (it has no roster) and never widens to `.>`.
 *
 * ## cortex#1362 — own-scope ONLY persisted (aligns with the #1220/#1361 join fix)
 *
 * A persisted PEER PRESENCE subtree (`federated.{peer}.{stack}.agent.>`) is OUT
 * of the receiving stack's own federated scope and FAILS the boot config
 * validator (ADR-0001, `CortexConfigSchema` subject-scope superRefine) — the
 * exact #1220 boot-invalid state, reachable via the offer verb because the old
 * preserve-merge kept a peer subtree a pre-#1361 `join` had written. So the
 * preserve step now DROPS any row that is not in this stack's own federated
 * scope (reusing `isFederatedSubjectInOwnScope`, the single predicate the boot
 * validator itself uses — #1361). Peer PRESENCE is NOT lost: the federation
 * reconciler re-derives the full own ∪ peer accept-list IN-MEMORY at runtime
 * (never persisted), exactly as it does for `network join` post-#1361. The
 * persisted projection therefore stays boot-valid (own-scope only) and offer's
 * guarded validate-before-write no longer refuses on a peered stack carrying a
 * stale peer row — it self-heals by not persisting it.
 *
 * Order: preserved (non-offer, own-scope) rows first in their original order,
 * then the regenerated capability-dispatch rows (sorted, as
 * `projectFederationConfig` already emits them). De-duped — a capability row
 * that also appears in the preserved set (a hand-pin) is not duplicated.
 *
 * PURE.
 */
export function mergeOfferAcceptSubjects(
  priorAccept: readonly string[],
  capabilityDispatchSubjects: readonly string[],
  principal: string,
  stack: string,
): string[] {
  const ownPrefix = ownDispatchPrefix(principal, stack);
  // Preserve every prior row that (a) the offer writer does NOT own (i.e. not one
  // of THIS stack's own-identity `…tasks.*.>` dispatch rows, which are
  // regenerated below) AND (b) is within this stack's OWN federated scope
  // (#1362). Condition (b) DROPS peer `.agent.>` presence subtrees — they are no
  // longer persisted (they fail the boot validator); the reconciler admits peer
  // presence in-memory at runtime. This keeps the persisted accept-list own-scope
  // and boot-valid, mirroring the `network join` fix (#1361).
  const preserved = priorAccept.filter(
    (s) => !s.startsWith(ownPrefix) && isFederatedSubjectInOwnScope(s, principal, stack),
  );

  const seen = new Set<string>(preserved);
  const out = [...preserved];
  for (const subject of capabilityDispatchSubjects) {
    if (seen.has(subject)) continue;
    seen.add(subject);
    out.push(subject);
  }
  return out;
}

/**
 * Compute the per-network federation-config projection from a stack's
 * offerings — the GENERATE half of DD-CO-2. PURE + total.
 *
 * For each capability offered at `federated` or `public` scope, the capability
 * is announced + accepted on the network its offering selects:
 *
 *   - `{kind:'network'}` federated accept → that accept's `network`.
 *   - top-level `offering.network` (the convenience field) → that network.
 *   - `{kind:'principals'}` federated accept with no network → applies to ALL
 *     declared networks (the principal allowlist is network-agnostic; the
 *     capability is reachable on whichever network those principals share).
 *   - `public` scope → announced/accepted on every declared federated network
 *     too (a public offering is reachable federation-wide; the surface gate,
 *     not the network roster, bounds it — ADR-0010). Public has its own
 *     `policy.public.announce_capabilities` projection as well (computed by
 *     `projectPublicAnnounce`).
 *
 * `local`-only offerings contribute NOTHING (default-deny; they bind to the
 * stack's own `local.*` subject and never touch federation config).
 *
 * @param offerings   the stack's `policy.offerings[]` (CO-1 model)
 * @param networkIds  the declared `policy.federated.networks[].id` set
 * @param principal   the receiving stack's principal segment (wire source)
 * @param stack       the receiving stack's stack segment (wire source)
 * @returns           one `NetworkProjection` per declared network (always all
 *                    declared networks, so a network that loses its last
 *                    offered capability is reset to empty lists — the projection
 *                    is authoritative, not additive).
 */
export function projectFederationConfig(
  offerings: readonly Offering[],
  networkIds: readonly string[],
  principal: string,
  stack: string,
): NetworkProjection[] {
  // Accumulate capability ids per network.
  const perNetwork = new Map<string, Set<string>>();
  for (const id of networkIds) perNetwork.set(id, new Set());

  const addTo = (networkId: string, capability: string): void => {
    const set = perNetwork.get(networkId);
    // A capability whose offering names a network NOT in the declared roster
    // is silently skipped here (the offering schema doesn't cross-check the
    // network exists; the projection only generates onto declared networks).
    // The caller surfaces such a dangling network as a warning.
    if (set !== undefined) set.add(capability);
  };

  for (const offering of offerings) {
    const scopes = new Set(offering.scopes);
    const reachesFederation = scopes.has("federated") || scopes.has("public");
    if (!reachesFederation) continue; // local-only → no federation projection.

    const accept = offering.accept;
    if (accept?.kind === "network") {
      addTo(accept.network, offering.capability);
    } else if (offering.network !== undefined) {
      addTo(offering.network, offering.capability);
    } else {
      // {kind:'principals'} with no network, or a public offering — reachable
      // on every declared network (the principal allowlist / surface gate, not
      // the network roster, is the bound).
      for (const id of networkIds) addTo(id, offering.capability);
    }
  }

  return networkIds.map((networkId) => {
    const caps = [...(perNetwork.get(networkId) ?? new Set<string>())].sort();
    return {
      networkId,
      announce_capabilities: caps,
      accept_subjects: caps.map((c) => capabilityAcceptSubject(principal, stack, c)),
    };
  });
}

/**
 * The `policy.public.announce_capabilities` projection — the public-scope
 * counterpart to `projectFederationConfig`. Every capability offered at
 * `public` scope is announced to the registry's public capability index
 * (CONTEXT.md §Capability offering; `PolicyPublicSchema.announce_capabilities`).
 * PURE. Sorted + de-duped.
 */
export function projectPublicAnnounce(offerings: readonly Offering[]): string[] {
  const caps = new Set<string>();
  for (const offering of offerings) {
    if (offering.scopes.includes("public")) caps.add(offering.capability);
  }
  return [...caps].sort();
}

/**
 * Networks named by an offering that are NOT in the declared federated roster.
 * A `cortex offer <cap> --scope federated --network <id>` that names a network
 * the stack hasn't joined is a likely mistake (the projection has nowhere to
 * land); the set command surfaces these as a warning (it does not block — the
 * principal may be about to `cortex network join <id>`). PURE.
 */
export function danglingNetworks(
  offerings: readonly Offering[],
  networkIds: readonly string[],
): string[] {
  const declared = new Set(networkIds);
  const dangling = new Set<string>();
  for (const offering of offerings) {
    const named =
      offering.accept?.kind === "network"
        ? offering.accept.network
        : offering.network;
    if (named !== undefined && !declared.has(named)) dangling.add(named);
  }
  return [...dangling].sort();
}

// =============================================================================
// Pure offerings-edit core (set / revoke) — no file I/O
// =============================================================================

/** A note describing one offerings-edit's disposition. */
export interface OfferEditNote {
  capability: string;
  /** added: new offering. widened: scope/accept changed on an existing one.
   *  unchanged: idempotent no-op. revoked: whole offering removed. narrowed:
   *  a scope dropped from an existing offering. absent: revoke target not
   *  present (no-op). */
  action: "added" | "widened" | "unchanged" | "revoked" | "narrowed" | "absent";
  /** The resulting scopes after the edit (empty ⇒ offering removed). */
  scopes: OfferScope[];
}

export interface OfferEditResult {
  /** The new offerings array (deep clone; input not mutated). */
  offerings: Offering[];
  note: OfferEditNote;
}

/** Structural equality via canonical JSON (key order irrelevant). */
function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}
function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  if (v === undefined) return "null";
  return JSON.stringify(v);
}

/**
 * Apply a SET (set/widen) to the offerings list — PURE. Replaces the existing
 * offering for `capability` wholesale with the new `(scopes, accept, network)`
 * triple (an offering carries ONE accept; widening is a replace, not a deep
 * merge — the new declaration is authoritative). The replacement is validated
 * per-entry by `OfferingSchema` at the call site (`buildOffering`); the
 * cross-offering coherence (federated-requires-naming, scope↔accept) is checked
 * via `superRefineOfferings` here so a malformed set is rejected before write.
 *
 * @returns {ok:false} with the coherence-issue messages on a malformed edit.
 */
export function applySet(
  existing: readonly Offering[],
  next: Offering,
): { ok: true; result: OfferEditResult } | { ok: false; errors: string[] } {
  const out = existing.map((o) => structuredClone(o));
  const idx = out.findIndex((o) => o.capability === next.capability);
  let action: OfferEditNote["action"];
  if (idx === -1) {
    out.push(structuredClone(next));
    action = "added";
  } else if (deepEqual(out[idx], next)) {
    action = "unchanged";
  } else {
    out[idx] = structuredClone(next);
    action = "widened";
  }

  // Coherence gate (CO-1) — federated-requires-naming, scope↔accept, dedup.
  const issues = superRefineOfferings(out);
  if (issues.length > 0) {
    return { ok: false, errors: issues.map((i) => i.message) };
  }
  return {
    ok: true,
    result: { offerings: out, note: { capability: next.capability, action, scopes: next.scopes } },
  };
}

/**
 * Apply a REVOKE to the offerings list — PURE. With `scope` undefined, removes
 * the whole offering (→ default-deny `local`). With `scope` set, drops just
 * that scope; if that empties the widened scopes, the offering's accept is
 * dropped too (a `local`-only offering carries no accept — CO-1 coherence) and,
 * when only `local` (or nothing) remains, the offering is removed entirely so
 * the resolver's default-deny is the single source of `local`. Idempotent: a
 * revoke of an absent capability (or an already-narrow scope) is a no-op.
 */
export function applyRevoke(
  existing: readonly Offering[],
  capability: string,
  scope: OfferScope | undefined,
): { ok: true; result: OfferEditResult } | { ok: false; errors: string[] } {
  const out = existing.map((o) => structuredClone(o));
  const idx = out.findIndex((o) => o.capability === capability);
  if (idx === -1) {
    return {
      ok: true,
      result: { offerings: out, note: { capability, action: "absent", scopes: [] } },
    };
  }

  // Whole-offering revoke (no --scope): remove → default-deny local.
  if (scope === undefined) {
    out.splice(idx, 1);
    return {
      ok: true,
      result: { offerings: out, note: { capability, action: "revoked", scopes: [] } },
    };
  }

  const target = out[idx];
  if (target === undefined) {
    // Unreachable (idx was found), but keeps the type checker honest.
    return {
      ok: true,
      result: { offerings: out, note: { capability, action: "absent", scopes: [] } },
    };
  }

  // If the requested scope was never on this offering, the revoke is a no-op:
  // nothing to narrow. Report `absent` and leave the offering untouched (NOT a
  // splice — `--scope public` on a `["federated"]` offering must not silently
  // remove the federated offering). (PR #967 review MAJOR — the action note must
  // reflect the actual outcome, and an absent scope is a no-op, not a removal.)
  const scopeWasPresent = target.scopes.includes(scope);
  if (!scopeWasPresent) {
    return {
      ok: true,
      result: { offerings: out, note: { capability, action: "absent", scopes: target.scopes } },
    };
  }

  const remaining = target.scopes.filter((s) => s !== scope);

  // The scope WAS present and we dropped it → this is a genuine `narrowed`. If
  // dropping it leaves no widened tier, remove the whole offering so the
  // capability resolves default-deny `local` (no stranded local-only entry, no
  // orphan accept) — still reported `narrowed` (the user dropped a present
  // scope; the entry-removal is the consequence, not an absence).
  const widenedRemaining = remaining.filter((s) => s !== "local");
  if (widenedRemaining.length === 0) {
    out.splice(idx, 1);
    return {
      ok: true,
      result: { offerings: out, note: { capability, action: "narrowed", scopes: [] } },
    };
  }

  // Scope still has a widened tier left: keep the offering, drop the scope.
  // The accept stays (it still gates a remaining widened scope). Re-validate.
  const narrowed: Offering = { ...structuredClone(target), scopes: remaining };
  out[idx] = narrowed;
  const issues = superRefineOfferings(out);
  if (issues.length > 0) {
    return { ok: false, errors: issues.map((i) => i.message) };
  }
  return {
    ok: true,
    result: { offerings: out, note: { capability, action: "narrowed", scopes: remaining } },
  };
}

// =============================================================================
// Offering builder — assemble + validate an Offering from CLI flags (CO-1 Zod)
// =============================================================================

/**
 * Build + validate an `Offering` from the set-path CLI inputs. Encodes the
 * accept-policy from `--accept` per the CONTEXT.md closed-set vocabulary:
 *
 *   federated:
 *     --accept network:<id>            → {kind:'network', network}
 *     --accept principals:a,b,c        → {kind:'principals', principals}
 *   public:
 *     --accept surface:<s>/<predicate> → {kind:'surface', surface, predicate}
 *       predicate forms (metadata-only, ADR-0010):
 *         repo:<glob>[,<glob>…]        → {kind:'repo-membership', repos}
 *         sender-allow:<id>[,…]        → {kind:'sender-allow', senders}
 *         sender-block:<id>[,…]        → {kind:'sender-block', senders}
 *         rate:<n>/<min|hour|day>      → {kind:'rate', per_*}
 *
 * Returns the OfferingSchema-validated value, or a list of error strings (bad
 * grammar / a content-dependent predicate that the closed enum rejects).
 */
export function buildOffering(input: {
  capability: string;
  scope: OfferScope;
  accept?: string;
  network?: string;
}): { ok: true; offering: Offering } | { ok: false; errors: string[] } {
  const { capability, scope } = input;
  const errors: string[] = [];

  if (!CAPABILITY_ID_RE.test(capability)) {
    errors.push(
      `capability "${capability}" must be a capability id — dot-separated lowercase segments (e.g. 'code-review.typescript')`,
    );
  }

  // Pre-flight (PR #967 review BLOCKER 2): a SINGLE-segment capability id (e.g.
  // `chat`) is valid in CO-1's offering grammar (`*` quantifier) but the
  // `announce_capabilities[]` schema this offering PROJECTS onto requires at
  // least one dot (`+` quantifier). Offering a single-segment capability at
  // federated/public would therefore project a value the composed-config schema
  // rejects with an opaque error. Catch it here with a CLEAR message; local-only
  // single-segment offerings are unaffected (they never reach announce_capabilities).
  if (
    (scope === "federated" || scope === "public") &&
    CAPABILITY_ID_RE.test(capability) &&
    !ANNOUNCEABLE_CAPABILITY_ID_RE.test(capability)
  ) {
    errors.push(
      `capability "${capability}" is single-segment, but a ${scope} offering projects onto announce_capabilities[], ` +
        `which requires a dotted (>=2-segment) capability id (e.g. 'work.chat', 'code-review.typescript'). ` +
        `Rename the capability to a dotted id, or offer it --scope local. ` +
        `(If single-segment federated offerings should be supported, that is a CO-1/announce-schema grammar mismatch to reconcile.)`,
    );
  }

  let accept: AcceptPolicy | undefined;
  if (scope === "federated") {
    const parsed = parseFederatedAccept(input.accept, input.network);
    if (!parsed.ok) errors.push(...parsed.errors);
    else accept = parsed.accept;
  } else if (scope === "public") {
    const parsed = parsePublicAccept(input.accept);
    if (!parsed.ok) errors.push(...parsed.errors);
    else accept = parsed.accept;
  } else if (input.accept !== undefined) {
    // local scope carries no accept (CO-1 coherence — it IS this stack).
    errors.push(
      `--accept is not valid for --scope local — 'local' is this stack, there is nobody-within-tier to gate`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  const candidate: Offering = {
    capability,
    scopes: [scope],
    ...(accept !== undefined ? { accept } : {}),
    // Carry the top-level network convenience field for a federated {kind:'network'}
    // accept so the projection (and a human reading the YAML) sees it on the entry.
    ...(scope === "federated" && accept?.kind === "network"
      ? { network: accept.network }
      : input.network !== undefined && scope === "federated"
        ? { network: input.network }
        : {}),
  };

  const validated = OfferingSchema.safeParse(candidate);
  if (!validated.success) {
    return { ok: false, errors: [validated.error.message] };
  }
  return { ok: true, offering: validated.data };
}

/** Parse a `--accept` value for a `federated` scope. */
function parseFederatedAccept(
  accept: string | undefined,
  network: string | undefined,
): { ok: true; accept: AcceptPolicy } | { ok: false; errors: string[] } {
  // `--network <id>` is sugar for `--accept network:<id>`.
  if (accept === undefined) {
    if (network !== undefined) {
      if (!LETTER_PREFIX_RE.test(network)) {
        return { ok: false, errors: [`--network "${network}" must be a network id (lowercase alphanumeric + hyphen, letter-prefixed)`] };
      }
      return { ok: true, accept: { kind: "network", network } };
    }
    return {
      ok: false,
      errors: [
        `--scope federated requires an accept-policy (default-deny): pass --network <id>, --accept network:<id>, or --accept principals:<a,b,c>`,
      ],
    };
  }
  const [kindRaw, rest] = splitOnce(accept, ":");
  if (kindRaw === "network") {
    if (!LETTER_PREFIX_RE.test(rest)) {
      return { ok: false, errors: [`--accept network:<id> — "${rest}" must be a network id`] };
    }
    return { ok: true, accept: { kind: "network", network: rest } };
  }
  if (kindRaw === "principals") {
    const principals = rest.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (principals.length === 0) {
      return { ok: false, errors: [`--accept principals:<a,b,c> must name at least one principal`] };
    }
    for (const p of principals) {
      if (!LETTER_PREFIX_RE.test(p)) {
        return { ok: false, errors: [`--accept principals — "${p}" must be a principal id`] };
      }
    }
    return { ok: true, accept: { kind: "principals", principals } };
  }
  return {
    ok: false,
    errors: [
      `--accept "${accept}" — federated accept must be 'network:<id>' or 'principals:<a,b,c>' (CONTEXT.md §Capability offering closed set)`,
    ],
  };
}

/** Parse a `--accept` value for a `public` scope (the two-stage gate, ADR-0010). */
function parsePublicAccept(
  accept: string | undefined,
): { ok: true; accept: AcceptPolicy } | { ok: false; errors: string[] } {
  if (accept === undefined) {
    return {
      ok: false,
      errors: [
        `--scope public requires --accept surface:<surface>/<predicate> (the two-stage metadata gate, ADR-0010)`,
      ],
    };
  }
  // Form: surface:<surface>/<predicate-kind>:<args>
  const [kindRaw, rest] = splitOnce(accept, ":");
  if (kindRaw !== "surface") {
    return {
      ok: false,
      errors: [`--accept for public must start with 'surface:' (e.g. surface:github/repo:the-metafactory/*)`],
    };
  }
  const [surface, predicateRaw] = splitOnce(rest, "/");
  if (surface.length === 0 || predicateRaw.length === 0) {
    return {
      ok: false,
      errors: [`--accept surface:<surface>/<predicate> — both surface and predicate are required (e.g. surface:github/repo:the-metafactory/*)`],
    };
  }
  const predParsed = parsePublicPredicate(predicateRaw);
  if (!predParsed.ok) return predParsed;
  return { ok: true, accept: { kind: "surface", surface, predicate: predParsed.predicate } };
}

/** Parse a public predicate string into a metadata-only `PublicPredicate`
 *  (ADR-0010 — content-dependent forms are NOT expressible; the closed set
 *  rejects anything outside repo/sender-allow/sender-block/rate). */
function parsePublicPredicate(
  raw: string,
): { ok: true; predicate: PublicPredicate } | { ok: false; errors: string[] } {
  const [kind, rest] = splitOnce(raw, ":");
  if (kind === "repo") {
    const repos = rest.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (repos.length === 0) return { ok: false, errors: [`repo predicate needs at least one repo glob (e.g. repo:the-metafactory/*)`] };
    return { ok: true, predicate: { kind: "repo-membership", repos } };
  }
  if (kind === "sender-allow" || kind === "sender-block") {
    const senders = rest.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (senders.length === 0) return { ok: false, errors: [`${kind} predicate needs at least one sender identity`] };
    return { ok: true, predicate: { kind, senders } };
  }
  if (kind === "rate") {
    // rate:<n>/<min|hour|day>
    const [nRaw, window] = splitOnce(rest, "/");
    const n = Number(nRaw);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, errors: [`rate predicate needs a positive integer (e.g. rate:60/min)`] };
    }
    if (window === "min" || window === "minute") return { ok: true, predicate: { kind: "rate", per_minute: n } };
    if (window === "hour") return { ok: true, predicate: { kind: "rate", per_hour: n } };
    if (window === "day") return { ok: true, predicate: { kind: "rate", per_day: n } };
    return { ok: false, errors: [`rate window must be min, hour, or day (e.g. rate:60/min)`] };
  }
  return {
    ok: false,
    errors: [
      `public predicate "${raw}" is not a metadata-only form — must be repo:<glob>, sender-allow:<id>, sender-block:<id>, or rate:<n>/<window> (ADR-0010: content-dependent predicates are forbidden)`,
    ],
  };
}

/** Split a string on the first occurrence of `sep`; the remainder keeps any
 *  further separators (so `surface:github/repo:x` splits to `surface` + the
 *  rest). Returns `[whole, ""]` when `sep` is absent. */
function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i === -1) return [s, ""];
  return [s.slice(0, i), s.slice(i + sep.length)];
}

// =============================================================================
// Target-layer resolution (mirrors config-merge.resolveTarget)
// =============================================================================

const LAYOUT_MARKER = join("system", "system.yaml");

export interface ResolvedTarget {
  /** Absolute path to the stack layer file the offer edit writes to. */
  filePath: string;
  /** The config dir to re-compose for whole-config validation. */
  configDir: string;
  /** Path to hand `composeRawConfig`. */
  composePath: string;
  /**
   * The `agents.d/` fragment directory to fold into the effective catalog when
   * validating (cortex#1071). Mirrors the daemon-boot convention
   * `join(dirname(configPath), "agents.d")` — for both config-split (configDir
   * is the dir) and single-file legacy (configDir is the file's dir) this is
   * `join(configDir, "agents.d")`. The directory need not exist;
   * `loadAgentsDirectory` returns `[]` for a missing dir.
   */
  agentsDir: string;
  /** True for the legacy single-file form (target IS the cortex.yaml). */
  singleFile: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function listStackFiles(stacksDir: string): string[] {
  if (!existsSync(stacksDir)) return [];
  return readdirSync(stacksDir)
    .filter((f) => !f.startsWith("."))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => join(stacksDir, f));
}

function readStackId(filePath: string): string | undefined {
  try {
    const parsed = YAML.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (isPlainObject(parsed) && isPlainObject(parsed.stack) && typeof parsed.stack.id === "string") {
      return parsed.stack.id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Resolve which stack file the offer edit targets from `--config` + optional
 * `--stack`. Mirrors `config-merge.resolveTarget`: single-file legacy → that
 * file; config-split dir → a `stacks/*.yaml` selected by `--stack` (declared
 * `stack.id` or file basename), else the only one, else error.
 */
export function resolveTarget(configPath: string, stackId: string | undefined): ResolvedTarget {
  const resolved = resolve(configPath);
  const stat = existsSync(resolved) ? statSync(resolved) : undefined;
  if (stat === undefined) {
    throw new Error(`--config path does not exist: ${resolved}`);
  }

  const configDir = stat.isDirectory() ? resolved : dirname(resolved);
  const markerPath = join(configDir, LAYOUT_MARKER);

  if (!existsSync(markerPath)) {
    if (stat.isDirectory()) {
      throw new Error(
        `--config ${resolved} is a directory with no ${LAYOUT_MARKER} marker — point --config at a single cortex.yaml, or at a config-split dir`,
      );
    }
    if (stackId !== undefined) {
      throw new Error(
        `--stack ${stackId} given but --config ${resolved} is a single-file (legacy) config with no stacks/ layer`,
      );
    }
    return {
      filePath: resolved,
      configDir,
      composePath: resolved,
      agentsDir: join(configDir, "agents.d"),
      singleFile: true,
    };
  }

  const stacksDir = join(configDir, "stacks");
  const stackFiles = listStackFiles(stacksDir);
  if (stackFiles.length === 0) {
    throw new Error(`config-split dir ${configDir} has no stacks/*.yaml layer to edit`);
  }

  const composePath = join(configDir, "offer-pointer.yaml");
  const agentsDir = join(configDir, "agents.d");

  if (stackId === undefined) {
    const [only] = stackFiles;
    if (stackFiles.length === 1 && only !== undefined) {
      return { filePath: only, configDir, composePath, agentsDir, singleFile: false };
    }
    const names = stackFiles.map((f) => f.replace(`${stacksDir}/`, "")).join(", ");
    throw new Error(
      `config-split dir ${configDir} has ${stackFiles.length} stack files (${names}); pass --stack <id> to pick one`,
    );
  }

  const wanted = stackId;
  const wantedTail = stackId.includes("/") ? stackId.slice(stackId.lastIndexOf("/") + 1) : stackId;
  for (const file of stackFiles) {
    const declaredId = readStackId(file);
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.ya?ml$/, "");
    if (declaredId === wanted || base === wanted || base === wantedTail) {
      return { filePath: file, configDir, composePath, agentsDir, singleFile: false };
    }
  }
  const names = stackFiles.map((f) => f.replace(`${stacksDir}/`, "")).join(", ");
  throw new Error(
    `--stack ${stackId} matched no stack file in ${stacksDir} (have: ${names}). Match a file's declared stack.id or its basename.`,
  );
}

// =============================================================================
// Layer edit + federation-config reconciliation (PURE over the parsed layer)
// =============================================================================

/**
 * Apply the new offerings array AND the regenerated federation-config
 * projections onto a parsed stack-layer object. PURE — `layer` not mutated.
 *
 * This is where the DD-CO-2 unify lands on the YAML: after the offerings edit,
 * we OVERWRITE each declared `policy.federated.networks[].announce_capabilities`
 * + `accept_subjects` with the projection computed from the offerings (the
 * generated shadow is authoritative — a capability removed from the offerings
 * is removed from the projection), and set `policy.public.announce_capabilities`
 * from the public-scoped offerings.
 *
 * Networks named by an offering but NOT declared in the roster are returned as
 * `danglingNetworks` warnings (the caller surfaces them; they don't block).
 */
export function reconcileLayer(
  layer: Record<string, unknown>,
  offerings: Offering[],
): { layer: Record<string, unknown>; dangling: string[] } {
  const out: Record<string, unknown> = structuredClone(layer);

  // Resolve the receiving stack's wire identity ({principal}.{stack}) for the
  // accept_subjects scope prefix. The PRINCIPAL segment MUST come from
  // `config.principal.id` — that is the value the runtime stamps onto the wire
  // (`MyelinRuntimeOptions.principal` → `federated.{principal}.{stack}.>`), and
  // it is exactly the source `CortexConfigSchema.superRefine` validates the
  // accept-list prefix against. We deliberately do NOT take the principal from
  // `deriveStackId().principal`: for the documented cross-principal override
  // (`principal.id: andreas` running `stack.id: jcfischer/sage-host`),
  // `deriveStackId().principal` is `jcfischer` while the runtime still subscribes
  // on `federated.andreas.…` — projecting `jcfischer` would generate accept_subjects
  // that never match the live subscription (and the schema would then reject the
  // write with an opaque error). The STACK segment is the `/{stack}` tail of
  // `stack.id` (what `deriveStackId().stack` also resolves), or `default` when no
  // `stack:` block is present.  (PR #967 review BLOCKER 1.)
  const wirePrincipal =
    isPlainObject(out.principal) && typeof out.principal.id === "string"
      ? out.principal.id
      : "default";
  const wireStack =
    isPlainObject(out.stack) && typeof out.stack.id === "string"
      ? deriveStackId({ stack: { id: out.stack.id } }).stack
      : "default";

  const policy: Record<string, unknown> = isPlainObject(out.policy)
    ? structuredClone(out.policy)
    : {};

  // Write the offerings array (omit entirely when empty → default-deny baseline,
  // byte-identical to no-offerings). An empty array is the same as absent for
  // the resolver, but we DELETE the key so a fully-revoked stack doesn't carry a
  // stranded `offerings: []`.
  if (offerings.length === 0) {
    delete policy.offerings;
  } else {
    policy.offerings = offerings.map((o) => structuredClone(o));
  }

  // Federation projection — regenerate announce_capabilities + MERGE the
  // capability-dispatch accept_subjects on each DECLARED network. We never create
  // networks here (that's `cortex network join`); we only project onto networks
  // the stack already declares. `announce_capabilities` is authoritative (the
  // offer writer is the only writer of the per-network announce list, so an
  // overwrite is correct); `accept_subjects` is SHARED with the presence-wiring
  // writer (`network join` / reconciler, #1087/#1105), so we MERGE rather than
  // overwrite — the offer writer owns only its own-identity `…tasks.{cap}.>`
  // dispatch rows and must preserve the presence path's OWN `.>` ∪ peer `.agent.>`
  // rows (cortex#1097). See `mergeOfferAcceptSubjects`.
  const federated = isPlainObject(policy.federated) ? structuredClone(policy.federated) : undefined;
  let dangling: string[];
  if (federated !== undefined && Array.isArray(federated.networks)) {

    const networks = federated.networks as Record<string, unknown>[];
    const networkIds = networks
      .map((n) => (typeof n.id === "string" ? n.id : undefined))
      .filter((id): id is string => id !== undefined);
    const projections = projectFederationConfig(
      offerings,
      networkIds,
      wirePrincipal,
      wireStack,
    );
    const byId = new Map(projections.map((p) => [p.networkId, p]));
    for (const network of networks) {
      const id = typeof network.id === "string" ? network.id : undefined;
      if (id === undefined) continue;
      const proj = byId.get(id);
      if (proj === undefined) continue;
      network.announce_capabilities = [...proj.announce_capabilities];
      const priorAccept = Array.isArray(network.accept_subjects)
        ? (network.accept_subjects as unknown[]).filter(
            (s): s is string => typeof s === "string",
          )
        : [];
      network.accept_subjects = mergeOfferAcceptSubjects(
        priorAccept,
        proj.accept_subjects,
        wirePrincipal,
        wireStack,
      );
    }
    federated.networks = networks;
    policy.federated = federated;
    dangling = danglingNetworks(offerings, networkIds);
  } else {
    // No federated block — any federated/public offering's projection has
    // nowhere to land; surface every named network as dangling.
    dangling = danglingNetworks(offerings, []);
  }

  // Public-announce projection.
  const publicCaps = projectPublicAnnounce(offerings);
  if (publicCaps.length > 0) {
    const pub: Record<string, unknown> = isPlainObject(policy.public)
      ? structuredClone(policy.public)
      : {};
    pub.announce_capabilities = publicCaps;
    policy.public = pub;
  } else if (isPlainObject(policy.public)) {
    // No public offerings left → clear the projected announce list (but keep the
    // block if the principal set enabled/allow_principals by hand).
    const pub = structuredClone(policy.public);
    delete pub.announce_capabilities;
    policy.public = pub;
  }

  out.policy = policy;
  return { layer: out, dangling };
}

/** Read a stack layer's current offerings (or [] when absent). */
function readLayerOfferings(layer: Record<string, unknown>): Offering[] {
  if (!isPlainObject(layer.policy)) return [];
  const raw = layer.policy.offerings;
  if (!Array.isArray(raw)) return [];
  // Best-effort parse; malformed entries surface at compose-validate time.
  const parsed: Offering[] = [];
  for (const entry of raw) {
    const r = OfferingSchema.safeParse(entry);
    if (r.success) parsed.push(r.data);
  }
  return parsed;
}

// =============================================================================
// Timestamped backup helper (mirrors config-merge / normalize-config)
// =============================================================================

function buildBackupPath(filePath: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "T",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  return `${filePath}.pre-offer-${stamp}.bak`;
}

// =============================================================================
// agents.d fold — make the offer-validation catalog match the daemon's (cortex#1071)
// =============================================================================

/**
 * Fold `agents.d/` bot-pack fragments into a raw (pre-schema) config object so
 * the offer-validation path resolves capabilities through the SAME effective
 * catalog the daemon trusts at boot (cortex#1071).
 *
 * The boot path (`src/cortex.ts`) merges `loadAgentsDirectory(agents.d)`
 * fragments into the live agent set (inline wins on id) and the dispatch
 * consumer trusts each merged agent's `runtime.capabilities[]` directly. But
 * `composeRawConfig` only folds `system/ → network/ → surfaces/ → stacks/` — it
 * NEVER reads `agents.d/`. So a capability provided ONLY by a bot-pack agent
 * (declared in `agents.d/<id>.yaml` `runtime.capabilities[]`, no top-level
 * `capabilities[]` entry) is invisible to `offer set/list`, and the composed
 * config fails `CortexConfigSchema` ("offers <cap>, but no matching entry in
 * the capabilities[] catalog") even though the daemon resolves it fine.
 *
 * This fold closes that gap WITHOUT touching the boot composer. It:
 *   1. merges the loaded fragment agents into `raw.agents[]` (inline wins on
 *      id — same rule as `src/cortex.ts` `mergedAgents`), so a synthesized
 *      `provided_by:[<fragment-id>]` reference resolves to a declared agent;
 *   2. derives the effective catalog via `deriveEffectiveCapabilityCatalog`
 *      (the SAME function `offer list` and bot-packs B-0 use) and writes it back
 *      to `raw.capabilities[]` — explicit entries pass through authoritative,
 *      and capabilities that exist ONLY via agent declaration synthesize an
 *      entry. Synthesized entries get a non-empty placeholder description so
 *      they satisfy `CapabilitySchema` (which the live derivation path skips
 *      because it runs AFTER parse).
 *
 * PURE-ish: returns a NEW object; `raw` is not mutated. Fragment-load failures
 * propagate as `FragmentLoadError` (the caller surfaces them) — a malformed
 * bot-pack should fail loudly here just as it does at boot.
 *
 * @param raw        the composed (or single-file-parsed) raw config object.
 * @param agentsDir  the `agents.d/` directory to fold (may not exist →
 *                   `loadAgentsDirectory` returns `[]`, raw passes through).
 */
function foldAgentsDirectoryCatalog(
  raw: Record<string, unknown>,
  agentsDir: string,
): Record<string, unknown> {
  const fragments = loadAgentsDirectory(agentsDir);
  if (fragments.length === 0) return raw;

  // Inline (composed) agents win on id — mirror src/cortex.ts mergedAgents.
  const rawInlineAgents = Array.isArray(raw.agents) ? (raw.agents as unknown[]) : [];
  const inlineIds = new Set(
    rawInlineAgents
      .map((a) => (isPlainObject(a) && typeof a.id === "string" ? a.id : undefined))
      .filter((id): id is string => id !== undefined),
  );
  const newFragments = fragments.filter((f) => !inlineIds.has(f.id));
  const mergedRawAgents: unknown[] = [...rawInlineAgents, ...newFragments];

  // Build the Agent-shaped view the derivation reads (`id` + `runtime.capabilities`).
  // Fragments are already-validated `Agent`s; inline raw agents may be only
  // partially shaped, so we project the two fields the derivation consults.
  const inlineAgentView: Agent[] = rawInlineAgents
    .filter(isPlainObject)
    .filter((a): a is Record<string, unknown> & { id: string } => typeof a.id === "string")
    .map((a) => {
      const runtime = isPlainObject(a.runtime) ? a.runtime : undefined;
      const caps = runtime && Array.isArray(runtime.capabilities)
        ? runtime.capabilities.filter((c): c is string => typeof c === "string")
        : [];
      return { id: a.id, runtime: { capabilities: caps } } as unknown as Agent;
    });
  const agentsForDerivation: Agent[] = [...inlineAgentView, ...newFragments];

  const explicit: Capability[] = Array.isArray(raw.capabilities)
    ? (raw.capabilities as Capability[])
    : [];
  const effective = deriveEffectiveCapabilityCatalog(explicit, agentsForDerivation);

  // Synthesized entries carry `description: ""` (the live path skips the schema,
  // so it never sees them). Our path validates BEFORE parse, and
  // `CapabilitySchema.description` requires non-empty, so fill a placeholder for
  // any entry the derivation synthesized (empty description ⇒ derived-only).
  const foldedCapabilities = effective.map((c) =>
    c.description === ""
      ? {
          ...c,
          description: `provided by bot-pack agent(s): ${c.provided_by.join(", ") || "(none)"}`,
        }
      : c,
  );

  return { ...raw, agents: mergedRawAgents, capabilities: foldedCapabilities };
}

/**
 * Compose the whole config from disk AND fold `agents.d/` into the effective
 * catalog (cortex#1071). The single entry point all offer validation/list
 * paths use so they share the daemon's view of provided capabilities.
 */
function composeRawConfigWithAgents(
  composePath: string,
  agentsDir: string,
): Record<string, unknown> {
  return foldAgentsDirectoryCatalog(composeRawConfig(composePath), agentsDir);
}

// =============================================================================
// Compose-whole validation (mirrors config-merge.validateComposed)
// =============================================================================

function validateComposed(
  target: ResolvedTarget,
  newLayerText: string,
  originalLayerText: string,
): { ok: true } | { ok: false; error: string } {
  if (target.singleFile) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(newLayerText);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Single-file legacy still folds agents.d (the convention dir alongside the
    // cortex.yaml) so a bot-pack capability is offerable in the monolith form too.
    let folded: Record<string, unknown>;
    try {
      folded = isPlainObject(parsed)
        ? foldAgentsDirectoryCatalog(parsed, target.agentsDir)
        : (parsed as Record<string, unknown>);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const res = CortexConfigSchema.safeParse(folded);
    return res.success ? { ok: true } : { ok: false, error: res.error.message };
  }

  let composed: Record<string, unknown>;
  try {
    writeFileSync(target.filePath, newLayerText, "utf-8");
    // Fold agents.d into the effective catalog (cortex#1071) so a bot-pack-
    // provided capability validates the same way the daemon resolves it.
    composed = composeRawConfigWithAgents(target.composePath, target.agentsDir);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    writeFileSync(target.filePath, originalLayerText, "utf-8");
  }
  const res = CortexConfigSchema.safeParse(composed);
  return res.success ? { ok: true } : { ok: false, error: res.error.message };
}

// =============================================================================
// REGISTRY-PUSH DEFERRAL — the flagged-not-half-done CO-3 boundary
// =============================================================================

/**
 * Surfaced on every federated/public `--apply`. CO-3 generates the LOCAL config
 * projections (announce_capabilities/accept_subjects) the daemon reads at boot;
 * pushing the offered subset to the network REGISTRY (`cortex provision-stack
 * register`) is a separate, network-touching, signed action — deferred (design
 * §7 third projection). See the file header REGISTRY PUSH section.
 */
const REGISTRY_PUSH_FOLLOWUP =
  "note: registry registration of the offered subset is NOT performed by `cortex offer` (CO-3) — " +
  "it is a separate signed action. Run `cortex provision-stack register <principal> …` to publish " +
  "the federated/public-offered capabilities to the network registry (tracked as a CO-3 follow-up / CO-4 concern).";

// =============================================================================
// Subcommand handlers
// =============================================================================

function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function ok(stdout: string): ExitResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function usageError(sub: string, reason: string, json: boolean): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, { subcommand: sub }))
    : `cortex offer ${sub}: ${reason}\n${topLevelHelp()}`;
  return { exitCode: 2, stdout: "", stderr };
}
function opError(sub: string, reason: string, json: boolean): ExitResult {
  const stderr = json
    ? renderJson(envelopeError(reason, { subcommand: sub }))
    : `cortex offer ${sub}: ${reason}\n`;
  return { exitCode: 1, stdout: "", stderr };
}

/** Resolve --config (preferred) or --config-dir; both name the stack's config
 *  dir or a single cortex.yaml. */
function resolveConfigPath(flags: FlagMap): string {
  const explicit =
    typeof flags["--config"] === "string"
      ? flags["--config"]
      : typeof flags["--config-dir"] === "string"
        ? flags["--config-dir"]
        : defaultConfigDir();
  return expandTildePath(explicit);
}

function resolveApply(
  flags: FlagMap,
): { ok: true; apply: boolean } | { ok: false; reason: string } {
  const apply = flags["--apply"] === true;
  const dry = flags["--dry-run"] === true;
  if (apply && dry) {
    return { ok: false, reason: "--apply and --dry-run are mutually exclusive" };
  }
  return { ok: true, apply };
}

/** Load + parse the target stack layer file. */
function loadTargetLayer(
  target: ResolvedTarget,
): { ok: true; text: string; layer: Record<string, unknown> } | { ok: false; error: string } {
  let text: string;
  try {
    text = readFileSync(target.filePath, "utf-8");
  } catch (err) {
    return { ok: false, error: `cannot read ${target.filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let layer: Record<string, unknown>;
  try {
    const parsed = YAML.parse(text) as unknown;
    layer = isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    return { ok: false, error: `invalid YAML in ${target.filePath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, text, layer };
}

/**
 * The shared write path for set + revoke: reconcile the layer (offerings +
 * projections), validate the composed whole, and (on apply) backup + write +
 * re-compose-validate with restore-on-failure. PURE-ish — only writes on apply.
 */
function commitEdit(
  sub: string,
  target: ResolvedTarget,
  originalText: string,
  layer: Record<string, unknown>,
  offerings: Offering[],
  note: OfferEditNote,
  apply: boolean,
  json: boolean,
): ExitResult {
  const { layer: reconciled, dangling } = reconcileLayer(layer, offerings);
  const newText = YAML.stringify(reconciled, { indent: 2, lineWidth: 0 });

  // Validate the composed whole BEFORE any write.
  const validation = validateComposed(target, newText, originalText);
  if (!validation.ok) {
    return opError(sub, `composed config failed CortexConfigSchema — NOT writing.\n  ${validation.error}`, json);
  }

  const reachesFederation = offerings.some((o) => o.scopes.some((s) => s === "federated" || s === "public"));

  // Build the human/JSON summary lines.
  const summaryLines: string[] = [];
  summaryLines.push(`${note.action}: ${note.capability}${note.scopes.length > 0 ? ` [${note.scopes.join(", ")}]` : ""}`);
  for (const d of dangling) {
    summaryLines.push(`  ⚠ offering names network "${d}" which is not in policy.federated.networks[] — run 'cortex network join ${d}' or fix the --network`);
  }

  // Idempotent no-op: nothing changed on disk.
  if (newText === originalText) {
    if (json) {
      return ok(renderJson(envelopeOk(
        [{ capability: note.capability, action: note.action, scopes: note.scopes.join(",") }],
        { changed: "false", applied: "false", dangling: dangling.join(",") },
      )));
    }
    return ok(`cortex offer ${sub}: ${note.capability} already in desired state — nothing to do\n${summaryLines.join("\n")}\n`);
  }

  // Dry-run (DEFAULT): print the plan, touch nothing.
  if (!apply) {
    if (json) {
      return ok(renderJson(envelopeOk(
        [{ capability: note.capability, action: note.action, scopes: note.scopes.join(",") }],
        { changed: "true", applied: "false", dangling: dangling.join(","), dry_run: "true" },
      )));
    }
    const lines = [
      `cortex offer ${sub}: dry-run (no disk mutation; pass --apply to write)`,
      "",
      ...summaryLines,
      "",
      "would update on " + target.filePath + ":",
      "  • policy.offerings[]",
      "  • policy.federated.networks[].{announce_capabilities,accept_subjects}  (generated from offerings — DD-CO-2)",
      ...(projectPublicAnnounce(offerings).length > 0 ? ["  • policy.public.announce_capabilities  (generated from public offerings)"] : []),
      "",
      ...(reachesFederation ? [REGISTRY_PUSH_FOLLOWUP, ""] : []),
      "Re-run with --apply to write.",
      "",
    ];
    return ok(lines.join("\n"));
  }

  // Apply: timestamped backup, write, re-compose-validate, restore on failure.
  const backupPath = buildBackupPath(target.filePath);
  try {
    writeFileSync(backupPath, originalText, "utf-8");
  } catch (err) {
    return opError(sub, `cannot write backup ${backupPath}: ${err instanceof Error ? err.message : String(err)}`, json);
  }
  try {
    writeFileSync(target.filePath, newText, "utf-8");
  } catch (err) {
    return opError(sub, `cannot write ${target.filePath}: ${err instanceof Error ? err.message : String(err)}`, json);
  }

  // Re-compose from disk + re-validate (belt-and-braces; catches a serialization
  // surprise the in-memory validation missed). Restore on failure.
  try {
    const recomposed = composeRawConfigWithAgents(target.composePath, target.agentsDir);
    const reval = CortexConfigSchema.safeParse(recomposed);
    if (!reval.success) {
      writeFileSync(target.filePath, originalText, "utf-8");
      return opError(sub, `post-write re-compose FAILED validation — restored original from backup.\n  ${reval.error.message}`, json);
    }
  } catch (err) {
    writeFileSync(target.filePath, originalText, "utf-8");
    return opError(sub, `post-write re-compose threw — restored original from backup.\n  ${err instanceof Error ? err.message : String(err)}`, json);
  }

  if (json) {
    return ok(renderJson(envelopeOk(
      [{ capability: note.capability, action: note.action, scopes: note.scopes.join(",") }],
      { changed: "true", applied: "true", dangling: dangling.join(","), backup: backupPath },
    )));
  }
  const lines = [
    `cortex offer ${sub}: applied`,
    "",
    ...summaryLines,
    "",
    `backup: ${backupPath}`,
    `wrote:  ${target.filePath}`,
    "  • policy.offerings[]",
    "  • policy.federated.networks[].{announce_capabilities,accept_subjects}  (generated — DD-CO-2)",
    ...(projectPublicAnnounce(offerings).length > 0 ? ["  • policy.public.announce_capabilities  (generated)"] : []),
    "",
    ...(reachesFederation ? [REGISTRY_PUSH_FOLLOWUP, ""] : []),
  ];
  return ok(lines.join("\n"));
}

/** set/widen — the bare-positional `offer <capability> --scope …` form. */
function runSet(
  capability: string,
  flags: FlagMap,
  json: boolean,
): ExitResult {
  const scopeRaw = typeof flags["--scope"] === "string" ? flags["--scope"] : undefined;
  if (scopeRaw === undefined) {
    return usageError("set", `--scope <local|federated|public> is required when offering a capability`, json);
  }
  if (scopeRaw !== "local" && scopeRaw !== "federated" && scopeRaw !== "public") {
    return usageError("set", `--scope must be one of local, federated, public (got "${scopeRaw}")`, json);
  }
  const scope: OfferScope = scopeRaw;

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("set", applyRes.reason, json);

  const built = buildOffering({
    capability,
    scope,
    accept: typeof flags["--accept"] === "string" ? flags["--accept"] : undefined,
    network: typeof flags["--network"] === "string" ? flags["--network"] : undefined,
  });
  if (!built.ok) return usageError("set", built.errors.join("; "), json);

  // Resolve the target + load current offerings.
  let target: ResolvedTarget;
  try {
    target = resolveTarget(resolveConfigPath(flags), typeof flags["--stack"] === "string" ? flags["--stack"] : undefined);
  } catch (err) {
    return opError("set", err instanceof Error ? err.message : String(err), json);
  }
  const loaded = loadTargetLayer(target);
  if (!loaded.ok) return opError("set", loaded.error, json);

  const current = readLayerOfferings(loaded.layer);
  const edit = applySet(current, built.offering);
  if (!edit.ok) return usageError("set", edit.errors.join("; "), json);

  return commitEdit("set", target, loaded.text, loaded.layer, edit.result.offerings, edit.result.note, applyRes.apply, json);
}

/** revoke — narrow back toward local. */
function runRevoke(
  capability: string,
  flags: FlagMap,
  json: boolean,
): ExitResult {
  if (!CAPABILITY_ID_RE.test(capability)) {
    return usageError("revoke", `capability "${capability}" must be a capability id`, json);
  }
  const scopeRaw = typeof flags["--scope"] === "string" ? flags["--scope"] : undefined;
  if (scopeRaw !== undefined && scopeRaw !== "local" && scopeRaw !== "federated" && scopeRaw !== "public") {
    return usageError("revoke", `--scope must be one of local, federated, public (got "${scopeRaw}")`, json);
  }
  const scope: OfferScope | undefined = scopeRaw;

  const applyRes = resolveApply(flags);
  if (!applyRes.ok) return usageError("revoke", applyRes.reason, json);

  let target: ResolvedTarget;
  try {
    target = resolveTarget(resolveConfigPath(flags), typeof flags["--stack"] === "string" ? flags["--stack"] : undefined);
  } catch (err) {
    return opError("revoke", err instanceof Error ? err.message : String(err), json);
  }
  const loaded = loadTargetLayer(target);
  if (!loaded.ok) return opError("revoke", loaded.error, json);

  const current = readLayerOfferings(loaded.layer);
  const edit = applyRevoke(current, capability, scope);
  if (!edit.ok) return usageError("revoke", edit.errors.join("; "), json);

  return commitEdit("revoke", target, loaded.text, loaded.layer, edit.result.offerings, edit.result.note, applyRes.apply, json);
}

/** A row in the `list` view — capability × resolved offering × providers. */
export interface OfferListRow {
  capability: string;
  scopes: OfferScope[];
  accept: string;
  provided_by: string[];
}

/**
 * Build the `list` rows from a parsed config: every capability in the stack's
 * top-level `capabilities[]` catalog × its resolved offering (CO-1
 * `resolveOffering` — default-deny `local`). PURE. The "what do I expose, to
 * whom" view.
 */
export function buildListRows(
  capabilities: { id: string; provided_by?: string[] }[],
  offerings: readonly Offering[] | undefined,
): OfferListRow[] {
  return capabilities
    .map((c) => {
      const resolved = resolveOffering(c.id, offerings);
      return {
        capability: c.id,
        scopes: resolved.scopes,
        accept: describeAccept(resolved.accept),
        provided_by: c.provided_by ?? [],
      };
    })
    .sort((a, b) => a.capability.localeCompare(b.capability));
}

/** One-line human description of an accept-policy. */
function describeAccept(accept: AcceptPolicy | undefined): string {
  if (accept === undefined) return "—";
  if (accept.kind === "network") return `network:${accept.network}`;
  if (accept.kind === "principals") return `principals:${accept.principals.join(",")}`;
  // surface
  const pred = accept.predicate;
  let predStr: string;
  switch (pred.kind) {
    case "repo-membership": predStr = `repo:${pred.repos.join(",")}`; break;
    case "sender-allow": predStr = `sender-allow:${pred.senders.join(",")}`; break;
    case "sender-block": predStr = `sender-block:${pred.senders.join(",")}`; break;
    case "rate": predStr = `rate:${[pred.per_minute && `${pred.per_minute}/min`, pred.per_hour && `${pred.per_hour}/hour`, pred.per_day && `${pred.per_day}/day`].filter(Boolean).join(",")}`; break;
  }
  return `surface:${accept.surface}/${predStr}`;
}

/** list — read-only "what do I expose, to whom". */
function runList(
  flags: FlagMap,
  json: boolean,
): ExitResult {
  let target: ResolvedTarget;
  try {
    target = resolveTarget(resolveConfigPath(flags), typeof flags["--stack"] === "string" ? flags["--stack"] : undefined);
  } catch (err) {
    return opError("list", err instanceof Error ? err.message : String(err), json);
  }
  // Compose the WHOLE config so capabilities[] (a top-level block, possibly in a
  // different layer) + offerings resolve together, AND fold `agents.d/` into the
  // effective catalog (cortex#1071) so bot-pack-provided capabilities — declared
  // ONLY in `agents.d/<id>.yaml` `runtime.capabilities[]` — surface in the list,
  // matching the catalog the daemon trusts at boot.
  let config: Record<string, unknown>;
  try {
    config = composeRawConfigWithAgents(
      target.composePath === target.filePath ? target.filePath : target.composePath,
      target.agentsDir,
    );
  } catch (err) {
    return opError("list", `cannot compose config: ${err instanceof Error ? err.message : String(err)}`, json);
  }
  const parsed = CortexConfigSchema.safeParse(config);
  if (!parsed.success) {
    return opError("list", `config failed CortexConfigSchema — cannot list offerings.\n  ${parsed.error.message}`, json);
  }
  const cfg = parsed.data;
  // `cfg.capabilities` is ALREADY the effective catalog — `composeRawConfigWithAgents`
  // folded `agents.d/` fragments into both `agents[]` and `capabilities[]` (via
  // `deriveEffectiveCapabilityCatalog`, cortex#1021 B-0 + cortex#1071) before the
  // parse above, so we read it directly rather than re-deriving.
  const rows = buildListRows(
    cfg.capabilities.map((c) => ({ id: c.id, provided_by: c.provided_by })),
    cfg.policy?.offerings,
  );

  if (json) {
    return ok(renderJson(envelopeOk(
      rows.map((r) => ({
        capability: r.capability,
        scopes: r.scopes.join(","),
        accept: r.accept,
        provided_by: r.provided_by.join(","),
      })),
      { count: rows.length.toString() },
    )));
  }

  if (rows.length === 0) {
    return ok(`cortex offer list: no capabilities declared on this stack\n`);
  }
  const lines = [`cortex offer list — what this stack exposes, to whom:`, ""];
  lines.push(`  CAPABILITY                       SCOPES                ACCEPT                  PROVIDED BY`);
  for (const r of rows) {
    lines.push(
      `  ${r.capability.padEnd(32)} ${r.scopes.join(",").padEnd(21)} ${r.accept.padEnd(23)} ${r.provided_by.join(",")}`,
    );
  }
  lines.push("");
  return ok(lines.join("\n"));
}

// =============================================================================
// Dispatcher
// =============================================================================

/**
 * The set-path is the bare-positional `offer <capability> …` form, which the
 * generic `parseSubcommandArgs` can't model as a named subcommand. We detect it
 * BEFORE the generic parse: if argv[0] is a capability id (not list/revoke/a
 * flag), route to a dedicated set parser. Otherwise the generic parser handles
 * list/revoke/help/unknown.
 */
const SET_FLAG_SPEC: Record<string, "value" | "bool"> = {
  "--scope": "value",
  "--accept": "value",
  "--network": "value",
  "--config": "value",
  "--config-dir": "value",
  "--stack": "value",
  "--apply": "bool",
  "--dry-run": "bool",
  "--json": "bool",
  "--help": "bool",
  "-h": "bool",
};

/** Hand-rolled parser for the set path. Returns the capability + flag map, or
 *  throws CliArgsError on a bad flag. */
function parseSetArgs(argv: string[]): { capability: string; flags: FlagMap } {
  const flags: FlagMap = {};
  const [capability, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const name = a.slice(0, eq);
        if (SET_FLAG_SPEC[name] !== "value") throw new CliArgsError("offer", `unknown or non-value flag: ${name}`);
        flags[name] = a.slice(eq + 1);
        continue;
      }
      const kind = SET_FLAG_SPEC[a];
      if (kind === undefined) throw new CliArgsError("offer", `unknown flag: ${a}`);
      if (kind === "value") {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith("-")) throw new CliArgsError("offer", `${a} requires a value argument`);
        flags[a] = next;
        i++;
      } else {
        flags[a] = true;
      }
    } else {
      throw new CliArgsError("offer", `unexpected extra positional argument: "${a}"`);
    }
  }
  return { capability: capability ?? "", flags };
}

export function dispatchOffer(argv: string[]): Promise<ExitResult> {
  // Help / no-args fast paths.
  if (argv.length === 0) {
    return Promise.resolve({ exitCode: 2, stdout: "", stderr: `cortex offer: no subcommand specified.\n${topLevelHelp()}` });
  }
  const first = argv[0] ?? "";
  if (first === "--help" || first === "-h") {
    return Promise.resolve({ exitCode: 0, stdout: topLevelHelp(), stderr: "" });
  }

  // The set path: argv[0] is a capability id (not a reserved subcommand, not a flag).
  if (first !== "list" && first !== "revoke" && !first.startsWith("-")) {
    let parsed;
    try {
      parsed = parseSetArgs(argv);
    } catch (err) {
      if (err instanceof CliArgsError) {
        return Promise.resolve({ exitCode: 2, stdout: "", stderr: `cortex offer: ${err.message}\n${topLevelHelp()}` });
      }
      throw err;
    }
    const json = parsed.flags["--json"] === true;
    if (parsed.flags["--help"] === true || parsed.flags["-h"] === true) {
      return Promise.resolve({ exitCode: 0, stdout: topLevelHelp(), stderr: "" });
    }
    return Promise.resolve(runSet(parsed.capability, parsed.flags, json));
  }

  // list / revoke / help / unknown via the generic parser.
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return Promise.resolve({ exitCode: 2, stdout: "", stderr: `cortex offer: ${err.message}\n${topLevelHelp()}` });
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;
  if (parsed.subcommand === "help" || parsed.help) {
    return Promise.resolve({ exitCode: 0, stdout: topLevelHelp(), stderr: "" });
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === ""
        ? "usage error — no subcommand specified."
        : `unknown subcommand "${parsed.rawSubcommand}".`;
    return Promise.resolve({ exitCode: 2, stdout: "", stderr: `cortex offer: ${msg}\n${topLevelHelp()}` });
  }

  switch (parsed.subcommand) {
    case "list":
      return Promise.resolve(runList(parsed.flags, json));
    case "revoke":
      return Promise.resolve(runRevoke(parsed.positionals.capability ?? "", parsed.flags, json));
  }
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex offer — set/list/revoke capability offerings (CO-3, #942)

The third control-plane leg (DD-CO-5):  cortex stack → cortex network → cortex offer.
An OFFERING is the provider side of the capability handshake: it elevates a held
capability into EXPOSED work — the triple (capability, offer-scope, accept-policy).
Default-deny: a capability not offered is local-only; widening is a deliberate act.

Usage:
  cortex offer <capability> --scope <local|federated|public> [--accept <policy>] [--network <id>] [--apply]
  cortex offer list [--config <dir>] [--stack <id>] [--json]
  cortex offer revoke <capability> [--scope <s>] [--apply]

Subcommands:
  <capability>   Set/WIDEN a capability's offering on this stack's stacks/<id>.yaml
                 policy.offerings[]. On --apply, REGENERATES the federation-config
                 projections (policy.federated.networks[].announce_capabilities /
                 accept_subjects) FROM the offerings — the offering is the source,
                 the federation config is generated (DD-CO-2, unify don't rebuild).
  list           The "what do I expose, to whom" view: every capability the stack's
                 agents hold × its resolved offer-scope + accept-policy + provider.
  revoke         Narrow a capability back toward local. Idempotent. --scope drops
                 just that scope; no --scope removes the whole offering.

Accept-policy (--accept), the CLOSED per-scope set (CONTEXT.md §Capability offering):
  federated:  network:<id>                 admit any peer on that network's roster
              principals:<a,b,c>           admit only those named principals
              (or the --network <id> shorthand for network:<id>)
  public:     surface:<surface>/<predicate>   the two-stage metadata gate (ADR-0010)
                predicate (metadata-only — content-dependent forms are forbidden):
                  repo:<glob>[,<glob>…]       admit surface-asserted repos
                  sender-allow:<id>[,…]       admit surface senders
                  sender-block:<id>[,…]       deny surface senders
                  rate:<n>/<min|hour|day>     deterministic rate ceiling

Safety:
  DRY-RUN by default — set/revoke print the offerings edit + the generated
  federation-config diff and touch NOTHING. Pass --apply to write (timestamped
  backup, validate-before-write, re-compose-and-validate-after). list is read-only.
  --apply and --dry-run are mutually exclusive.

Deferred (flagged, not half-done): registry registration of the offered subset
  (cortex provision-stack register) is a separate signed action — CO-3 generates
  the local config projections only.

Flags:
  --scope <s>        local | federated | public (required on set).
  --accept <policy>  the accept-policy (see above).
  --network <id>     federated shorthand for --accept network:<id>.
  --config <path>    stack config-split dir or single cortex.yaml (default: ~/.config/cortex).
  --config-dir <p>   alias for --config.
  --stack <id>       target stack id; required when >1 stacks/*.yaml exist.
  --apply            write (default: dry-run).
  --json             emit a { status, items, data, error } envelope.
  -h, --help         show this help.
`;
}

// =============================================================================
// Entry point
// =============================================================================

if (import.meta.main) {
  const result = await dispatchOffer(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
