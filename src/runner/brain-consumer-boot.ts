/**
 * S8 lane 2 (epic #1514, plan §2, cortex#1522) — boot wiring for the
 * per-agent exec-brain consumer construction, extracted from the
 * ~200-line `startBrainConsumersForAgent` closure that used to live inline
 * in `src/cortex.ts` (Bot Packs B-1/B-2, cortex#1021/#1033). Modeled on S7's
 * `review-consumer-boot.ts`: a narrow structural `BrainBootAgent`
 * projection + a `WireBrainConsumersOpts` interface listing every
 * boot-scoped value the wiring needs, so the construction is
 * unit-testable without standing up `startCortex`.
 *
 * **Same two-call-site shape as the review lane.** `cortex.ts` calls this
 * construction TWICE — once in the boot loop over `brainAgents`, and again
 * from the `agents.d/` hot-reload path for each added/changed exec-brain
 * agent (§B-1 design §7/§11). `wireBrainConsumers` returns a callable,
 * `startForAgent`, that `cortex.ts` invokes per agent at both sites, exactly
 * where `startBrainConsumersForAgent(agent)` used to be called.
 *
 * **No hosting filter here.** The `isBrainHosted` predicate (an exec-brain
 * agent with at least one declared capability) stays in `cortex.ts` — both
 * call sites only ever invoke `startForAgent` for an agent already known to
 * be brain-hosted (`brainAgents`/`isBrainHosted`). This module has nothing
 * to decide about eligibility; it only builds + subscribes. Same division of
 * labour as `wireReviewConsumers`.
 *
 * **`opts.brainConsumers` / `opts.daemonBrainHosts` are shared, NOT owned,
 * arrays.** `cortex.ts` still declares `const brainConsumers: BrainConsumer[]
 * = []` and `const daemonBrainHosts: DaemonBrainHost[] = []`, and reads both
 * for the hot-reload diff (`drainConsumersForAgent`) and the shutdown drain —
 * both well outside this slice's scope. `startForAgent` pushes onto the SAME
 * array references (passed once as opts fields), so those call sites keep
 * seeing every consumer/host this module wires, unchanged.
 *
 * **`opts.brainPresenceHolder` is a shared, mutable HOLDER OBJECT — not a
 * mutable-capture that needs getter/setter threading.** The holder itself
 * (`{ producer: AgentPresenceProducer | null }`) is a `const` in `cortex.ts`,
 * constructed once, before this module is ever called; only its `.producer`
 * FIELD is assigned later (once the presence producer is constructed,
 * further down boot). Passing the object by reference means a daemon host's
 * `onDegraded` callback — which fires at RUNTIME, long after boot, reading
 * `opts.brainPresenceHolder.producer` lazily — sees the assignment cortex.ts
 * made in between, exactly as the inline closure did. No getter/setter pair
 * is needed because the reference itself is never reassigned.
 *
 * **Free-variable capture — no mutable-capture threading needed for the
 * rest.** Every other value `WireBrainConsumersOpts` carries is a plain
 * snapshot, because none of the captured `cortex.ts` `let`s are reassigned
 * after `wireBrainConsumers` is constructed (boot-time, right where the old
 * closure used to be defined) and before either call site runs: `runtime`
 * (a `let`) is assigned once from either `options.injectRuntime` or
 * `startMyelinRuntime(...)`, well before the boot loop or any hot-reload
 * event. `surfacePrincipalGate`, `brainPackBaseDir`, `brainJsm`,
 * `brainTasksStream`, `reviewConsumerMaxDeliver`, `reviewPrincipalId`, and
 * `systemEventSource` are all `const`s assigned exactly once, earlier in
 * boot. The old closure only ever READ these — it never reassigned any of
 * them — so a plain value capture at construction time is behaviourally
 * identical to the inline closure's live-binding read.
 *
 * **`collectBrainSecrets` / `loadBrainPersona` moved here wholesale.** Both
 * were module-level private helpers in `cortex.ts` with no callers outside
 * the extracted closure — they move with it rather than staying behind as
 * now-orphaned functions.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  BrainConsumer,
  BRAIN_TASK_SUBJECT_FAMILY,
  type BrainConsumerAgent,
} from "../bus/brain-consumer";
import {
  SubprocessDispatchStateRecorder,
  type DispatchStateRecorder,
} from "../common/agents/dispatch-state-recorder";
import { provisionReviewConsumer, type ProvisionJsm } from "../bus/jetstream/provision";
import { makeExecBrainRunner } from "../brain/exec-brain-runner";
import {
  DaemonBrainHost,
  type CreatePrivateThreadFn,
  type DaemonTransport,
} from "../brain/daemon-brain-host";
import type { SystemEventSource } from "../bus/system-events";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import type { AgentPresenceProducer } from "./agent-presence-producer";
import type { SurfacePrincipalGate } from "../bus/surface-principal-gate";
import type { AgentModelClass } from "../bus/sovereignty-gate";
import type { PlatformAdapter } from "../adapters/types";

// ---------------------------------------------------------------------------
// The narrow agent shape the boot wiring consumes
// ---------------------------------------------------------------------------

/**
 * Minimal projection of a cortex.yaml `Agent` the brain boot wiring needs —
 * structural (not the full Zod `Agent`) so `cortex.ts` passes
 * `mergedAgents`/hot-reload agents without a cast, mirroring
 * `ReviewBootAgent`/`DevBootAgent`.
 */
