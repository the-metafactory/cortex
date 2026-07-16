# API model-provider support

**Status:** Proposed  
**Date:** 2026-07-16  
**Scope:** Direct Anthropic Messages API and OpenAI-compatible model inference in Cortex

## Summary

Cortex should add direct model APIs beneath a Cortex-owned API agent harness,
while preserving Claude Code as the default full agent runtime.

The target has three independent axes:

1. **Execution** — where a harness runs (`local`, Cloudflare, E2B, SSH).
2. **Substrate** — which agent harness runs (`claude-code`, `api-agent`,
   `bus-peer`).
3. **Inference profile** — which provider, protocol, and model an API harness
   calls.

This separation is load-bearing. Claude Code is an agent runtime: it supplies
the model loop, tools, hooks, permissions, filesystem behaviour, resumable
sessions, subprocess isolation, and telemetry. A model API supplies inference.
Treating an API base URL as equivalent to Claude Code would silently remove
those behaviours.

The first implementation slice should therefore be an opt-in, text-only
`ApiAgentHarness` with streaming, portable conversation state, timeouts,
normalized errors, and usage accounting. Cortex-owned tool execution should be
a later, separately reviewed slice.

## Goals

- Call Anthropic through its native Messages API.
- Call services that implement the portable core of OpenAI Chat Completions,
  including local services such as Ollama or LM Studio.
- Keep provider wire formats out of the runner and Myelin lifecycle layers.
- Preserve the existing Claude Code OAuth and full-harness path unchanged.
- Make model class, residency, feature support, and cost observable to policy
  and Mission Control.
- Fail closed when a provider cannot support a requested input or capability.
- Give implementation work small, independently reviewable rollout slices.

## Non-goals

- Reimplement Claude Code in the first API-provider release.
- Claim behavioural parity between models or providers.
- Translate Claude Code tool names such as `Bash`, `Edit`, or `Skill` into a
  supposedly universal tool vocabulary.
- Make automatic cross-provider failover safe after output or side effects have
  begun.
- Route production Anthropic traffic through Anthropic's OpenAI compatibility
  layer.
- Replace the `SessionHarness` or Myelin dispatch-lifecycle contracts.

## Current Cortex seams

Cortex already has most of the upper boundary required by this design:

- [`SessionHarness`](../src/common/substrates/types.ts) defines provider-neutral
  dispatch as an async stream of Myelin lifecycle envelopes.
- [`ClaudeCodeHarness`](../src/substrates/claude-code/harness.ts) owns translation
  from `DispatchRequest` to `CCSessionOpts`.
- [`dispatch-listener.ts`](../src/runner/dispatch-listener.ts) owns policy and
  admission checks, builds `DispatchRequest`, selects a harness, and publishes
  the yielded lifecycle envelopes.
- [`CCSession`](../src/runner/cc-session.ts) owns Claude Code process spawning,
  stream parsing, inactivity handling, settings isolation, and Claude-specific
  telemetry.
- [`SessionManager`](../src/runner/session-manager.ts) maps a surface thread to a
  Claude Code session ID for continuation.
- [`ClaudeConfigSchema`](../src/common/types/cortex-config.ts) configures the
  Claude Code runtime; `ExecutionConfigSchema` configures where execution runs.

The main missing seams are:

1. a registry that resolves an agent to a `SessionHarness` rather than choosing
   `ClaudeCodeHarness` for every ordinary dispatch;
2. a provider-neutral model request/event contract;
3. native Anthropic and OpenAI-compatible adapters;
4. a portable conversation store;
5. a host-side tool registry and executor for API-backed agents.

The existing `DispatchRuntime` contains intentionally substrate-native knobs
such as `resumeSessionId`, `allowedDirs`, bash policy, and additional CLI args.
An API harness must not pretend every one of these has a provider equivalent.

## External protocol constraints

### Anthropic

Anthropic's Messages API accepts conversation history on each request; it does
not make a prior message ID a portable session. Streaming uses typed
server-sent events for message starts, content-block deltas, tool-input JSON,
usage, completion, ping, and error events. New event variants may be added, so
the adapter must ignore unknown events safely.

References:

