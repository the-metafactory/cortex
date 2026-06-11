# Design: Capability Offering & Visibility — the third leg of the control plane

**Status:** Draft
**Stage:** design spec (+ ADR-0008)
**Author:** Andreas + Luna
**Date:** 2026-06-11
**Epic:** [cortex#939](https://github.com/the-metafactory/cortex/issues/939)
**Refs:** CONTEXT.md §Capability / §Scope / §Dispatch · `docs/adr/0003-network-join-control-plane.md` · `docs/sop-federation-onboarding.md` · `docs/design-agentic-dev-pipeline.md` (the dev-loop — first customer, wave-5 #887/#925) · `docs/design-capability-dispatch-review-consumer.md`

---

## 1. Problem — capability declaration is scope-blind

The metafactory control plane has two legs today:

```
cortex stack    → stand one up        (your factory exists)
cortex network  → federate it         (your factory joins a network)
```

But there is no third leg for **what your factory offers, and to whom.** A stack declares capabilities as a flat list — `runtime.capabilities: ["chat", "code-review.typescript", "dev.implement", …]` — with **no scope dimension.** A capability is just a tag. Whether it is reachable cross-principal is decided coarsely and elsewhere: `announce_capabilities` + `accept_subjects` at network-join time (`sop-federation-onboarding.md`), the registry that publishes "pubkey + capabilities," and the `local.`/`federated.`/`public.` scope prefix on the wire.

So the primitives exist but are **scattered and all-or-nothing**: you join a network, you announce capabilities, and roughly everything you declare is reachable by that network. There is no per-capability policy — *"I offer `dev.implement` only to my own stacks, `code-review.typescript` to the public square, `chat` to my federated network."*

This is the **service-mesh / API-gateway exposure model**, applied to agentic work: you have services (capabilities), and you control each one's exposure (internal / VPC-peered / public) and who may call it. The dev-loop forces the question — its capabilities (`dev.implement`, `merge.approve`, `release.cut`) are *internal by nature*; you would never let a stranger run dev or merge your PRs — so "enable the dev-loop on a stack" cannot be a flag flip without answering *"…and at what scope."*

And the inverse is the prize: **`code-review.typescript` is a capability worth offering publicly.** An external contributor opening a PR against a public meta-factory repo should be able to have it reviewed — and *my* assistants can be the ones who claim and fulfill that review. That is the Internet of Agentic Work made concrete: a two-sided capability marketplace.

## 2. The model — capability offering = `(capability × offer-scope × accept-policy)`

A **capability offering** elevates a flat capability tag into a policy triple:

| Field | Meaning | Values |
|---|---|---|
| **capability** | the bus-routable ability (unchanged) | `code-review.typescript`, `dev.implement`, `chat`, … |
| **offer-scope** | the scope(s) at which the capability is *reachable* | a subset of `{local, federated, public}` — a capability MAY be offered at several |
| **accept-policy** | within an offered scope, *who* may dispatch it | e.g. `network:<id>`, `public:rate-limited`, `pr-against:the-metafactory/*`, `principals:[…]` |

Two load-bearing rules:

- **Default-deny, opt-in-widen (security-first).** Every capability defaults to **`local`-only** offer-scope. You explicitly widen to `federated` / `public`. The secure default is *internal*; exposure is a deliberate act. (This is also why the dev-loop is dormant-by-default — it is the *correct* default of this model, not a special case.)
- **Offering GENERATES the existing federation config — it does not replace it.** The offering policy is the single source of truth *above* `announce_capabilities`, `accept_subjects`, and the registry registration. `cortex offer …` recomputes those from the policy. We **unify, not rebuild** — the wire grammar and registry already enforce scope; offering is the policy that populates them.

The wire already carries scope (`local.`/`federated.`/`public.` prefix); offering is the **policy layer above the transport** that decides which scope prefixes a capability's consumer is bound on, and what the gate admits.

## 3. Worked example — the public PR-review marketplace

The motivating case, traced end to end. An **external contributor** (no stack, no nkey) opens a PR against a public meta-factory repo, and *my* assistant reviews it.

```
External contributor → opens PR on a public the-metafactory/* repo
   gh-webhook tap (src/taps/gh-webhook) validates HMAC, translates the PR-opened event into:
   →  PUBLIC Offer:  public.the-metafactory.<repo>.tasks.code-review.typescript
                      { originator: {github: <login>, pr: <url>}, payload: {repo, pr, diff-ref} }
   Stacks that OFFER code-review.typescript at PUBLIC scope (my Echo) see the Offer:
   →  Echo claims it (competing-consumer, exactly-once) — IF its accept-policy admits
        "a PR against a repo I offer review for"
   →  Echo runs the review, posts to GitHub (gh pr review) + emits the verdict
   →  dispatch.task.completed — the contributor sees the review on their PR
```

The asymmetry is the whole point:

- **I am the provider.** I offer `code-review.typescript` at `public` scope. My assistants earn (or donate) the work.
- **The contributor is a consumer — via a surface, not a stack.** They never hold a bus identity. GitHub *is* their trust anchor: the Offer's `originator` is their GitHub login + the PR URL, and the accept-policy gates on *"is this a real PR against a repo I offer review for"* — not on a bus pubkey.
- **`dev.implement` / `merge.approve` / `release.cut` stay `local`.** You offer *review* to the world; you never offer *write/merge/release* on your own repos to a stranger. The model makes that asymmetry expressible and enforceable.

This is the first revenue-or-community-shaped surface of the IoAW: a public capability with a real external consumer.

## 4. The control-plane third leg — `cortex offer`

```
cortex stack     → exists
cortex network   → federated
cortex offer     → capabilities exposed        ← NEW
```

| Command | Purpose |
|---|---|
| `cortex offer <capability> --scope <local\|federated\|public> [--accept <policy>] [--network <id>]` | Widen (or set) a capability's offer-scope + accept-policy. Default-deny: a capability not offered is `local`-only. Regenerates `announce_capabilities` / `accept_subjects` / registry registration. Dry-run by default; `--apply`. |
| `cortex offer list` | Show every capability the stack's agents hold and its current offer-scope + accept-policy + which agent provides it. The "what do I expose, to whom" view. |
| `cortex offer revoke <capability> [--scope <s>]` | Narrow a capability back (down to `local`). Idempotent. |

The offering policy lives in config (a new `policy.offerings[]` block on the stack layer — see §6), so it is declarative + reviewable + version-controlled like the rest of the config-split. `cortex offer` is the ergonomic front-end; editing the config block by hand is equivalent.

## 5. Gate posture is a function of offer-scope

The further out you offer, the more the gates matter. Offer-scope *raises the trust floor* (it does not change the orthogonal signing posture knob — it sets a *minimum*):

| Offer-scope | Trust anchor | Minimum gates |
|---|---|---|
| **local** | the home bus (your own stacks) | none beyond the bus |
| **federated** | the registry (pinned), peer pubkeys | signing ≥ permissive; accept-policy = network roster |
| **public** | the *surface* (e.g. GitHub identity) + rate limit | signing enforce (for bus peers); compliance gate; rate-limit; accept-policy bounds *what* may be asked (the offered capability only, never a sibling) |

The dispatch refusal taxonomy already has the vocabulary for the public floor: `policy_denied` (accept-policy refused), `compliance_block` (compliance gate), `not_now` (rate-limit backpressure). Offering at `public` simply makes those gates non-optional.

## 6. Unify, don't rebuild — relationship to existing primitives

The offering policy is the **source**; these existing artifacts become its **projections**:

- `runtime.capabilities[]` — what an agent *holds* (unchanged). Offering decides the *scope* each is reachable at.
- `announce_capabilities` / `accept_subjects` (federation) — **generated** from the offerings whose scope includes `federated`/`public`.
- registry `provision-stack register` (pubkey + capabilities) — registers the *publicly/federated-offered* subset, not the whole list.
- the scope prefix on the wire — already the enforcement; offering decides which prefix a capability's consumer binds on.

New config (stack layer): `policy.offerings: [{ capability, scopes: [...], accept: <policy>, network?: <id> }]`. The boot composer + the consumer-wiring read it to decide which scope prefixes each capability's JetStream consumer subscribes on, and the federation/registry config is regenerated from it.

## 7. Decisions (this design locks)

- **DD-CO-1 — Capabilities carry an offer-scope; default is `local`-only, opt-in-widen.** The secure default is internal exposure; widening is deliberate. *(ADR-0008.)*
- **DD-CO-2 — Offering is the single source of truth; it GENERATES `announce_capabilities`/`accept_subjects`/registry registration.** Unify, do not duplicate.
- **DD-CO-3 — Offer-scope raises the gate floor.** `public` ⇒ signing-enforce (bus peers) + compliance + rate-limit + bounded accept-policy; `federated` ⇒ registry-trust; `local` ⇒ home-bus. Orthogonal to but a floor on the signing-posture knob.
- **DD-CO-4 — Public consumers reach offered capabilities through surfaces, not stacks.** The marketplace is *consumer-via-surface, provider-via-stack*; the surface (GitHub) is the public consumer's trust anchor; the accept-policy bounds the request to the offered capability.
- **DD-CO-5 — `cortex offer` is the third control-plane leg** (stack → network → offer), with the offering policy declarative in the config-split.

## 8. Feature breakdown (the epic slices)

- **CO-1 — the offering policy model + config.** `policy.offerings[]` schema, default-deny resolution, the `(capability, offer-scope, accept-policy)` types, validation. The data model + loader, no behavior change yet (every capability resolves to `local`, byte-identical).
- **CO-2 — consumer wiring reads offer-scope.** A capability's JetStream consumer binds on the scope prefixes its offering admits (today: always `local`). Provingly inert until something is offered wider.
- **CO-3 — `cortex offer` CLI** (set / list / revoke) + offering→federation-config generation (the unify layer over `announce_capabilities`/`accept_subjects`/registry).
- **CO-4 — gate posture per scope.** Wire the §5 floor: public ⇒ enforce + compliance + rate-limit + bounded accept-policy; the `policy_denied`/`compliance_block`/`not_now` refusals.
- **CO-5 — the public PR-review marketplace (the dogfood).** gh-webhook tap emits a `public.…tasks.code-review.*` Offer on a PR to a public repo; a stack offering `code-review.*` at public scope claims + fulfills it. End-to-end, observable on the dashboard.
- **CO-6 — dev-loop integration (W5.1 re-pointed).** "Enable the dev-loop" = `cortex offer dev.implement/merge.approve/release.cut --scope local`; a clean instance of the general model. (Replaces the bespoke framing in cortex#925.)

## 9. Open questions

1. **Public requester identity.** A GitHub contributor has no nkey. The surface (GitHub HMAC-validated webhook) is the trust anchor; the Offer carries the GitHub identity as `originator`. Is that sufficient, or do public offers need a lightweight requester-token? *(Lean: surface-anchored is enough for the PR-review case; revisit for non-surface public dispatch.)*
2. **Accounting / cost for public work.** Reviewing a stranger's PR costs tokens. Ties to the stubbed `BudgetCheck` building-block gap — public offerings need a budget/rate posture so a public capability can't drain a principal.
3. **Capability versioning + SLAs for public offers.** `code-review.typescript@v1`? Discoverability of *who* offers what publicly (a registry-of-public-offerings)?
4. **Compliance scope for public review.** What may a public reviewer's output contain (no leaking of the reviewing principal's private context — ties to the §interior-privacy model: `local`-only trace).
5. **Relationship to `chat` public offering.** `chat` is the obvious second public capability (a public-facing assistant). Does it share the marketplace plumbing or need its own?
