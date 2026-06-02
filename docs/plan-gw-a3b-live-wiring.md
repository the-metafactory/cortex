**Status: Draft — for principal review**

**Refs:** cortex#524 (shared surface gateway) · `docs/design-shared-surface-gateway.md` (the design; §2.2 inbound, §6 blast-radius, §7 rollout) · task #88 · builds on GW.a.1 (#536 resolver), GW.a.2 (#546 orchestrator), GW.a.3a (#548 `BusInboundSink`), all merged · `CONTEXT.md` §Dispatch-source (D1, 2026-06-02)

> **What this is.** The implementation plan for **GW.a.3b** — wiring the (already-built, fully-tested) gateway into the live `cortex.ts` boot path and resolving the D1 signing mechanism. This is the first GW slice that touches the *running* system, so it is written for review **before** any boot-path/signing code lands. GW.a.3c (launchd) and GW.a.3d (outbound mux) are separate follow-on slices, sketched in §6–§7.

---

## 1. What is already in place (no live risk yet)

The entire inbound gateway exists as merged, unit-tested, **dormant** code — nothing references it from the boot path:

- **`buildBindingIndex` / `resolveBinding`** (`src/gateway/binding-resolver.ts`, #536) — `(platform, guildId|workspaceId) → {principal, stack, agent}`.
- **`SurfaceGateway`** (`src/gateway/surface-gateway.ts`, #546) — drives adapters, rebinds `onMessage → handleInbound`, never-throws, hands decisions to an injected `GatewayInboundSink`.
- **`BusInboundSink`** (`src/gateway/bus-inbound-sink.ts`, #548) — maps a decision → `InboundChatDispatchPublishOpts` and delegates to `publishInboundChatDispatchEnvelope`. Signing-agnostic (delegates to the runtime it's given).

GW.a.3b is **wiring**, not new gateway logic.

## 2. The D1 signing mechanism — the load-bearing decision

D1 (CONTEXT.md): *"a separate-process dispatch source … stamps `originator` and publishes on the local intra-principal hop **unsigned**; the bound **stack re-signs on ingest** with its own NKey."*

### 2.1 What the running code actually does today (grounded)

- **`publishOnSubject` signs** only when the runtime has a configured signer (`cortex.yaml.stack.nkey_seed_path`); load failure is non-fatal and **"the runtime publishes unsigned"** (`src/cortex.ts:452-459`). An unsigned publish is already a tolerated, exercised path.
- **The inbound dispatch consumer verifies** via `verifySignedByChain` (`src/runner/dispatch-listener.ts:1190`, `cryptoVerify:true` since v2.0.2) — **but with `rejectEmpty: false`** (`:1192`). An envelope with **no `signed_by` stamp falls through cleanly** (not rejected). Adapter-originated dispatches today take the cortex#480 *own-stack trust short-circuit* (self-signed by the stack, structurally trusted).

### 2.2 Consequence — re-sign-on-ingest is NOT required for v1

Because empty `signed_by` is tolerated (`rejectEmpty:false`), the gateway can publish the inbound envelope **unsigned + `originator`-stamped** on the intra-principal hop and **the bound stack's existing consumer accepts it with zero consumer change**. The stack remains the sole *cryptographic* signer for everything **it** originates downstream; the gateway's intra-principal inbound hop rides the already-tolerated unsigned path.

**Recommendation — two shapes, ship Shape A:**

- **Shape A (v1, recommended):** gateway publishes **unsigned, `originator`-stamped**. No change to the stack consumer. The `originator` carries the resolved principal DID (the publisher already does this via `policyEngine`, `dispatch-source-publisher.ts`). Trust on the intra-principal hop is the OS/process boundary + the local NATS account, not an envelope signature — acceptable because gateway and stacks share one principal + one host in v1 (OQ3 single-principal).
- **Shape B (deferred to Phase B / federation):** the stack **re-signs on ingest** — appends its own stamp before the envelope proceeds downstream — so the stack is the cryptographic origin even for gateway-injected traffic. **Required only when** (a) `cryptoVerify` tightens to `rejectEmpty:true` for tasks.chat, or (b) gateway-injected dispatches must cross `federated.` and be verifiable by a remote principal. The insertion point is the consumer just after `verifySignedByChain` accepts the unsigned envelope (`dispatch-listener.ts` ~1190) — a re-stamp via the stack runtime's signer before the harness runs.

This makes a.3b **substantially lower-risk than feared**: no change to the running stacks' verification path in v1.

> **OQ for principal:** confirm Shape A for v1 (publish unsigned, rely on `rejectEmpty:false`), with Shape B tracked as a Phase-B follow-on. The alternative — implement Shape B now — is more invasive (touches the consumer's trust path) for no v1 benefit while we're single-principal.

## 3. Boot wiring (`cortex.ts`)

Today each surface is wired per-stack at `src/cortex.ts` ~1361-1365 (token→agent maps) and ~1443-1495 (per-instance `adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg, …))`), mirrored for Mattermost (~1652) and Slack (~1750).

The gateway wiring is **additive and gated**, shadow-first:

1. **Gate:** a surface is *gateway-owned* iff it appears in the composed `surfaces.yaml` binding map (the `foldSurfaceBindings` output, CFG.c) **and** a feature flag is on (`CORTEX_GATEWAY=1` env or `system.yaml` toggle). Absent → today's per-stack `adapter.start → dispatchHandler` path is unchanged. This is the **revert switch**: flag off = old behavior, byte-for-byte.
2. **Shadow (Stage 1, §7):** when the flag is on, construct a `SurfaceGateway` with the bound adapters + `buildBindingIndex(surfaces)` + a **`LoggingInboundSink`** (a.2) — it logs routing decisions but does not publish. Per-stack adapters keep running (the gateway runs against a **staging identity** or in pure-observe to avoid the §1.2 double-connection on a shared token). Acceptance gate: prove demux + connection-count on real traffic.
3. **Flip (Stage 2, §7), per-binding:** swap `LoggingInboundSink → BusInboundSink` (a.3a) for one binding, **in the same change** that the bound stack stops instantiating its own adapter for that surface. This keeps the "exactly one connection per identity" invariant true throughout — never zero, never two. Each binding flip is independently revertible (flag/binding removal → stack re-opens its adapter).

> **OQ for principal:** which identity to pilot first? Recommend a **staging Discord identity** (not live Luna) for Stage-1 shadow, then flip the lowest-traffic real binding first.

## 4. Gateway runtime identity

The gateway needs a `MyelinRuntime` to publish. Per Shape A it publishes unsigned, so it needs **no stack NKey** — a runtime constructed with a NATS connection (the local account) but **no signer**. This is the existing "runtime publishes unsigned" path (`cortex.ts:458`), so no new runtime capability is required. The gateway's `source` identity is `{principal}.gateway.{instance}` (a dispatch-source label, not an assistant/agent).

> **OQ for principal:** gateway `source` identity label — `{principal}.gateway.{instance}` vs reusing a stack's source. Recommend a distinct `gateway` segment so dashboard/audit can attribute gateway-injected dispatches.

## 5. Slice breakdown (each its own PR, dev→verify→review→merge)

- **a.3b.1** — boot gating + Stage-1 shadow: construct `SurfaceGateway` + `LoggingInboundSink` behind the flag; per-stack adapters untouched. Verifiable by log inspection; zero publish. *Lowest risk.*
- **a.3b.2** — gateway runtime (unsigned publisher) + flip `LoggingInboundSink → BusInboundSink` for ONE pilot binding, with that stack's adapter skipped for that surface. The first binding that actually routes through the bus.
- **a.3b.3** — the remaining bindings, one per PR, each revertible.
- (**a.3c** launchd, **a.3d** outbound mux — §6/§7.)

## 6. Blast-radius mitigations (design §6) → mostly a.3c

Collapsing N connections to 1 concentrates the failure domain. a.3b.1/2 inherit the adapters' existing reconnect primitives (`src/adapters/discord/retry.ts`). The dedicated mitigations land with the launchd slice:

- **Reconnect/backoff per connection** — reuse adapter retry; surface a **connection-health `system.*` event** on the bus (the `systemEventSource` pattern, `cortex.ts:647`) so the dashboard shows "Luna-Discord down — N stacks affected."
- **Inbound durability** — already structural: inbound is published to the bus; a down stack's consumer redelivers via JetStream. A stack outage does **not** require a gateway reconnect (§6.2 mitigation 1).
- **a.3c launchd** — run the gateway as its own supervised plist (sibling to `ai.meta-factory.cortex.bot.plist`) so a stack deploy (`arc upgrade Cortex`) doesn't bounce the shared connection.

## 7. Outbound mux (a.3d, sketch)

The gateway subscribes to `dispatch.task.{started|completed|failed|aborted}` lifecycle envelopes, reads `payload.response_routing.adapter_instance` (already on the wire, cortex#491/#498/#502 — the value the `BusInboundSink` path stamps via `msg.instanceId`), reconstructs the `ResponseTarget`, and calls `postResponse`/`sendProgress`/`clearProgress` on the matching connection. Its own thin sink-subscriber (not a `SurfaceRouter`). **OQ5** (outbound replay on reconnect) and **OQ6** (shared rate-limiting) are decided here, not in a.3b.

## 8. Acceptance gate (Stage 1, design §7)

Before any real binding flips (a.3b.2): with the staging-identity shadow running, demonstrate (a) the platform-reported connection count for the identity drops to 1, and (b) **zero double-dispatch** in a shared channel — the demux logs show exactly one target stack per inbound. Only then flip the first real binding.

## 9. Summary of decisions requested

1. **Shape A vs B** for D1 signing in v1 (recommend A — publish unsigned, defer re-sign-on-ingest to Phase B).
2. **Pilot identity** for Stage-1 shadow (recommend a staging Discord identity).
3. **Gateway `source` label** (recommend a distinct `{principal}.gateway.{instance}`).
4. **Flag mechanism** (recommend `CORTEX_GATEWAY` env for the shadow bring-up, graduating to a `system.yaml` toggle).
