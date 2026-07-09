# Design: Pluggable surface adapters — out-of-tree, arc-installable, hot-loadable

**Status:** draft for principal review (grounds [ADR-0024](adr/0024-pluggable-surface-adapters.md), Status *proposed*) · **Date:** 2026-07-09 · **Epic:** [#1784](https://github.com/the-metafactory/cortex/issues/1784) · **S0:** [#1785](https://github.com/the-metafactory/cortex/issues/1785) · **Lifts the deferral in** [ADR-0017](adr/0017-surface-tooling-arc-bundles.md) §Alternatives L64–67

> This design is the S0 artifact for epic #1784. It grounds ADR-0024. Everything downstream (S1–S13) implements what the ADR ratifies. Where the epic's proposal left a genuine choice, this doc makes a recommendation and marks it **[AWAITING PRINCIPAL DECISION]** — those are the four pinned decisions the ADR must settle before it moves from *proposed* to *accepted*.

---

## 1. Problem — a surface change means a whole-cortex release

Today Discord, Mattermost, Slack, and the web/SSE surface are all compiled into cortex core (`src/adapters/{discord,mattermost,slack,web}/`). Adding a surface, upgrading a platform SDK, or removing one means cutting and deploying a whole cortex release. The platform npm deps (`discord.js`, `@slack/socket-mode`, `@slack/web-api`) sit in cortex's own `package.json:47-55`, so every stack — even one that binds only Discord — carries the transitive weight of every surface.

[ADR-0017](adr/0017-surface-tooling-arc-bundles.md) already extracted the surface *tooling* (the Discord CLI + skills → the `metafactory-discord` arc bundle, epic #1171) and **explicitly deferred the adapter**: *"Extract the adapter too … Rejected for now — the adapter is deeply woven into the bus/dispatch/surface-router; a plugin adapter model is a much larger change. Deferred to a separate future ADR"* (`docs/adr/0017-surface-tooling-arc-bundles.md:64-67`). This design lifts that deferral: it extends the arc-bundle shape from the tooling layer to the **adapter** layer, so a surface becomes a per-platform bundle a principal installs, upgrades, and removes independently of cortex releases.

**Goal (the epic's Definition of Done, restated):** on a stack whose cortex checkout contains *no* Slack code, `arc install metafactory-slack` + a `surfaces.slack[]` binding + a daemon reload yields a live Slack surface — no cortex release, no code change in the cortex repo — and a broken compat range refuses that one bundle without taking the daemon or any other adapter down.

### 1.1 Vocabulary (CONTEXT.md is authoritative)

This design uses the repo's terms as pinned in `CONTEXT.md` §"Surfaces, substrates, dispatch routing":

- **binding** — a `surfaces.{platform}[]` entry `{ agent, stack?, binding }` mapping platform credentials to an agent/stack (`src/common/types/surfaces.ts:327-341`).
- **presence** — an agent process being up and connected on a surface (distinct from **agent presence** the topology signal; here: the live bot connection an adapter owns).
- **dispatch source / dispatch sink** — a platform adapter is *both* (`CONTEXT.md:185`): its inbound side sources dispatch envelopes, its outbound side sinks lifecycle envelopes. A sink never signs.
- **surface gateway** — the separate-process surface owner (cortex#524) that holds one platform connection per bot-user identity, publishes **unsigned** on the local hop, and lets the **bound stack re-sign on ingest** (`CONTEXT.md:181`). The stack is the sole cryptographic signer (M3).
- **substrate harness** — the M6 layer that executes a dispatch (`CONTEXT.md:174`). Adapters are M7; harnesses are M6. This design touches only M7.

New terms this design coins (added to CONTEXT.md in the same PR per the issue's scope): **adapter SDK**, **adapter bundle**, **adapter module**, **AdapterFactoryRegistry**, **compat gate**.

---

## 2. Current state — verified stocktake (2026-07-09, worktree @ v6.7.0 / c447e062)

The epic's stocktake was captured @ origin/main `83e73ec2`; re-verified here against the current tree. LOC counts are exact; line numbers below supersede the epic's where they drifted (S9/cortex#1523 moved per-stack construction since 83e73ec2 — see §2.1).

| # | Finding | Status | Evidence (current tree) |
|---|---|---|---|
| 1 | Four in-core adapters: discord 2 858 / mattermost 1 469 / slack 1 189 / web 535 LOC | ✅ | `wc -l src/adapters/{discord,mattermost,slack,web}` |
| 2 | Clean adapter contract exists — `start/stop`, `updateConfig?` (F-092), `attachInboundDispatch?` | ✅ | `src/adapters/types.ts:183-264` (`updateConfig?` :251, `attachInboundDispatch?` :263) |
| 3 | Gateway construction has an injected factory seam, but hardcodes 4 platform methods + per-platform loops | ⚠️ | `src/gateway/gateway-adapters.ts:189-195` (factory iface), `:372-472` (`buildGatewayAdapters` per-platform loops) |
| 4 | Both construction paths now route through the same injected factory (S9 already extracted the per-stack loop) | ⚠️ **delta vs epic** | `src/cortex.ts:107,3152` → `wireSurfaceAdapters` (`src/runner/surface-adapter-boot.ts`); both call `defaultGatewayAdapterFactory` |
| 5 | dispatch-handler imports platform-generic code from `adapters/discord/*` | ❌ blocker | `src/bus/dispatch-handler.ts:25` (`attachment-types`), `:51` (`attachments`), `:52` (`channel-context`) |
| 6 | Legacy worklog reaches through `DiscordAdapter` — static import + `getClient()` + `formatEventForDiscord` | ❌ blocker | `src/cortex.ts:134` (import), `:335` (`formatEventForDiscord`), `:5882,5889` (`getClient`), `:5936` (format call) |
| 7 | `SurfacesSchema` is `.strict()` with 4 hardcoded platform keys — no out-of-tree platform validates | ❌ blocker | `src/common/types/surfaces.ts:327-341` |
| 8 | Platform npm deps live in cortex `package.json` | ❌ blocker | `package.json:47,48,55` |
| 9 | arc bundles + `dependencies:` ranges + repo-first install proven | ✅ | ADR-0017, `metafactory-discord` installed under `~/.config/metafactory/pkg/repos/` |
| 10 | arc semver-range *enforcement* between installed packages + bundle `bun install` | ⚠️ likely missing | arc-side slice (arc#284 / S7) |
| 11 | Daemon runs TS via bun → dynamic `import()` of installed bundle source is feasible | ✅ | `src/cortex.ts:1` shebang; plists run `~/bin/cortex start` |
| 12 | Config hot-reload machinery exists (`applied` vs `requiresRestart`) | ✅ | `src/common/config/watcher.ts:12-16,101-106` |
| 13 | Gateway lifecycle is all-or-nothing `start()/stop()`; no per-adapter runtime attach/detach | ❌ missing | `src/gateway/surface-gateway.ts:167,191` |
| 14 | No existing ADR/issue covers adapter extraction/hot-loading | ✅ gap | ADR-0001..0023 checked; this fills it |

### 2.1 The one material delta from the epic's stocktake

The epic (blocker #4) says the legacy per-stack boot "statically imports/constructs Discord/Mattermost/Slack" in `cortex.ts` at `:143,169,170` / construction `~:3771-4160`. Since 83e73ec2, **S9 (cortex#1523) already extracted that construction** into `wireSurfaceAdapters` (`src/runner/surface-adapter-boot.ts`), which calls the *same* `defaultGatewayAdapterFactory` the gateway uses (`src/gateway/gateway-adapters.ts:264-347`, module doc §"S9 … a second caller" :54-69). So:

- The "two construction paths must both consume the registry" work (S3) is **further along than the epic implies** — both paths already funnel through one factory object. S3 becomes "turn that fixed 4-method factory into a platform-keyed registry", not "unify two divergent construction sites."
- The **real** remaining `cortex.ts`↔adapter coupling is **blocker #6, not #4**: `cortex.ts` still *statically imports* `DiscordAdapter` (`:134`) purely for the worklog reach-through (`getClient()` at `:5889`, `formatEventForDiscord` at `:335,5936`). That static import is what pins `discord.js` into the core dependency graph regardless of the factory. **S2 (worklog decoupling) is therefore load-bearing for the discord extraction (S12), and blocker #4 is mostly retired.** The ADR records this so S3's issue can be trimmed.

---

## 3. Proposed architecture

Five pieces, layered so extraction is "move a module out", never "rewire the core". The order below is the dependency order (S3 → S4 → S5 → S6 → S8), matching the epic's wave plan.

### 3.1 Adapter SDK — a stable, versioned contract surface (S5)

A dedicated export surface in cortex (`src/adapter-sdk/`, new) re-exports the *stable* subset of the adapter contract a bundle links against: `PlatformAdapter`, `InboundMessage`, `ResponseTarget`, `AccessDecision`, `OutboundFile`, the message/target types (`src/adapters/types.ts`), and the `AdapterModule` shape (below). Cortex exports a single integer-major `ADAPTER_SDK_VERSION` (new; none exists today — grep empty). Bundles declare the range they satisfy.

```ts
// The shape a bundle's entry file default-exports.
export interface AdapterModule {
  /** semver range over cortex's ADAPTER_SDK_VERSION, e.g. "^1". THE compat gate (§4). */
  sdkRange: string;
  /** platform id — the surfaces.{platform} key and adapter.platform (e.g. "slack"). */
  platform: string;
  /** the binding schema this platform contributes to SurfacesSchema (§3.3). */
  bindingSchema: ZodTypeAny;
  /** binding → demux key (Slack: workspaceId; Mattermost: apiUrl; Discord: token group). */
  demuxKey(binding: unknown): string;
  /** optional: platforms that group multiple bindings onto one connection (Discord tokens). */
  groupBindings?(bindings: unknown[]): BindingGroup[];
  /** construct (never start) an adapter — the registry entry the factory calls. */
  createAdapter(args: AdapterFactoryArgs): PlatformAdapter;
}
```

The SDK is the **contract**; its version is what the compat gate checks (§4). Keeping it a distinct module (not "import from `src/adapters/types.ts`") lets cortex refactor internals freely while holding the SDK surface stable, and gives the ADR one file whose changelog *is* the compat history.

### 3.2 Bundle shape (arc) — one repo per surface (S9–S12, S7 arc-side)

Per-surface repo `metafactory-<platform>`, the same repeatable shape ADR-0017 established for tooling, now carrying the adapter:

```
metafactory-slack/
  arc-manifest.yaml        # version; dependencies: (compat metadata, advisory)
  cortex-adapter.yaml      # platform id, entry file, sdkRange, cortex range (advisory)
  package.json             # @slack/socket-mode, @slack/web-api — deps leave cortex core
  src/index.ts             # default-exports an AdapterModule
```

`arc install metafactory-slack` lands it under `~/.config/metafactory/pkg/repos/metafactory-slack/` and runs its `bun install` (arc#284 / S7). Distribution is **repo-first** (ADR-0017's decision) — registry-by-name publication is later and gated on a principal sign-off (HOLD).

### 3.3 Discovery + loading — a platform-keyed registry with fail-isolation (S3, S4, S6)

- **AdapterFactoryRegistry** (S3): replace the fixed 4-method `GatewayAdapterFactory` (`src/gateway/gateway-adapters.ts:189-195`) with a `Map<platform, AdapterModule>`. Both construction paths (`buildGatewayAdapters` + `wireSurfaceAdapters`) resolve their per-binding factory from the registry. The in-tree adapters register at boot exactly as bundles do — **dogfooding**: extraction later is "delete the in-tree registration + move the module out", not "rewire the core."
- **Registry-contributed binding schemas** (S4): `SurfacesSchema` (`src/common/types/surfaces.ts:327-341`) stops being `.strict()` over 4 hardcoded keys and instead composes its per-platform schemas from the registry (each `AdapterModule.bindingSchema`). An installed bundle *contributes* its binding schema, so `surfaces.slack[]` validates even though no Slack code ships in cortex. Unknown-key strictness is preserved *against the registered set* (a typo `discrod:` still fails loudly).
- **Loader** (S6, the trust-path slice): at boot the daemon scans installed bundles for `cortex-adapter.yaml`, runs the **compat gate** (§4), `await import(entry)`, validates the `AdapterModule` shape, and registers it. **Per-bundle failure isolation** — a bad/incompatible/throwing bundle is skipped with a `system.error` event; the daemon and every other adapter keep running (DoD steps 3 & 5). Fail-isolation is a *robustness* boundary, not a security one (§6).

### 3.4 Discord token-grouping travels into the registry entry (S3)

`groupDiscordBindingsByToken` (`src/gateway/discord-token-groups.ts`, used at `gateway-adapters.ts:385`) is platform-specific: Discord delivers all guild events for a bot token over one gateway session, so bindings are token-keyed not guild-keyed. This logic must move *into* the discord `AdapterModule.groupBindings()` (the generic loop calls `groupBindings?.()` when present, else one-adapter-per-binding). **No discord special-case survives in the generic loop** — else extraction (S12) strands it.

---

## 4. Compat model — **[AWAITING PRINCIPAL DECISION #1]**

The issue requires picking ONE primary gate and naming who refuses. The epic's proposal carries *both* an `sdkRange` and a `cortex: >=X <Y` range. **Recommendation: the SDK semver range is the primary (authoritative) gate; the cortex version range is optional advisory metadata only.** Who refuses: **the loader (runtime, authoritative); arc install (advisory warning only).**

**Why SDK-range over cortex-version-range as the gate:**

- The whole point of the epic is that *a surface change should not require a cortex release* — and, symmetrically, *a cortex release should not invalidate an unchanged surface*. A `cortex: ">=6.7 <7"` gate couples the bundle to cortex's marketing version, which bumps for reasons unrelated to the adapter contract (a dashboard change, a federation change). Every such release would force bundles to widen their range or re-publish — re-coupling exactly what we decoupled.
- The **SDK version is the honest contract**: it bumps major only when `PlatformAdapter` / `AdapterModule` breaks. cortex can go 6.7 → 7.0 and, as long as `ADAPTER_SDK_VERSION` stays `1.x`, every `sdkRange: "^1"` bundle loads unchanged. The gate tracks the thing that actually breaks compatibility.
- **Only the loader knows the truth.** `ADAPTER_SDK_VERSION` is a property of the *running* daemon. arc install sees the *installed-at-that-moment* cortex, which `arc upgrade cortex` can change afterward — so arc install can only *warn*, never authoritatively gate. The loader, running inside the daemon, checks `satisfies(ADAPTER_SDK_VERSION, module.sdkRange)` at load time and is the sole authority. This also gives the fail-isolation contract its home: the loader refuses one bundle with a `system.error` reason and keeps the rest live (DoD step 5).

**Consequence to accept:** cortex must treat `ADAPTER_SDK_VERSION` as a real semver contract with discipline — a breaking change to `PlatformAdapter`/`AdapterModule` is a *major* SDK bump (and a documented migration for bundle authors), not a silent edit. This is the cost of the decoupling; it is the right cost.

**The `cortex` range stays** in `cortex-adapter.yaml` as optional human/advisory metadata (arc install may surface "bundle targets cortex ~6.x; you run 7.0"), but it is **not** the load gate.

> If the principal prefers a cortex-version-range gate (simpler mental model, one version to reason about), the trade is: bundles re-declare/re-publish on cortex releases that don't touch the adapter contract, and arc-install-time checks become misleading after `arc upgrade cortex`. Recommendation stands on SDK-range; this is the decision to confirm.

---

## 5. Hot-load semantics — **[AWAITING PRINCIPAL DECISION #3]**

The epic proposes "both, verbs in S8." **Recommendation: boot-time discovery is the v1 MVP bar (S6); runtime `load`/`unload`/`reload` verbs land as a separate slice (S8), not gated into the v1 loader.**

**MVP (S6):** the daemon discovers + compat-gates + imports + registers bundles **at boot**. Installing a bundle and *restarting the daemon* is enough to bring a surface live — that already delivers the epic's core value (no cortex release). This is low-risk: no cache busting, no drain, no per-adapter attach/detach.

**Runtime hot verbs (S8):** `cortex adapter list|load|unload|reload`. These carry three real hazards the ADR must name and S8 must handle:

1. **Module-cache busting.** bun caches a module by resolved path; a plain re-`import()` returns the cached instance and never picks up a new bundle version. The proposal busts the cache with a query-param import (`import(entry + "?v=" + version)`). **State loss / bounded leak:** the *old* module object is not evicted from the cache — it is only dereferenced. Its top-level singletons (a `discord.js` `Client`, timers, an SSE server) survive until GC, and GC cannot run while a reachable reference exists. So `unload` MUST call `adapter.stop()` and drop *every* reference (registry entry, gateway/router attachment, any closure) before the next `load` — otherwise the platform connection leaks. This is a **documented, bounded leak** (one stale module tree per reload), acceptable for an operator-driven verb, not for an automatic reload-on-file-change loop.
2. **In-flight drain.** An adapter is a live dispatch source *and* sink. `unload` must (a) stop accepting new inbound (`adapter.stop()` tears down the platform listener), and (b) let in-flight outbound lifecycle deliveries settle. Recommendation: `stop()` stops inbound immediately; the outbound sink drains for a bounded window (reuse the sink drain the `DispatchSink`/`ReviewSink` already implement — `src/adapters/dispatch-sink.ts`), then detaches. A dispatch mid-flight whose sink detaches before completion loses its surface delivery — surfaced as a `system.error`, not a silent drop.
3. **Per-adapter attach/detach (blocker #13).** `SurfaceGateway.start()/stop()` (`src/gateway/surface-gateway.ts:167,191`) is all-or-nothing today. S8 adds per-adapter attach/detach on the gateway *and* the router so one adapter unloads without cycling the others. This is the bulk of S8's real work.

**State loss on reload (explicit):** adapters hold connection state (Discord session, Slack socket, progress-message placeholders keyed by `sessionId`, `src/adapters/types.ts:167`). A `reload` = full `stop()` + reconstruct: **in-memory adapter state is lost by design** (progress placeholders reset; the platform reconnects fresh). Nothing durable is lost (no adapter owns durable state — response routing is wire-level, `CONTEXT.md:189`), but a "working…" placeholder mid-dispatch may orphan. Acceptable for an operator verb; documented so nobody expects seamless reconnection.

> If the principal wants runtime verbs in v1 (S6), the loader slice grows to absorb S8's attach/detach + drain — larger, and it collides with the trust-path review lane the wave plan isolates S6 into. Recommendation keeps S6 boot-only and S8 separate.

---

## 6. Trust model — **[AWAITING PRINCIPAL DECISION #4]**

**A loaded adapter bundle runs in-process with the daemon's full authority.** State this plainly; do not let the compat gate be mistaken for a security gate.

**The accepted risk.** An adapter loaded into the stack daemon (the per-stack `wireSurfaceAdapters` path) runs *inside the daemon process*. It therefore has — regardless of whether it ever calls the signer — access to everything the daemon has: the stack's NKey seed (it can mint signed envelopes as the stack), config secrets, the CC-session spawn path, bash, and the filesystem. `await import(entry)` executes arbitrary bundle code at load. **A malicious or compromised bundle = full stack compromise.** The compat gate (§4) gates *compatibility*, and fail-isolation (§3.3) gates *crashes/incompat* — **neither is a security boundary.**

**Mitigations (reduce likelihood; the risk itself is accepted):**

- **Org-trusted repos only.** v1 loads bundles only from the `the-metafactory` org via arc's repo-first install (ADR-0017). No arbitrary third-party / by-name registry loads. Installing a bundle is an explicit, reviewed act.
- **Same CI floor as cortex on bundle repos.** `scripts/check-shippable-hygiene.ts` (blocking) + the `confidentiality-gate` (gitleaks) run on every bundle repo — no live snowflakes, internal emails, seeds, or secrets ship (per the Critical Rules two-gate model).
- **Provenance pinning + upgrade-is-a-trust-act.** arc pins bundle install to a repo + ref; document that `arc upgrade`-ing a bundle re-executes new code with full authority and MUST be treated as a code-review event, not a passive fetch.
- **Fail-isolation is not a sandbox — say so.** The loader's per-bundle try/catch stops a *broken* bundle from crashing boot; it does nothing against a *malicious* one. The ADR states this explicitly so the isolation guarantee is never over-read.

**Future work (named, not built):** (a) registry signing — verify a bundle signature at install (mirrors the federation signing track, ADR-0018/0023); (b) if a real trust boundary is ever required, the **separate-process-over-IPC** adapter model (§ADR alternatives) is the escalation path — it is rejected *for v1* on cost/latency, but it is the architecturally-correct answer to "I need to run an untrusted adapter", and the design leaves that door open. The gateway's existing separate-process, unsigned-publish, stack-re-signs-on-ingest model (`CONTEXT.md:181`) is the partial precedent.

> The decision to confirm: **accept in-process/full-authority for v1 with the four mitigations above, org-trusted bundles only.** The alternative is to require the separate-process model from day one (safer, materially more work + latency, and unnecessary while every bundle is first-party). Recommendation: accept for v1.

---

## 7. In-tree adapters after extraction — **[AWAITING PRINCIPAL DECISION #2]**

The epic proposes: extraction PRs **delete** the in-tree adapter. **Recommendation: delete on extraction — keep only the in-tree *mock* adapter as the permanent contract-test dogfood.**

**Why delete, not keep-as-fallback:**

- A fallback copy is a **second source of truth** — the bundle and the in-tree copy drift, and "which one loads?" becomes a support question.
- The monolith never shrinks (defeats the epic's Why) and, decisively, **the platform npm deps cannot leave `package.json` (blocker #8) while an in-tree copy imports them.** `discord.js` stays pinned into core exactly as long as `src/adapters/discord/` and `cortex.ts:134` exist. Keep-as-fallback = never achieve the dependency extraction that is half the point.
- The **SDK + the in-tree mock** already provide the permanent in-tree contract anchor. The mock adapter drives the contract tests (`bun test src/adapters src/gateway`, DoD step 7) forever — the registry always has at least one in-tree entry, so "both paths consume the registry" stays exercised in CI without shipping a real platform.

So: each extraction PR (S9–S12) *deletes* the real in-tree adapter and its deps once its bundle is proven; the mock stays. Web pilots first (S9) precisely because it is the safest to delete (gateway-only, no npm dep, no secret in binding — §8).

> If the principal wants a transitional fallback (in-tree copy retained behind a flag for one release while bundles bake), that is a defensible conservative path — but it must be *time-boxed* (delete by release N+1) or blocker #8 never resolves. Recommendation: delete on extraction, no fallback, mock is the anchor.

---

## 8. Extraction order + per-adapter risk table

Order = the wave plan (S9 web → S10 slack ∥ S11 mattermost → S12 discord). Discord is last and hard-gated on S1 (relocate generic modules out of `adapters/discord/`) + S2 (worklog decoupling), because until those land, deleting `src/adapters/discord/` breaks `dispatch-handler.ts` (blocker #5) and `cortex.ts` (blocker #6).

| Adapter | LOC | npm deps | Legacy-path wiring | Secrets in binding | Blockers gating extraction | Risk | Wave |
|---|---|---|---|---|---|---|---|
| **web/SSE** | 535 | none | none (gateway-only, `CONTEXT`/epic note) | none (CF Access at edge, no bot token) | none | **Low — pilots the pattern** | S9 |
| **slack** | 1 189 | `@slack/socket-mode`, `@slack/web-api` | gateway + per-stack | botToken, appToken | needs arc#284 (dep install) proven | Medium | S10 |
| **mattermost** | 1 469 | (mattermost client) | gateway + per-stack | apiToken | disjoint from slack → parallel | Medium | S11 |
| **discord** | 2 858 | `discord.js` | gateway + per-stack + **worklog reach-through** + **generic modules imported by dispatch-handler** | token(s) | **S1 (#5) + S2 (#6) MUST land first** | **High — last** | S12 |

**Discord-specific debts to clear before S12** (all filed as their own slices, not "fixed while I'm in here"):
- Relocate `attachment-types`, `attachments`, `channel-context` out of `src/adapters/discord/` into a platform-generic home so `dispatch-handler.ts:25,51,52` no longer imports from a discord path (S1 / #1786).
- Decouple the worklog from `DiscordAdapter.getClient()` + `formatEventForDiscord` (`cortex.ts:134,335,5889,5936`) onto a platform-neutral sink so the static import can go (S2 / #1787).
- Move `groupDiscordBindingsByToken` into the discord `AdapterModule.groupBindings()` (S3 / §3.4).

---

## 9. Decisions this design locks (subject to §4–§7 confirmation)

1. **Compat gate = SDK semver range**, authoritative at the **loader**; cortex-version range is advisory metadata; arc install warns only. *(→ ADR-0024 D1)*
2. **Extraction deletes the in-tree adapter**; the in-tree **mock** is the permanent contract anchor; no real-adapter fallback. *(→ D2)*
3. **v1 MVP = boot-time discovery** (S6); runtime `load/unload/reload` verbs are a separate slice (S8) with cache-bust + drain + per-adapter attach/detach. *(→ D3)*
4. **In-process = full daemon authority**, accepted for v1 with four mitigations (org-trusted repos, CI hygiene/confidentiality floor, provenance pinning, "fail-isolation ≠ sandbox"); separate-process-over-IPC is the named future escalation. *(→ D4)*
5. **Both construction paths already share one factory** (S9); S3 turns that factory into a platform-keyed registry rather than unifying two sites — the epic's blocker #4 is mostly retired, blocker #6 is the real residual. *(→ ADR consequence)*
6. **The in-tree adapters dogfood the registry** — extraction is "move the module out", never "rewire the core." *(→ D2/D3)*

---

## 10. Open questions for the principal

- **OQ1 — compat gate (pinned #1):** confirm SDK-range-primary + loader-authoritative, or prefer cortex-version-range? (§4)
- **OQ2 — fallback (pinned #2):** delete-on-extraction with mock-only anchor, or a time-boxed in-tree fallback? (§7)
- **OQ3 — hot-reload bar (pinned #3):** boot-discovery-only v1, or runtime verbs in v1? (§5)
- **OQ4 — trust (pinned #4):** accept in-process/full-authority for v1, or require separate-process isolation from day one? (§6)
- **OQ5 — SDK versioning discipline:** who owns the `ADAPTER_SDK_VERSION` changelog + bundle-author migration notes, and does a breaking SDK bump block release until first-party bundles are updated in lock-step? (§3.1, §4)
- **OQ6 — `system.adapters.external` flag:** the wave plan lists "flipping `system.adapters.external` on any live stack" as a HOLD. Should external-bundle loading be **default-off behind this flag** for the whole v1 (in-tree registrations always load; external bundles only when the principal opts a stack in)? Recommendation: **yes** — secure default, matches the dev-loop-dormant-by-default posture. (§3.3)
- **OQ7 — registry-by-name publication:** stays a post-v1 HOLD (ADR-0017 already deferred it), confirmed? (§3.2)

---

## 11. Feature breakdown (epic #1784 slices — ground truth is the wave-plan comment)

S0 (this doc + ADR-0024) · S1 relocate generic modules · S2 worklog decouple · S3 AdapterFactoryRegistry · S4 registry-contributed schemas · S5 adapter SDK · S6 loader + compat gate + fail-isolation (trust-path lane) · S7 arc-side dep install + compat surfacing (arc#284) · S8 runtime attach/detach + `cortex adapter` verbs · S9 web pilot extraction · S10 slack · S11 mattermost · S12 discord (last) · S13 docs/glossary/release.

**HOLDS (not executor decisions):** merging this ADR without the principal's review; creating any new `the-metafactory/*` repo (S9–S12); arc registry publication; community announcements; flipping `system.adapters.external` on a live stack.
