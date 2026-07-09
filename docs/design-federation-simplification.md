# Design — Federation Simplification: presence-by-membership, derive-don't-configure, honest diagnostics

**Status:** Proposed · **Date:** 2026-07-10 · **Author:** Luna (with Andreas)
**Provenance:** the 2026-07-09/10 live two-principal debugging session (andreas ⇄ jc on `metafactory`) — the first real attempt to get mutual presence on the Network view. Two principals + three assistants, two days, **zero dots on the map**. This doc is the retrospective turned into design.
**Related:** #738 ("feel like TCP/IP"), #1812 (join reciprocal-import gap), #1808 (`cortex config validate`), ADR-0001 (federated subject grammar), ADR-0005 (interior privacy), ADR-0018 (operator-mode scoped creds), `compass/sops/federation-wire-protocol.md`.

## 1. Problem — the evidence

To see one admitted peer's presence dot, a principal currently traverses **seven concepts across four config surfaces owned by two operators**: registry admission → `peers[]` → acceptance offerings → hub-minted cred `allow-sub` → NSC account import → signing posture → ADR-0001 subject grammar.

What the live session actually hit:

| # | Incident | Root cause |
|---|---|---|
| 1 | `accept_subjects` edited to import a peer scope → **daemon crash-looped 49×** under launchd keepalive | The field's only *legal* value is the stack's own scope — i.e. it is fully derivable, yet it looks like a knob. **Three assistants independently misread it** as the peer-import mechanism. |
| 2 | Crash-loop instead of a pre-flight error | Config validation runs at boot only. #1808 added `cortex config validate`, but it is opt-in and memory-dependent. |
| 3 | "We joined, we pinged — what changed?" | Nothing. Ping publishes *to* the peer and receives on the sender's **own** reply scope; presence requires subscribing the **peer's** scope. Two permission paths for operations that feel identical; nothing surfaces the asymmetry. |
| 4 | Peer stuck `admitted-absent` forever; diagnosed only by daemon-log archaeology ("zero `federated.jc.*` envelopes ever") | `join`/`admit --and-seal` wires the joiner's **outbound** scope but never the **reciprocal import** of admitted peers (#1812). And the roster verdict can't distinguish *peer offline* from *I am deaf to the peer* — the system knew, and never said. |
| 5 | `doctor` reported **BROKEN** for a healthy leaf | `doctor` lacks the monitor-URL default `status` got in C-797 — the tool built to diagnose the join couldn't see the bus without `--monitor-url`. |
| 6 | `network status` shows `link.state: unknown` on a joined network | Same monitor plumbing gap. |
| 7 | Peer principal's MC was a blank screen | The legacy standalone Grove MC v2 entry (`src/surface/mc/index.ts`) still boots, squats the port, and is fed by nothing. |
| 8 | `Stop hook error: Permission denied` on a fresh signal install | Installer symlinks hook handlers without exec-bit/shebang — the chmod flavour of the same disease. |
| 9 | `not accepted` / `hub-authorize pending` / `authorship unchecked` badges | Raw trust-machine internals surfaced to the principal with no action attached. |

**The pattern:** wire-level mechanics leak all the way up to the principal, and *visibility* is bundled into the wrong trust layer.

## 2. Principles

1. **Visibility ≠ dispatch.** The two-layer trust model ("granted *and* chosen") is correct for *dispatch* — whom you'll do work for. Presence is aggregate, presence-level metadata (the only class ADR-0005 lets federate at all). Seeing a member of a network you both joined should not require a capability grant.
2. **Reciprocal by construction.** A join that leaves you deaf to your peers is not a join. Whatever `join`/`admit` wire outbound, they wire the inbound counterpart — for every admitted peer, on both sides, kept current as the roster changes.
3. **Derive, don't configure.** A config key with exactly one valid value is not configuration — it is a crash-loop waiting for an editor. Generate it.
4. **Honest verdicts.** When the system knows *why* (absent-because-offline vs absent-because-unheard; broken-because-X), it says why. A verdict without a reason is a guess delegated to the human.
5. **Fail loud early, fail soft late.** Validate at write time, every path that touches config. At boot, a broken config falls back to last-known-good — never a keepalive crash-loop.
6. **One entrypoint.** Legacy paths (standalone MC, un-executable handlers) either work or exit with a pointer to what replaced them. Never a blank screen.

## 3. Decisions

### D-1 — Presence-by-membership `[NEEDS PRINCIPAL RATIFICATION]`
Admission to a network ⇒ members see each other's presence (agent online/heartbeat/offline, stack-level aggregates) by default; acceptance offerings continue to gate **dispatch only**.
**Security analysis:** presence is already the *only* federated class under ADR-0005 (no session interiors ever cross). Membership is itself the trust gate — admission is hub-admin-signed, sealed, and revocable; a principal you would not show presence to is a principal you should not admit. The federated-presence subscriber's chain verification + source-binding (an accept-listed peer can only announce agents under its own verified `{principal}/{stack}`) is unchanged — this drops the *offerings* precondition for presence folding, not the crypto.
**Alternative (rejected as default):** per-peer `presence: allow` flag — recreates today's invisible-by-default trap; may return later as an opt-out (`presence: hidden`) for a member who wants to lurk.

