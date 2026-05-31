# Soma Integration — Assistant-Body Protocol for Substrate-Independent Agents

**Refs:** cortex#110 (Internet of Agentic Work META) · [`the-metafactory/soma`](https://github.com/the-metafactory/soma) (CONTEXT.md + `docs/substrate-adapters.md` + `docs/architecture.md`)
**Status:** Design draft. No implementation in this PR — synthesis grounded in shipped code on both sides.
**Driver:** Andreas
**Scope:** Single design view of how Soma (the portable assistant-body protocol) composes with cortex/myelin (the bus + agent-surface stack), and where Soma adoption sequences in the IAW phase ladder.

---

![Soma + cortex/myelin — the two-axis substrate-independence claim](./diagrams/2026-05-17-soma-integration.png)

> **The diagram above is the whole thesis in one glance.** Two orthogonal axes of substrate-independence: the *body axis* (one Soma assistant body → four substrate-native projections) and the *runtime axis* (cortex/myelin's M1–M7 stack with IAW phases). The join key (`policy.principals[].body: soma://...`) ties them together. The three bottom insets (A reinvention / B identity / C policy) are the load-bearing reconciliations §2–§4 unpack in prose.
>
> **Two diagram variants:**
> - **Hero (above)** — overview, optimised for "thesis in 10 seconds". This is the version to put in a slide.
> - **[Reference poster](./diagrams/2026-05-17-soma-integration-reference-poster.png)** — dense reference-poster variant with the full IAW Phase A–E ladder, exact file paths verbatim, the load-bearing-claim summary panel, and the federation inset annotated with the §6 option-(a) claim. SVG source at [`./diagrams/2026-05-17-soma-integration-reference-poster.svg`](./diagrams/2026-05-17-soma-integration-reference-poster.svg) — re-rasterise with `rsvg-convert` if you want to iterate.
> - **[Thumbnail](./diagrams/2026-05-17-soma-integration-thumb.png)** — simplified two-axis-only variant for inline embedding in narrower contexts.

## TL;DR

The Internet of Agentic Work pipeline (cortex#110, Phases A→E) has been incrementally building **substrate independence at the runtime layer**:

- **SessionHarness** (Phase A) — cortex can dispatch into any LLM substrate via a common interface.
- **NKey chain-of-stamps** (Phase B) — agents have substrate-independent cryptographic identity.
- **PolicyEngine** (Phase C) — authorization lifted out of substrate-coupled adapters into a single M6 decision point.
- **Federation** (Phases D/E) — stacks compose across principals regardless of what substrate any individual agent runs on.

Nothing in IAW makes the **assistant body** substrate-independent. Luna's persona, voice, telos, skills, memory, and learnings live in cortex-specific `agents.d/*.md` frontmatter + persona body, projected by hand into whichever substrate adapter happens to host her. ClaudeCodeHarness re-invents the projection one way; sage's pi.dev shim re-invents it another way; alpha's `.cursor/rules/persona.mdc` workdir shim re-invents it a third way. **Three substrate adapters, three hand-rolled projection shims, no common contract.**

[Soma](https://github.com/the-metafactory/soma) is the missing dual. Cortex/Myelin gives substrate-independent **dispatch + identity + policy at the bus layer**. Soma gives a substrate-independent **assistant body** that *projects into* whichever substrate is hosting a given session. They aren't competing. They're orthogonal axes of the same independence claim, and they compose cleanly through one new join key on `policy.principals[]`.

The unit of federation isn't the agent, isn't the stack, isn't even the network — it's **the (Soma-assistant, NKey-stack) tuple addressable across principals**.

**One refinement up front (principal feedback, 2026-05-17 in `#soma`):** the assistant body is a *spectrum*, not a monolith. Luna and Ivy live at the thick end — full Identity / Telos / ISA / Skills / Memory / Policy. Echo lives at the thin end — "a wrapper around two slash commands with a persona file as an example." Soma must serve both. The `SomaCore` layer set is the *maximal* shape; thin assistants declare a subset. §2.5 unpacks this; §7's strawman shows both a thick (Luna) and a thin (Echo) entry side-by-side.

---

## §1 — Soma is an M7-layer body protocol

The instinct is to ask "is Soma M6.5? M7-sibling? a new M8?" The operative test is: *does X provide a contract that lower layers depend on?* M2–M6 are entirely unchanged by Soma's presence or absence — the bus, envelope, namespace, JetStream consumer, and surface-router are identical whether Soma is installed or not. So Soma is **an M7-layer body protocol** — hostable inside any M7 surface (cortex's agent surface, pilot, signal-collector) **or runnable as its own M7 process** (Soma daemon mode, equivalent to a headless agent with `presence: {}` per cortex#245's `AgentSchema`). The daemon mode is not "non-M-layer"; it's an M7 application that happens to advertise no platform presence.

What's special about Soma — and worth saying without rhetorical sleight-of-hand — is that **it's an M7 contract that other M7 surfaces (cortex, pilot, future apps) host on behalf of an assistant body owned by the assistant's source-of-truth (`~/.soma/`)**. Cortex doesn't *contain* Luna; cortex hosts a Luna presence projected from Soma. Pilot doesn't contain Echo; pilot hosts an Echo presence projected from Soma. The body lives in Soma; the M7 surface materialises it.

Re-read Soma's `CONTEXT.md` glossary on `substrate` and `daemon mode` together:

> **substrate:** The host runtime that Soma projects into. Examples: Claude Code, OpenAI Codex, Pi.dev, **Cortex/Myelin**.

> **daemon mode:** Soma runs as a long-lived process subscribing to Myelin subjects. No substrate involved. (From Soma `CONTEXT.md`'s Runtime modes table.)

Cortex/Myelin is listed as a *substrate* AND Soma's daemon mode subscribes to *Myelin subjects directly without substrate*. That isn't a contradiction — it's the same M7-protocol-with-two-deployment-shapes pattern cortex already uses internally (cf. the cortex#245 headless-agent shape, where an agent declared with `presence: {}` runs as a bus-only participant with no chat-surface adapter). Soma's daemon mode is the same pattern at the body-protocol layer.

The placement diagram below is unchanged in shape — Soma above the M-stack with downward arrows to substrates — but the right *label* is "M7 cross-stack body protocol" rather than "cross-cutting non-M-layer concern":

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
| `src/substrates/claude-code/harness.ts` (`ClaudeCodeHarness`, IAW Phase A.1 / cortex#113) — and the underlying spawner `src/runner/cc-session.ts` (`CCSession`, used as `ccSessionFactory` and instantiated at `dispatch-listener.ts:615`) | Harness wraps the substrate; `CCSession` spawns `claude --print` with `CLAUDE.md` + `agents.d/*.md` fragments already on disk | Soma's `home` mode already projects into `~/.claude/`. The harness stays as the dispatch-transport abstraction (it already IS one); projection is Soma's job, not the harness's. |
| `the-metafactory/alpha` `src/cursor/workdir.ts` (per `docs/design-cursor-substrate-bot.md` §4) | Per-dispatch: `mkdtemp` workdir, shallow clone PR, **strip YAML frontmatter from `alpha.md` and write to `.cursor/rules/persona.mdc`**, stage PR.md + diff.patch | Soma's `workspace` mode + Cursor adapter projects the persona once at install; the workdir shim only needs to clone the PR + invoke `cursor-agent`. The frontmatter-stripping is Soma adapter logic, not per-dispatch shim logic. |
| `the-metafactory/sage` (pi.dev agent) | Sage's persona-staging into pi.dev's instruction surface (mirror of the alpha pattern, also reimplemented) | Soma's Pi.dev adapter (`buildPiDevContext` + `buildPiDevHomeContext` already exist on the Soma side) |
| `src/common/types/cortex-config.ts` `AgentRuntimeSchema.substrate` (currently around line 421 — cite by symbol; the line number has drifted with cortex#245 schema growth) | Substrate enum (`claude-code / codex / pi-dev / cursor / custom`) gates which harness runs | Same enum value; Soma reuses the substrate identifier as the projection target |
| `agents.d/*.md` fragment with frontmatter (`id`, `did`, `runtime`, `roles`, `trust`, `capabilities`) + persona body | Mixes infrastructure config (runtime, trust, bus identity) with assistant body (persona, capabilities) | Frontmatter stays in cortex.yaml / arc-rendered fragment; persona body, capability declarations, and skill library move to Soma. The fragment becomes a thin pointer (`body: soma://<assistant-id>`). |

The cursor-design example is the load-bearing one. §4 of `docs/design-cursor-substrate-bot.md` walks through the persona-staging shim — strips YAML frontmatter (because `.mdc` doesn't parse it), writes to `.cursor/rules/persona.mdc`, cleans up the workdir after dispatch. **That is, verbatim, a Soma `projection` performed by a `workspace`-mode adapter, with frontmatter-stripping inlined into the host code rather than the adapter.** The cursor design even names the structural gap ("the single structural gap is the missing `--system-prompt` flag, which forces a per-dispatch workdir-staging step") without observing that the gap is already filled in Soma's adapter contract — it's just not yet wired in.

When alpha ships and the metafactory then adds (say) a Codex agent and then a Gemini agent, the projection logic gets reinvented 2–3 more times. That's exactly the failure mode Soma was built to prevent — and the failure mode IAW's substrate harness work alone does NOT prevent (the harness abstracts *dispatch*, not *persona*).

---

## §2.5 — The assistant-body spectrum (thin Echo ↔ thick Luna)

Principal feedback during this design's review window (Andreas, in `#soma`, 2026-05-17 at 01:12 PM, verbatim):

> "Soma would need to handle the thin persona and wrapping layer around tooling and skills without all of the other stuff that we have in Luna and Ivy. Echo is a wrapper around two slash commands with a persona file as an example.
>
> This is what I was thinking when I mentioned the meta-factory stack in Soma but reading your context document solidified that thinking..."

This is a load-bearing refinement to §1's framing. The diagram and §1 prose show the Soma body as one block with six pillars (Identity · Telos · ISA · Skills · Memory · Policy · Learning). That's the *maximal* shape. Real assistants in the metafactory ecosystem sit on a **spectrum** of body thickness:

| Tier | Example | Body shape | Typical projection |
|---|---|---|---|
| **Thin** | Echo (cortex code-reviewer) | Persona file + skill index (2 slash commands) + role/trust scoping. No Telos. No long-running Memory. No Learning loop. | One `agents.d/echo.md` fragment + a couple of skill references. |
| **Medium** | Sage, Alpha (cortex review peers) | Persona + capability declarations + per-substrate workdir lifecycle (clone, project, cleanup). Operational, not biographical. | The persona-staging shim from `design-cursor-substrate-bot.md` §4. |
| **Thick** | Luna, Ivy (principal's primary assistants) | Full `SomaCore`: Identity + Telos + ISA + Skills + Memory + Policy + Learning. Long-running, biographical, evolving. | Full `~/.soma/profile/<name>/` tree with all compartments populated. |

### Implications for the Soma adapter contract

The `SomaCore` layer set is the **maximal** shape. Thin and medium assistants **declare a subset**. The adapter contract has to handle "this assistant has only persona + skill registry; do not look for Telos or Memory because none exist" without that being an error path. Two design consequences:

1. **Optionality on every layer.** Each of Identity / Telos / ISA / Skills / Memory / Policy / Learning is optional in the body schema. Only the **persona** (Identity layer's profile facts + voice) is required — without persona the assistant has no voice at all, which is the minimum for "an assistant exists here". Everything else is opt-in.

2. **Projection scales with declared body.** A thin Echo projection into Claude Code is `~/.claude/agents.d/echo.md` with persona + skill references. Period. No `~/.claude/MEMORY/`, no Telos appendix, no Learning hook. A thick Luna projection into Claude Code is the full `~/.claude/PAI/` tree. Same `SomaCortexAdapter`, same projection mechanism — different declared body, different output volume.

### Implications for §7 strawman

The original §7 strawman showed three Luna presences pointing at the same `body: soma://andreas/luna`. That's *one half* of the spectrum (thick + multi-substrate). The refined §7 below adds an **Echo** entry to show the *other half* (thin + single-substrate + capability-scoped). The two together demonstrate that the adapter contract has to handle both ends cleanly.

### Implications for the M1–M7 placement (§1)

§1 framed Soma as "the assistant-body protocol that any M7 surface can host." That's still right — but with the spectrum in mind, "host" means *"materialise whatever subset of SomaCore this assistant has declared, in the substrate-native shape, and route the substrate's events to whichever subset of writeback hooks the assistant has registered."* Thin assistants exercise less of the protocol; thick assistants exercise all of it. The protocol surface is the same.

### Not implied (anti-claim)

This spectrum does **not** mean "thin assistants don't need Soma." They still need: a portable persona, a portable skill registry, and a portable substrate-projection adapter. Without Soma, Echo today is `agents.d/echo.md` in cortex, plus a separate skill registry inside `~/.claude/skills/` (or wherever), plus an ad-hoc projection that lives in cortex's substrate harness layer (the `ClaudeCodeHarness` at `src/substrates/claude-code/harness.ts` + `CCSession` spawner at `src/runner/cc-session.ts`). With Soma, Echo is `~/.soma/profile/echo/` (persona + skill refs) and the projection is the adapter's job. The win for thin assistants is *less reinvention*, not *less Soma*.

### Federation visibility scales with declared body

Closely related: **federation-publishable metadata is whatever sits in the Identity layer, regardless of body thickness.** Thin assistants publish only what their Identity layer carries — typically `(did, capabilities[], persona-summary)`. Medium assistants additionally publish operational metadata (per-substrate capability declarations, workdir conventions). Thick assistants additionally publish biographical metadata (voice tier, lineage, declared Telos prose if marked public). The minimum federation-publishable record is `(did, capabilities[], persona-summary)`; the maximum extends through every Identity-layer sub-key the assistant has chosen to mark public. This means **Sage (Medium tier per the table above) can still appear in the federation registry with persona-summary + capabilities + any Identity-layer fields it exposes** — Medium-thickness limits what fits, not whether anything is federation-visible. §6's federation example uses voice tier as a routing signal; voice tier is Identity-layer metadata, available to any assistant that declares it (thin / medium / thick), so the example is consistent with the tier table — it just exercises a field that not every assistant chooses to populate.

---

## §3 — Reconciling the two identities

This is the subtle one. Cortex's IAW Phase B introduces a 3-tier NKey identity chain: operator-account NKey → stack NKey → agent NKey. Every envelope is signed; `signed_by[]` is the chain-of-stamps. Soma has its own **Identity layer** — "the one Soma layer that stores who the principal is and who the assistant is: profile facts, communication preferences, personality metadata, and optional voice metadata" (Soma `CONTEXT.md`).

These are not in conflict — they're complementary along **different axes**:

- **NKey identity** (cortex / Myelin) — *"I am cryptographically agent X on stack Y of principal Z, and here's the signature to prove it."* Bus-level. Lives in `policy.principals[]` (post-Phase-C) and in the chain-of-stamps. Answers: *who signed this envelope?*
- **Soma Identity** (Soma) — *"I am Luna; this is my voice, my profile, my preferences, my history."* Body-level. Lives in `~/.soma/profile/`. Answers: *who is the assistant?*

The join key is the principal record. Post-cortex#243a the actual `PolicyPrincipalSchema` shape (`src/common/types/cortex-config.ts:1124`) is:

```
{ id, home_principal, home_stack, nkey_pub?, role[], trust[], platform_ids, session_config? }
```

`nkey_pub?` is already on the principal — it's *exactly* where the bus-level NKey identity lives. Soma integration adds **one field**: `body: soma://<assistant-id>`. Critically, this is additive next to `nkey_pub?`, not in competition with it. The two fields **co-live on the same record**, which is what makes the join clean — one principal carries both its bus-side cryptographic identity and its body-side Soma reference. Now the principal table is the cross-layer pivot:

```
chain-of-stamps signed_by[].principal
                    │
                    ▼
cortex.yaml policy.principals[<id>]
   ├── home_principal     (bus identity)
   ├── home_stack        (bus identity)
   ├── nkey_pub?         (bus identity — already shipped)
   ├── platform_ids      (cortex adapter binding)
   ├── role[]            (cortex policy)
   ├── trust[]           (cortex policy)
   ├── session_config?   (cortex runtime)
   └── body: soma://...  (→ Soma assistant body — ADDED)
```

**Where else `body:` may need to live (see §10 / §9 Q10).** For projection-time use (deciding *which* Soma body to project into *which* substrate at agent-spawn time), the more natural location is `AgentSchema.body` (next to `presence:` and `runtime:`). For federation-time use (resolving a remote principal's body across principals via the Phase D cloud network registry), `PolicyPrincipalSchema.body` is the right home. **Both locations are valid for different consumers** — projection vs federation — and they MUST agree per the validation rule below.

**Validation rule (multi-presence-compatible).** §7 declares that multiple agents (`luna`, `luna-codex`, `luna-daemon`) can share one principal (`luna`) when they're substrate-different presences of the same logical assistant. The binding is therefore **agent → principal → body**, not **agent → body** directly. Stated precisely: every agent declares `body:` (its projection target) AND a principal binding (explicit `agent.principal_id` or implicit when `agent.id == principal.id`); the principal carries its own `body:` for federation; both `body:` values for an agent–principal pair MUST equal the same `soma://...` URL. Three agents bound to one principal therefore all carry the same `body:`, and the principal carries that body once for federation lookups. (Q9 in §9 captures this as the open binding question and the rule above is the leading answer.)

This is what makes "Andreas's Luna calls jcfischer's sage" coherent across principal boundaries: both Luna and sage are Soma assistants; their identities resolve through the Phase D cloud network registry; the chain-of-stamps proves *which Soma assistant on which stack* signed which step.

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

**Open: does writeback carry principal context?** A substrate session runs bound to a (Principal, body) tuple. At session-end, the substrate emits a writeback. The writeback gate sees a mutation request; the question is whether that request includes only the body context (which body, what diff) or also the principal context (NKey, stack id, chain-of-stamps from the originating dispatch). The latter is more powerful — writeback policies can be principal-aware ("only stack-NKey-signed sessions can mutate Memory; cross-principal delegations can mutate ISA only") — but adds coupling. The former is simpler and treats Soma as cleanly substrate-agnostic. Tracked as §9 Q12; leaning principal-aware once chain-of-stamps reaches the writeback boundary (Phase B+), stateless for the initial cortex hook in §9 Q8.

---

## §5 — Where it sequences in the IAW pipeline

The IAW plan (`docs/plan-internet-of-agentic-work.md`) framed Phase C as the **single** principal-facing cortex.yaml schema flip. Soma adoption requires reshaping `agents[]` fragments (lifting inline `persona:` / `capabilities:` / `trust:` out, leaving a `body: soma://...` substrate-binding pointer in), which is a second schema flip. The honest framing is: **we accept a second flip.** v2.0.0 = C.2b/c policy cutover (in flight); v3.0.0 = Soma factor-out (post-stabilisation). Two flips, each small and testable on its own. The original IAW plan's "one flip" was a *target*, not a hard constraint; this design's review process forced the trade.

Current Phase C status (`plan-internet-of-agentic-work.md` §4):

- **C.1** PolicyEngine module — done (cortex#218)
- **C.2a** Top-level `policy:` block added (additive) — done (cortex#219)
- **C.2b/c** Breaking removal of per-adapter `roles[]` + `migrate-config` extension — **in flight, ratified design** ([PR #291](https://github.com/the-metafactory/cortex/pull/291), iteration plan in [`docs/iteration-policy-cutover.md`](./iteration-policy-cutover.md))
- **C.3 / C.4** Substrate-harness integration + audit envelopes — done

The Soma integration lands as **its own v3.0.0 cycle**, sequenced AFTER C.2b/c v2.0.0 stabilises (don't pile on the policy cutover mid-execution) but compatible with Phase D's federation (federation MAY consume Soma metadata when present, falls back to opaque-principal otherwise — see §6):

```
Phase C (in flight)  ─── v2.0.0 schema flip:
                            policy: { principals[], roles[] }
                            (cortex#293, #295, #302, #305, #306 — running)
        │
        ▼ stabilise + ratify
        │
v3.0.0 (post-C.2b/c) ─── Soma factor-out schema flip:
                            agents[].body: soma://<id>            (projection target)
                            policy.principals[].body: soma://<id> (federation join)
                            SomaCortexAdapter ships
                            migrate-config v2 → v3 lifts inline
                                  persona/capabilities into ~/.soma/profile/<id>/
        │
Phase D              ─── federation: peers resolve via cloud network registry.
        │                If peer principal carries body: → option (a) Soma-federated.
        │                If not: → option (b) opaque-principal. Both work.
        │
Phase E              ─── orchestrator pattern: one assistant IS a Soma; can be
                         projected into N substrates concurrently for substrate
                         diversity; daemon mode adds bus-direct presence.
```

**Recommendation: defer to v3.0.0.** Earlier drafts of this doc equivocated between fold-and-defer; ratification round 1 (Echo-equivalent review) pressure-tested that equivocation and made the call concrete. C.2b/c is mid-execution as of 2026-05-17 — cortex#293 + #295 + #302 + #305 + #306 are all visible on `main` running the iteration in `docs/iteration-policy-cutover.md`. Growing scope mid-cutover is the kind of thing the metafactory ecosystem has consistently moved away from (the cost is measured in *principal-migration confidence*, not just engineering hours). **Defer Soma factor-out to a separate v3.0.0 cycle once C.2b/c lands and stabilises.** Principals pay two migrations, but each one is small, testable, and ratifiable in isolation.

**Runner-up: fold into v2.1.0, not v2.0.0.** If folding has to happen, the safer landing is a minor-bump-with-additive-field in v2.1.0 (`body:` as optional on both schemas, no removal of the inline persona path yet) once C.2c's `migrate-config` is stable. The breaking removal of inline persona then lands in v2.2.0 or v3.0.0. This is still two cycles, but the principal-facing burden is split: v2.1 = "you can move to Soma", v3.0 = "you must move to Soma."

**What's explicitly off the table: fold into v2.0.0.** The original framing in earlier drafts; rejected here on schedule-risk grounds. Documented as the rejected option so future readers see what was considered.

---

## §6 — Federation profundity — assistants as the unit of address

This is where it gets actually profound. Phase E's delegation pattern (§3.6 of `docs/design-internet-of-agentic-work.md`):

> "Your main digital assistant that will then delegate around and coordinate on your behalf by leaning into these different networks and stacks depending on their capability."

For this to work, "your main digital assistant" must exist **independently of any one substrate**. Today Luna is `agents.d/luna.md` projected into Claude Code via ClaudeCodeHarness. She's substrate-coupled at the body level. For Phase E delegation to mean what the principal-vision script says it means, Luna has to be addressable across:

- her Claude Code presence (where Andreas DMs her),
- her Codex presence (where she might run a coding task),
- her Cursor presence (where she might do whole-repo analysis),
- her Soma daemon presence (where she subscribes directly to Myelin subjects and orchestrates without any substrate session in the way),

…all at once, all with the **same identity, memory, telos, and skills**. That's only coherent if Luna is a Soma. The cortex-side identity (NKey on stack `andreas/main`) is shared across all four presences; the Soma-side body is shared across all four presences; what differs is the *substrate-native projection* in each case.

Now consider the federation case. Andreas's Luna delegates a TypeScript review to jcfischer's network. The capability registry (Phase D `D.4` cloud-side network registry, `network.meta-factory.ai`) returns: "principal jcfischer has assistant `did:mf:sage` with capability `code-review.typescript`." How does Andreas's Luna know what sage *is*? Two options:

- **(b) Opaque-principal model.** sage is just a principal — a public key, a capability tag, an SLA. Andreas's Luna doesn't know who sage is as an assistant. Mechanically simpler. The Phase D `network-registry` spec already supports this — it returns principal/stack/capability metadata, no body.
- **(a) Soma-federated model.** sage's Soma identity (her body's *public* metadata — profile, voice, declared capabilities, lineage) is resolvable via the cloud network registry. Andreas's Luna can introspect *who* she's delegating to.

(a) is the profound version because it makes **assistants themselves the unit of federation**, not just capabilities. The "Internet of Agentic Work" becomes literally an internet of assistants: every assistant has a Soma body, every assistant projects into substrate(s), every assistant is addressable across principals via a (NKey-identity, Soma-body) tuple. The chain-of-stamps becomes a chain of `(assistant, substrate, stack-NKey)` triples — full audit of *who* did *what* on *which substrate*.

The Phase E delegation pattern (§3.6) becomes meaningful in (a), thin in (b). Without (a), "delegate to the best assistant for this task" reduces to "delegate to the best public key advertising this capability tag" — a marketplace primitive, not an assistant primitive. (a) is the form that matches the principal-vision script's intent.

The substrate-independence claim — the thing this design is named after — is what makes (a) operable. An assistant identity that is portable across substrates is the prerequisite for an assistant identity that is portable across *principals*.

**Concrete delegation example (the principal benefit of (a) made specific — illustrative; see caveat).** Andreas's Luna has a Telos line that says *"keep customer-facing prose warm; favour reviewers whose declared voice is conversational"*. She receives a `tasks.code-review.typescript` request that includes a customer-facing docs file. She queries the Phase D network registry for candidates with `code-review.typescript` capability and receives three peers: `jcfischer/sage` (Soma voice `terse-empirical`), `acme/holly` (Soma voice `conversational-warm`), `bigcorp/atlas` (no Soma body — option-(b) opaque principal). Under **option (a)**, Luna routes to `acme/holly` based on the voice-style match; under **option (b)**, she has no introspection, so the choice is round-robin or first-claim, defeating her Telos-driven routing. This is the kind of capability-aware-but-also-identity-aware delegation §3.6 of the IAW design promised; it requires (a).

> **Caveat — `voice.style` is illustrative, not currently a documented Soma schema field.** Soma's `CONTEXT.md` mentions "optional voice metadata" as part of the Identity layer (`Identity stores who the principal is and who the assistant is. It includes profile facts, communication preferences, personality metadata, and optional voice metadata.`) without specifying a structured `voice.style` enum with named tiers like `terse-empirical` / `conversational-warm`. The example above presumes such a field exists; if it does not, the example is best read as a *proposal back to Soma* — "if Soma's Identity layer exposed a structured `voice.style` enum, here's how Luna's federation routing would use it." Tracked as a follow-up question in §9 Q11 (registry-schema-ownership) and as a likely sibling issue to file in the-metafactory/soma if this design ratifies.

---

## §7 — Concrete cortex.yaml delta

Today (post-Phase-A, pre-Soma):

```yaml
principal: { id: andreas }
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
      home_principal: andreas
      home_stack: andreas/main
      role: [operator]
  roles:
    - id: principal
      grants: [keyword.chat, keyword.async, keyword.team, dispatch.*]
```

Post-Soma — **this is the v3.0.0 target shape per §5; today's cortex.yaml is the pre-Soma block above.** The block below is not what a principal's `cortex.yaml` looks like in v2.0.0; it is the shape the v3.0.0 cycle's `migrate-config` produces. Shown here to make the design concrete, not to pre-stage principal changes. Showing **both ends of the §2.5 spectrum** side-by-side — thick Luna (multi-substrate, full SomaCore) and thin Echo (single-substrate, persona + slash-commands only):

```yaml
principal: { id: andreas }
stack:    { id: andreas/main, nkey_pub: SAA… }

agents:
  # ─── THICK: Luna (full SomaCore, three substrate presences) ───
  - id: luna
    body: soma://andreas/luna           # ← thick body (Identity/Telos/ISA/
                                        #    Skills/Memory/Policy/Learning all
                                        #    populated in ~/.soma/profile/luna/)
    presence: { discord: { ... }, mattermost: { ... } }
    runtime:  { substrate: claude-code, mode: in-process }

  - id: luna-codex                      # ← same Soma, different substrate
    body: soma://andreas/luna           # ← identical reference
    runtime:  { substrate: codex, mode: standalone }

  - id: luna-daemon                     # ← same Soma, no substrate (bus-direct)
    body: soma://andreas/luna
    runtime:  { substrate: soma-daemon, mode: standalone }

  # ─── THIN: Echo (persona + 2 slash-commands, single substrate) ───
  - id: echo
    body: soma://andreas/echo           # ← thin body: ~/.soma/profile/echo/
                                        #    has persona.md + skills/ pointing at
                                        #    /code-review and /security-review.
                                        #    NO telos, ISA, memory, learning.
    presence: { discord: { agentDisplayId: "...", … } }
    runtime:  { substrate: claude-code, mode: in-process }
    capabilities: [code-review.typescript, security-review]   # declared at cortex
                                                              # for capability
                                                              # routing; matches
                                                              # the thin body's
                                                              # declared skills

policy:
  principals:
    - id: luna
      home_principal: andreas
      home_stack: andreas/main
      body: soma://andreas/luna         # ← join key into Soma body (thick)
      role: [agent]
    - id: echo
      home_principal: andreas
      home_stack: andreas/main
      body: soma://andreas/echo         # ← join key into Soma body (thin)
      role: [agent-restricted]          # narrower role for thin reviewer agent
  roles:
    - id: agent
      grants: [keyword.chat, keyword.async, keyword.team, dispatch.*]
    - id: agent-restricted               # ← reinforces §2.5's "thin assistants
      grants:                            #    declare a subset" at the policy layer
        - code-review.typescript
        - code-review.docs
        - security-review
        # No keyword.chat / keyword.async / keyword.team / dispatch.* —
        # thin agents typically don't accept open-ended chat or dispatch to
        # other agents; they execute their declared review capabilities only.
```

The same `policy.principals[].body` join key handles both ends of the spectrum — Soma resolves to whatever subset of the body the assistant has declared. The cortex side doesn't care whether the body has Memory or not; it cares about identity (NKey), routing (capabilities), and the projection adapter call. Thin Echo's projection is small; thick Luna's projection is large; the contract is identical.

Note the `id: luna` / `id: luna-codex` / `id: luna-daemon` are *presence handles* (cortex's perspective — three runtime processes); they all resolve to the same `body: soma://andreas/luna` (one Soma assistant). The `policy.principals[].id: luna` is the bus-level principal; all three presences sign as that principal. Echo only has one presence (single runtime) — typical for thin agents. The chain-of-stamps may need to carry `signed_by[].substrate` to distinguish *which presence* did the work for multi-presence assistants — see §9 Q3.

---

## §8 — `SomaCortexAdapter` — what ships first **within the v3.0.0 cycle**

> **Timing preamble (cross-ref §5).** Per §5's v3.0.0 commit, none of the deliverables below ship in the in-flight v2.0.0 (C.2b/c) cutover. They open the **v3.0.0 cycle**, which begins once C.2b/c has stabilised in production. "Ships first" in this section means "ships first within the Soma cycle", not "ships next on `main`." For the v2.0.0 vs v3.0.0 timeline, read §5.

The first concrete deliverable, once this design ratifies:

1. **`SomaCortexAdapter`** (Soma-side, new) — implements Soma's adapter contract for the Cortex/Myelin substrate. Two projection shapes per `docs/substrate-adapters.md`:
   - **In-process** (`home` mode): projects a Soma assistant into `~/.config/cortex/agents.d/<name>.md` as the thin frontmatter+pointer fragment shown in §7.
   - **Daemon** (`daemon` mode): arc-installs a standalone bot from the Soma package; bot subscribes to Myelin subjects via the existing `MyelinRuntime` interface (no SessionHarness, no in-process spawn — pattern matches sage today).
2. **Schema additions on the cortex side** — add `body: soma://...` to **both** `AgentSchema` (around line 421, for projection) and `PolicyPrincipalSchema` (around line 1124, for federation join) in `src/common/types/cortex-config.ts`. Optional string field at first (back-compat with pre-Soma agents that carry inline persona); cross-field validation enforces that when both are present they agree per id. Becomes the only path at v3.0.0 cutover.
3. **`migrate-config` extension** — when an agent fragment carries inline persona + capabilities + trust, offer to lift those into a new Soma assistant scaffold under `~/.soma/profile/<id>/` and rewrite the fragment to `body: soma://...`. Idempotent. Principal pre-flight via `--check`.
4. **Substrate provenance on chain-of-stamps** — coordinate with myelin#31 on whether `signed_by[].substrate` should be added before Phase D federation locks in. (See §9 Q3 — small extension, much cheaper to add in Phase B/C than retrofit in Phase E.)

None of these is large. The harder work is the design ratification — once §5 sequencing is locked, the implementation is mechanical.

---

## §9 — Open questions

| # | Question | Impact |
|---|----------|--------|
| **Q1** | ~~Fold into Phase C, or defer to v3?~~ **RESOLVED (this round):** defer to v3.0.0. C.2b/c is mid-execution ([PR #291](https://github.com/the-metafactory/cortex/pull/291)) and the metafactory ecosystem consistently moves away from growing scope mid-cutover. Principals pay two migrations; each is small and ratifiable in isolation. See §5 for the runner-up (v2.1.0 additive landing) and what's off the table (v2.0.0 fold). | ~~Schema-flip count: 1 vs 2~~ → committed to 2 |
| **Q2** | **Reference URL grammar.** `body: soma://andreas/luna` or `body: did:mf:luna` (reuse existing DID grammar)? The DID form is already in agent fragments (`did: did:mf:luna`); using it as the Soma reference avoids inventing a new URL scheme. The `soma://` form makes the Soma layer explicit. Lean: reuse `did:mf:` for the principal-facing reference; Soma uses `did` → assistant lookup internally. | Documentation clarity; one fewer URL scheme |
| **Q3** | **Substrate provenance on chain-of-stamps.** If alpha-as-Luna (Cursor) and luna-as-Luna (Claude Code) both sign with the same stack NKey, the audit trail loses substrate provenance. Add `signed_by[].substrate: "cursor" \| "claude-code" \| ...` before Phase D federation locks the envelope schema? | Audit fidelity post-federation |
| **Q4** | **Federation model (§6 option (a) vs (b)).** Should the Phase D cloud network registry return Soma assistant metadata (profile, voice, public capability declarations) — option (a) — or just opaque principal data — option (b)? (a) is the profound version and matches the principal-vision script; (b) is simpler. | Phase D registry schema |
| **Q5** | **Multi-presence trust.** If Luna's `claude-code` presence and `codex` presence are both online for the same principal on the same stack, how does the surface-router decide which one renders a Discord message? Today there's exactly one presence per agent. Soma multi-presence breaks that 1:1 mapping. | Surface-router routing logic |
| **Q6** | **Soma-locality vs federation.** Soma is filesystem-local at `~/.soma/`. Federation means principals from other principals show up. Either (a) extend Soma to cover *remote* assistants discoverable via Phase D cloud registry, or (b) keep Soma local-only and let cortex/Myelin handle remote principals as opaque NKey identities. Q4 and Q6 are the same question viewed from different sides. | Soma scope |
| **Q7** | **Daemon mode + Soma.** Soma's `daemon` mode subscribes to Myelin subjects directly. In cortex's worldview that's an `arc`-installable bot of `type: agent`. Does the Soma daemon ship as its own arc-installable repo (analogous to sage, alpha) or as a Soma command-line mode that the principal invokes from inside the Soma install? The two paths converge in implementation but diverge in principal ergonomics. | Distribution model |
| **Q8** | **Writeback policy reconciliation.** Soma's writeback gate decides what cortex-substrate sessions are allowed to write back to Soma source. Today cortex has no concept of writeback (sessions run, emit envelopes, terminate; no body mutation). Adding writeback means the `ClaudeCodeHarness` needs a hook to capture session-end mutations and hand them to the Soma adapter. Phase scoping. | New cortex hook surface |
| **Q9** | **Agent→principal→body binding rule under multi-presence.** §3's leading answer: every agent declares `body:` (projection target) AND a principal binding (explicit `agent.principal_id` or implicit when `agent.id == principal.id`); the principal carries its own `body:` for federation; both `body:` values for the agent–principal pair MUST equal the same `soma://...` URL. Multiple presence agents bound to one principal therefore share one body. Confirm this is the rule and the agent fragment stays source-of-truth (the agent declares its body; the principal table reflects it for federation lookups). | Where `body:` lives + multi-presence binding |
| **Q10** | **`body:` URL grammar revisited.** Earlier draft listed `soma://andreas/luna` vs `did:mf:luna` as options. With §3 now showing `body:` co-living next to `nkey_pub?` on the principal record, and `did:mf:<name>` already being the assistant DID in `signed_by[].principal`, the natural call is `body: did:mf:luna` — reuse the existing DID, no new URL scheme. The `soma://` form survives only inside Soma's own filesystem layout (`~/.soma/profile/<did-tail>/`). | Documentation clarity |
| **Q11** | **Federation registry layer placement — M6 transport, M7 surface, or part of Soma's M7 protocol?** §1's M7-layer reframe makes this question newly visible. Three coherent answers: **(i)** the Phase D cloud network registry is an M6 (composition) service that *carries* Soma metadata as opaque payload — schema is registry-defined, Soma fills the relevant fields; **(ii)** the registry is M7 infrastructure where Soma daemons publish themselves as peers alongside cortex/pilot/signal-collector — Soma is both a body protocol AND a registry peer; **(iii)** the registry schema itself is part of the Soma M7 protocol — Phase D is plumbing for a Soma-defined registry contract. Lean: **(i)** for v3.0.0 (cleanest layering — Phase D ships independently of Soma), with **(ii)** as the natural follow-up once Soma daemon mode is operational. (iii) is rejected as too coupled. Q4 captures *what* goes in the registry; Q11 picks *who defines the schema* and where the registry sits relative to Soma. | Federation registry ownership |
| **Q12** | **Writeback-gate principal context.** §4 partitions PolicyEngine (dispatch in) and Soma writeback gate (body mutation out). Open: at session-end the substrate emits a writeback — does it carry the principal context (NKey, stack id, chain-of-stamps) or only the body context (which body, what diff)? Stateless-w.r.t.-cortex is simpler; principal-aware is more powerful (writeback policies become principal-aware: "only stack-NKey-signed substrate sessions can mutate Memory; cross-principal delegations can mutate ISA only"). Lean: principal-aware once chain-of-stamps reaches the writeback boundary (Phase B+); stateless for the initial cortex hook in Q8. | Writeback policy semantics |

---

## §10 — Non-goals

- **Not a Soma rewrite.** Soma's core is shipped; this design wires cortex/Myelin in.
- **Not a cortex.yaml redesign.** The §7 delta is additive (`body:` field on `AgentSchema` and `PolicyPrincipalSchema`); the breaking removal of inline `persona:` waits for the v3.0.0 cycle per §5.
- **Not in the v2.0.0 schema flip.** §5 commits to v3.0.0 — the in-flight C.2b/c v2.0.0 cutover ships unchanged.
- **Not an attempt to unify Cortex's PolicyEngine and Soma's writeback gate.** They decide different things (§4); they keep separate identities.
- **Not a new IAW phase.** This is a v3.0.0 cycle on its own (post-C.2b/c stabilisation); the Phase D federation work continues to consume Soma metadata if available, or fall back to opaque-principal otherwise per §6.
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
- `src/common/types/cortex-config.ts` — `AgentRuntimeSchema.substrate` (substrate enum: claude-code / codex / pi-dev / cursor / custom; currently around line 421); `PolicyPrincipalSchema` (around line 1124, post-cortex#243a)
- `src/substrates/claude-code/harness.ts` — `ClaudeCodeHarness` (the substrate-pluggable wrapper, IAW Phase A.1 / cortex#113); instantiated at `src/runner/dispatch-listener.ts:615`
- `src/runner/cc-session.ts` — `CCSession` (the per-dispatch `claude --print` spawner; used as the harness's `ccSessionFactory`)

### Soma (`the-metafactory/soma`)
- [`CONTEXT.md`](https://github.com/the-metafactory/soma/blob/main/CONTEXT.md) — domain glossary (substrate, project/projection, presence, install, writeback, daemon mode, runtime modes, eager/indexed/on-demand, private/protected/generated)
- [`docs/architecture.md`](https://github.com/the-metafactory/soma/blob/main/docs/architecture.md) — SomaCore (Identity, Telos, ISA, Skills, Memory, Policy, Learning)
- [`docs/substrate-adapters.md`](https://github.com/the-metafactory/soma/blob/main/docs/substrate-adapters.md) — adapter contract; existing Codex / Pi.dev / Claude Code / Cortex/Myelin sections (this design extends the last)
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

*This document is the design specification for Soma integration into the cortex/myelin stack. It does NOT include implementation — once the remaining §9 questions (Q2–Q10) ratify (Q1 fold-or-defer was resolved in round 1: defer to v3.0.0), a sibling plan doc will sequence the v3.0.0 cycle. Authored 2026-05-17 by Andreas + Luna; round-1 review by Echo (in-session Architect equivalent, see PR #309 comment thread) applied as commit-after-review. Round-2 ratification awaits @jcfischer.*
