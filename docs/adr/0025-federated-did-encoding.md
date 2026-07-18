# ADR-0025 — Cortex adopts the RFC-0001 class-explicit `did:mf` encoding (the class-tag dot-form)

**Status:** **accepted** — hard cut affirmed by Andreas 2026-07-19 (decision owner + §9 ratifier); the history-discard consent that required JC's ADR co-sign is moot (no pre-cut federated history — the `jc↔andreas` leaf has carried `in=0 / out=0`), so JC's role relocates to the **runbook §10 two-party lockstep-cut coordination** (the cut is physically two-party regardless of history). · **Date:** 2026-07-19 · **Decision owner:** Andreas (principal/architect) · **Co-signer:** JC (hub custodian) · **Scope:** records the encoding decision for [cortex#1880](https://github.com/the-metafactory/cortex/issues/1880) (WP-4 of epic [#1876](https://github.com/the-metafactory/cortex/issues/1876)); it does **NOT** implement the encoding, migrate any mint site, touch the guard, or flip any test (those are the post-decision WP-4/WP-5/WP-6 build, blocked on this co-sign). · **Refs:** myelin RFC-0001 §4/§5/§6.2/§8.1/§9 (`specs/rfc/rfc-0001-identifiers.md`, Ratified single-principal 2026-07-13 under myelin ADR-0001), myelin [#286](https://github.com/the-metafactory/myelin/issues/286), `./wire` `src/wire/identity.ts` (`parseDid`/`renderDid`/`encodeDidSegment`), cortex `src/cortex.ts:1071` (stack-DID mint), `src/common/registry/identity-registry.ts:178` (`peerDid`), the trust-displacement guard `identity-registry.ts:330-343`, WP-2 target module `src/common/wire/identity.ts`, WP-3 injectivity `src/common/wire/__tests__/identity.property.test.ts:401`, `docs/runbook-flag-day-r.md` §1.6/§3/§7/§9.2/§9.3, compass `sops/federation-wire-protocol.md`.

**Vocabulary (`CONTEXT.md` / RFC-0001 §1.2 authoritative).** A **DID** is a `did:mf:` identifier for one identity. Its **class** is which of the six kinds it names — `principal`, `stack`, `agent`, `hub`, `surface`, `system`. The **encoding** is the byte-level rendering of an identity to a DID string. **Injective** means two distinct identities never render to the same DID. A **stamp** is a DID sitting inside signed envelope bytes (`signed_by` chains, the boot anchor). The **flag-day** (release R) is the coordinated cut at which emitters and verifiers flip together (`docs/runbook-flag-day-r.md`).

## Context

The deployed `did:mf:` encoding is **not injective across classes**, and a security property depends on that not being exploited. Three classes are minted independently as structurally-indistinguishable strings and compared with `===`:

- stack: `did:mf:${stack.id.replace("/","-")}` (`cortex.ts:1071`) → `did:mf:andreas-meta-factory`
- principal: `did:mf:${principalId}` (`peerDid`, `identity-registry.ts:178`) → `did:mf:andreas-meta-factory`

Slugs permit `-` (`hub-leaf-authorization.ts:48`, `/^[a-z][a-z0-9_-]*$/`), so `principalDid("andreas-meta-factory") === stackDid({principal:"andreas", stack:"meta-factory"})` — byte-identical, different classes. The materialised myelin registry is keyed by DID and `add()` is last-write-wins, so a peer whose id collides with the boot stack DID would **displace the out-of-band boot anchor in the very registry the verifier consumes**. Today that is stopped by a hand-written runtime `refuse` plus a prose paragraph (`identity-registry.ts:330-343`): a security-relevant invariant held by **vigilance**, which is exactly what epic #1876 exists to eliminate. The same guard is why WP-6 (#1882) cannot simply relabel a resolved peer's DID, and why WP-2's `parseDid` deliberately returns `ambiguous` (its `TODO(WP-4)` waits on this decision).

The runbook records this as a **blocking, principal-owned decision** (`docs/runbook-flag-day-r.md` §1.6): release R's DID-flip steps (§3) are gated on the encoding being recorded, owners Andreas + JC. This ADR is that record.

## Decision

**Cortex adopts the RFC-0001 §6.2 class-explicit dot-form as the sole `did:mf` grammar** — issue option **(C)**. Every identity renders as `did:mf:{class}.{segments…}` in tag-arity order, `.`-separated:

```
principal  did:mf:principal.{p}
stack      did:mf:stack.{p}.{s}
agent      did:mf:agent.{p}.{s}.{a}
hub        did:mf:hub.{network}
surface    did:mf:surface.{name}
system     did:mf:system.{name}
```

The class tag sits at position 0, drawn from the closed §7 registry, validated fail-closed (an unregistered tag is a reject, never a pass-through); arity is bound to the tag; `.` is the sole separator and is forbidden inside every segment. This makes the encoding **injective by construction** — the tag disambiguates the class and the arity-bound dot-form disambiguates the structure, so no cross-class collision is *constructible*. The whole trust-displacement surface at `identity-registry.ts:330-343` is closed at the wire, not merely watched at runtime.

This is not a new fork. The metafactory ecosystem has **already ratified this exact form**: RFC-0001 §6.2 records `[RESOLVED — 2026-07-12 — cortex#1880 → Candidate C]`, Ratified single-principal 2026-07-13 under myelin ADR-0001, and `./wire`'s `parseDid`/`renderDid`/`encodeDidSegment` (`src/wire/identity.ts`) already **implement** it as the total, class-explicit, vector-bound codec. Cortex aligning to it is **coherence with a ratified pack**, and WP-2/WP-4 consume the `./wire` codec rather than hand-rolling a second one. The injectivity property carries its RFC-0001 §5 precondition: dot-separation is necessary but not sufficient — it is the **kebab-strict** segment rule (no segment edge is `-`) that guarantees a `-` is never adjacent to a `.`, so the subject-segment `--`→`.` decode is total. Do not cite the bare "`.` → injective" claim; that is the false claim the RFC draft caught.

## Alternatives considered

- **(A) Forbid `-` in principal ids and stack slugs.** Smallest code change; makes `{p}-{s}` unambiguous. **Rejected — breaks a live stack:** `andreas/meta-factory` is deployed and its slug contains `-`; hyphenated names share the namespace and cannot be legislated away after the fact. RFC-0001 §6.2 records Candidate A as *shown insufficient before the decision*.
- **(B) Swap the separator for one outside the slug alphabet** (`did:mf:{p}:{s}`, `%2F`, …). Unambiguous by construction. **Rejected — subsumed by C:** `.` already *is* a separator illegal in every base alphabet without introducing a new character, and B still leaves the class implicit (a `stack` and a two-segment reading of some other class could still coincide in intent). C gives B's disambiguation *plus* an explicit class tag for the same stamp cost.
- **(D) Keep the encoding + the guard, add WP-2 branded types.** Cheapest; branded types stop cross-class `===` *in code*. **Rejected — leaves the security property on vigilance:** branded types are a compile-time discipline over cortex's own call sites; they do nothing for a DID arriving over the wire from a peer, so the *runtime* trust-displacement guard remains the only real defence and `parseDid` stays permanently ambiguous. RFC-0001 §6.2 rejected D as "an invariant held by vigilance, not design" — the exact thing epic #1876 is retiring.

**Why C wins:** it is the already-ratified ecosystem form (coherence, not divergence), and it kills the entire `===`-between-classes bug class **at the wire**, demoting the runtime guard to a provably-unreachable assertion instead of a live defence. Its cost — the largest stamp change of the four — is paid once at the flag-day and is exactly the cost the RFC pack already accepted.

## Compatibility — the hard part, RESOLVED to the hard cut

**The migration is destructive by design (RFC-0001 §9.2).** A DID sits inside the signed bytes of every envelope, so a pre-cut stamp **cannot be rewritten** — rewriting the DID would break the signature it sits under. Pre-cut signed envelopes stop verifying at the cut and pre-cut signed history is **discarded, not migrated**. This consequence is accepted *with* the decision, not discovered after it. The affected surfaces cortex must account for at the cut:

- **In-flight / at-rest stamps** — JetStream signed history embeds old-form DIDs in signed bytes: discarded (RFC-0001 §9.3(1); runbook §7).
- **`signed_by` chains** — any chain verified against an old-form DID breaks at the boundary; not re-derivable without re-signing.
- **The boot anchor** — the out-of-band `bootDid` re-mints in class-explicit form; the §9.1(6) mapping fixes the only carried-over names (`did:mf:reflex`→`system.reflex`, `did:mf:signal-tap`→`system.signal-tap`, `did:mf:public`→`principal.public`).
- **JC's stack** — as a cross-principal peer, JC's stack DID re-mints and re-registers (RFC-0001 §6.3 register-once) in the same coordinated release; this is why the decision is JC's to co-sign, not Andreas's alone.

**OQ-1 was a document conflict, not an open design choice — and it is now resolved to the hard cut.** The tension was between two artifacts written at different times:

- **cortex#1880's acceptance criteria** (authored 2026-07-11) required, *if the encoding changed*, a **dual-accept window**: "old-form stamps still verify for one release." Compass `sops/federation-wire-protocol.md` sets the same dual-accept default.
- **RFC-0001 §9** (decision Andreas 2026-07-12; Ratified single-principal 2026-07-13) mandates a **HARD CUT**: "NO dual-registration, NO staged emitter window, NO ongoing legacy verifier tolerance," explicitly superseding the compass dual-accept default (§8.9). The runbook §3 (atomic cut) and §7/§9.3 (scoped `[principal-hands]` purge) are written to the hard cut.

#1880 **predates** the §9 decision by one day; its dual-accept criterion is therefore stale, and per the ecosystem rule (when an issue and the ratified spec disagree, the spec wins) the RFC governs.

> **OQ-1 — RESOLVED to the HARD CUT (Andreas, 2026-07-19).** cortex honours RFC-0001 §9's hard cut: no dual-accept window, emitter+verifier flip atomically at release R, pre-cut signed history discarded per §9.3. **Rationale:** the two concerns that would have made this JC's to co-sign are both discharged — (a) the history-discard cost is **nil**: the `jc↔andreas` federated leaf has never carried traffic (`in=0 / out=0`), so there is no pre-cut federated signed history to lose, and cutting now — while empty — is strictly cheaper than cutting after months of signed traffic; (b) the encoding itself was already decided by the RFC-0001 §9 ratification Andreas owns. **Consequence:** cortex#1880's dual-accept acceptance criterion + its verification bullet are **superseded and struck** on the issue; the WP-4 build carries **no** dual-accept window — the cut is the runbook's atomic flip (§3) + scoped purge (§7).

**JC's role (unchanged in substance, relocated in venue).** The cut is *physically* two-party: emitters and verifiers must flip together on **both** stacks, or an old-form emitter on one side fails against the new-form verifier on the other. That lockstep coordination is the **runbook §10 two-party fire**, where it always lived — not an ADR history-consent gate (which is moot). This ADR records the architectural decision (Andreas's to make); the runbook §10 sign-off records the two-party execution.

