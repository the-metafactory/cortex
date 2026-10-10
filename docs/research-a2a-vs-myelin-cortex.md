# Research: how does A2A compare to myelin/cortex — and where does it fit?

**Status:** research + recommendation · **Date:** 2026-07-08 · **Author:** Luna (with 5 parallel research agents + an adversarial verify pass)
**Prompted by:** the distributed-execution / "distributed hands" thread — a community member (Sumarhús) framed cross-domain comms as *three buses by trust boundary*, which lands on the question: is Google/LF's **A2A** the standard for our **public ring**, and how does it sit against what myelin + cortex already do?

---

## TL;DR / Verdict

**A2A is the metafactory public ring's interop standard — bridge to it, don't build on it.** It belongs at the outer "meet an agent you've never met" boundary; myelin's NATS **federated** bus + sovereignty validation stays the trusted-peer ring behind it; cortex owns the bridge as a boundary surface. The load-bearing fact: **A2A signs the Agent Card (identity); myelin signs every envelope (identity + content + delegation).** A2A's deliberate gaps — no authorization, no sovereignty, no originator chain, no audit — are precisely what myelin already provides, so we can speak A2A at the edge *without inheriting its weaknesses*, as long as we never downgrade to card-only signing.

Three trust rings, stated plainly:
- **local** — inside one stack (myelin `local.*`).
- **federated** — between stacks that have handshaked: trusted, cross-ownership, NSC + sovereignty-validated (myelin `federated.*`). This is where "my head asks your stack to do a job" happens *today*, when trust is pre-established.
- **public** — agents you've never met, no prior handshake. Discovery by signed identity, minimal exposure. **This is A2A's home** (myelin `public.*`).

## What A2A is (verified, mid-2026)

Open protocol, Google-born (Apr 2025), **donated to the Linux Foundation 23 Jun 2025**, Apache-2.0, `github.com/a2aproject/A2A` (~22K stars, 5 SDKs). **v1.0 stable (early 2026)** — minor version is fuzzy across sources (v1.0.x vs a v1.2 announced ~late Mar 2026), so cite "v1.0, 2026". **150+ orgs in production by Apr 2026** (AWS, Cisco, Google, IBM, Microsoft, Salesforce, SAP, ServiceNow, Deutsche Bank; native in Azure AI Foundry, Copilot Studio, Bedrock AgentCore).

Thin by design — "HTTP for agents". Core objects: **Agent Card** (identity + capabilities, discovered at `/.well-known/agent-card.json`), **Task** (8-state lifecycle), Message, Part, Artifact. **Opaque-agent model** — internals (tools, memory, prompts) never cross the boundary; only task I/O + capability metadata do. Transports: JSON-RPC 2.0 (primary), gRPC, HTTP/REST; SSE streaming + webhooks for async. **MCP is complementary, not competing** — A2A is horizontal (agent↔agent), MCP is vertical (agent↔tool); you'd run both, MCP beneath A2A. **AP2** (Agent Payments Protocol, launched **Sept 2025**, 60+ orgs) is the A2A extension for agent commerce via signed Mandates.

## A2A vs myelin — the comparison

