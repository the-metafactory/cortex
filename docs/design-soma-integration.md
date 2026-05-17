# Soma Integration — Assistant-Body Protocol for Substrate-Independent Agents

**Refs:** cortex#110 (Internet of Agentic Work META) · [`the-metafactory/soma`](https://github.com/the-metafactory/soma) (CONTEXT.md + `docs/substrate-adapters.md` + `docs/architecture.md`)
**Status:** Design draft. No implementation in this PR — synthesis grounded in shipped code on both sides.
**Driver:** Andreas
**Scope:** Single design view of how Soma (the portable assistant-body protocol) composes with cortex/myelin (the bus + agent-surface stack), and where Soma adoption sequences in the IAW phase ladder.

---

## TL;DR

The Internet of Agentic Work pipeline (cortex#110, Phases A→E) has been incrementally building **substrate independence at the runtime layer**:

- **SessionHarness** (Phase A) — cortex can dispatch into any LLM substrate via a common interface.
- **NKey chain-of-stamps** (Phase B) — agents have substrate-independent cryptographic identity.
- **PolicyEngine** (Phase C) — authorization lifted out of substrate-coupled adapters into a single M6 decision point.
- **Federation** (Phases D/E) — stacks compose across operators regardless of what substrate any individual agent runs on.

Nothing in IAW makes the **assistant body** substrate-independent. Luna's persona, voice, telos, skills, memory, and learnings live in cortex-specific `agents.d/*.md` frontmatter + persona body, projected by hand into whichever substrate adapter happens to host her. ClaudeCodeHarness re-invents the projection one way; sage's pi.dev shim re-invents it another way; alpha's `.cursor/rules/persona.mdc` workdir shim re-invents it a third way. **Three substrate adapters, three hand-rolled projection shims, no common contract.**

[Soma](https://github.com/the-metafactory/soma) is the missing dual. Cortex/Myelin gives substrate-independent **dispatch + identity + policy at the bus layer**. Soma gives a substrate-independent **assistant body** that *projects into* whichever substrate is hosting a given session. They aren't competing. They're orthogonal axes of the same independence claim, and they compose cleanly through one new join key on `policy.principals[]`.

The unit of federation isn't the agent, isn't the stack, isn't even the network — it's **the (Soma-assistant, NKey-stack) tuple addressable across operators**.

---

## §1 — Why Soma is not an M-layer

The instinct is to ask "is Soma M6.5? M7-sibling? a new M8?" That's the wrong question. The M1–M7 stack is the **bus/transport/composition** spine. Soma is a **cross-cutting concern** that applies wherever an assistant is instantiated, regardless of substrate.

Re-read Soma's `CONTEXT.md` glossary on `substrate` and `daemon mode` together:

> **substrate:** The host runtime that Soma projects into. Examples: Claude Code, OpenAI Codex, Pi.dev, **Cortex/Myelin**.

> **daemon:** Soma runs as a long-lived process subscribing to **Myelin subjects**. No substrate involved.

Cortex/Myelin is listed as a *substrate* AND Soma's daemon mode subscribes to *Myelin subjects directly without substrate*. That isn't a contradiction — it means **Myelin is the bus** (where Soma daemons live as M7-equivalent application processes) and **Cortex is one possible M7 substrate atop Myelin** (where Soma projects into agent surfaces). Soma sits **across** layers, not at any one of them:

```
                Soma assistant body
                (Identity, Telos, ISA, Skills, Memory, Policy)
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
 projects into          projects into          projects into
 Claude Code            Cursor                 Codex
 (CLAUDE.md +           (.cursor/rules/        (AGENTS.md)
 agents.d fragments)    persona.mdc)
        │                       │                       │
        └───────────────────────┼───────────────────────┘
                                │
                                ▼
                  OR runs as Soma daemon
                  subscribing directly to
                  Myelin subjects (no substrate)
                                │
                                ▼
              ┌──────────────────────────────────┐
              │  M2–M6: NATS + envelope +        │
              │  chain-of-stamps + PolicyEngine  │
              │  (Myelin + cortex, substrate-    │
              │   neutral)                       │
              └──────────────────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
         Cortex (M7 agent surface +          Pilot / signal / future
         PolicyEngine + federation)          M7 surfaces — all consume
                                             Myelin, all can host Soma
```

The placement: **Soma is the assistant-body protocol that any M7 surface (or daemon mode directly on M2) can host.** Cortex is one such host. The Myelin bus carries traffic between Soma instances regardless of which substrate each one is projected into.

This matches Soma's own [`docs/substrate-adapters.md`](https://github.com/the-metafactory/soma/blob/main/docs/substrate-adapters.md), which already names two Cortex/Myelin integration shapes: (1) **in-process assistant profile** (cortex consults Soma context when spawning a substrate session) and (2) **standalone daemon** (Soma subscribes to Myelin subjects, claims tasks, updates its own memory). This design extends both shapes into a coherent protocol surface.

---

## §2 — The concrete reinvention Soma absorbs

These are not future hypotheticals — they're shipped or in-design cortex code that hand-rolls what Soma's adapter contract would mechanically own:

| Cortex code | What it does | What Soma would do |
|---|---|---|
| `src/runner/cc-session.ts` (ClaudeCodeHarness) | Spawns `claude --print` with `CLAUDE.md` + `agents.d/*.md` fragments already on disk | Soma's `home` mode already projects into `~/.claude/`. ClaudeCodeHarness becomes a pure *substrate harness* (dispatch transport); projection is Soma's job, not the harness's. |
| `the-metafactory/alpha` `src/cursor/workdir.ts` (per `docs/design-cursor-substrate-bot.md` §4) | Per-dispatch: `mkdtemp` workdir, shallow clone PR, **strip YAML frontmatter from `alpha.md` and write to `.cursor/rules/persona.mdc`**, stage PR.md + diff.patch | Soma's `workspace` mode + Cursor adapter projects the persona once at install; the workdir shim only needs to clone the PR + invoke `cursor-agent`. The frontmatter-stripping is Soma adapter logic, not per-dispatch shim logic. |
| `the-metafactory/sage` (pi.dev agent) | Sage's persona-staging into pi.dev's instruction surface (mirror of the alpha pattern, also reimplemented) | Soma's Pi.dev adapter (`buildPiDevContext` + `buildPiDevHomeContext` already exist on the Soma side) |
| `src/common/types/cortex-config.ts:253` `substrate: z.enum([...])` | Substrate enum gates which harness runs | Same enum value; Soma reuses the substrate identifier as the projection target |
| `agents.d/*.md` fragment with frontmatter (`id`, `did`, `runtime`, `roles`, `trust`, `capabilities`) + persona body | Mixes infrastructure config (runtime, trust, bus identity) with assistant body (persona, capabilities) | Frontmatter stays in cortex.yaml / arc-rendered fragment; persona body, capability declarations, and skill library move to Soma. The fragment becomes a thin pointer (`body: soma://<assistant-id>`). |

The cursor-design example is the load-bearing one. §4 of `docs/design-cursor-substrate-bot.md` walks through the persona-staging shim — strips YAML frontmatter (because `.mdc` doesn't parse it), writes to `.cursor/rules/persona.mdc`, cleans up the workdir after dispatch. **That is, verbatim, a Soma `projection` performed by a `workspace`-mode adapter, with frontmatter-stripping inlined into the host code rather than the adapter.** The cursor design even names the structural gap ("the single structural gap is the missing `--system-prompt` flag, which forces a per-dispatch workdir-staging step") without observing that the gap is already filled in Soma's adapter contract — it's just not yet wired in.

When alpha ships and the metafactory then adds (say) a Codex agent and then a Gemini agent, the projection logic gets reinvented 2–3 more times. That's exactly the failure mode Soma was built to prevent — and the failure mode IAW's substrate harness work alone does NOT prevent (the harness abstracts *dispatch*, not *persona*).

---

## §3 — Reconciling the two identities

This is the subtle one. Cortex's IAW Phase B introduces a 3-tier NKey identity chain: operator-account NKey → stack NKey → agent NKey. Every envelope is signed; `signed_by[]` is the chain-of-stamps. Soma has its own **Identity layer** — "the one Soma layer that stores who the principal is and who the assistant is: profile facts, communication preferences, personality metadata, and optional voice metadata" (Soma `CONTEXT.md`).

These are not in conflict — they're complementary along **different axes**:

- **NKey identity** (cortex / Myelin) — *"I am cryptographically agent X on stack Y of operator Z, and here's the signature to prove it."* Bus-level. Lives in `policy.principals[]` (post-Phase-C) and in the chain-of-stamps. Answers: *who signed this envelope?*
- **Soma Identity** (Soma) — *"I am Luna; this is my voice, my profile, my preferences, my history."* Body-level. Lives in `~/.soma/profile/`. Answers: *who is the assistant?*

The join key is the principal record. Phase C's `policy.principals[]` schema (`{ id, home_operator, home_stack, role[], trust[] }`) gains one field: `body: soma://<assistant-id>`. Now the principal table is the cross-layer pivot:

```
chain-of-stamps signed_by[].principal
                    │
                    ▼
cortex.yaml policy.principals[<id>]
   ├── home_operator      (bus identity)
   ├── home_stack         (bus identity)
   ├── nkey_pub           (bus identity)
   ├── role[]             (cortex policy)
   └── body: soma://...   (→ Soma assistant body)
```

This is what makes "Andreas's Luna calls jcfischer's sage" coherent across operator boundaries: both Luna and sage are Soma assistants; their identities resolve through the Phase D cloud network registry; the chain-of-stamps proves *which Soma assistant on which stack* signed which step.

The `did:mf:<name>` convention already used in cortex agent fragments (`did: did:mf:luna`, `did: did:mf:alpha`) is the natural URL-shape for the Soma reference; `body: soma://andreas/luna` is one strawman, `body: did:mf:luna` reusing the existing DID grammar is another. Picked in §9 open questions.

---

## §4 — Reconciling the two policies

The other word-collision worth surfacing: both stacks have a "Policy" concept and they decide different things.

|  | Decides | When |
|---|---|---|
| Cortex `PolicyEngine` (`src/common/policy/`) | "Is this principal allowed to invoke this capability?" | At dispatch-handler, on inbound envelope |
| Soma `Policy` / writeback gate (`docs/writeback-and-policy.md`) | "Is this substrate allowed to mutate Soma source?" | At adapter, on session-end writeback |

They compose cleanly: **Cortex's PolicyEngine gates *dispatch in*; Soma's writeback gate gates *body mutation out*.** A session begins when cortex dispatches a Principal+Intent to a substrate (PolicyEngine gates this). The session runs. During the session, the assistant might learn things, update ISA, capture memory. When the substrate session ends, the Soma adapter writes those changes back (writeback gate decides what's allowed to land in Soma source — per-substrate trust policies, per-private-root protection, the `private`/`protected`/`generated` data adjectives Soma already locks in `CONTEXT.md`).

No naming conflict needs resolving in code; both can keep their names because they live in different repos and decide different things. The reconciliation is documentary: every place that says "Policy" in cortex docs should disambiguate as either *dispatch policy* (PolicyEngine) or *writeback policy* (Soma adapter). Same convention on the Soma side.

---

## §5 — Where it sequences in the IAW pipeline

The IAW plan (`docs/plan-internet-of-agentic-work.md`) has one and only one operator-facing schema flip — Phase C. The constraint is sharp: **cortex.yaml flips ONCE**. If Soma adoption requires reshaping `agents[]` fragments (lifting persona body out, leaving substrate pointer in), that should ride with the Phase C flip or it forces a second flip.

Current Phase C status (`plan-internet-of-agentic-work.md` §4):

- **C.1** PolicyEngine module — done (cortex#218)
- **C.2a** Top-level `policy:` block added (additive) — done (cortex#219)
- **C.2b/c** Breaking removal of per-adapter `roles[]` + `migrate-config` extension — **in flight, ratified design** ([PR #291](https://github.com/the-metafactory/cortex/pull/291), iteration plan in [`docs/iteration-policy-cutover.md`](./iteration-policy-cutover.md))
- **C.3 / C.4** Substrate-harness integration + audit envelopes — done

The natural Soma insertion point is **Phase C.5 (new) or Phase D.0**, sequenced AFTER C.2b/c lands (don't pile on the policy cutover mid-execution) but BEFORE Phase D's federation locks in a non-Soma assistant-body model:

```
Phase C (in flight) ─── schema flip #1: policy: { principals[], roles[] }
        │
Phase C.5 (NEW)    ─── (option A) absorbed into the SAME flip:
        │              agents[].persona/capabilities → soma://<assistant-id>
        │              policy.principals[].body: soma://<assistant-id>
        │              SomaCortexAdapter exists; migrate-config lifts persona too
        │
Phase D            ─── federation: principals resolve to Soma assistants
        │              across operators; network-registry returns Soma metadata
        │
Phase E            ─── orchestrator pattern: one assistant IS a Soma; can be
                       projected into N substrates concurrently for substrate
                       diversity; daemon mode adds bus-direct presence
```

The strategic call worth making explicitly: **fold the Soma factor-out into the Phase C breaking change** so cortex.yaml flips once for both `policy:` AND for `body: soma://`. Operators run `migrate-config` once. Otherwise the metafactory pays a second v3.0.0 churn cycle later doing the Soma migration on its own. The cost of folding is design + adapter work in the Phase C window; the cost of deferring is operator-facing migration churn.

If C.2b/c timing doesn't allow it (the cutover is mid-execution and shouldn't grow), then the explicit acceptance is: **v2 for policy now, v3 for Soma later**. That's a coherent choice — but call it.

---

## §6 — Federation profundity — assistants as the unit of address

This is where it gets actually profound. Phase E's delegation pattern (§3.6 of `docs/design-internet-of-agentic-work.md`):

> "Your main digital assistant that will then delegate around and coordinate on your behalf by leaning into these different networks and stacks depending on their capability."

For this to work, "your main digital assistant" must exist **independently of any one substrate**. Today Luna is `agents.d/luna.md` projected into Claude Code via ClaudeCodeHarness. She's substrate-coupled at the body level. For Phase E delegation to mean what the operator-vision script says it means, Luna has to be addressable across:

- her Claude Code presence (where Andreas DMs her),
- her Codex presence (where she might run a coding task),
- her Cursor presence (where she might do whole-repo analysis),
- her Soma daemon presence (where she subscribes directly to Myelin subjects and orchestrates without any substrate session in the way),

…all at once, all with the **same identity, memory, telos, and skills**. That's only coherent if Luna is a Soma. The cortex-side identity (NKey on stack `andreas/main`) is shared across all four presences; the Soma-side body is shared across all four presences; what differs is the *substrate-native projection* in each case.

Now consider the federation case. Andreas's Luna delegates a TypeScript review to jcfischer's network. The capability registry (Phase D `D.4` cloud-side network registry, `network.meta-factory.ai`) returns: "operator jcfischer has assistant `did:mf:sage` with capability `code-review.typescript`." How does Andreas's Luna know what sage *is*? Two options:

- **(b) Opaque-principal model.** sage is just a principal — a public key, a capability tag, an SLA. Andreas's Luna doesn't know who sage is as an assistant. Mechanically simpler. The Phase D `network-registry` spec already supports this — it returns operator/stack/capability metadata, no body.
- **(a) Soma-federated model.** sage's Soma identity (her body's *public* metadata — profile, voice, declared capabilities, lineage) is resolvable via the cloud network registry. Andreas's Luna can introspect *who* she's delegating to.

(a) is the profound version because it makes **assistants themselves the unit of federation**, not just capabilities. The "Internet of Agentic Work" becomes literally an internet of assistants: every assistant has a Soma body, every assistant projects into substrate(s), every assistant is addressable across operators via a (NKey-identity, Soma-body) tuple. The chain-of-stamps becomes a chain of `(assistant, substrate, stack-NKey)` triples — full audit of *who* did *what* on *which substrate*.

The Phase E delegation pattern (§3.6) becomes meaningful in (a), thin in (b). Without (a), "delegate to the best assistant for this task" reduces to "delegate to the best public key advertising this capability tag" — a marketplace primitive, not an assistant primitive. (a) is the form that matches the operator-vision script's intent.

The substrate-independence claim — the thing this design is named after — is what makes (a) operable. An assistant identity that is portable across substrates is the prerequisite for an assistant identity that is portable across *operators*.

---

## §7 — Concrete cortex.yaml delta

Today (post-Phase-A, pre-Soma):

```yaml
operator: { id: andreas }
stack:    { id: andreas/main, nkey_pub: SAA… }

agents:
  - id: luna
    did: did:mf:luna
    presence: { discord: { ... }, mattermost: { ... } }
    runtime:  { substrate: claude-code, mode: in-process }
    persona: |
      # Luna — Persona
      You are Luna, andreas's primary assistant...
      (200 lines of body)
    capabilities: [chat, dispatch, ...]
    trust: [echo, holly, ivy, sage, alpha]

policy:
  principals:
    - id: andreas
      home_operator: andreas
      home_stack: andreas/main
      role: [operator]
  roles:
    - id: operator
      grants: [keyword.chat, keyword.async, keyword.team, dispatch.*]
```

Post-Soma:

```yaml
operator: { id: andreas }
stack:    { id: andreas/main, nkey_pub: SAA… }

agents:
  - id: luna
    body: soma://andreas/luna           # ← Soma assistant reference
    presence: { discord: { ... }, mattermost: { ... } }
    runtime:  { substrate: claude-code, mode: in-process }
    # persona, capabilities, trust now live in ~/.soma/profile/luna + ISA + Skills
    # The fragment is now a thin substrate-binding pointer.

  - id: luna-codex                      # ← same Soma, different substrate
    body: soma://andreas/luna           # ← identical reference
    runtime:  { substrate: codex, mode: standalone }

  - id: luna-daemon                     # ← same Soma, no substrate (bus-direct)
    body: soma://andreas/luna
    runtime:  { substrate: soma-daemon, mode: standalone }

policy:
  principals:
    - id: luna
      home_operator: andreas
      home_stack: andreas/main
      body: soma://andreas/luna         # ← join key into Soma body
      role: [agent]
```

Three substrate presences of the same Luna, all signing with the stack NKey, all backed by the same Soma body. That's substrate independence made operable.

Note the `id: luna` / `id: luna-codex` / `id: luna-daemon` are *presence handles* (cortex's perspective — three runtime processes); they all resolve to the same `body: soma://andreas/luna` (one Soma assistant). The `policy.principals[].id: luna` is the bus-level principal; all three presences sign as that principal. The chain-of-stamps may need to carry `signed_by[].substrate` to distinguish *which presence* did the work — see §9 Q3.

---

## §8 — `SomaCortexAdapter` — what ships first

The first concrete deliverable, once this design ratifies:

1. **`SomaCortexAdapter`** (Soma-side, new) — implements Soma's adapter contract for the Cortex/Myelin substrate. Two projection shapes per `docs/substrate-adapters.md`:
   - **In-process** (`home` mode): projects a Soma assistant into `~/.config/cortex/agents.d/<name>.md` as the thin frontmatter+pointer fragment shown in §7.
   - **Daemon** (`daemon` mode): arc-installs a standalone bot from the Soma package; bot subscribes to Myelin subjects via the existing `MyelinRuntime` interface (no SessionHarness, no in-process spawn — pattern matches sage today).
2. **`SCHEMA_SOURCE_COMMIT` bump on the cortex side** — add `body: soma://...` to `AgentSchema` and `PolicyPrincipalSchema` in `src/common/types/cortex-config.ts`. Optional string field at first (back-compat with pre-Soma agents that carry inline persona); MAY become required at Phase C.5 cutover.
3. **`migrate-config` extension** — when an agent fragment carries inline persona + capabilities + trust, offer to lift those into a new Soma assistant scaffold under `~/.soma/profile/<id>/` and rewrite the fragment to `body: soma://...`. Idempotent. Operator pre-flight via `--check`.
4. **Substrate provenance on chain-of-stamps** — coordinate with myelin#31 on whether `signed_by[].substrate` should be added before Phase D federation locks in. (See §9 Q3 — small extension, much cheaper to add in Phase B/C than retrofit in Phase E.)

None of these is large. The harder work is the design ratification — once §5 sequencing is locked, the implementation is mechanical.

---

## §9 — Open questions

| # | Question | Impact |
|---|----------|--------|
| **Q1** | **Fold into Phase C, or defer to v3?** §5 makes the case for folding the Soma factor-out into the same C.2b/c schema flip. C.2b/c is mid-execution ([PR #291](https://github.com/the-metafactory/cortex/pull/291)); growing scope mid-cutover is risky. Defer-to-v3 is safer but pays operator migration churn twice. | Schema-flip count: 1 vs 2 |
| **Q2** | **Reference URL grammar.** `body: soma://andreas/luna` or `body: did:mf:luna` (reuse existing DID grammar)? The DID form is already in agent fragments (`did: did:mf:luna`); using it as the Soma reference avoids inventing a new URL scheme. The `soma://` form makes the Soma layer explicit. Lean: reuse `did:mf:` for the operator-facing reference; Soma uses `did` → assistant lookup internally. | Documentation clarity; one fewer URL scheme |
| **Q3** | **Substrate provenance on chain-of-stamps.** If alpha-as-Luna (Cursor) and luna-as-Luna (Claude Code) both sign with the same stack NKey, the audit trail loses substrate provenance. Add `signed_by[].substrate: "cursor" \| "claude-code" \| ...` before Phase D federation locks the envelope schema? | Audit fidelity post-federation |
| **Q4** | **Federation model (§6 option (a) vs (b)).** Should the Phase D cloud network registry return Soma assistant metadata (profile, voice, public capability declarations) — option (a) — or just opaque principal data — option (b)? (a) is the profound version and matches the operator-vision script; (b) is simpler. | Phase D registry schema |
| **Q5** | **Multi-presence trust.** If Luna's `claude-code` presence and `codex` presence are both online for the same operator on the same stack, how does the surface-router decide which one renders a Discord message? Today there's exactly one presence per agent. Soma multi-presence breaks that 1:1 mapping. | Surface-router routing logic |
| **Q6** | **Soma-locality vs federation.** Soma is filesystem-local at `~/.soma/`. Federation means principals from other operators show up. Either (a) extend Soma to cover *remote* assistants discoverable via Phase D cloud registry, or (b) keep Soma local-only and let cortex/Myelin handle remote principals as opaque NKey identities. Q4 and Q6 are the same question viewed from different sides. | Soma scope |
| **Q7** | **Daemon mode + Soma.** Soma's `daemon` mode subscribes to Myelin subjects directly. In cortex's worldview that's an `arc`-installable bot of `type: agent`. Does the Soma daemon ship as its own arc-installable repo (analogous to sage, alpha) or as a Soma command-line mode that the operator invokes from inside the Soma install? The two paths converge in implementation but diverge in operator ergonomics. | Distribution model |
| **Q8** | **Writeback policy reconciliation.** Soma's writeback gate decides what cortex-substrate sessions are allowed to write back to Soma source. Today cortex has no concept of writeback (sessions run, emit envelopes, terminate; no body mutation). Adding writeback means the ClaudeCodeHarness needs a hook to capture session-end mutations and hand them to the Soma adapter. Phase scoping. | New cortex hook surface |

---

## §10 — Non-goals

- **Not a Soma rewrite.** Soma's core is shipped; this design wires cortex/Myelin in.
- **Not a cortex.yaml redesign.** The §7 delta is additive (`body:` field) until Phase C.5 (if folded).
- **Not an attempt to unify Cortex's PolicyEngine and Soma's writeback gate.** They decide different things (§4); they keep separate identities.
- **Not a Phase F.** This is properly an extension/insertion into Phase C or D, not a new IAW phase. If it lands as Phase C.5, it ships with the v2.0.0 cutover; if as Phase D.0, it precedes federation.
- **Not the federation registry schema design.** §6 Q4 surfaces the option but the actual Phase D D.1 registry-side spec is a separate doc.

---

## §11 — References

### Cortex (this repo)
- `docs/design-internet-of-agentic-work.md` — the IAW architectural synthesis (substrate harness, NKey, PolicyEngine, federation)
- `docs/plan-internet-of-agentic-work.md` — IAW Phase A–E plan; §4 (Phase C) is the schema-flip window referenced here
- `docs/design-policy-cutover.md` + `docs/iteration-policy-cutover.md` — current C.2b/c work that this design's sequencing depends on
- `docs/design-cursor-substrate-bot.md` §4 — the persona-staging shim that's a Soma projection in disguise
- `docs/design-pi-dev-review-agent.md` — sage's reference implementation; same persona-staging pattern
- `docs/architecture.md` §6 + §9 — bus contracts + agent / presence / renderer model
- `src/common/types/cortex-config.ts:253` — substrate enum (claude-code / codex / pi-dev / cursor / custom)
- `src/runner/cc-session.ts` — ClaudeCodeHarness (the in-process projection point)

### Soma (`the-metafactory/soma`)
- [`CONTEXT.md`](https://github.com/the-metafactory/soma/blob/main/CONTEXT.md) — domain glossary (substrate, project/projection, presence, install, writeback, daemon mode, runtime modes, eager/indexed/on-demand, private/protected/generated)
- [`docs/architecture.md`](https://github.com/the-metafactory/soma/blob/main/docs/architecture.md) — SomaCore (Identity, Telos, ISA, Skills, Memory, Policy, Learning)
- [`docs/substrate-adapters.md`](https://github.com/the-metafactory/soma/blob/main/docs/substrate-adapters.md) — adapter contract; existing Codex / Pi.dev / Claude Code / Cortor/Myelin sections (this design extends the last)
- [`docs/writeback-and-policy.md`](https://github.com/the-metafactory/soma/blob/main/docs/writeback-and-policy.md) — writeback gate (substrate → Soma mutation policy)
- [`docs/boundaries.md`](https://github.com/the-metafactory/soma/blob/main/docs/boundaries.md) — what's portable vs substrate-native vs substrate-neutral
- [`docs/portability-proof.md`](https://github.com/the-metafactory/soma/blob/main/docs/portability-proof.md) — proof that the same Soma core projects into multiple substrates correctly

### Myelin
- `myelin/specs/namespace.md` — subject grammar (post-Phase-A.5 stack-aware)
- `myelin/docs/envelope.md` — chain-of-stamps + sovereignty fields; §9 Q3 proposes a small extension to `signed_by[]`
- `myelin/src/identity/` — Principal, SignedBy, PrincipalRegistry; the bus-level identity that this design ties to Soma's body-level identity

### Operator vision
- "Internet of Agentic Work" (2026-05-13) — north-star script wrapped by cortex#110; §3.6 (delegation) is the pattern §6 of this design grounds in Soma

---

*This document is the design specification for Soma integration into the cortex/myelin stack. It does NOT include implementation — once §9 questions are answered (in particular Q1 fold-or-defer), a sibling plan doc will sequence the Phase C.5 (or Phase D.0) work. Authored 2026-05-17 by Andreas + Luna; ratification awaits review from @jcfischer + Echo (code-review lens) + Luna (design lens).*