**Reconciliation with the runbook.** This ADR is the record runbook §1.6 gates on; §1.6's "DECISION PENDING" marker now cites ADR-0025 (hard cut), and §3/§7 proceed under it.

## Consequences (post co-sign; these are WP-4/5/6 build, not this ADR)

- **WP-2 `parseDid` becomes total.** The `TODO(WP-4)`/`ambiguous` return is removed; the WP-2 module (`src/common/wire/identity.ts`) classifies every valid DID by its class tag, consuming the `./wire` codec shape.
- **WP-6 (#1882) unblocks.** With classes explicit, the resolved-peer DID can be relabelled to its true class without risking the boot-anchor collision the guard exists to prevent.
- **The guard demotes.** `identity-registry.ts:330-343` becomes a provably-unreachable assertion (a `throw new Error("unreachable: DID collision")` citing this ADR) or is deleted with an ADR-0025 citation — under the class-explicit encoding a cross-class collision is not constructible.
- **WP-3's injectivity property flips live.** `src/common/wire/__tests__/identity.property.test.ts:401` (`test.todo`) becomes a passing assertion: `principalDid(p2) !== stackDid({p,s})` for all inputs including `p2 = "andreas-meta-factory"`. It must pass by construction, never by weakening.
- **Stamp size grows.** The class tag + dotted arity lengthens every DID (agent DIDs carry the full `{principal, stack, assistant}` triple); RFC-0001 §6.2 caps the msi at 255 octets and §10 notes the added class-tag disclosure. RFC-0002's short-form is the federated-subject length answer; out of scope here.

## Explicitly out of scope

Implementing the encoding in `src/common/wire/identity.ts`; migrating the mint sites `cortex.ts:1071` / `identity-registry.ts:178` (WP-5); fixing the resolved-peer DID class (WP-6); deleting/demoting the guard; flipping the WP-3 `test.todo`. All are the post-decision build, blocked on this co-sign, and partly executed only at the flag-day (§9.3).

## Sign-off

This ADR records an **architectural decision Andreas owns** (he is the decision owner and the §9 ratifier). The history-discard consent that would have required JC's co-sign is moot (no federated history — §Compatibility OQ-1). JC's involvement is the **runbook §10 two-party lockstep cut** at execution, not an ADR gate.

| Role | Principal | Signed (name + date) |
|---|---|---|
| Decision owner | Andreas | **Andreas, 2026-07-19 — hard cut affirmed** |
| Lockstep-cut coordination (execution) | JC | at runbook §10 fire (two-party) — not an ADR gate |

**OQ-1 resolved:** hard cut (§Compatibility). No dual-accept window; #1880's stale dual-accept criterion superseded and struck.
