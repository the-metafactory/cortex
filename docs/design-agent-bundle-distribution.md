# Design — Distributing multi-agent bundles via arc + capability offerings

**Status: Accepted — principal-approved 2026-06-18**

**Refs:** cortex#1133 (umbrella) · cortex#1021 (bot packs / B-0 #1027) · cortex#939 + #962 (capability offering, CO-1) · `docs/adr/0008-capability-offering-scope.md` · `docs/adr/0009-offerings-per-stack-no-shared-layer.md` · `docs/adr/0010-public-accept-gate-two-stage.md` · **`docs/adr/0014-capability-authorized-agents.md`** (this design's new decision) · cortex#1071 (offer folds `agents.d`) · the-metafactory/dev-loop (the bundle) + dev-loop#4 (`trust:[]`) · the-metafactory/yarrow (the single-bot reference) · the-metafactory/arc#244 (arc lane) · cortex#129 (install validation) · `CONTEXT.md` §Identity&trust / §Capability offering · compass `sops/federation-wire-protocol.md`

> **Provenance.** Synthesized from the 2026-06-18 dev-loop "make-it-live" + distribution work. The headline: the pieces are ~built (yarrow proved the single bot-pack; arc's `installLibrary` proves library fan-out; the offering model + AgentSchema exist) — what was missing is a *coherent contract* for distributing a **bundle of agent blueprints**, plus the removal of two recurring mis-models (transport reinvention, coordinator-name trust). This is a convergence + correction plan, not an invention.

---

## 1. The problem

The dev-loop (and any future multi-agent product — a review fleet, an onboarding tender, a SOC triage team) is **a bundle of cooperating agents**, not one bot. We want to distribute it the way yarrow distributes a single bot-pack: **one `arc install`**, from the GitHub org repo during beta, from **meta-factory.ai** once it's through beta. Installing it onto any cortex stack should *enable the loop* — drop the agents, provision their state + creds, wake their dormant consumers — with **zero per-principal hand-wiring**.

Two recurring mis-models blocked this, both corrected this cycle:

1. **Transport reinvention** — the bundle's publishers hand-rolled NATS connect + signing instead of delegating to the Myelin runtime (cred-less connect → `Authorization Violation` on the operator-mode bus). Fixed: pilot#168/#171, cortex#1125. Principle: *bus work delegates to `MyelinRuntime`/`runtime.publish`; never hand-roll the wire.*
2. **Coordinator-name trust** — the worker fragments hardcoded `trust:[pilot]` (the loop-driver's name), which is a category error (bot-attribution ≠ capability authorization) and breaks the boot trust-closure on any stack where that name isn't registered — including a per-principal rename (`pilot→vega`). Fixed: dev-loop#4. Decision: **ADR-0014**.

## 2. The model

A distributable agent bundle is an **arc `type: library`** whose artifacts are `type: agent` **bot-packs** (cortex#1021) plus a `process` definition and an optional `skill`. dev-loop is the proving case: `agents/{dev,release,approver}` (in-process capability workers) + `agents/pilot` (the standalone loop-driver daemon) + `process/` + `skill/`, depending on `cortex` / `pulse` / `agent-state`.

### 2.1 Workers are generic; authorization is on the wire
A worker **declares a capability** and `trust:[]`. It is **not** wired to a named coordinator. *Who* may invoke it is decided by the protocol, not the fragment (ADR-0014; grounded in `CONTEXT.md` §Identity&trust / §Capability offering + the federation-wire-protocol SOP):

- **capability** — the JetStream consumer claims `tasks.{capability}` (Offer mode).
- **signed `originator`** — the requester's principal DID rides the envelope; the **stack** signs (M3). Local: **own-stack implicit trust**. Federated: the requester must be a `peers[]` member + the `signed_by` chain verifies under `signing: enforce`.
- **capability offering** — the `(capability, offer-scope, accept-policy)` triple (ADR-0008) is the authorization policy. **Default-deny ⇒ `local`-only**; `federated`/`public` are deliberate widenings. The offering *generates* `accept_subjects` — it **is** the "who may invoke," not a per-agent list.

The agent `trust:[]` field is for Discord *peer-bot attribution* (agents with presence), irrelevant to a headless worker. **Reference: yarrow ships `trust:[]`.**

### 2.2 The coordinator self-names
The loop-driver (dev-loop's `pilot`) carries the coordination logic. Its identity is **configurable per principal** (`PILOT_AGENT_NAME`, pilot#173) — Andreas runs `vega`, JC runs `pilot` — and rides the envelope as `originator`. The workers never reference it by name, so the same bundle deploys for every principal unchanged. (ADR-0014.)

## 3. Deploy mechanics

`arc install <library>` (whole-library ref; `arc install <library>:<artifact>` for one) **fans out** to install every member artifact — `installLibrary` (arc#227/F-6c: ordered, journaled, resumable). Per `type: agent` artifact, arc's cortex host:

1. drops `agent.yaml → {stack}/agents.d/<id>.yaml` + `persona.md → personas/<id>.md` (verbatim symlink — cortex validates `runtime`/`brain`/`capabilities` on reload),
2. provisions per-agent **NATS creds** + scaffolds **agent-state** (`identity-provision.ts` four-folder + `state.sqlite`),
3. postinstall **reloads cortex** → the agent registers; `deriveEffectiveCapabilityCatalog` synthesizes `provided_by:[<id>]`; the dormant consumer (shipped in cortex) wakes.

**Offering integration (cortex#1071, done):** `cortex offer set/list` now folds `agents.d` so a bot-pack-provided capability is offerable beyond `local`. Without it, an arc-installed bot-pack's capability is live-for-claim but invisible to the offer control plane.

## 4. Lanes

| Lane | Scope | State |
|---|---|---|
| **cortex** (this principal) | `offer` folds `agents.d` (#1071); dev-loop bundle workers `trust:[]` (dev-loop#4) | ✅ **done** |
| **arc** (parallel agent) | `type:agent` install currency vs evolved `AgentSchema`; confirm `installLibrary` fan-out for a current bundle; offering boundary; `add-bot→add-agent` (#242) | 🔭 **arc#244** |
| **joint** | `arc install` the dev-loop bundle on a scratch stack — end-to-end (fan-out + agent-state + creds + reload + offer) | ⏸️ **#129**, after arc#244 |

## 5. Trajectory

- **Beta:** `arc install https://github.com/the-metafactory/<bundle>` from the GH org repo (arc resolves GitHub URLs). yarrow + dev-loop both install this way; neither is on the marketplace yet.
- **Post-beta:** package + publish to **meta-factory.ai** → `arc install <bundle>` from the registry. Gated by the onboarding chain: a bundle's deps must be onboarded first (dev-loop → {cortex, myelin}; cortex → myelin), and none of myelin/cortex are on the marketplace yet.

## 6. Decisions → ADR

- **ADR-0014 — Capability-authorized agents + per-principal coordinator identity.** Workers are `trust:[]` and authorize by capability + signed `originator` + offering accept-policy; the coordinator self-names (`PILOT_AGENT_NAME`). (New, this design.)
- Offering scope/accept-policy/public-gate: **ADR-0008 / 0009 / 0010** (existing).

## 7. Open questions

1. **agent-state for in-process workers** — the loop-driver needs its errand store; do headless capability-workers need a scaffolded `state.sqlite`, or only the daemon-mode coordinator? (Confirm during #129.)
2. **arc-primitive currency** — does arc's `type:agent` manifest validation accept a current bot-pack's `runtime.brain`/offering shape unchanged? (arc#244.)
3. **Default `local` offering at install** — should `arc install` seed a default `local` offering for each agent's capability, or leave it implicit (default-deny `local` needs none)? Leaning *implicit*.
4. **Marketplace onboarding chain** — the myelin→cortex→dev-loop sequence is a separate effort; this design assumes git-install for beta.
