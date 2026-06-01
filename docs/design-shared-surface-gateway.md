**Status: Draft**

**Refs:** cortex#524 (IAW GW: shared surface gateway — one assistant, many deployments) · `docs/design-internet-of-agentic-work.md` (IoAW architectural synthesis) · `docs/plan-internet-of-agentic-work.md` (phase ladder) · CFG epic (config split, task #83, CFG.a merged / CFG.b–CFG.c in flight) · child of cortex#110

> **Provenance note (read first).** Issue #524 cites "plan §13.2" and depends on "CFG.c". As of this writing the implementation plan (`docs/plan-internet-of-agentic-work.md`) ends at §12 and contains no §13; `surfaces.yaml`, `CFG.c`, and `GW` appear in the issue tracker and the local task list (#83 EPIC CFG, #85 IAW GW) but **not yet** as ratified sections in either `docs/` artifact. This document therefore treats §13.2 and `surfaces.yaml` as **forward-references to be created by CFG.c**, and grounds the gateway design on what is real in the repo today: the `PlatformAdapter` contract, the per-presence-token adapter wiring in `src/cortex.ts`, the dispatch-source publisher, the `SurfaceRouter`, and the dispatch-source / dispatch-sink / response-routing vocabulary fixed in `CONTEXT.md`. Where this doc asserts a §13.2 or `surfaces.yaml` shape, that shape is a **proposal for CFG.c to ratify**, flagged inline.

---

## 1. The problem — N connections per bot identity

### 1.1 What ships today

cortex starts platform adapters by **iterating per-agent presence credentials**. In `src/cortex.ts` the daemon builds three token→agent maps:

- `agentByDiscordToken` ← `a.presence.discord?.token` (`src/cortex.ts:1274-1275`)
- `agentByMattermostApiToken` ← `a.presence.mattermost?.apiToken` (`src/cortex.ts:1276-1278`)
- `agentBySlackBotToken` ← `a.presence.slack?.botToken` (`src/cortex.ts:1279-1281`)

Then for **each** Discord instance it constructs a `DiscordAdapter`, registers its surface face with the router, and calls `adapter.start(...)`, which opens a live platform connection (`src/cortex.ts:1324-1457`; the Slack and Mattermost loops mirror this). The platform credential lives under `agents[].presence.{platform}.token` in the config schema (`src/common/types/cortex-config.ts:160` for Discord `token`, `:304` for Slack `botToken`, `:265` for Mattermost `apiToken`).

The `PlatformAdapter` contract makes the connection ownership explicit: `start(onMessage)` "Connect to the platform and start listening", and `getPlatformUserId()` returns "the platform user id of the bot account **this adapter is connected as**" (`src/adapters/types.ts:108-124`).

### 1.2 The fan-out

The binding is therefore **one platform connection per adapter instance, keyed by the presence token**. This is fine for one stack. It breaks for the IoAW target state of "**one assistant, many deployments**" (issue title; `docs/design-internet-of-agentic-work.md` §3.2 multi-stack-per-principal, §3.3 multi-principal network):

When the **same** assistant — say Luna — is deployed across N stacks (a principal running `andreas/meta-factory`, `andreas/work`, `andreas/halden`, per `CONTEXT.md` Stack), **each stack process runs its own adapter loop and opens its own connection using the same Luna bot token.** The platform sees N gateway connections (Discord), N Socket-Mode sockets (Slack), or N pollers (Mattermost) **for one bot identity**.

Two concrete failure modes:

1. **Rate-limit / connection-budget pressure.** Discord enforces per-bot session-start (`IDENTIFY`) limits and a global request budget per bot token; Slack Socket Mode and Mattermost polling similarly meter per bot identity. N stacks contending for one identity's budget is self-inflicted contention that scales with deployment count, not with traffic.
2. **Double-message risk.** N connections under one identity each receive the same inbound platform event (a `messageCreate` in a shared guild). Without coordination, each bound stack's `dispatchHandler.handleMessage` (`src/cortex.ts:1416`) fires, so one human message can produce N dispatches and N replies. The current `trustedBotIds` anti-self-loop guards (`src/cortex.ts:1378`, `cortex-config.ts:204`) defend against bot-echo, not against N-way intra-identity duplication.

