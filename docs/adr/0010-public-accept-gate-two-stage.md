# ADR-0010: The public accept-gate is a two-stage gate — deterministic metadata-only admission before any LLM sees content

**Status:** Accepted
**Date:** 2026-06-11
**Context refs:** ADR-0008 (capability offering & scope) · `docs/design-capability-offering.md` §6 (threat model, M1–M6) · CONTEXT.md §Capability offering · `src/taps/gh-webhook/`

## Context

A `public` capability offering (e.g. `code-review.typescript`) means **attacker-controlled content** (a PR's title/description/diff/comments) becomes input to an LLM reviewer, whose output then egresses back to a public surface. This is indirect prompt injection — the highest risk in the offering model (ADR-0008 DD-CO-6, design §6).

The decisive question is *where* and *on what data* the decision to admit a public request is made. If admission depended on reading the request's content — or ran through an LLM — the attacker could *talk their way past the gate*. The asymmetry that saves us: the webhook's **origin** (HMAC-validated), the **repo**, and the **sender's surface identity** are trustworthy (the surface, e.g. GitHub, asserts them; the HMAC proves the webhook is genuine), whereas the request's *content* is not.

## Decision

A public offering is admitted through a **two-stage gate**:

1. **Stage 1 — deterministic, pre-LLM admission at the tap.** Whether to claim/process a public Offer is decided **in code**, from **surface-asserted trustworthy metadata only** — `(HMAC-validated origin, repo, sender identity, rate/budget)` — with **zero LLM involvement** and **zero dependence on attacker-controlled content.**
2. **Content-dependent accept-predicates are forbidden.** Accept-policy predicate types for `public` are constrained to what Stage 1 can evaluate deterministically (repo-membership, sender allow/block, signature, rate). A predicate that reads the PR's content (e.g. "review PRs whose description contains X") is rejected — the attacker controls X.
3. **The public requester's identity is the surface-asserted, HMAC-validated surface identity** (e.g. the GitHub login) + repo + request coordinates — *that* is the `originator`. There is no bus pubkey for a public requester; the gate trusts the surface's assertion of *who/what*, never the request's self-description.
4. **Content reaches the reviewer only after Stage 1 passes**, where it is handled as untrusted data per the §6 mitigations (M1 boundary, M2 least-privilege, M3 sandbox, M4 egress control).

**The line:** the attacker's content can never influence *whether it gets in* — only *what a sandboxed, least-privileged reviewer says about it once it's in.*

## Consequences

- The gh-webhook tap (`src/taps/gh-webhook`) owns Stage 1 for the PR-review marketplace: validate HMAC → evaluate the metadata-only accept-policy → only then emit the `public.…tasks.code-review.*` Offer. No Offer is published for a request that fails Stage 1.
- Accept-policy schema (ADR-0008) gains a hard validation: `public` predicates must be metadata-evaluable; content-referencing predicates fail schema validation, not runtime.
- CO-5 (the public marketplace) and CO-7 (injection hardening) inherit this as their admission contract; CO-4 (gate posture) enforces it.
- Federated offerings get the same shape for free (the registry-roster membership check is a Stage-1 metadata gate), at a lower trust bar.

## Alternatives considered

- **LLM-mediated triage of inbound requests** ("let the reviewer decide if this PR is in scope"). Rejected: it puts attacker content upstream of the admission decision — exactly the injection surface the gate exists to close.
- **Content-dependent accept-policies** (label/description predicates). Rejected: the attacker controls those fields; they cannot be a trust input.
