# Plugin Process Isolation — Design Note (deferred half of EBH-5)

**Status:** Draft (design only — no implementation)
**Author:** Luna (with Andreas), cortex#2347 (EBH-5, epic #2341 "execution-boundary hardening")
**Companion:** registry signing (cortex#2347's OTHER half — implemented alongside this note, `src/adapters/plugin-signing.ts`)
**Refs:** [ADR-0024](adr/0024-pluggable-surface-adapters.md) D4 ("Plugins run in-process with full daemon authority; risk accepted for v1 with mitigations" — names *"separate-process-over-IPC if a real trust boundary is ever required"* as the escalation this note designs), `docs/security/hardening-plan.md` §2 L4, `src/adapters/loader.ts`

---

## 0. Why this is a design note, not a build

cortex#2347 (EBH-5) is **trigger-gated**: build nothing here until *first non-first-party bundle loaded* (`system.plugins.external` flips on for a bundle outside the org's own first-party set) OR *first federated deployment* (cross-principal bus). Neither has happened. ADR-0024 D4 is an **accepted** decision — every bundle today is first-party, reviewed at the same CI bar as cortex itself, and process isolation is real, non-trivial engineering (a supervision layer, an IPC serialization boundary on the hot inbound/outbound dispatch path, per-adapter lifecycle management) that ADR-0024's own "Alternatives considered" section explicitly rejected for v1 on that cost, while naming it as the retained escalation path. Building it now would be scope creep past an accepted architectural decision, done without the trigger that would justify revisiting it, and without an ADR amendment recording why v1's cost-benefit calculus changed. This note exists so that when the trigger fires, the decision is fast — not "start from zero."

Registry signing (the other half of this issue, landed in the same PR as this note) is **not** a substitute for isolation and does not reduce the urgency of this design. Signing answers *"is this the bundle a trusted publisher produced"* — a supply-chain question, checked once at load time. Isolation answers *"what can this bundle do once it's running"* — a runtime blast-radius question. A validly-signed bundle can still be compromised after publication (a maintainer's account is phished, a dependency is poisoned, a bug is exploited at runtime) or simply buggy in a way that reaches for something it shouldn't. Signing narrows *which* code you trust enough to run; isolation bounds *what happens* if that trust was misplaced. Both matter; neither implies the other. See §5 for how they compose once both exist.

---

## 1. Problem statement (recap — full detail in ADR-0024 D4)

A surface plugin (adapter or renderer) loaded by `src/adapters/loader.ts` runs **in-process**, with the daemon's **full authority**: the stack NKey seed (can sign as the stack), config secrets, CC-session spawn, bash, filesystem. `await import()` executes arbitrary plugin code at load — there is no sandbox between "the loader decided to trust this bundle" and "this bundle's top-level module code is now running with everything the daemon can do." A malicious or compromised plugin is a full stack compromise. The load-time gates (org-trust, first-party exemption, compat check, duplicate-id, entry containment, and now signature verification) are all **load-time**; none of them constrain what an already-imported, already-registered plugin's `createAdapter`/`createRenderer`/`start`/`render` methods can do once the daemon calls them.

This is explicitly **not** covered by the session sandbox (EBH-2..4, `docs/design-session-sandbox.md`): that sandbox wraps `claude --print` child processes — sessions, not the daemon. A plugin runs inside the daemon process itself; wrapping sessions in a kernel jail does nothing for it.

---

## 2. Options considered

### Option A — Separate process per bundle, narrow IPC surface (ADR-0024's named escalation)

Each loaded bundle runs in its own OS process (`Bun.spawn` a small host runtime that `import()`s the bundle and exposes only the `AdapterPlugin`/`RendererPlugin` SDK surface over IPC — likely a JSON-over-pipe or Unix-domain-socket RPC, not raw `postMessage`/shared memory). The daemon process calls into the plugin only through the same `PlatformAdapter`/`Renderer` method signatures it uses today, marshaled over IPC instead of a direct in-process call.

**What this buys:** a compromised bundle's arbitrary-code-execution is confined to *its own process* — it cannot read the daemon's heap (other plugins' loaded state, in-flight message content it wasn't handed, the stack's NKey seed unless explicitly passed to it), cannot forge a call into another bundle, and can be killed/restarted independently without taking the daemon down. This is the acceptance-criteria shape the trigger-gated issue names: *"A bundle cannot read daemon memory / config / other bundles' state"* and *"bundle-to-daemon calls are limited to the declared SDK surface."*

**Cost:** real. Every `PlatformAdapter`/`Renderer` method becomes an IPC round-trip instead of a function call — added latency on the hot inbound/outbound dispatch path (every Discord message, every render). Passing rich objects (envelopes, binding config with secrets, file attachments) across a process boundary needs a serialization contract, which is itself a new attack surface (a malformed IPC message from a compromised child) and a new place for the `secretFields`/binding-schema discipline to leak or be re-implemented incorrectly. Per-adapter lifecycle (spawn, health-check, crash-restart, graceful shutdown, log capture) is a supervision layer that doesn't exist today (`src/cortex.ts` has no `ProcessManager` — see repo CLAUDE.md's explicit "cortex does NOT have... process orchestration" rule, which this option would need to partially reverse or scope narrowly). The gateway's separate-process adapter path (cortex#524, `CONTEXT.md:181`) is real prior art for "adapters as their own process" but runs **unsigned** and is a *different* trust model (out-of-process by default, not as an isolation upgrade for the SAME in-tree loader) — it's a precedent that the architecture supports this shape, not a component this can directly reuse without its own review.

**Verdict:** this is the real fix, and the one ADR-0024 D4 names. It is the option the trigger should cause to happen — engineered properly, at the point the trigger justifies the cost, not spec'd in more detail today (the SDK's exact method surface, and thus the IPC contract, may still shift before the trigger fires).

### Option B — OS-level sandboxing of the whole daemon process (coarser than per-bundle)

Instead of isolating each *bundle*, run the entire cortex daemon inside an OS sandbox (macOS `sandbox-exec`/Seatbelt profile, Linux `bwrap`/landlock/seccomp) — the same primitive family EBH-2/3 already use for session isolation (`docs/design-session-sandbox.md` §4.1's `SessionSandbox` interface / `macos-sbpl` / `linux-bwrap` backends).

**What this buys:** a floor under EVERYTHING the daemon does, plugins included, with infrastructure this epic is already building for sessions — no new supervision layer, no IPC contract, reuses `SessionSandbox`'s profile-generation code.

**Why it doesn't answer the acceptance criteria:** the daemon-level sandbox profile has to be **as permissive as the daemon's own legitimate needs** — NATS connectivity, config file I/O, the stack's own NKey seed, spawning CC sessions, disk access for events/logs. A plugin running inside that same process inherits the SAME permissive profile; it is not confined *relative to the daemon*, only relative to the *host OS* outside the daemon's own already-wide grant. This does not satisfy *"a bundle cannot read daemon memory / config / other bundles' state"* — memory and config are exactly what the daemon-scoped sandbox profile has to allow. **Rejected as the primary mechanism** for the SAME reason EBH-2 v1's `guarded` posture is documented as "narrowed, not closed" (`docs/security/hardening-plan.md` §L2 callout) — a coarse boundary around a process that legitimately needs broad access inside itself doesn't produce the per-plugin confinement this issue asks for. **Retained as defense-in-depth, not a substitute**: once the daemon itself runs under a sandbox profile (a separate, not-yet-scoped effort), a compromised plugin is still bounded by the HOST-level floor even where the per-bundle isolation (Option A) has a gap — the same "belt and suspenders, not either/or" logic already governing L1 vs L2 for sessions.

### Option C — WASM/V8-isolate sandboxing of plugin code

Compile or run plugin bundles inside a WebAssembly runtime or a V8 isolate with a narrow host-function import surface (similar in spirit to Cloudflare Workers' isolate model), rather than a full OS process.

**What this buys:** potentially cheaper than a full process per bundle (no separate OS process, faster spawn, tighter memory isolation than same-process JS but without process-boundary IPC latency for every call — depending on the runtime, some isolate models support fast in-process host-function calls).

**Cost / why not recommended for v1-of-the-escalation:** cortex's plugin SDK (`src/surface-sdk/`) is an ordinary TypeScript/Bun module contract today — `import()`ing a `.ts` file, calling async methods that themselves do real I/O (HTTP calls to Discord/Slack/Mattermost APIs, filesystem reads for attachments). Neither Bun nor Node ships a production-ready "run this TS module inside a V8 isolate with a host-function bridge" primitive the way Cloudflare Workers does — building one is a bigger and less-precedented lift than Option A, which reuses ordinary OS process primitives cortex already understands (`Bun.spawn`, already used for `arc list`, CC sessions, and the gateway's separate-process adapters). A bundle author would also need a materially different authoring model (no arbitrary `fs`/`net` access even for legitimate reasons, e.g. an adapter's own platform SDK making HTTP calls) unless the isolate is given broad host-function access anyway — which erodes the isolation benefit back toward Option A's IPC-surface problem without Option A's simpler mental model (OS process boundaries are well-understood; isolate escape classes are their own specialized field). **Rejected for v1 of the escalation** — worth revisiting only if Option A's per-process overhead proves prohibitive in practice, which requires actually building Option A first to measure.

### Option D — Do nothing beyond load-time gates + signing (status quo + this PR)

Keep the load-time-only trust model, now strengthened by signature verification, and accept D4's risk indefinitely.

**Why this is the current, deliberate state, not a rejected option:** this is exactly what ADR-0024 D4 already decided for v1, and the trigger conditions exist precisely so this stays true UNTIL one of them fires. It is listed here for completeness, not as a live alternative being chosen — the epic's whole premise is that this stops being acceptable once a non-first-party bundle or federated deployment is real.

---

## 3. Recommended shape (for when the trigger fires)

**Option A** (separate process per bundle, narrow IPC surface), engineered at that time against whatever `src/surface-sdk/` looks like then. Sketch of what "engineered properly" should include, so a future implementer starts from more than a blank page:

- **One child process per LOADED bundle**, not per platform instance — matches today's `SurfacePluginRegistry` granularity (`(kind, id)`-keyed), so an adapter with multiple bound instances (e.g. two Discord bot tokens) still shares one process, same as it shares one in-process class today.
- **IPC surface = the SDK, nothing else.** The child process's ONLY communication channel to the daemon is a request/response RPC whose method set is generated from (or manually kept in lock-step with) `PlatformAdapter`/`Renderer`'s method signatures. No shared filesystem access beyond what the bundle's own binding config grants it (e.g. attachment temp dirs, explicitly passed); no shared NKey seed (the daemon signs on the plugin's behalf when a signed action is needed, never hands the seed across the boundary); no arbitrary daemon-internal call.
- **Crash isolation is already half-designed**: `loadExternalPlugins`'s existing "one bad bundle never takes down boot or another bundle" contract (ADR-0024 §3.3, D3) extends naturally to "one CRASHED child process never takes down the daemon or another bundle's child" — a supervision loop restarts a crashed plugin process the same way today's code isolates a bad `import()`.
- **Secrets cross the boundary deliberately, not implicitly.** `AdapterPlugin.secretFields` already names which binding fields are secret (`src/adapters/registry.ts`) — the IPC transport should treat those the same way `bash-guard`/config loaders already treat secrets (never logged, redacted in any IPC-level tracing), and the daemon should hand a plugin process only the binding it needs, not the whole resolved `Surfaces` config.
- **Ship staged**, mirroring every other control in this epic (`docs/security/hardening-plan.md`'s whole ladder, `SecurityPostureSchema.signing`'s off/permissive/enforce, `SessionSandbox`'s off/audit/enforce): an `audit` mode that runs plugins isolated but doesn't yet enforce the narrowed IPC surface (logs a would-have-been-refused call), then `enforce`. Building the isolation with an on/off switch from day one avoids the EBH-2 v1 lesson (a control that can't be tried in production before it's trusted is a control nobody dares turn on).

None of this is being built now — it is recorded so the trigger-fired implementer has a starting sketch rather than a re-read of ADR-0024's one paragraph.

---

## 4. Trigger → action mapping

| Trigger | What should happen |
|---|---|
| **First non-first-party bundle** about to load (`system.plugins.external` flips on for a stack that will load a bundle outside cortex's own `metafactory-cortex-adapter-*`/`metafactory-cortex-renderer-*` first-party set) | Before that stack goes live: (1) populate `PLUGIN_TRUST_ROOT` (`src/adapters/plugin-signing.ts`) with a real production key and require that bundle to be signed under `system.plugins.signing: enforce` — signing is buildable TODAY and should gate this immediately; (2) open the Option-A implementation as its own epic/issue, scoped against the then-current `src/surface-sdk/`, and treat that stack's exposure between "bundle loads" and "isolation ships" as a tracked, time-boxed risk acceptance, not a silent gap. |
| **First federated deployment** (cross-principal bus) | Same as above — federation raises the stakes because a compromised plugin now has reach into cross-principal trust material (leaf secrets, admission state), not just a single-principal stack. Isolation should land BEFORE the first federated stack also runs a non-first-party bundle; a federated stack running only first-party, signed bundles is a smaller, still-nonzero risk (ADR-0024 D4's mitigations 1-3 all still apply to first-party bundles) that the epic's principal can consciously accept per-deployment. |
| **Neither trigger** (today) | No isolation work. Registry signing (this PR) is the standing, non-trigger-gated improvement — it does not wait for either trigger because it is cheap, additive, and directly named by ADR-0024 D4 as part of the mitigation set. |

---

## 5. How signing and isolation compose once both exist

They are independent, layered controls, not sequential steps:

- **Signing without isolation** (this PR's state): raises the bar for "which code gets a chance to run" but a validly-signed, compromised-after-signing, or simply buggy bundle still has full daemon authority once it runs. This is where cortex is after this PR.
- **Isolation without signing**: any bundle that clears the org-trust/first-party gates can run, confined to its own process — bounds the blast radius of a bug or compromise, but admits a wider set of code in the first place (no cryptographic provenance check).
- **Both**: only signed-and-trusted code runs, AND it runs confined. This is the target state once the trigger fires and Option A ships. Neither control should be described as making the other unnecessary — a reviewer reading only one of the two doc headers (`plugin-signing.ts` or this note) should come away with an accurate, not overstated, picture of what's actually enforced.

---

## 6. Non-goals of this note

- No implementation, no interface code, no IPC wire format spec — that is the trigger-fired implementer's job, informed by §3's sketch.
- No ADR amendment. ADR-0024 D4 is unchanged by this note; §"Consequences" of this issue's parent PR states precisely what (nothing, on the isolation side) changed about what D4 asserts is true. If a future PR implements Option A, THAT PR should amend or supersede D4, not this design note.
- No change to `system.plugins.external`'s default-off posture, the first-party exemption computation, or any existing load-time gate.