### 1.3 Why this is the natural seam to cut

The architecture already separates the **wire-facing roles** from the platform I/O. `CONTEXT.md` defines a **dispatch source** ("turns a platform message into a `tasks.@{assistant}.{capability}` envelope") and a **dispatch sink** ("consumes lifecycle envelopes … and renders them to a surface"), and states the load-bearing principle: **"Discord (and other platforms) are sources and/or sinks for chat envelopes — they are not the medium of communication. The bus is the medium."** (`CONTEXT.md`, `chat` capability entry.)

If the bus is the medium, the platform connection is an **edge resource** that should be owned **once per identity**, not once per stack. That is the gateway.

---

## 2. The gateway — one platform connection per bot identity

### 2.1 Definition

**GW (shared surface gateway):** a process that owns **exactly one platform connection per `(platform, bot-identity)` pair**, acts as a pure **dispatch source** (inbound) and **dispatch sink** (outbound) on the bus, and uses a binding map (`surfaces.yaml`, §3) to **demux** inbound platform events to the right **stack** and **mux** outbound lifecycle envelopes back to the right platform connection.

In `CONTEXT.md` vocabulary: the gateway is a dispatch source and dispatch sink that is **shared across stacks**. It is not an assistant, not an agent, not (necessarily) a stack — it is the surface edge, factored out.

```
                         ┌──────────────────────────────────────────┐
   Discord guild   ◄────►│  GW — shared surface gateway               │
   Slack workspace ◄────►│   • ONE connection per (platform,identity) │
   Mattermost srv  ◄────►│   • reads surfaces.yaml binding map        │
                         │   • demux inbound → bus  (dispatch source) │
                         │   • mux  outbound ← bus  (dispatch sink)   │
                         └───────────────┬────────────────────────────┘
                                         │  bus (the medium)
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                             ▼
   stack: andreas/meta-factory   stack: andreas/work          stack: andreas/halden
   (surface-bus-only)            (surface-bus-only)            (surface-bus-only)
   subscribes tasks.@luna.chat   subscribes tasks.@luna.chat   subscribes tasks.@luna.chat
   emits dispatch.task.*         emits dispatch.task.*         emits dispatch.task.*
```

### 2.2 Inbound path (demux — gateway as dispatch source)

1. The single platform connection receives a native event and normalizes it to the existing `InboundMessage` (`src/adapters/types.ts:14-45`) — already platform-agnostic, already carrying `instanceId`, `guildId`, `channelId`, `threadId`, `channelName`, `threadName`, `authorId`.
2. The gateway resolves the **target stack** from `surfaces.yaml` using the binding key — `(platform, instanceId)` and/or `(platform, guildId/workspaceId/teamId)` (§3.2).
3. It publishes a canonical inbound dispatch envelope onto the bus for that stack, reusing the existing `publishInboundChatDispatchEnvelope` shape (`src/bus/dispatch-source-publisher.ts:81-185`): `distribution_mode: "direct"`, `target_assistant: did:mf:<assistant>`, subject `…{principal}.{stack}.tasks.@{did-encoded-assistant}.chat`, and `originator: { identity, attribution: "adapter-resolved" }` (`dispatch-source-publisher.ts:161-164`).
4. **The bound stack consumes** the envelope on its existing dispatch listener (`local.{principal}.{stack}.tasks.*.>`, per `CONTEXT.md` Dispatch migration note) and runs it through its substrate harness — unchanged.

Crucially, the **demux decision is `surfaces.yaml`-driven**, so exactly one stack is targeted. That, by construction, eliminates the §1.2 double-message problem: the platform event enters the bus once, addressed to one stack.

### 2.3 Outbound path (mux — gateway as dispatch sink)

1. The bound stack's runner emits `dispatch.task.{started|completed|failed|aborted}` lifecycle envelopes joined by `correlation_id` (`CONTEXT.md` Dispatch; `src/runner/dispatch-listener.ts:19-23`).
2. Each lifecycle envelope carries **response routing** — "the originating surface address … `{adapter_instance, channel_id, thread_id?}`" that the runner "**echoes onto every `dispatch.task.{action}` lifecycle envelope so the originating dispatch sink can correlate completion → platform target without keeping state**" (`CONTEXT.md` Response routing).
3. The gateway subscribes to lifecycle envelopes (across all bound stacks), reads `response_routing.instance` to pick **which of its platform connections** to render on, reconstructs the existing `ResponseTarget` (`{ instanceId, channelId, threadId }`, `src/adapters/types.ts:80-89`), and calls the existing `postResponse` / `sendProgress` / `clearProgress` methods on the right connection (`src/adapters/discord/index.ts:709,756,780`).