- [Create a Message](https://platform.claude.com/docs/en/api/messages/create)
- [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)

Anthropic also exposes an OpenAI SDK compatibility layer, but documents it as
primarily intended for testing and comparison rather than as the preferred
production integration. Unsupported fields may be ignored, and native features
such as prompt caching and full extended-thinking support are not equivalent.
Cortex should use the native Messages API for Anthropic.

Reference: [Anthropic OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)

### OpenAI-compatible services

"OpenAI-compatible" is a family of partial implementations, not a capability
guarantee. Cortex should initially target the portable core of streamed Chat
Completions. OpenAI's Responses API can support stateful continuation and richer
hosted tools, but those features cannot be assumed on generic compatible
endpoints.

References:

- [OpenAI API quickstart](https://developers.openai.com/api/docs/quickstart)
- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

Provider profiles must declare supported features, and Cortex must reject
unsupported requests rather than allow providers to silently discard them.

## Target architecture

```text
DispatchRequest
      |
      v
SessionHarness
 |- ClaudeCodeHarness ----------------> claude CLI (unchanged)
 |- BusPeerHarness
 `- ApiAgentHarness
        | owns loop, transcript, limits, tools, lifecycle
        v
    ModelProvider
     |- AnthropicMessagesProvider
     `- OpenAICompatibleProvider
```

### Decision D1: provider portability belongs below the agent loop

`SessionHarness` remains the M6 boundary consumed by the runner.
`ApiAgentHarness` implements the behaviours required to turn raw inference into
a Cortex session. `ModelProvider` implementations only translate normalized
requests and streams to and from provider protocols.

This produces one API agent loop rather than one loop per vendor, without
pretending vendor wire formats are identical.

### Decision D2: keep native Anthropic and OpenAI-compatible adapters separate

The adapters share a normalized contract but retain native request construction,
stream parsing, error handling, request IDs, rate-limit metadata, and
provider-specific options. Production Anthropic use does not flow through its
OpenAI compatibility shim.

### Decision D3: retain `claude-code` as the default

Existing agents that omit `runtime.substrate` continue to resolve to
`claude-code`. API-backed execution is explicit through `substrate: api-agent`
and an `inferenceProfile`. No existing tool, hook, OAuth, isolation, session, or
lifecycle behaviour changes as part of introducing the new path.

### Decision D4: Cortex owns canonical API conversation state

The portable session is a Cortex conversation containing normalized messages,
tool calls, results, and usage. A provider continuation ID is optional opaque
metadata and may be used as an optimization, never as the only recoverable
state.

This permits resumption when a provider has no server-side session, and makes
provider migration or replay explicit rather than accidental.

## Model-provider contract

The normalized contract should be deliberately smaller than any provider's full
API:

```ts
interface ModelProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelTools: boolean;
  images: boolean;
  documents: boolean;
  structuredOutput: boolean;
  serverContinuation: boolean;
  promptCaching: boolean;
}

type ModelEvent =
  | { type: "response.started"; providerRequestId?: string }
  | { type: "text.delta"; text: string }
  | { type: "tool_call.delta"; id: string; name?: string; json: string }
  | { type: "tool_call.completed"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: "response.completed"; finishReason: FinishReason }
  | { type: "error"; error: ProviderError };
```

The core content model should support text, image references, tool calls, and
tool results. Provider-only features belong under a namespaced options escape
hatch and must not be represented as portable behaviour.

### Error normalization

Provider failures should normalize to stable kinds while retaining safe native
diagnostics:

- `authentication`
- `authorization`
- `rate_limit`
- `overloaded`
- `invalid_request`
- `unsupported_capability`
- `content_filter`
- `timeout`
- `unavailable`
- `malformed_response`

The normalized error carries retryability, `retryAfterMs` when known, provider
request ID, and a redacted diagnostic summary. Dispatch lifecycle publishing
then maps stable error kinds onto existing `failed`/`aborted` semantics and
back-pressure hints.

## Configuration

Inference configuration belongs in the machine/substrate layer alongside
`claude` and `execution`, but must not reuse either name:

```yaml
inference:
  providers:
    anthropic:
      protocol: anthropic-messages
      baseUrl: https://api.anthropic.com
      apiKey: env:ANTHROPIC_API_KEY

    local-ollama:
      protocol: openai-chat-completions
      baseUrl: http://127.0.0.1:11434/v1
      apiKey: env:OLLAMA_API_KEY
      capabilities:
        streaming: true
        tools: false
        images: false
        structuredOutput: false

  profiles:
    claude-sonnet:
      provider: anthropic
      model: claude-sonnet-4-6
      maxOutputTokens: 8192
      modelClass: frontier
      dataResidency: US

    local-qwen:
      provider: local-ollama
      model: qwen3-coder
      maxOutputTokens: 8192
      modelClass: local-only
      dataResidency: NZ
```

An agent opts in independently:

```yaml
runtime:
  mode: in-process
  substrate: api-agent
  inferenceProfile: claude-sonnet
  capabilities:
    - research
```

#### `maxOutputTokens` — and what omitting it means

`maxOutputTokens` is the principal's declared cost/length bound. It reaches the
wire as `max_tokens` on both protocols. (It was accepted by the schema and read
by both providers but never populated in between for the whole of Phase 1 —
silently discarding the bound; issue #2114 wired the middle of that chain and
pins it with wire-body tests.)

It is optional, but **what omission means is per protocol** — the two APIs
disagree on whether the field is required, so cortex cannot make this uniform:

| Protocol | Profile omits `maxOutputTokens` |
|---|---|
| `anthropic-messages` | The API **requires** `max_tokens`, so cortex sends a declared default: `DEFAULT_MAX_OUTPUT_TOKENS` = **4096** (exported from `src/providers/anthropic/messages-provider.ts`; overridable per provider instance via `defaultMaxOutputTokens`). |
| `openai-chat-completions` | The field is **omitted entirely**; the target server's own default applies and cortex bounds nothing. |

A profile that states `maxOutputTokens` always wins on both. **Prefer stating
it** — as the examples above do. Omitting it does not mean "unbounded"; it means
the bound is chosen by the provider adapter's default or by the remote server,
not by the principal.

#### `options` — the namespaced escape hatch

`options` is a single bag of opaque provider-only knobs keyed by provider
namespace (Q5). A provider merges **only its own namespace** onto its wire body:

```yaml
profiles:
  claude-sonnet:
    provider: anthropic
    model: claude-sonnet-4-6
    maxOutputTokens: 8192
    modelClass: frontier
    options:
      anthropic:            # → merged onto the Anthropic wire body
        top_k: 40
      openai:               # → inert here; a foreign namespace is never read
        temperature: 0.2
```

Portable behaviour must not depend on anything under `options`.

**Precedence against core fields is currently asymmetric** — the two adapters
merge the bag in opposite order:

- `anthropic-messages` merges the bag **first**, then the core fields
  (`model`, `max_tokens`, `stream`, `system`, `messages`) — so core **wins** and
  `options.anthropic` cannot override the profile's `maxOutputTokens`.
- `openai-chat-completions` merges the bag **last** — so `options.openai` **can**
  override core fields, including `max_tokens`.

Both are as-shipped in Phase 1 and pinned by test. The asymmetry is a known wart
rather than a designed behaviour: an `options` entry that overrides the
principal's declared bound on one protocol but not the other is a footgun, and
converging both on "core wins" is worth a follow-up decision. Until then, do not
set core fields via `options`.

Do not reuse `agent.runtime.model`: that field currently selects the model used
by the Sage review engine. `inferenceProfile` names a resolved operational
profile rather than embedding a provider and model at every agent.

### Secrets and egress

- API keys are environment/secret references, never literal values in committed
  configuration or lifecycle envelopes.
- Custom authentication headers are also secret references.
- A provider base URL is a reviewed model-egress destination with whole-stack
  blast radius.
- Redirects, proxy behaviour, TLS validation, and log redaction need explicit
  tests.
- Provider profile changes are policy changes because they can change data
  residency, model class, retention, and cost.

## Harness selection

Harness selection should move out of the inline conditional in
`dispatch-listener.ts` into a registry or resolver:

```ts
interface HarnessResolver {
  resolve(agent: AgentRuntime, mode: DistributionMode): SessionHarness;
}
```

`delegate` may continue resolving to `AgentTeamHarness`. Ordinary dispatch uses
the target agent's configured substrate, defaulting to `claude-code` for
backward compatibility. Resolution fails at config load or admission when a
referenced harness or inference profile is unavailable.

The runner remains responsible for chain verification, policy, admission,
request construction, response routing, and lifecycle publication. Provider
selection must not leak into surface adapters.

## Conversation state

The API path needs a durable `ConversationStore`, not an extension of the
in-memory Claude Code `SessionManager`:

```text
surface thread
  -> Cortex conversation ID
  -> normalized turns and tool results
  -> selected inference profile
  -> optional opaque provider continuation token
```

The store must preserve:

- persona/system instructions and their version or digest;
- normalized user, assistant, tool-call, and tool-result turns;
- provider/profile/model used for each inference turn;
- usage and provider request IDs;
- parent/child session linkage;
- compaction or summarization events;
- terminal and abort state.

Changing provider or model should create an explicit conversation branch unless
a migration policy says otherwise. The store must be able to reconstruct a
request without relying on retained provider state.

## Tool execution

Tool support is a separate security-sensitive implementation phase. API models
emit structured requests; Cortex must execute them.

```ts
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

The API agent loop is:

1. Resolve the allowed API-harness tool inventory after policy admission.
2. Send only those schemas to the provider.
3. Accumulate and validate streamed tool-call input.
4. Re-check authorization immediately before execution.
5. Execute inside the configured execution/sandbox boundary.
6. Persist the call and result.
7. Continue inference until a final answer or a hard loop limit.

API-harness tool names are substrate-native. Existing Q1-alpha semantics in
`DispatchRequest.tools` already permit that: Cortex passes a harness's native
tool vocabulary rather than translating names across substrates.

The initial API harness exposes no tools. Later slices should begin with
read-only tools or an MCP-backed inventory, followed by mutation tools only
after schema validation, audit, approval, output limits, time limits, and
sandbox enforcement are proven. The Claude Code security preamble and hooks do
not automatically protect this path.

## Streaming and lifecycle

Provider adapters normalize every stream event. `ApiAgentHarness` consumes
those events to:

- reset the inactivity timer on meaningful provider activity;
- accumulate text and tool input;
- persist usage and request IDs;
- execute permitted tool turns;
- emit progress envelopes when the Myelin schema supports them;
- yield exactly one terminal dispatch envelope.

The existing `SessionHarness` invariant remains: a started dispatch ends in one
of completed, failed, or aborted, with stable correlation and ordering.

Adapters must tolerate fragmented UTF-8/SSE frames, partial JSON, ping events,
unknown event variants, an error after HTTP 200, and disconnects before a final
usage event.

## Policy, sovereignty, and economics

The selected provider profile is authoritative operational evidence for:

- `modelClass` (`local-only`, `frontier`, or `any`);
- declared data residency;
- provider and model identity;
- supported modalities and tools;
- retention/ZDR posture when configured;
- cost attribution.

Admission should compare envelope sovereignty requirements with the resolved
profile. It should not rely only on the agent's self-declared `modelClass` when
the executing stack can resolve the actual profile.

Usage events map onto Mission Control's existing input/output/cache token and
cost fields. Cost should be provider-reported when available or calculated from
a versioned price table; an estimate must be labelled as an estimate.

Automatic fallback is allowed only before observable output or tool execution,
unless an operation is explicitly idempotent and replay-safe. Provider fallback
can change model behaviour, residency, retention, and price, so it is a policy
decision rather than a transport retry.

## Rollout

### Phase 0 — contracts and configuration

- Add `api-agent` to the harness/runtime enums.
- Add inference provider/profile schemas and secret resolution.
- Add `ModelProvider`, normalized request/event/error types, and registry.
- Extract harness selection behind a resolver.
- Preserve `claude-code` defaults and behaviour.

### Phase 1 — text-only API harness

- Add `AnthropicMessagesProvider`.
- Add `OpenAICompatibleProvider` targeting streamed Chat Completions.
- Add `ApiAgentHarness` with no tools.
- Implement streaming, cancellation, wall-clock and inactivity limits,
  normalized failures, and usage accounting.
- Reject attachments and tool requirements with `unsupported_capability`.

This phase provides useful API-backed chat, classification, summarization, and
research synthesis without claiming coding-agent parity.

### Phase 2 — durable conversations

- Add `ConversationStore` and thread mapping.
- Persist normalized turns, usage, and provider metadata.
- Add deterministic context-window budgeting and compaction records.
- Support resume and explicit provider/model branching.

### Phase 3 — restricted tool loop

- Add a host-side tool registry and executor.
- Start with read-only, bounded tools.
- Add schema validation, loop limits, audit events, and policy re-checks.
- Integrate MCP tools only through an explicit, filtered inventory.

### Phase 4 — mutation and routing

- Add sandboxed shell/edit tools under explicit grants.
- Add profile routing based on capability, sovereignty, cost, and availability.
- Add pre-output fallback and provider health/back-pressure signals.
- Revisit whether an OpenAI Responses adapter is valuable as a distinct native
  protocol rather than part of generic compatibility.

## Verification strategy

Every provider adapter should pass the same contract suite using recorded
fixtures and local fake HTTP servers:

- streamed text and Unicode split across frames;
- tool-call JSON split across arbitrary chunks;
- unknown event variants;
- cancellation and both timeout types;
- authentication, rate-limit, overload, and unavailable responses;
- an in-stream error after HTTP success;
- malformed or truncated streams;
- usage normalization and missing final usage;
- unsupported capability rejection;
- secrets absent from errors, events, snapshots, and logs.

Conversation tests should prove transcript round trips, deterministic request
reconstruction, compaction provenance, model/profile branching, and restart
resumption.

Harness tests should prove one started event, exactly one terminal event,
correlation stability, shutdown behaviour, and policy/tool fail-closed paths.

Existing Claude Code harness and dispatch-listener tests form the non-regression
gate: the new path must not change Claude CLI arguments, settings isolation,
OAuth, hooks, skill grants, resumption, tool ACLs, or lifecycle envelopes.

Live API smoke tests should be optional and secret-gated; CI correctness must
not depend on provider availability or paid credentials.

## Expected implementation surface

The exact file split remains implementation-owned, but the likely shape is:

```text
src/common/inference/
  types.ts
  registry.ts
  errors.ts

src/providers/anthropic/
  messages-provider.ts
  stream-parser.ts

src/providers/openai-compatible/
  chat-completions-provider.ts
  stream-parser.ts

src/substrates/api-agent/
  harness.ts
  conversation-store.ts
  agent-loop.ts
  tool-registry.ts             # Phase 3

src/runner/
  harness-resolver.ts
```

Provider adapters are internal implementation components, not M6 substrates.
They should not be added as `HarnessId` variants.

## Open questions

1. Which durable store should own normalized transcripts: the existing Mission
   Control database, a runner-local store, or a shared session repository?
2. Should provider capabilities be entirely configured, probed at startup, or
   both with configured requirements checked against observed capabilities?
3. What is the smallest Cortex-native read-only tool inventory worth shipping
   before MCP integration?
4. How should persona revisions affect resumption of an older API conversation?
5. Which provider-specific options are safe to expose without making profiles
   unreviewable bags of arbitrary JSON?
6. Should first-party OpenAI use a future native Responses adapter while generic
   compatible services remain on Chat Completions?
7. Where should versioned price data live, and which component labels costs as
   provider-reported versus estimated?

## Decision record

| ID | Decision | Rationale |
| --- | --- | --- |
| D1 | Put model providers below `ApiAgentHarness`. | Raw inference is not an agent runtime. |
| D2 | Implement native Anthropic and OpenAI-compatible adapters separately. | Compatibility does not preserve full features or failure semantics. |
| D3 | Keep `claude-code` as the default substrate. | Zero migration and no silent capability regression. |
| D4 | Make Cortex transcripts canonical for API sessions. | Portable resume cannot depend on provider-owned state. |
| D5 | Ship the first API harness without tools. | Tool execution is the primary security and parity risk. |
| D6 | Treat provider profiles as policy-bearing configuration. | Provider selection changes sovereignty, retention, capability, and cost. |

