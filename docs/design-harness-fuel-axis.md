# Harness fuel — separating "which agent runtime" from "what pays for inference"

**Status:** Proposed
**Date:** 2026-07-16
**Scope:** Whether `inferenceProfile` should fuel any substrate, not only `api-agent`
**Follows:** [`design-api-model-provider-support.md`](design-api-model-provider-support.md) (Phase 0 + 1 shipped, epic #2055)

## Summary

Cortex models three axes: **execution** (where a harness runs), **substrate** (which harness), and
**inference profile** (which provider/model an API harness calls). The third is scoped to exactly one
substrate — only the `api-agent` branch of `HarnessResolver` consumes it.

That welds together two independent things:

- **harness capability** — a full agent runtime (tools, hooks, permissions, resumable sessions) vs a bare inference loop
- **fuel** — what backs the inference and who pays for it

Today you can express *"bare harness + metered API."* You cannot express *"full harness + cheaper fuel."*
This note argues **fuel is a fourth axis**, that Claude Code already proves it is separable, and that the
Phase 0 work is the prerequisite for modelling it — but that a licensing constraint removes the most
attractive-sounding leg of the idea.

## Why this matters: we optimised the cheap half

`ApiAgentHarness` is text-only and ships **no tools** by design (D5, enforced structurally — `ModelRequest`
has no `tools` field). So it *structurally cannot serve the expensive workload*. The token spend lives in
coding agents: long tool loops, large contexts. `api-agent` can only serve chat, classification,
summarization, research synthesis — the cheap tail.

The Phase 0/1 design is explicit about this ("without claiming coding-agent parity"), but its economics
framing (D6, `modelClass`, cost attribution) implies a cost lever the slice cannot pull. **The lever that
would matter is running the full Claude Code harness on cheaper fuel** — and cortex cannot currently
express that.

## What was verified

Verified against Claude Code documentation on 2026-07-16. Confidence marked per row; do not treat the
low-confidence rows as settled.

| Claim | Verdict | Confidence | Source |
| --- | --- | --- | --- |
| Base URL is overridable (`ANTHROPIC_BASE_URL`), plus `ANTHROPIC_CUSTOM_HEADERS` | **True, documented** | High | `code.claude.com/docs/en/llm-gateway-connect` |
| Documented auth precedence: cloud-provider flags (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`) → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → subscription OAuth | **True, documented** | High | `.../authentication` |
| Model selectable via `--model` > `ANTHROPIC_MODEL` > `settings.json` > picker > default | **True, documented** | High | `.../model-config` |
| Bedrock / Google Cloud Agent Platform / Microsoft Foundry are first-class documented backends | **True** | High | `.../amazon-bedrock`, `.../google-vertex-ai` |
| **Subscription OAuth cannot point at a non-Anthropic base URL** | **True** | High | `.../llm-gateway-connect` |
| **Subscription plans prohibit *unattended* automation; API-key billing required for fleet/scripted use** | **Probably true** | **LOW — see below** | support article + third-party summary of a Feb 2026 ToS update |
| Non-Anthropic models behind a translating proxy (LiteLLM/OpenRouter): tool-use fidelity, vision, streaming | **Undocumented** | — | Docs are silent. Community practice only. |
| `CLAUDE_CODE_OAUTH_TOKEN` legitimacy for unattended fleet use | **Unresolved** | Low | Docs describe it for "CI pipelines"; parent Consumer Terms may restrict. |

### The load-bearing uncertainty

The ToS constraint is the single most consequential input to this note and it has the **weakest sourcing** —
a support article plus a third-party blog summarising a ToS update, not linked ToS text. **This must be
confirmed with Anthropic before any decision rests on it.** It is called out here rather than laundered into
a conclusion.

## What this changes

**The framing is not "subscription vs on-demand."** For cortex's dispatch path — an unattended fleet of
launchd daemons consuming a bus — subscription is (probably) not a permitted fuel at all. So the axis is:

| Path | Attended? | Fuels available |
| --- | --- | --- |
| Dispatch (bot/daemon, bus-driven) | No | API key · LLM gateway · Bedrock · Vertex · Foundry |
| Instrumented interactive session (`cldyo-live`, human at keyboard) | Yes | Subscription OAuth **and** all of the above |

That distinction is real and cortex does not currently represent it.

### A pre-existing question this surfaced (not introduced by epic #2055)

`ClaudeCodeHarness` spawns `claude --print` subprocesses for dispatch — **unattended**. If those inherit a
machine's interactive OAuth subscription login, that is the pattern the terms appear to prohibit, and it is
true **today**, independent of any of this work.

- [ ] Determine what credential cortex's dispatched CC subprocesses actually use in the live deployment.
- [ ] Confirm the terms position with Anthropic (see the load-bearing uncertainty above).

This is a compliance question, not an architecture one, but the fuel axis is what made it visible.

## Proposal

**Model fuel as a property any harness can consume; each harness declares which fuels it accepts.**

| Harness | Fuels it can accept |
| --- | --- |
| `claude-code` | api-key · gateway (base-URL + token) · bedrock · vertex · foundry · *(subscription — attended only)* |
| `api-agent` | any inference profile (native Anthropic, OpenAI-compatible, local) |
| `pi-dev` / `cursor` / `gemini` / … | their own mechanisms |

Concretely, the next increment is **let `claude-code` consume an `inferenceProfile`**:

`ClaudeCodeHarness` already owns translation from `DispatchRequest` → `CCSessionOpts`. Extend it to
translate a resolved profile → subprocess env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`, or the Bedrock/Vertex/Foundry flags). That is squarely in its
existing remit.

### Why the shipped work is the prerequisite, not a detour

Phase 0 built exactly the vocabulary and seams this needs:

- **`inference.profiles`** — provider, model, bound, credential-as-reference, `modelClass`, `dataResidency`,
  cost identity. That already describes *fuel* for any harness, not just ours.
- **The registry** — resolves a profile → a concrete thing. For `api-agent` that's a `ModelProvider`; for
  `claude-code` it would resolve to **env vars**. Same seam, different translation.
- **`HarnessResolver`** — the exact injection point where fuel would be handed to a harness.
- **D6 policy-bearing profiles** — right regardless of which harness burns the tokens.
- **Secret references** — `apiKeyHelper` (a shell command emitting a credential) maps cleanly onto cortex's
  reference model and would suit rotation; worth evaluating over a raw env var.

### Why `api-agent` still earns its place

Not redundant, just aimed at the cheap tail: in-process with no `claude` binary; reachable in
worker/bus-peer contexts where the CLI can't run; local models without CC in the loop; and Cortex-canonical
transcripts (D4) that survive provider migration.

## Risks

1. **Quality cliff, undocumented.** Claude Code emits Anthropic Messages shape. Behind a proxy translating to
   a non-Anthropic model, tool-use schemas, vision and streaming **may degrade silently** — and Anthropic's
   docs say nothing and support won't cover it. Cheap fuel on a full harness is *not* free: it needs
   per-model evaluation, not assumption. This is where `modelClass` on a profile earns its keep.
2. **The ToS constraint is under-sourced** (above). If it is wrong, the attended/unattended split collapses
   and the axis is simpler. If it is right, cortex may have a live compliance gap today.
3. **Fuel is not freely composable.** Subscription OAuth binds to Anthropic's endpoint. So "any harness ×
   any fuel" is a lattice with holes, not a clean product — the model must express which combinations are legal.

## Open questions

1. Does cortex's dispatched `claude --print` currently ride a subscription OAuth? (compliance, urgent-ish)
2. Is `CLAUDE_CODE_OAUTH_TOKEN` legitimate for unattended fleet use, or attended-only?
3. Should fuel be a distinct config concept, or is `inferenceProfile` (already policy-bearing) the right
   carrier for every harness?
4. Where does per-model tool-fidelity evaluation live — is `modelClass` sufficient, or does a profile need a
   `toolFidelity`/`verified-against` marker before a coding agent may burn it?
5. Does `apiKeyHelper` supersede env-var credential passing for the claude-code fuel path?

## Decision record

| ID | Decision | Rationale |
| --- | --- | --- |
| F1 | Treat fuel as an axis distinct from substrate. | Claude Code demonstrably separates them; cortex conflates them and cannot express full-harness + cheap fuel. |
| F2 | Do **not** model "subscription vs on-demand" as a dispatch-path choice. | Subscription appears barred from unattended automation and cannot target a non-Anthropic endpoint. Pending confirmation. |
| F3 | Next increment: `claude-code` consumes an `inferenceProfile` → subprocess env. | Smallest change that reaches the expensive workload; reuses the shipped registry/resolver/profile seams. |
| F4 | Do not assume cheap fuel is safe for coding agents. | Non-Anthropic tool-use fidelity behind a proxy is undocumented; requires per-model evidence. |
| F5 | Keep `api-agent`. | Serves contexts CC cannot reach; D4 portable transcripts; local models. |