| Concern | A2A | myelin | Relationship |
|--------|-----|--------|--------------|
| Discovery | Agent Card (JWS-signed, domain-bound, public, mutable) | L5 capability registry (KV, operator-scoped) | **rhyme** — A2A is public+mutable, myelin operator-controlled |
| Task model | Task lifecycle, `contextId` links related work | L6 task envelope, `correlation_id` | **rhyme** — A2A lacks per-envelope sovereignty |
| Signature | **Card only** (RFC 7515 JWS + RFC 8785 JCS) | **Every envelope** end-to-end (Ed25519 chain-of-stamps: payload + identity) | **myelin strictly stronger** |
| Identity | domain PKI ("trust the domain name") | `did:mf:` principals in an operator registry ("trust the handshake") | different roots — reconciliation is the hard part |
| Delegation / on-behalf-of | `contextId` metadata; scoped tokens, no originator chain | `originator` field (#160) + `signed_by` chain = cryptographic proof-of-orchestration | **myelin fills A2A's biggest gap** |
| Authorization | **out of scope** — implementer's job | policy at ingress | myelin owns it |
| Sovereignty (classification, residency, max-hop) | **none** | declared per-envelope (L3), validated at ingress/egress (NSC + F-5) | **A2A has no equivalent** |
| Trust boundary | cross-org public API | `public.*` namespace | A2A = the public ring's transport |

**The one distinction that governs everything:** A2A proves *who published the card* and then rides task payloads on bearer/OAuth tokens; myelin signs the *content of every message* end-to-end. A2A explicitly leaves authorization, credential provisioning, key rotation, input validation, and audit to the implementer ("robust like HTTPS — the standard is secure, implementations frequently aren't"). Those are exactly myelin's built-ins. **So A2A's weaknesses are our differentiators.**

Reality check on maturity: **only ~11–14% of A2A pilots reach production** — the rest stall on governance, identity fragmentation, and audit gaps. Documented attacks (agent impersonation ~70% success in discovery spoofing, Agent Card spoofing via DNS/CDN, prompt-injection propagation, agent-in-the-middle via inflated card descriptions) all have implementer-owned mitigations. This is a "bridge to it, keep your own trust core" signal, not a "rebuild on it" one.

## Where it fits: the bridge as a cortex boundary surface

Cortex already owns the operator/federation boundary (dispatch, surfaces, approvals, egress checks). The A2A bridge is a **cortex M7 service**, not part of core myelin:

- **Egress (internal → public):** wrap a myelin task envelope as an A2A task — map `originator.identity` → A2A caller, mint a short-lived JWT (5–10 min, unique `jti`) from the myelin principal for A2A auth, map `requirements[]` → A2A skill tags, publish **only** when `sovereignty.classification == public`, and drop residency/max-hop (A2A can't carry them).
- **Ingress (public → internal):** verify the Agent Card signature **before parsing it** (context-poisoning defense), wrap the A2A result in a myelin envelope signed by the **bridge principal**, set `originator.attribution = federated`, default incoming `max_hop = 1`, and validate the claimed origin against the sovereignty policy's `imported_principals`.
- **Hard part — identity reconciliation:** A2A's domain PKI vs myelin's `did:mf` registry. The bridge maintains an issuer-domain → operator map and **pins card versions** (public cards are mutable → rug-pull risk).

**What myelin must NOT give up at the edge:** end-to-end envelope signing, the chain-of-stamps audit trail, ingress sovereignty validation (nak *before* the agent sees a task), and the `subject-prefix ↔ classification` invariant. These are our federation-safety gates — A2A has none of them.

## Worth thinking about: A2A over async mail (AMTP / AAMP)

Sumarhús runs a hand-rolled **A2A-over-email** channel for cross-ownership-boundary comms. That instinct is worth taking seriously, and it now has standardized cousins:

- **AMTP** (Agent Message Transfer Protocol, `amtp-protocol.org`) — A2A-style messaging over SMTP with **DNS-TXT discovery**, HTTPS gateways, **at-least-once delivery + idempotency**, structured JSON payloads with stronger semantics than raw email, transparent SMTP bridging.
- **AAMP** (Asynchronous Agent Message Protocol, larksuite) — turns mailboxes into agent task networks (`task.dispatch`, `task.result`, `task.help_needed`) with sender-policy controls.
- Also seen: A2A ↔ **Kafka** via a "Return Inbox" pattern (async request/reply over a broker).

**Assessment — is it worth it?** The *pattern* is: yes, genuinely. A public ring wants an **async, store-and-forward, human-inspectable, no-public-ingress** transport, and mail is a battle-tested such substrate — federated, DNS-discoverable, offline-tolerant, auditable, and it degrades gracefully when the far side is asleep. That aligns tightly with three things we already believe: **no public ingress** (mail needs no inbound listener), **human-in-the-loop across ownership boundaries** (a mailbox is inspectable/approvable), and **Sumarhús's working precedent**. It's the natural async complement to A2A-over-HTTPS (synchronous, well-known-URL discovery).

**But** — treat AMTP/AAMP as *references, not commitments*: both are 2025–2026 and their production adoption is unverified. The durable bet is the pattern (myelin-signed messages carried over a store-and-forward substrate), transport-agnostic. Concretely: the same bridge that speaks A2A-over-HTTPS could carry the same A2A/myelin payloads over mail, so **transport is a bridge config, not an architecture fork.** A small design spike ("public ring: sync HTTPS vs async mail — when each") is warranted; a commitment to a specific mail protocol is not, yet.

## Recommendation + sequencing

1. **Now:** nothing changes. A2A doesn't touch the near-term spawn/cortex work (execution engine, the SpawnHandle interface, bus binding). It's a *boundary* concern.
2. **After the federated ring is real** (myelin bus binding + spawn phases 0–3): build the A2A bridge as a cortex boundary service — the natural home for the public surface once trusted-peer federation works.
3. **Then:** operate a metafactory A2A registry (verify cards, map issuers → operators) and enable cross-operator public flows, each gated by the operator's sovereignty policy. Fold the async-mail (AMTP/AAMP) decision in here as a transport option, not a rewrite.

## Corrections the verify pass caught

Signed cards use **RFC 7515 (JWS) + RFC 8785 (JCS)**, not RFC 9421 · **AP2 launched Sept 2025**, not May 2026 · A2A minor version is ambiguous (v1.0.x vs v1.2) — cite "v1.0, 2026".

## Provenance

Workflow `wf_f6845960-6f4`, 2026-07-08: 5 researchers (A2A mechanics, trust/security, governance/adoption, ecosystem/AP2/MCP, and a myelin-fit agent that read the myelin architecture/envelope/identity/sovereignty/namespace/task-routing docs) → an adversarial verify pass (12 verdicts, 3 corrections). Companion to the spawn design corpus (`distributed-hands-vision.md`, research 06/07, `bring-spawn-to-life.md`) and to `docs/research-federation-decentralization.md` here in cortex.