export interface BrainBootAgent {
  id: string;
  /** Path to the agent's persona markdown file (Architecture §9.3). */
  persona: string;
  /**
   * cortex#1720 S1 — OPT-IN per-instance durable state declaration. Present ⇒
   * this fragment is STATEFUL: the boot wiring constructs a
   * {@link DispatchStateRecorder} (S3) so its dispatch lifecycle records
   * AgentState work_items. Absent ⇒ stateless, zero new code paths. The full
   * Zod `Agent` carries this (added in S1); this structural projection re-declares
   * it so the wiring can gate on it without a cast.
   */
  state?: { blueprint: string; version: string };
  /**
   * cortex#2215 — the Pier "open-onboarding" gate (`AgentSchema.openOnboarding`,
   * cortex#1165). `true` ⇒ this agent is reachable by an unmapped, zero-
   * authority anon principal, which is ALSO the (and, per the ADR, the ONLY)
   * criterion this boot wiring uses to decide whether a `lifecycle: daemon`
   * agent gets a live `create_private_thread` capability at all (see
   * `startForAgent` below). Absent/`false` ⇒ no capability is wired for this
   * agent — fail-safe: the wider "explicit member list" path for a trusted,
   * non-anon-reachable agent is deliberately out of scope here (ADR
   * cortex#2206 #1: "which future agents get [the wider path] is each of
   * their own onboarding, not a blanket switch").
   */
  openOnboarding?: boolean;
  /**
   * cortex#2215 — the per-platform presence bindings this wiring reads to
   * resolve `create_private_thread`'s parent channel. Only Discord's
   * `agentChannelId` is consulted today (the primitive's first real
   * consumer); other platforms are structurally absent here rather than
   * wired to a no-op, so a future platform's own presence shape doesn't need
   * a dead field on every agent that never uses it.
   */
  presence?: {
    discord?: {
      /** `presence.discord.agentChannelId` — the agent's own bound channel. */
      agentChannelId?: string;
    };
  };
  runtime?: {
    capabilities?: readonly string[];
    maxConcurrent?: number;
    /** Governance Stage 1b — feeds the consumer-side sovereignty gate. */
    modelClass?: AgentModelClass;
    brain?: {
      kind: "builtin" | "exec";
      /** Argv template, e.g. `"bun {pack}/brain/main.ts"`. Required for `exec`. */
      run?: string;
      lifecycle: "per-task" | "daemon";
      /** Env var NAMES to forward into the brain's minimal env. */
      secrets: readonly string[];
      /** The manifest ALLOW-LIST for `dispatch` effects. */
      dispatch_capabilities: readonly string[];
      /** Daemon supervision restart cap (`lifecycle: daemon` only). */
      maxRestarts: number;
    };
  };
}