The mux key is `response_routing.instance`. This is the **`response_routing.instance` bump** the issue calls for (§4).

---

## 3. Reading `surfaces.yaml` (the CFG.c precondition)

### 3.1 Dependency on CFG.c

GW is **additive and depends on CFG.c** (issue #524). CFG.a (the layered composer) is merged; CFG.b/CFG.c are in flight (task #83). CFG.c introduces `surfaces.yaml` as the place where the **{surface-instance → stack} binding** lives — pulled **out** of `agents[].presence.{platform}` (where the token lives today, `cortex-config.ts:160/265/304`) so that a surface binding is no longer implicitly owned by one stack's config.

GW must not invent its own config format. It reads the CFG.c artifact. If CFG.c is not yet merged when GW.a starts, GW reads a **shim** that the composer can later supersede (§7 phasing).

### 3.2 Proposed binding shape (for CFG.c to ratify)

> **PROPOSAL — not yet in repo.** CFG.c owns the final schema. The fields below are what GW needs; their names should be reconciled with the CFG composer and the existing `PresenceSchema` field names (`token`, `guildId`, `workspaceId`, `channels`, `instanceId`).

```yaml
# surfaces.yaml  (CFG.c)  — one entry per platform connection the gateway owns
surfaces:
  - instance: luna-discord-mf          # the response_routing.instance value (§4)
    platform: discord
    identity:                          # ONE connection opened for this identity
      token_ref: secrets://discord/luna
      bot_user_id: "1487...."          # populated post-connect via getPlatformUserId()
    bindings:                          # demux map: which inbound → which stack
      - match: { guildId: "1487...", channelName: "cortex" }
        principal: andreas
        stack: meta-factory
        assistant: luna
      - match: { guildId: "1487...", channelName: "work" }
        principal: andreas
        stack: work
        assistant: luna
```

GW resolves an `InboundMessage` against `bindings[].match` (most-specific wins: `threadName` > `channelName` > `guildId`), yielding `(principal, stack, assistant)` → the subject the dispatch-source publisher builds (`dispatch-source-publisher.ts:68-79,91-99`). `instance` is the stable id that flows out on `response_routing.instance`.

### 3.3 The `response_routing.instance` bump

Today the gateway-equivalent information is **in-memory only**: a `ResponseTarget.instanceId` (`src/adapters/types.ts:81-83`) that the same process that received the message already holds. Inbound envelopes carry ad-hoc payload keys (`grove_channel`, `grove_network`, `dispatch-source-publisher.ts:123-124`), **not** a structured `response_routing` block. For a *shared* gateway, the connection that renders the reply is in a **different** logical owner than the stack that did the work — so the instance id **must travel on the wire**.

The bump: `response_routing` becomes a first-class field on the inbound envelope (`{ instance, channel_id, thread_id? }`), and the runner echoes it verbatim onto every `dispatch.task.{action}` lifecycle envelope — exactly the contract `CONTEXT.md` Response routing already specifies ("echoed by the runner onto every lifecycle envelope … Response routing is wire-level, not in-memory"). GW.a's job is to **populate `response_routing.instance` on publish** and **read it on the lifecycle subscription**. Whether the schema promotion is GW's PR or a CFG/myelin-schema prerequisite is an open question (§9, OQ4).

---

## 4. Per-stack adapter retirement — stacks go surface-bus-only

Once GW owns the connection, a bound stack **no longer opens a platform connection**. It becomes **surface-bus-only**:

- It does **not** instantiate `DiscordAdapter`/`SlackAdapter`/`MattermostAdapter` for a bound surface (the `src/cortex.ts:1324-1457` loop is skipped for surfaces present in `surfaces.yaml`).
- It still **consumes** inbound dispatch envelopes on its dispatch listener and **emits** `dispatch.task.*` lifecycle envelopes — i.e., it participates purely as a bus peer. This is exactly the `bus-peer` posture the IoAW substrate-harness work already contemplates (`docs/design-internet-of-agentic-work.md` §2 "cortex#91 BusPeerHarness"; `CONTEXT.md` Substrate harness `bus-peer`).

This is **GW.f** in the issue checklist ("retire per-stack adapters — stacks go surface-bus-only").

A subtle, important consequence for the trust model: today the **stack** is the cryptographic signer (`CONTEXT.md`: "the **stack** signs the envelope via `runtime.publish` using the stack NKey"; the adapter only populates `originator`). When the gateway is a *separate* process publishing *on behalf of* a stack, **who signs?** This is the single most important unresolved decision and is broken out as OQ2 (§9). The retirement of per-stack adapters cannot land before it is resolved, because the inbound envelope GW publishes must be signed by *something* the bound stack and the network will accept.

---

## 5. Composition with existing adapters + the surface-router

GW is **not a rewrite of the adapters** — it is a **new owner** of them. The composition is clean because the seams already exist:

- **`PlatformAdapter` (I/O) is reused as-is.** `src/adapters/{discord,mattermost,slack}/index.ts` already encapsulate connect/listen/post/typing/progress/thread behind `start`/`stop`/`postResponse`/`sendProgress`/`getPlatformUserId` (`src/adapters/types.ts:102-144`). The gateway constructs **one** adapter instance per `(platform, identity)` and drives it directly. No adapter internals change.
- **The `onMessage` callback is rebound.** Today: `adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg))` (`src/cortex.ts:1416`) — handle locally, in-process. In the gateway: `adapter.start((msg) => gateway.demuxAndPublish(msg))` — resolve the binding, publish to the bound stack's subject. The `DispatchHandler` (in-process synchronous path, `src/bus/dispatch-handler.ts`) is **bypassed** at the gateway; dispatch happens on the bus, consumed by the bound stack.
- **The `SurfaceRouter` stays inside each stack, not in the gateway.** The router (`src/bus/surface-router.ts`) is a **bus-envelope → adapter fan-out** within a process (`SurfaceAdapter.subjects` + `filter` + `render`, `src/bus/surface-router.ts:66-115`). The gateway's outbound side is the *inverse* concern (lifecycle-envelope → one platform connection, keyed by `response_routing.instance`), so the gateway runs its **own** thin sink subscriber rather than a `SurfaceRouter`. The router continues to serve **non-platform sinks that stay in-stack** (dashboard renderer, PagerDuty — `src/renderers/`), which are unaffected by GW because they are not platform connections.
- **`TrustResolver` co-tenancy.** Today each adapter registers its `getPlatformUserId()` into the per-process `TrustResolver` for the in-process anti-self-loop / peer-trust merge (`src/cortex.ts:1431-1445`, `cortex#98` part B). In the gateway, the single connection registers once; cross-process peer trust falls back to the explicit `presence.{platform}.trustedBotIds` bridge (`cortex-config.ts:204`, `:369`) exactly as it does today for cross-process peers.

Net: GW is roughly "the `src/cortex.ts:1274-1457` adapter loop, lifted into a dedicated owner, with the `onMessage` callback and the outbound sink re-pointed at the bus, and the per-stack copies removed."

---

## 6. Failure / reconnect — blast radius

Collapsing N connections to 1 **concentrates** the failure domain. This is the central trade-off and must be designed for explicitly.

### 6.1 The blast radius

- **One connection drop affects ALL bound stacks.** Today, if `andreas/work`'s Discord connection drops, only `andreas/work` goes dark; the other stacks' own connections survive. Under GW, one Luna-Discord disconnect blacks out inbound and outbound for **every** stack bound to that connection.
- **Outbound in-flight loss spans stacks.** A reconnect window during which `postResponse`/`sendProgress` calls fail (`src/adapters/discord/index.ts:730` already logs `postResponse failed while connected`) now drops replies for multiple stacks at once.

### 6.2 Mitigations (design requirements for GW.a)

1. **Inbound is naturally durable.** Inbound dispatch envelopes are published to the bus; if a bound stack is down, JetStream retention + the stack's consumer (queue-group claim, `CONTEXT.md` Offer/Subject) handle redelivery. The gateway's inbound responsibility ends at a successful publish. So **a stack outage does not require a gateway reconnect** — they are decoupled by the bus. This is a structural win: GW makes stacks *more* independently restartable, not less.
2. **Connection is the single point.** The gateway needs first-class **reconnect with backoff** per connection (the adapters already carry retry primitives — `src/adapters/discord/retry.ts`). A connection-health signal should emit on the bus (`system.*`, reusing the `systemEventSource` pattern, `src/cortex.ts:647-658`) so the principal dashboard can see "Luna-Discord connection down — N stacks affected."
3. **Outbound replay policy is an open question (OQ5).** On reconnect, should the gateway re-drain `dispatch.task.*` from a durable consumer (re-rendering latest state, at the cost of duplicate edits) or fire-and-forget (matching today's adapter behaviour, accepting dropped replies)? This is a deliberate availability-vs-duplication trade.
4. **Run GW as its own supervised process.** A dedicated launchd plist (sibling to `ai.meta-factory.cortex.bot.plist` / `.relay.plist`, `src/services/`) so the gateway can restart independently of any stack, and so a stack deploy (`arc upgrade Cortex`) does not bounce the shared connection.

The honest framing for the principal: **GW trades N small, independent failure domains for 1 larger, shared one, in exchange for removing the rate-limit and double-message defects and enabling "one assistant, many deployments."** The bus decoupling (mitigation 1) means the shared domain is *only* the platform edge, not the work itself.

---

## 7. Phased rollout

GW is additive (issue #524). The rollout never has a flag-day where a stack has *no* path to its surface.

### Stage 0 — `surfaces.yaml` lands (CFG.c, prerequisite)
CFG.c ships the binding artifact and the composer wiring (task #83). No gateway behaviour yet. GW work is **blocked** on this (issue: "Depends on CFG.c").

### Stage 1 — Gateway alongside per-stack adapters (GW.a, shadow)
- Stand up the gateway process holding one connection per `(platform, identity)` for the chosen pilot identity (e.g. Luna-Discord).
- Stacks **keep** their per-stack adapters (no `getPlatformUserId` collision risk because the gateway can run against a *staging* identity first, or in observe-only mode that publishes inbound envelopes but does not render outbound).
- **Acceptance gate:** prove connection-count reduction and correct demux on the bus *before* any stack loses its adapter. Measure: platform-reported connection count for the identity, and zero double-dispatch in a shared channel.

> Note: a real shared bot token cannot have *both* a per-stack adapter *and* the gateway connected simultaneously without re-introducing the §1.2 duplication. So Stage 1 is either (a) staging-identity shadow, or (b) per-binding cutover (Stage 2) done one binding at a time. The "alongside" phase is per-*binding*, not per-*identity*.

### Stage 2 — Flip, binding by binding (GW.a → GW.f, incremental)
- For each binding in `surfaces.yaml`: switch the bound stack to **surface-bus-only** (skip its adapter instantiation for that surface, §4) **in the same change** that the gateway begins owning that binding's connection. This keeps "exactly one connection per identity" invariant true throughout — never zero, never two.
- The bound stack now relies on the wire `response_routing.instance` (§3.3) for outbound; verify replies land in the right channel/thread for the right stack.

### Stage 3 — Retire per-stack platform connections (GW.f complete)
- Once all bindings for an identity are gateway-owned, delete the per-stack adapter wiring for those platforms from the stack boot path; the `presence.{platform}.token` field migrates into `surfaces.yaml.identity` (CFG.c) and is removed from `agents[].presence` for bound surfaces.
- The `DispatchHandler` in-process synchronous chat path (`src/bus/dispatch-handler.ts`) is retained only for any surfaces *not* gateway-bound (or retired with #412's `dispatch-handler.ts` deletion, `CONTEXT.md` Dispatch migration note — coordinate the two retirements).

Each stage is independently revertible: revert a binding flip and the stack re-opens its own adapter.

---

## 8. Vocabulary compliance

Per the live whole-tree vocabulary gate (`CONTEXT.md`), this design uses: **principal** (the human, root of trust), **stack** (one running cortex deployment), **assistant** (the named being, e.g. Luna), **agent** (the stack-local runtime hosting an assistant), **dispatch source / dispatch sink** (the gateway's two roles), **response routing** (the wire-level reply address), **Offer / Direct / Delegate** (dispatch modes; GW publishes **Direct** chat envelopes), and **scope** `local` / `federated` / `public` (GW v1 is `local` within one principal; cross-principal is `federated`, deferred — OQ3). No bare "operator" is used; where the NSC/NATS operator account is meant it is qualified ("NSC operator account" — not relevant to GW's data path).

---

## 9. Open questions for the principal

1. **Connection dedup key** — `(platform, token)` (operational truth today, `cortex.ts:1274-1281`), `(platform, bot_user_id)`, or `(platform, assistant)`? They diverge when one assistant runs under two tokens.
2. **Who signs the inbound envelope?** GW as a separate process is a dispatch source but `CONTEXT.md` makes the **stack** the cryptographic signer. Options: (a) gateway holds a delegated per-stack signing key; (b) gateway publishes originator-stamped, bound stack re-signs on ingest; (c) gateway IS a minimal stack. **Blocks GW.f.** (See §4.)
3. **Cross-principal bindings** — is GW v1 single-principal (all bound stacks share one principal, all `local.`), with shared-channel cross-principal traffic (`federated.`, `CONTEXT.md` Network) deferred to a federation-aware gateway?
4. **`response_routing` schema promotion** — is promoting `response_routing` to a first-class wire field GW's PR, or a CFG/myelin-schema prerequisite GW depends on? (See §3.3.)
5. **Outbound replay on reconnect** — durable re-drain of `dispatch.task.*` (recover blast-radius, risk duplicate edits) vs fire-and-forget (match today, drop on disconnect)? (See §6.2.)
6. **Shared outbound rate-limiting** — one connection now carries summed volume of all bound stacks against one identity's per-route quota; does GW need a shared route-keyed limiter + bus backpressure contract?
7. **`surfaces.yaml` ownership + hot-reload** — gateway-owned file or CFG-composed into each `cortex.yaml`? Reload must not bounce connections for unaffected stacks (precedent: `src/common/config/watcher.ts`).

---

## 10. References (cited source)

- `CONTEXT.md` — Principal / Stack / Assistant / Agent; Dispatch (Offer/Direct/Delegate, `distribution_mode`); Dispatch source; Dispatch sink; Response routing; `chat` capability ("the bus is the medium").
- `src/adapters/types.ts:14-45` (`InboundMessage`), `:80-89` (`ResponseTarget`), `:102-144` (`PlatformAdapter`).
- `src/cortex.ts:1274-1281` (token→agent dedup maps), `:1324-1457` (Discord adapter start loop + `getPlatformUserId` trust registration), `:1416` (`onMessage` → `dispatchHandler.handleMessage`), `:647-658` (`systemEventSource`).
- `src/bus/dispatch-source-publisher.ts:57-66` (`adapterOriginatorIdentity`), `:81-185` (canonical inbound chat envelope: subject build, `distribution_mode:"direct"`, `originator`).
- `src/bus/surface-router.ts:66-115` (`SurfaceAdapter`), `:160-176` (`SurfaceRouter`), `:200-236` (`subjectMatches`).
- `src/adapters/discord/index.ts:709,756,780` (`postResponse`/`sendProgress`/`clearProgress`), `:730` (post-failure logging), `:1136` (surface render binding); `src/adapters/discord/retry.ts` (reconnect primitives).
- `src/common/types/cortex-config.ts:157-244` (`DiscordPresenceSchema`, token + `surfaceSubjects` + `trustedBotIds`), `:258-276` (Mattermost), `:297-387` (Slack).
- `src/runner/dispatch-listener.ts:8-55` (lifecycle envelope emission; render-vs-dispatch adapter shape).
- `docs/design-internet-of-agentic-work.md` §3.1 (single stack), §3.2 (multi-stack per principal), §3.3 (multi-principal network), §2 (`bus-peer` / BusPeerHarness).
- `docs/plan-internet-of-agentic-work.md` (phase ladder; note: ends at §12 — §13 is a forward-reference, see provenance note).