### D-2 — Derive `accept_subjects`; audit single-value keys `[ADOPT — recommendation]`
Remove `accept_subjects` from user config (generate `federated.{principal}.{stack}.>` from the stack identity — the validator already pins it to exactly that). Loader accepts-and-warns on the legacy key for one release, then rejects. Audit `policy.federated.networks[]` for other keys with a single derivable value (e.g. `leaf_node` defaulting to the network id).

### D-3 — Last-known-good boot fallback `[ADOPT — recommendation]`
On config-validation failure at boot, the daemon logs the precise error, loads the last successfully-booted config snapshot (written on every good boot), and marks itself DEGRADED (surfaced in MC + `status`). Keepalive crash-loops become impossible for config errors. A `--strict` flag preserves fail-hard for CI/provisioning.

## 4. Track FS — slices

| Slice | What | Depends | Size |
|---|---|---|---|
| **FS-1** | **Presence-by-membership**: federated-presence subscriber folds any *admitted roster member's* signed/permissive presence (offerings gate removed from the presence path only; dispatch gating untouched). Roster UI renders acceptance as a dispatch-posture chip, not a visibility error. `[frontier-review]` trust path. | **D-1** | M |
| **FS-2** | **Join wires reciprocity** (#1812 as verbs): `join`/`admit --and-seal` add, for every admitted peer, the account import + scoped-cred `allow-sub federated.{peer}.{stack}.>`, both sides; `cortex network accept-peer <peer>` as the incremental/repair verb. Hub-half coordinated with the hub custodian. `[frontier-review]` | FS-1 (or D-1) | L |
| **FS-3** | **Reconciler self-heal**: the 60s registry reconciler detects roster⇄import drift (admitted peer whose scope is not subscribable) and repairs where it holds authority, else raises a named attention item ("peer X unhearable — hub reseal needed"). | FS-2 | M |
| **FS-4** | **Derive-don't-configure**: implement D-2 (generate `accept_subjects`, warn-then-reject legacy key, single-value-key audit). | D-2 | S |
| **FS-5** | **Doctor/status truth**: `doctor` gains `status`'s monitor-URL default (C-797 parity) + a per-peer **"can I hear X?"** leg (cred perms → import → envelopes-arriving → gate → fold, each pass/fail); `status` folds leafz so `link.state` is never `unknown` on a live bus. | — | M |
| **FS-6** | **Honest absence**: `/api/networks` member verdicts split `absent(offline)` vs `absent(unheard — import/cred gap)` using FS-5's hearing check + last-received-presence counters; roster UI + federated-peer node render the reason. | FS-5 | S |
| **FS-7** | **Validate-on-write + last-good boot**: every cortex verb that writes config runs #1808's validation before writing; implement D-3 fallback. | D-3 | M |
| **FS-8** | **Kill trapdoors**: standalone Grove MC entry exits with a pointer to the in-process MC; signal installer sets exec-bit/shebang on all symlinked handlers **or** registers hooks as `bun <path>` (no exec-bit needed) — cross-repo, signal. | — | S |

## 4.1 Lifecycle walkthrough — a new member arrives after you joined

The late joiner is the case that breaks join-time-only wiring; it is the FS-2/FS-3 division of labor:

1. **Admit time (hub authority, once):** `admit --and-seal <mia>` seals mia **and** updates every *existing* member's scoped leaf cred with `allow-sub federated.mia.{stack}.>`, then `nsc push`. The push-capable resolver delivers the new permissions live — no member restarts, no member action. (Symmetrically, mia's own join wires her cred + imports for the full existing roster.)
2. **Within one reconcile tick (~60s, member authority, self-healing):** each existing member's reconciler sees mia on the roster, detects "admitted peer with no import," and adds its **own** account import for `federated.mia.{stack}.>` — it can, because a member's account is under its own operator (ADR-0013 Model B). No human `nsc`.
3. **Under D-1:** the moment mia is hearable, her signed presence folds and she appears on the constellation — and the existing members on hers. Zero config edits by anyone.
4. **Degraded honestly:** if either half lags (old hub, missed push), FS-6 renders `mia — absent (unheard: cred/import gap)` and FS-3 raises a named attention item ("hub reseal needed") instead of a silent forever-absent.

The invariant: **cred half = hub authority, executed at admit, fanned to all members; import half = each member's own authority, reconciler-self-healed.** Membership changes propagate; humans never run `nsc`.

## 5. Waves

- **Wave 0 — truth & safety (no decisions needed):** FS-5, FS-6, FS-7, FS-8. Pure diagnosis/robustness; would have turned this session's two-day hunt into minutes.
- **Wave 1 — the model fix (needs D-1):** FS-1 presence-by-membership. `[frontier-review]` adversarial pass required (the one slice that changes a trust boundary).
- **Wave 2 — plumbing-by-construction:** FS-2 (two-party; hub custodian coordination), FS-3, FS-4. FS-2/FS-3 serialize (same join/reconciler files, trust path).

**HELD [principal-hands]:** D-1/D-2/D-3 ratification; the live hub reseal for the current andreas⇄jc gap (interim unblock per #1812's runbook — independent of, and superseded by, FS-2); anything touching the production hub/registry.

## 6. Non-goals

Changing the dispatch trust model (offerings/acceptance stay authoritative for work); weakening ADR-0005 (interiors never federate — presence-by-membership shares strictly what ADR-0005 already scopes); federated session/cost visibility (SES track); signal activation (OBS track).