/** Inputs `cortex.ts` threads into the brain-consumer boot wiring. */
export interface WireBrainConsumersOpts {
  /** Arc install dir `{pack}` expands to (`{brainPackBaseDir}/{agentId}`). */
  brainPackBaseDir: string;
  /** `{principal}` subject segment — durable names. */
  reviewPrincipalId: string;
  /** `{stack}` subject segment — subscribe pattern. */
  stack: string;
  /** Bus-side event source every consumer publishes lifecycle envelopes through. */
  systemEventSource: SystemEventSource;
  /** The (possibly dormant) MyelinRuntime the consumer subscribes against. */
  runtime: MyelinRuntime;
  /**
   * B-3 (design-bot-packs.md §4, §6, §8) — the shared surface-reply gate for
   * `ask_principal` effects. Undefined ⇒ the consumer keeps its DenyAll
   * default (fail-closed — no configured surface identity to verify a reply
   * against).
   */
  surfacePrincipalGate?: SurfacePrincipalGate;
  /**
   * Shared, mutable holder for the presence producer — see the file header's
   * note on why this is a reference, not a getter/setter pair. `cortex.ts`
   * owns the assignment (further down boot, once the producer is
   * constructed); this module only reads `.producer` lazily inside a daemon
   * host's `onDegraded` callback.
   */
  brainPresenceHolder: { producer: AgentPresenceProducer | null };
  /**
   * Shared consumer array — the SAME array `cortex.ts` owns for its
   * hot-reload diff (`drainConsumersForAgent`) and shutdown drain. This
   * module pushes onto it; it does not own the array's lifecycle.
   */
  brainConsumers: BrainConsumer[];
  /**
   * Shared daemon-host array — ditto, for `lifecycle: daemon` teardown
   * (hot-swap drain + unconditional shutdown stop).
   */
  daemonBrainHosts: DaemonBrainHost[];
  /**
   * Resolved JetStream manager, or `null` when the runtime is dormant.
   * cortex#2247 — this is the BRAIN lane's own provisioning JSM (resolved in
   * `cortex.ts` independently of review-capability presence), so a brain-only
   * stack provisions its per-capability durables too. Renamed from
   * `reviewJsm`, whose name encoded the former review-gate coupling.
   */
  brainJsm: ProvisionJsm | null;
  /** BRAIN_TASKS stream name (B-3, cortex#1021). */
  brainTasksStream: string;
  /** Durable max-deliver, shared with the review/release lanes. */
  reviewConsumerMaxDeliver: number;
  /**
   * cortex#1720 S3 — factory for the dispatch-lifecycle state recorder (test
   * seam). Called ONLY for a `state:`-declaring (stateful) agent, behind the
   * `if (agent.state)` guard below. Defaults to the real
   * {@link SubprocessDispatchStateRecorder} (subprocesses to the bundle's
   * `errands.ts`). A stateless agent never reaches this factory, so its consumer
   * gets no recorder and takes zero new dispatch code paths. Injected so tests
   * assert which agents are wired with a recorder without a real bundle.
   */
  makeDispatchStateRecorder?: (agent: { id: string }) => DispatchStateRecorder;
  /**
   * cortex#2215 — shared, mutable holder mapping `agent.id` → its constructed
   * `PlatformAdapter`, populated by `wireSurfaceAdapters` LATER in boot
   * (surface adapters construct AFTER brain consumers — see `cortex.ts`'s
   * boot order). This module never iterates or reads the map at
   * CONSTRUCTION time; a `lifecycle: daemon` agent's `createPrivateThread`
   * closure (see `startForAgent` below) captures the map by REFERENCE and
   * reads `.get(agentId)` LAZILY, only when the `create_private_thread`
   * effect actually fires — which structurally cannot happen before
   * `wireSurfaceAdapters` has run (reaching the effect requires a live task
   * to already have been dispatched to the brain over the bus). Same
   * holder-indirection idiom `cortex.ts` already uses for
   * `brainPresenceHolder`; resolves the adapter-construction-ordering
   * problem without reordering boot.
   */
  agentPlatformAdapters: ReadonlyMap<string, PlatformAdapter>;
  /**
   * Test-only seam — override the `DaemonBrainHost`'s transport instead of
   * the real `makeBunUnixTransport` (spawn-a-real-subprocess) default. Lets
   * an integration test drive a `lifecycle: daemon` agent through this REAL
   * boot-wiring function against an in-memory fake brain, with no real
   * socket/subprocess. Production omits this.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  daemonTransport?: DaemonTransport;
}

/** The callable `cortex.ts` invokes per agent, at both the boot loop and the `agents.d/` hot-reload sites. */
export interface WiredBrainConsumers {
  startForAgent: (agent: BrainBootAgent) => Promise<void>;
}

/**
 * Bot Packs B-1 (cortex#1033 §Maintainability) — collect the declared brain
 * secrets from THIS process's env. Only named keys are forwarded into the
 * brain's minimal env (the runner enforces the minimal-env policy; §8). A
 * named-but-unset secret is simply absent (logged once for visibility — the
 * install-time consent is the arc-side gate). Pure except for the stderr log.
 */
function collectBrainSecrets(
  agentId: string,
  declared: readonly string[],
): Record<string, string> {
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of declared) {
    const value = process.env[name];
    if (value !== undefined) secrets[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    process.stderr.write(
      `cortex: brain agent=${agentId} declares secrets not present in the ` +
        `environment: [${missing.join(",")}] — they will be absent from ` +
        `the brain process (install-time consent is the arc-side gate)\n`,
    );
  }
  return secrets;
}

/**
 * Bot Packs B-1 (cortex#1033 §Maintainability) — read the persona text once at
 * brain start. `personaPath` is the loader-resolved file PATH. A
 * missing/unreadable persona is non-fatal: returns `undefined` (the brain
 * receives no persona) and logs once.
 */
function loadBrainPersona(
  agentId: string,
  personaPath: string,
): string | undefined {
  try {
    return readFileSync(personaPath, "utf-8");
  } catch (personaErr) {
    process.stderr.write(
      `cortex: brain agent=${agentId} persona unreadable at "${personaPath}": ` +
        `${personaErr instanceof Error ? personaErr.message : String(personaErr)} — ` +
        `proceeding without persona\n`,
    );
    return undefined;
  }
}

/**
 * cortex#2215 — build the `CreatePrivateThreadFn` a `lifecycle: daemon`
 * `DaemonBrainHost` calls for its `create_private_thread` effect. Reads
 * `adapters` (the shared, mutable holder — see
 * {@link WireBrainConsumersOpts.agentPlatformAdapters}) LAZILY, at call time,
 * not at construction time — so it is correct regardless of whether
 * `wireSurfaceAdapters` has run yet. NEVER throws: a missing adapter (no
 * platform binding constructed for this agent — disabled instance, gateway-
 * owned, construction failure, …) or an adapter that doesn't implement
 * `createPrivateThread` (a bundle with no stake in this capability) both
 * resolve `{ ok: false, detail }`, matching {@link CreatePrivateThreadFn}'s
 * own never-throws contract (mirrors every other injected I/O seam in
 * `daemon-brain-host.ts`).
 */
function makeCreatePrivateThreadFn(
  agentId: string,
  adapters: ReadonlyMap<string, PlatformAdapter>,
): CreatePrivateThreadFn {
  return async (callOpts) => {
    const adapter = adapters.get(agentId);
    if (adapter?.createPrivateThread === undefined) {
      return {
        ok: false,
        detail:
          adapter === undefined
            ? `no platform adapter configured for agent "${agentId}"`
            : `adapter "${adapter.platform}" for agent "${agentId}" does not implement createPrivateThread`,
      };
    }
    return adapter.createPrivateThread(callOpts);
  };
}

/**
 * Build the per-agent exec-brain consumer construction. Returns
 * `startForAgent` — the same construction the boot loop (over `brainAgents`)
 * and the `agents.d/` hot-reload path (for an added/changed exec-brain
 * agent) both call, so a hot-added agent's brain consumer starts identically
 * to a boot agent's. Never throws: a single agent's consumer-init failure is
 * caught and logged so siblings still wire (mirrors the pre-extraction
 * closure).
 */
export function wireBrainConsumers(
  opts: WireBrainConsumersOpts,
): WiredBrainConsumers {
  const startForAgent = async (agent: BrainBootAgent): Promise<void> => {
    try {
      const brain = agent.runtime?.brain;
      if (brain?.kind !== "exec" || brain.run === undefined) {
        // Defensive: the caller filters to exec brains with a `run`; a
        // mis-routed builtin/absent brain is a no-op, not a crash.
        return;
      }
      const caps = agent.runtime?.capabilities ?? [];
      const consumerAgent: BrainConsumerAgent = {
        id: agent.id,
        capabilities: caps,
        dispatchCapabilities: brain.dispatch_capabilities,
        ...(agent.runtime?.maxConcurrent !== undefined && {
          maxConcurrent: agent.runtime.maxConcurrent,
        }),
        ...(agent.runtime?.modelClass !== undefined && {
          modelClass: agent.runtime.modelClass,
        }),
      };

      // Resolve the per-task runner over the manifest `brain` block. `{pack}`
      // expands to `{base}/{agentId}` (the arc install dir; design §7.1). The
      // declared secrets resolve from THIS process's env at spawn — only the
      // named keys are forwarded into the brain's minimal env (the runner
      // enforces the minimal-env policy; §8). A named-but-unset secret is
      // simply absent in the env (logged once for visibility). cortex#1033
      // §Maintainability — secret collection + persona load are extracted to
      // the module-level `collectBrainSecrets` / `loadBrainPersona` helpers so
      // this startup closure reads as a sequence of named steps.
      const packDir = join(opts.brainPackBaseDir, agent.id);
      const secrets = collectBrainSecrets(agent.id, brain.secrets);

      // Persona delivered to the brain — per-task brains receive it on each task
      // event; daemon brains receive it ONCE in the `hello` handshake (§5
      // "Persona delivery"). A missing/unreadable persona is non-fatal.
      const personaText = loadBrainPersona(agent.id, agent.persona);

      // Bot Packs B-2 — `lifecycle: daemon` is hosted by a long-lived
      // DaemonBrainHost (spawn once, socket-multiplex tasks, supervise + drain);
      // `per-task` (default) keeps the B-1 per-spawn runner. Both feed the SAME
      // BrainConsumer policy seam (the consumer is lifecycle-agnostic — it routes
      // brain effects through the host hooks identically). The lifecycle-specific
      // runner is mutually exclusive: a daemon agent passes `daemonHost` (no
      // per-task runner constructed), a per-task agent passes `runBrainTask`.
      // The `principalGate` (B-3, cortex#1021 W-2): when the principal has a
      // configured surface identity, every brain consumer gets the SHARED
      // `surfacePrincipalGate` — `ask_principal` renders to the task's
      // surface/thread and awaits the principal's identity-checked reply via
      // the `gateReplyRouter` bridge (wired into each adapter's inbound flow
      // at adapter start). Tasks that are bus-only, on a surface this
      // instance doesn't host, or on a surface with no configured principal
      // id STILL fail closed inside the gate (resolve-time checks). With no
      // principal surface identity at all the consumer keeps its
      // DenyAllPrincipalGate default (B-1 fail-closed).
      // Sovereignty audit-parity by default, mirroring ReviewConsumer (a
      // self-declared modelClass is spoofable until bound to the signing
      // identity, cortex#327).
      // cortex#1720 S3 — OPT-IN dispatch-lifecycle state recorder. Constructed
      // ONLY for a `state:`-declaring (STATEFUL) fragment, so the gate is at
      // CONSTRUCTION (not a per-envelope string check inside the consumer). A
      // stateless fragment leaves `stateRecorder` undefined and its consumer's
      // `this.stateRecorder?.…` calls short-circuit — zero new dispatch paths.
      const makeRecorder =
        opts.makeDispatchStateRecorder ??
        ((a: { id: string }) => new SubprocessDispatchStateRecorder(a));
      const stateRecorder: DispatchStateRecorder | undefined = agent.state
        ? makeRecorder({ id: agent.id })
        : undefined;

      const baseConsumerOpts = {
        agent: consumerAgent,
        source: opts.systemEventSource,
        runtime: opts.runtime,
        ...(personaText !== undefined && { persona: personaText }),
        ...(opts.surfacePrincipalGate !== undefined && {
          principalGate: opts.surfacePrincipalGate,
        }),
        ...(stateRecorder !== undefined && { stateRecorder }),
      };
      // cortex#2215 — wire cortex#2206's `create_private_thread` capability
      // for exactly the agents its ADR intends: `openOnboarding: true` (the
      // Pier "open-onboarding" gate, `AgentSchema.openOnboarding`) AND a
      // bound Discord `agentChannelId`. BOTH conditions are required —
      // `openOnboarding` alone with no Discord binding has no channel to
      // open a thread on; a Discord binding alone on a NON-open-onboarding
      // agent is deliberately left unwired (the wider "explicit member
      // list" path for a trusted agent is its own future onboarding
      // decision per the ADR, not something this generic wiring grants by
      // default). Either condition failing ⇒ `agentChannelId` /
      // `createPrivateThread` stay UNDEFINED on the host — the fail-safe
      // "no capability at all" state (every `create_private_thread` effect
      // this agent's brain emits is refused `effect_rejected`/`cant_do` —
      // DaemonBrainHost's structural "no thread-capable surface configured"
      // path — regardless of `anonReachable`'s own true-by-default).
      const discordAgentChannelId = agent.presence?.discord?.agentChannelId;
      const isOpenOnboarding = agent.openOnboarding === true;
      const wireCreatePrivateThread =
        isOpenOnboarding && discordAgentChannelId !== undefined;

      let daemonHost: DaemonBrainHost | undefined;
      let consumer: BrainConsumer;
      if (brain.lifecycle === "daemon") {
        daemonHost = new DaemonBrainHost({
          agentId: agent.id,
          run: brain.run,
          packDir,
          secrets,
          maxRestarts: brain.maxRestarts,
          ...(personaText !== undefined && { persona: personaText }),
          ...(opts.daemonTransport !== undefined && { transport: opts.daemonTransport }),
          // cortex#2215 — see the `wireCreatePrivateThread` computation
          // above. `anonReachable: true` is set EXPLICITLY (not left to
          // `DaemonBrainHost`'s own safe-by-default) because it must track
          // `isOpenOnboarding`, not just "capability configured" — an
          // open-onboarding agent's brain may ONLY ever request
          // `members: "source"` (cortex#2206 policy), never an explicit
          // member list, and that gate is what `anonReachable: true` turns
          // on inside the host.
          ...(wireCreatePrivateThread && {
            agentChannelId: discordAgentChannelId,
            anonReachable: true,
            createPrivateThread: makeCreatePrivateThreadFn(
              agent.id,
              opts.agentPlatformAdapters,
            ),
          }),
          // On degradation (restart budget exhausted) surface the agent via the
          // presence producer's capability-change signal (drop to empty caps),
          // the same path the reconcile uses (§7.4). Read the holder lazily —
          // the producer is constructed after this boot closure runs.
          onDegraded: (degradedId: string): void => {
            const producer = opts.brainPresenceHolder.producer;
            if (producer !== null) {
              producer.publishCapabilitiesChanged(degradedId, []);
            }
            process.stderr.write(
              `cortex: daemon brain agent=${degradedId} marked DEGRADED — ` +
                `restart budget exhausted; presence signalled\n`,
            );
          },
        });
        // Spawn + connect + hello. A spawn/connect failure is logged; the
        // consumer still registers so a later reload can replace it. The
        // consumer's runner (the host's runTask) fast-fails not_now until the
        // host connects, so no task is silently lost.
        // Non-blocking start (sage cortex#1035 round 3): start() resolves on
        // the socket handshake, so awaiting here would make cortex boot
        // latency the SUM of every daemon's spawn+auth. The consumer's
        // runner fast-fails not_now until the host connects (documented
        // above), so registering the consumer before the handshake settles
        // loses nothing — failures land in the same stderr path.
        void daemonHost.start().catch((startErr: unknown) => {
          process.stderr.write(
            `cortex: daemon brain host start failed for agent=${agent.id}: ` +
              `${startErr instanceof Error ? startErr.message : String(startErr)}\n`,
          );
        });
        opts.daemonBrainHosts.push(daemonHost);
        consumer = new BrainConsumer({ ...baseConsumerOpts, daemonHost });
      } else {
        const runBrainTask = makeExecBrainRunner({ run: brain.run, packDir, secrets });
        consumer = new BrainConsumer({ ...baseConsumerOpts, runBrainTask });
      }
      opts.brainConsumers.push(consumer);

      // Provision + bind one durable pull consumer per declared capability.
      // Subject grammar: `local.{principal}.{stack}.tasks.{capability}` (the
      // myelin task-envelope grammar the design + agent envelopes use — the
      // capability is a literal trailing segment, no `>` wildcard since a brain
      // task subject is exact per capability). Durable name is unique per
      // (principal, agent, capability).
      //
      // cortex#1033 §Architecture/§HonestOracle — provision ALL capability
      // durables UP-FRONT and AWAIT them BEFORE calling `consumer.start()`, so
      // the bind inside `start()` cannot race ahead of a not-yet-created durable
      // on a virgin broker. This mirrors the review path (which awaits
      // `provisionReviewConsumer` before `consumer.start()`); the brain path
      // previously fired `void provisionReviewConsumer(...)` from inside the
      // synchronous `resolve` callback, which returned the subscription params
      // immediately while provisioning was still in flight. `resolve` is now a
      // pure subject/durable resolver with no side effect.
      // B-3 (cortex#1021): brain task subjects live on the `brain.` family /
      // BRAIN_TASKS stream — NOT `tasks.`/CODE_REVIEW (where B-1 bound them,
      // a stream that never carried non-code-review capabilities). The inbound
      // dispatch publishes onto exactly this subject.
      const brainCapabilities = consumerAgent.capabilities;
      const brainDurableFor = (capability: string): string =>
        `cortex-brain-consumer-${opts.reviewPrincipalId}-${agent.id}-${capability.replaceAll(".", "-")}`;
      const brainPatternFor = (capability: string): string =>
        `local.${opts.reviewPrincipalId}.${opts.stack}.${BRAIN_TASK_SUBJECT_FAMILY}.${capability}`;

      if (opts.brainJsm !== null) {
        // Hoisted to a local `const` — a narrowed PROPERTY access
        // (`opts.brainJsm`) does not survive into the nested `async`
        // closure below (TS drops property narrowing across closure
        // boundaries), while a narrowed `const` binding does. Mirrors the
        // pre-extraction closure, which narrowed a plain top-level `const`.
        const jsm = opts.brainJsm;
        // Independent durables — provision in one parallel wave (sage
        // cortex#1033 round 2); still awaited as a whole BEFORE start().
        await Promise.all(
          brainCapabilities.map(async (capability) => {
            const durable = brainDurableFor(capability);
            try {
              await provisionReviewConsumer({
                jsm,
                stream: opts.brainTasksStream,
                durable,
                filterSubject: brainPatternFor(capability),
                maxDeliver: opts.reviewConsumerMaxDeliver,
              });
            } catch (provisionErr) {
              // Don't abort — let `consumer.start()` surface the bind failure
              // through its own dormant/skip path (mirrors the review path).
              process.stderr.write(
                `cortex: provisionReviewConsumer (brain) failed for "${durable}": ` +
                  `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
              );
            }
          }),
        );
      }

      const started = await consumer.start({
        resolve: (capability) => ({
          pattern: brainPatternFor(capability),
          stream: opts.brainTasksStream,
          durable: brainDurableFor(capability),
        }),
      });

      const capSummary =
        started.capabilities.length > 0 ? started.capabilities.join(",") : "(none)";
      if (started.subscribedCapabilities.length > 0) {
        console.log(
          `cortex: brain consumer ready for agent=${agent.id} kind=exec ` +
            `capabilities=[${capSummary}] subscribed=[${started.subscribedCapabilities.join(",")}] ` +
            `gate=${opts.surfacePrincipalGate !== undefined ? "surface" : "deny-all"}`,
        );
      } else {
        console.log(
          `cortex: brain consumer DORMANT for agent=${agent.id} kind=exec ` +
            `capabilities=[${capSummary}] ` +
            `gate=${opts.surfacePrincipalGate !== undefined ? "surface" : "deny-all"} ` +
            `— cortex MyelinRuntime subscriptions disabled ` +
            `(G-1111 pending; tasks.{capability} envelopes will not be claimed by this brain)`,
        );
      }
    } catch (err) {
      // Per CLAUDE.md: log every error. One brain's wiring failure does NOT
      // abort boot; the consumer (if pushed) stays in `brainConsumers[]` so the
      // shutdown drain still calls `.stop()` (idempotent).
      process.stderr.write(
        `cortex: brain consumer init failed for agent=${agent.id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  return { startForAgent };
}
