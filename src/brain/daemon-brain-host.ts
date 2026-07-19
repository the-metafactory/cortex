/**
 * `cortex-brain/v1` daemon host (Bot Packs B-2; `docs/design-bot-packs.md`
 * §5, §7, §12.1).
 *
 * The cortex-side half of the `kind: exec`, `lifecycle: daemon` seam: a
 * LONG-LIVED brain process per agent, spawned ONCE, speaking the protocol over a
 * cortex-assigned **Unix domain socket** (§12.1: socket for protocol, stdio for
 * logs). Per-task events MULTIPLEX over the one socket — every event/effect
 * already carries `task_id` (protocol.ts), so a single connection serves many
 * concurrent tasks. The host:
 *
 *   1. spawns the brain with a MINIMAL env (PATH/HOME/LANG/TMPDIR + the
 *      manifest secrets, same discipline as `exec-brain-runner`) plus the
 *      `CORTEX_BRAIN_SOCKET` env naming the socket to connect back on, a
 *      per-spawn `CORTEX_BRAIN_SOCKET_TOKEN` the brain MUST echo as its first
 *      socket line to authenticate (`{ v:1, type:"auth", token }` — see
 *      {@link DaemonTransport}), and the `lifecycle: daemon`-marking
 *      `CORTEX_BRAIN_LIFECYCLE=daemon`;
 *   2. waits for the brain to connect + AUTHENTICATE, then sends the `hello`
 *      handshake
 *      (host → brain: agent id, persona, protocol version — §5 "Persona
 *      delivery"; identity is HOST-AUTHORITATIVE);
 *   3. accepts `runTask(task, hooks)` calls — writes the `task` event, routes
 *      the brain's effects (post / ask_principal / dispatch / log / result) to
 *      the per-task hooks, and resolves when that task's `result` arrives.
 *      `create_private_thread` (cortex#2206) is the one effect NOT routed
 *      through the per-task hooks: it is host-POLICY (channel binding,
 *      anon-reachable membership gate, rate limit), so this file enforces it
 *      directly and calls an injected {@link CreatePrivateThreadFn} only for
 *      the mechanical create-thread-and-add-members I/O. `post_log`
 *      (cortex#2256) splits the same way: the POLICY gates (log-channel
 *      binding, length cap, rate limit) are enforced here, and only a
 *      gate-passing effect reaches the consumer's `onPostLog` hook — with
 *      the HOST-derived target channel as an argument, never brain input;
 *   4. enforces, PER TASK (not per process): task_id correlation, scratch
 *      confinement, and the 4 MiB attachment budget (§12.5). Scratch dirs are
 *      created per TASK and removed when the task closes — confinement stays
 *      task-scoped even though the process is shared (the task brief: "scratch
 *      dir per TASK, not per process");
 *   5. SUPERVISES the process: a crash restarts it up to `maxRestarts`, then
 *      marks the agent DEGRADED; the restart counter RESETS after a healthy
 *      uptime interval. All in-flight tasks of a crashed brain fail
 *      (`cant_do`, "brain crashed") — the consumer maps that to
 *      `dispatch.task.failed` + nak;
 *   6. DRAINS on hot-swap (`drain(deadlineMs)`): sends `shutdown` with the
 *      deadline, waits for in-flight tasks (and open `ask_principal` gates) up
 *      to the deadline, CANCELS anything still open past it, then SIGTERM →
 *      +killGraceMs SIGKILL.
 *
 * ## Relationship to `exec-brain-runner`
 *
 * The per-task runner spawns-per-task; this host spawns-once and multiplexes.
 * They SHARE the protocol codec, the scratch-confinement helper
 * (`confineScratchPath`), the minimal-env builder (`buildEnv`), the argv
 * builder (`buildArgv`), and the attachment budget — so the security discipline
 * is identical at both lifecycles; only the process lifecycle differs.
 *
 * ## Transport injection
 *
 * The socket is behind a {@link DaemonTransport} seam (mirroring the runner's
 * injectable `BrainSpawnFn`). Production wires {@link makeBunUnixTransport}
 * (`Bun.listen({ unix })` + `Bun.spawn` with the socket env); tests inject an
 * in-memory transport that drives the brain side directly — the protocol,
 * multiplexing, supervision, drain, budget, and confinement logic are all
 * exercised without a real socket or subprocess.
 */

import { timingSafeEqual } from "crypto";
import { chmodSync, mkdtempSync } from "fs";
import { realpath } from "fs/promises";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join, resolve as resolvePath } from "path";
import {
  encodeBrainEvent,
  parseBrainEffect,
  JsonlDecoder,
  type TaskEvent,
  type ResultEffect,
  type HostReasonKind,
} from "./protocol";
import {
  buildArgv,
  buildEnv,
  confineScratchPath,
  type BrainTaskHooks,
  type BrainTaskRunResult,
} from "./exec-brain-runner";
import { AttachmentBudget } from "./attachment-budget";

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/**
 * A connected brain socket — the bytes-in / bytes-out + close handle the host
 * speaks the protocol over. Production is a Bun Unix-socket connection; tests
 * supply an in-memory double. The host owns framing (JsonlDecoder); the
 * transport only moves bytes.
 */
export interface DaemonBrainConnection {
  /** Write a raw chunk (one or more newline-delimited JSON lines) to the brain. */
  write(chunk: string): void | Promise<void>;
  /** Register the byte sink for inbound brain → host bytes. Called once. */
  onData(handler: (chunk: Uint8Array | string) => void): void;
  /** Register the connection-closed handler (brain disconnected / crashed). */
  onClose(handler: () => void): void;
}

/**
 * The spawned-and-connected brain. The transport spawns the process, listens on
 * the assigned socket, and resolves `connection` once the brain connects back.
 * `exited` resolves with the process exit code (or null if killed). `kill`
 * escalates termination.
 */
export interface DaemonBrainProcess {
  /** Resolves once the brain has connected on the socket + is ready for `hello`. */
  connection: Promise<DaemonBrainConnection>;
  /** Resolves with the exit code when the process exits (null if killed pre-exit). */
  exited: Promise<number | null>;
  /** Send a POSIX signal (SIGTERM / SIGKILL escalation). */
  kill(signal?: NodeJS.Signals | number): void;
}

/**
 * Spawn-and-listen transport. Given the resolved argv + env + a socket path,
 * it must: bind/listen on the socket, spawn the process (with the socket env
 * already injected by the host into `env`), and resolve `connection` when the
 * brain connects. Tests inject a fake that wires an in-memory pipe.
 *
 * ## Connection authentication (`socketToken`)
 *
 * A Unix socket under `tmpdir()` is reachable by any local process; the first
 * connector wins. Without a proof, a local process racing the real brain could
 * connect first and impersonate it (emit posts / dispatches / gate requests).
 * So the host mints a per-spawn `socketToken`, injects it into the brain's env
 * (`CORTEX_BRAIN_SOCKET_TOKEN`), and the transport REQUIRES the brain's FIRST
 * line on the socket to be a matching auth proof
 * (`{ "v": 1, "type": "auth", "token": "…" }`) BEFORE it resolves `connection`.
 * This auth line is consumed by the TRANSPORT layer (raw bytes), NOT the
 * protocol codec — it is pre-protocol, so `protocol.ts` is untouched and the
 * tolerant ingest never sees it. Mismatch / malformed / no line within
 * {@link SOCKET_AUTH_TIMEOUT_MS} → the socket is closed and `connection`
 * rejects; the host treats that as a failed spawn (counts against the restart
 * budget). A second connector arriving while one is already live is closed
 * immediately (single-connection socket).
 */
export type DaemonTransport = (opts: {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  socketPath: string;
  /**
   * Per-spawn auth token. The transport must require the brain's first socket
   * line to be `{ v: 1, type: "auth", token }` matching this value before
   * resolving `connection`. Always set by the host.
   */
  socketToken: string;
}) => DaemonBrainProcess;

/** How long the transport waits for the brain's auth line before rejecting. */
export const SOCKET_AUTH_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// `create_private_thread` I/O seam (cortex#2206)
// ---------------------------------------------------------------------------

/**
 * The result of a `create_private_thread` I/O attempt. NEVER throws — a
 * platform/API failure resolves `{ ok: false, detail }` so the host maps it
 * to a retryable `effect_rejected` (`not_now`) instead of an unhandled
 * rejection (mirrors every other injected seam in this file).
 */
export type CreatePrivateThreadOutcome =
  | { ok: true; threadId: string }
  | { ok: false; detail: string };

/**
 * The actual create-thread-and-add-members I/O for a `create_private_thread`
 * effect (cortex#2206). Every POLICY decision — which channel, who gets
 * added, whether the rate limit allows it — is made by
 * {@link DaemonBrainHost} itself, BEFORE this function is ever called; this
 * seam performs only the mechanical platform call under parameters the host
 * already decided. Mirrors the `transport` seam: production wires the real
 * Discord adapter (`src/adapters/discord/index.ts`'s `createPrivateThread`);
 * tests inject a fake.
 */
export type CreatePrivateThreadFn = (opts: {
  /** The parent channel — ALWAYS the agent's own binding, never brain input. */
  channelId: string;
  name: string;
  /** Host-resolved member ids — `"source"` has already been expanded server-side. */
  memberIds: string[];
}) => Promise<CreatePrivateThreadOutcome>;

/**
 * Rate limit for `create_private_thread`: 10/hour, PER AGENT (ADR
 * cortex#2206 #2). Each {@link DaemonBrainHost} instance already serves
 * exactly one agent (`agentId` is fixed at construction), so the limiter
 * state below is naturally per-agent without needing to key it — a second
 * agent gets its own `DaemonBrainHost` instance and its own counter.
 *
 * Open follow-up (explicitly NOT required for v1, per the ADR): this budget
 * is shared across every triggering user of an anon-reachable agent, so one
 * bad actor can exhaust the hour's capacity for every legitimate newcomer.
 * Per-triggering-user budgets are a fast-follow if abuse is observed.
 */
export const CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR = 10;

/** The sliding window `CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR` is measured over. */
const CREATE_PRIVATE_THREAD_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// `post_log` policy constants (cortex#2256)
// ---------------------------------------------------------------------------

/**
 * Rate limit for `post_log`: 10/hour, PER AGENT (cortex#2256) — the same
 * constant class and sliding-window mechanics as
 * {@link CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR}, and a SEPARATE budget
 * from it (opening threads and notifying the log channel are independent
 * capabilities; one must not starve the other). Per-agent for the same
 * structural reason: each {@link DaemonBrainHost} serves exactly one agent.
 *
 * The trigger is stranger-influenced for anon-reachable (`openOnboarding`)
 * agents — notifying humans about strangers is the PRIMARY use case, so those
 * agents ARE allowed to use `post_log`; this window (plus the length cap) is
 * what keeps the steward channel unspammable, matching the ADR posture that
 * host-side enforcement, not brain trust, carries anon safety.
 */
export const POST_LOG_RATE_LIMIT_PER_HOUR = 10;

/** The sliding window `POST_LOG_RATE_LIMIT_PER_HOUR` is measured over. */
const POST_LOG_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Length cap on `post_log.text` (cortex#2256): 2000 chars — Discord's own
 * message cap. For hybrid brains the text may be model-authored; the cap plus
 * the FIXED host-derived target keeps the blast radius at "odd words in the
 * log channel", never routing. Over-cap → `effect_rejected` (`wont_do`:
 * the same request will never succeed on retry — mirror of the attachment
 * budget's over-limit refusal), checked BEFORE the rate window so a
 * refused-anyway request never burns budget.
 */
export const POST_LOG_MAX_TEXT_CHARS = 2000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Construction options for {@link DaemonBrainHost}. */
export interface DaemonBrainHostOpts {
  /** Logical agent id — sent in `hello`, used in logs. */
  agentId: string;
  /** The manifest `run` string (`bun {pack}/brain/main.ts`); `{pack}` → packDir. */
  run: string;
  /** The arc install dir — substituted for `{pack}`. */
  packDir: string;
  /** Persona text — delivered ONCE in the `hello` handshake (daemon §5). */
  persona?: string;
  /** Secret env vars (resolved values), injected verbatim. Defaults to `{}`. */
  secrets?: Record<string, string>;
  /**
   * Daemon supervision restart cap (§7.4): restart a crashed brain up to this
   * many times, then mark the agent degraded. Defaults to 3.
   */
  maxRestarts?: number;
  /**
   * Healthy-uptime interval after which the restart counter RESETS (§7.4: "restarts
   * reset on a healthy interval (e.g. 10 min uptime)"). A brain that runs this
   * long without crashing is considered recovered. Defaults to 600_000 (10 min).
   */
  healthyResetMs?: number;
  /**
   * Per-task timeout (ms). A task with no `result` by this point fails
   * (`cant_do`, timeout) — but does NOT kill the shared process (other tasks
   * keep running). Defaults to 300_000 (5 min): a frontier-model brain
   * (e.g. Yarrow's compose) can make SEVERAL sequential LLM calls in one task
   * — the soc-demo no-match path is initial + `MAX_RETRIES` (2) validator
   * retries + a closest-match call = up to 4 frontier calls (the loop in
   * pulse `examples/soc-demo/composer/compose.ts`), which blew past the old 2-min
   * default and stranded the brain's real answer (cortex#1040 follow-up: the
   * task failed mid-compose, so every post after the disclosure was rejected
   * as a closed task_id). 5 min is a heuristic headroom bump (~2.5x the old
   * ceiling), NOT a measured bound — per-call frontier latency varies; if a
   * brain's chain still exceeds it, lengthen this rather than treating 5 min
   * as validated. The host caller may also override per-brain.
   */
  taskTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace on drain/shutdown. Defaults to 5_000 (§7.6). */
  killGraceMs?: number;
  /** Injected transport. Defaults to {@link makeBunUnixTransport}. */
  transport?: DaemonTransport;
  /** Scratch-dir factory (per TASK). Defaults to `mkdtempSync` under OS temp. */
  makeScratchDir?: () => string;
  /** Socket-path factory. Defaults to a unique path under OS temp. */
  makeSocketPath?: (agentId: string) => string;
  /**
   * Called when the brain is marked DEGRADED (restart budget exhausted). The
   * consumer/boot wiring routes this to the presence producer
   * (`publishCapabilitiesChanged(agentId, [])`) — the existing capability-change
   * presence signal (§7.4: "surface it (agent.online presence envelope already
   * exists for exactly this)"). Best-effort; a throw here is logged, not fatal.
   */
  onDegraded?: (agentId: string) => void;
  /** Test seam — clock for uptime accounting. Defaults to `() => Date.now()`. */
  now?: () => number;
  /**
   * cortex#2206 — the parent channel a `create_private_thread` effect opens
   * its thread on. ALWAYS the agent's OWN presence binding
   * (`presence.discord.agentChannelId` today), resolved by the CALLER at
   * construction — never supplied by the brain (the wire effect carries no
   * channel field at all; that absence is intentional, see `protocol.ts`'s
   * `CreatePrivateThreadEffectSchema`). Undefined ⇒ this agent has no
   * thread-capable surface bound; every `create_private_thread` effect is
   * refused `effect_rejected` (`not_now`).
   */
  agentChannelId?: string;
  /**
   * cortex#2206 — the injected create-thread-and-add-members I/O
   * ({@link CreatePrivateThreadFn}). Undefined ⇒ same `not_now` refusal as a
   * missing `agentChannelId` (no capability configured for this agent).
   */
  createPrivateThread?: CreatePrivateThreadFn;
  /**
   * cortex#2256 — the log channel a `post_log` effect targets. ALWAYS the
   * agent's OWN presence binding (`presence.discord.logChannelId` today),
   * resolved by the CALLER at construction — never supplied by the brain
   * (the wire effect carries no channel field at all; that absence is
   * intentional, see `protocol.ts`'s `PostLogEffectSchema`). Undefined ⇒
   * this agent has no log channel bound; every `post_log` effect is refused
   * `effect_rejected` (`cant_do` — structural, never resolves on retry
   * without a config change, same reasoning as `create_private_thread`'s
   * missing-binding refusal).
   */
  logChannelId?: string;
  /**
   * cortex#2206 — true when this agent is reachable by an unmapped,
   * zero-authority anon principal (`AgentSchema.openOnboarding`,
   * cortex#1165). Gates `create_private_thread`'s `members` field: while
   * `true`, a brain requesting anything other than the literal `"source"` is
   * refused `effect_rejected` (`policy_denied`) — an anon-reachable brain
   * may never name its own thread membership.
   *
   * **Defaults to `true` — the SAFE default.** A brand-new capability like
   * this must fail toward the MORE restrictive behaviour when the caller
   * doesn't say otherwise; an agent must be EXPLICITLY constructed with
   * `anonReachable: false` before its brain may request an explicit member
   * list. (ADR cortex#2206 #1: "which future agents get [the wider path] is
   * each of their own onboarding, not a blanket switch.")
   */
  anonReachable?: boolean;
}

/** Per-task tracking record (one per multiplexed task_id). */
interface TaskRecord {
  task: TaskEvent;
  hooks: BrainTaskHooks;
  scratchReal: string;
  scratchDir: string;
  budget: AttachmentBudget;
  logs: string[];
  resolve: (r: BrainTaskRunResult) => void;
  settled: boolean;
  /** Open `ask_principal` gate count — drain waits on these up to the deadline. */
  openGates: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

/** A reason the host fails an in-flight task it could not let the brain finish. */
type HostTaskFailKind = "crashed" | "drained" | "timeout";

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * One long-lived daemon brain, supervised. Construct it, `await start()` (spawn
 * + connect + hello), then `runTask(...)` per inbound task. `drain(deadlineMs)`
 * on hot-swap; `stop()` for an unconditional teardown.
 */
export class DaemonBrainHost {
  readonly agentId: string;

  private readonly run: string;
  private readonly packDir: string;
  private readonly persona: string | undefined;
  private readonly secrets: Record<string, string>;
  private readonly maxRestarts: number;
  private readonly healthyResetMs: number;
  private readonly taskTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly transport: DaemonTransport;
  private readonly makeScratchDir: () => string;
  private readonly makeSocketPath: (agentId: string) => string;
  private readonly onDegraded: ((agentId: string) => void) | undefined;
  private readonly now: () => number;
  /** cortex#2206 — see {@link DaemonBrainHostOpts.agentChannelId}. */
  private readonly agentChannelId: string | undefined;
  /** cortex#2206 — see {@link DaemonBrainHostOpts.createPrivateThread}. */
  private readonly createPrivateThreadFn: CreatePrivateThreadFn | undefined;
  /** cortex#2206 — see {@link DaemonBrainHostOpts.anonReachable}. Fail-safe default: `true`. */
  private readonly anonReachable: boolean;
  /**
   * cortex#2206 — sliding-window timestamps (ms) of accepted
   * `create_private_thread` ATTEMPTS (recorded before the adapter call, not
   * only on success — an attempt that fails at the platform still cost a
   * real API call and must still count against the budget). Pruned lazily
   * on each check/record; never grows past
   * {@link CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR} entries. In-memory
   * only — does NOT survive a daemon restart (see file header discussion in
   * the PR/issue for why that's an accepted v1 tradeoff).
   */
  private threadCreateAttempts: number[] = [];
  /** cortex#2256 — see {@link DaemonBrainHostOpts.logChannelId}. */
  private readonly logChannelId: string | undefined;
  /**
   * cortex#2256 — sliding-window timestamps (ms) of accepted `post_log`
   * ATTEMPTS. Same mechanics (and the same record-before-I/O and
   * in-memory-only tradeoffs) as {@link threadCreateAttempts}; a SEPARATE
   * window so log posts and thread creates never starve each other.
   */
  private postLogAttempts: number[] = [];

  /** Live process + connection for the CURRENT generation. */
  private proc: DaemonBrainProcess | null = null;
  private connection: DaemonBrainConnection | null = null;
  private decoder = new JsonlDecoder();

  /** In-flight tasks keyed by task_id (multiplexed over the one socket). */
  private readonly tasks = new Map<string, TaskRecord>();

  /** Restart accounting (§7.4). */
  private restartCount = 0;
  private spawnAt = 0;
  private healthyResetTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Monotonic generation token. Incremented on every spawn. The close/exit
   * watchers capture the generation they were wired for and IGNORE a disconnect
   * that arrives for a STALE generation — a crashed process's `exited` and its
   * socket `close` both fire, and a restart may already have advanced the live
   * generation by the time the second signal lands; without this, a single
   * crash could be counted twice (or a restart's fresh process mistaken for the
   * crashed one).
   */
  private generation = 0;

  private started = false;
  private degraded = false;
  private draining = false;
  private stopped = false;

  constructor(opts: DaemonBrainHostOpts) {
    this.agentId = opts.agentId;
    this.run = opts.run;
    this.packDir = opts.packDir;
    this.persona = opts.persona;
    this.secrets = opts.secrets ?? {};
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.healthyResetMs = opts.healthyResetMs ?? 600_000;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? 300_000;
    this.killGraceMs = opts.killGraceMs ?? 5_000;
    this.transport = opts.transport ?? makeBunUnixTransport;
    this.makeScratchDir =
      opts.makeScratchDir ??
      (() => mkdtempSync(join(tmpdir(), "cortex-brain-daemon-")));
    this.makeSocketPath = opts.makeSocketPath ?? defaultMakeSocketPath;
    this.onDegraded = opts.onDegraded;
    this.now = opts.now ?? (() => Date.now());
    this.agentChannelId = opts.agentChannelId;
    this.createPrivateThreadFn = opts.createPrivateThread;
    this.anonReachable = opts.anonReachable ?? true;
    this.logChannelId = opts.logChannelId;
  }

  /** True once the restart budget is exhausted — the consumer stops dispatching. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Spawn the brain, wait for it to connect, send `hello`. Idempotent-guarded.
   * Throws if the brain never connects (a manifest/transport fault) — boot logs
   * + skips, same as the per-task runner's spawn-fail synthesis.
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error(`daemon-brain-host: already started for "${this.agentId}"`);
    }
    this.started = true;
    await this.spawnGeneration(/* isRestart */ false);
  }

  /**
   * Run one task. Writes the `task` event over the socket and resolves with the
   * terminal result. Multiplexed: many `runTask` calls share the one process,
   * correlated by `task_id`. A degraded/stopped/draining host fails fast with a
   * synthesized `not_now` (the consumer naks for the next boot).
   */
  async runTask(
    task: TaskEvent,
    hooks: BrainTaskHooks,
  ): Promise<BrainTaskRunResult> {
    if (this.degraded || this.stopped) {
      return synthHostFail(
        task.task_id,
        "not_now",
        `daemon brain "${this.agentId}" is ${this.degraded ? "degraded" : "stopped"}`,
      );
    }
    if (this.draining) {
      return synthHostFail(
        task.task_id,
        "not_now",
        `daemon brain "${this.agentId}" is draining (hot-swap)`,
      );
    }
    const conn = this.connection;
    if (conn === null) {
      return synthHostFail(
        task.task_id,
        "not_now",
        `daemon brain "${this.agentId}" not connected`,
      );
    }
    if (this.tasks.has(task.task_id)) {
      // task_id collision — a host bug (correlation ids must be unique). Refuse
      // rather than clobber the existing record.
      return synthHostFail(
        task.task_id,
        "cant_do",
        `duplicate task_id ${task.task_id} already in flight`,
      );
    }

    // Async scratch setup (sage cortex#1035 round 2): per-task filesystem work
    // must not stall the event loop the multiplexed socket shares with every
    // other in-flight task.
    const scratchDir = this.makeScratchDir();
    let scratchReal: string;
    try {
      scratchReal = await realpath(scratchDir);
    } catch (_err) {
      // Path not resolvable (yet) — fall back to a normalized absolute path;
      // confinement still prefix-checks against this base.
      scratchReal = resolvePath(scratchDir);
    }

    const runPromise = new Promise<BrainTaskRunResult>((resolve) => {
      const record: TaskRecord = {
        task,
        hooks,
        scratchReal,
        scratchDir,
        budget: new AttachmentBudget(),
        logs: [],
        resolve,
        settled: false,
        openGates: 0,
      };
      // Per-task timeout: fail the task (does NOT kill the shared process).
      record.timeoutTimer = setTimeout(() => {
        void this.failTask(record, "timeout");
      }, this.taskTimeoutMs);
      this.tasks.set(task.task_id, record);
    });

    // Send the task over the socket. The daemon receives persona via `hello`,
    // so the per-task event carries no persona (strip it if a caller set one).
    const taskEvent: TaskEvent = { ...task };
    delete (taskEvent as { persona?: string }).persona;
    try {
      await conn.write(encodeBrainEvent(taskEvent) + "\n");
    } catch (err) {
      const record = this.tasks.get(task.task_id);
      if (record) {
        await this.failTask(
          record,
          "crashed",
          `task write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return runPromise;
  }

  /**
   * Hot-swap drain (§7.3/§7.5/§7.6). Send `shutdown` with the deadline; wait for
   * in-flight tasks to finish up to `deadlineMs`. Past the deadline, every still-
   * open task is CANCELLED — an open `ask_principal` gate gets a visible
   * "brain was upgraded; re-trigger" notice and the task closes `failed/not_now`
   * (no verdict is ever forwarded to a replaced generation). Then SIGTERM, +grace
   * SIGKILL. Idempotent.
   */
  async drain(deadlineMs: number): Promise<void> {
    if (this.stopped) return;
    if (this.draining) return;
    this.draining = true;

    // Tell the brain to wind down. Best-effort — a dead socket just means the
    // brain already gone.
    const conn = this.connection;
    if (conn !== null) {
      try {
        await conn.write(
          encodeBrainEvent({
            v: 1,
            type: "shutdown",
            deadline_ms: deadlineMs,
          }) + "\n",
        );
      } catch (err) {
        process.stderr.write(
          `daemon-brain-host: shutdown write failed for "${this.agentId}" ` +
            `(brain likely gone): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // Wait for in-flight tasks up to the deadline.
    const deadline = this.now() + deadlineMs;
    while (this.tasks.size > 0 && this.now() < deadline) {
      await sleep(Math.min(25, Math.max(0, deadline - this.now())));
    }

    // Past the deadline — CANCEL whatever is still open. Snapshot first (failTask
    // mutates the map). Open gates get the upgrade notice via the post hook.
    const stragglers = Array.from(this.tasks.values());
    for (const record of stragglers) {
      if (record.openGates > 0) {
        await this.postUpgradeNotice(record);
      }
      await this.failTask(record, "drained");
    }

    // SIGTERM → SIGKILL escalation.
    await this.terminateProcess();
    await this.cleanupSocket();
  }

  /**
   * Unconditional teardown — fail every in-flight task (`drained`), kill the
   * process, drop the socket. Idempotent. Used by the consumer's `stop()` when
   * not a graceful hot-swap (e.g. process shutdown).
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.draining = true;
    if (this.healthyResetTimer !== undefined) {
      clearTimeout(this.healthyResetTimer);
      this.healthyResetTimer = undefined;
    }
    const stragglers = Array.from(this.tasks.values());
    for (const record of stragglers) {
      await this.failTask(record, "drained");
    }
    await this.terminateProcess();
    await this.cleanupSocket();
  }

  // -------------------------------------------------------------------------
  // Generation lifecycle
  // -------------------------------------------------------------------------

  private currentSocketPath: string | null = null;

  /**
   * Spawn a fresh brain generation, connect, hello, wire the data/close pumps.
   *
   * `isRestart` distinguishes the two failure modes of a connect failure:
   *   - initial `start()` (`isRestart=false`): re-throw so the boot path logs
   *     and skips (the manifest/transport-fault contract); no live proc is left.
   *   - supervised restart (`isRestart=true`): a connect failure is a failed
   *     spawn — it must count against the restart budget (degrade if exhausted),
   *     NOT throw into the floating `.catch` and recurse. {@link handleSpawnFailure}
   *     owns that.
   */
  private async spawnGeneration(isRestart: boolean): Promise<void> {
    const argv = buildArgv(this.run, this.packDir);
    const socketPath = this.makeSocketPath(this.agentId);
    this.currentSocketPath = socketPath;
    // Per-spawn socket auth token: a local process racing the brain to the
    // tmpdir socket cannot impersonate it without this secret. The transport
    // requires the brain's first line to prove it before accepting effects
    // (see `DaemonTransport`). Fresh per generation — a restart re-mints it so
    // a leaked token from a crashed generation is useless.
    const socketToken = crypto.randomUUID();
    // Minimal env (shared discipline with the per-task runner) PLUS the socket
    // env naming where the brain connects back, the per-spawn auth token, and
    // the daemon lifecycle marker.
    const baseScratch = this.makeScratchDir();
    const env = {
      ...buildEnv(baseScratch, this.secrets),
      CORTEX_BRAIN_SOCKET: socketPath,
      CORTEX_BRAIN_SOCKET_TOKEN: socketToken,
      CORTEX_BRAIN_LIFECYCLE: "daemon",
    };
    // The process-level scratch (env TMPDIR baseline) is removed on teardown; per
    // TASK scratch dirs are separate (created in runTask, removed on task close).
    this.processScratch = baseScratch;

    // This generation's token — captured by the close/exit watchers so a stale
    // disconnect (an old crashed process's exit landing after a restart) is
    // ignored.
    this.generation += 1;
    const myGeneration = this.generation;

    this.spawnAt = this.now();
    this.decoder = new JsonlDecoder();
    const proc = this.transport({ argv, env, cwd: baseScratch, socketPath, socketToken });
    this.proc = proc;

    // Await the AUTHENTICATED connection. The transport rejects this promise on
    // a wrong/missing auth proof or connect failure; a rejection here is a
    // failed spawn — clear the live process/connection and count it against the
    // restart budget (degrade if exhausted) rather than installing a stale proc
    // or recursing. See finding 2 (failed-restart-does-not-degrade).
    let connection: DaemonBrainConnection;
    try {
      connection = await proc.connection;
    } catch (err) {
      if (!isRestart) {
        // Initial start() — clear the stale proc and re-throw so the boot path
        // logs + skips (the documented manifest/transport-fault contract).
        if (this.generation === myGeneration) {
          this.proc = null;
          this.connection = null;
        }
        throw err;
      }
      // Supervised restart — route through the budget (degrade if exhausted).
      this.handleSpawnFailure(myGeneration, err);
      return;
    }
    // A drain/stop (or a newer generation) may have superseded this spawn while
    // we awaited the connection — don't install a connection nobody owns.
    if (this.stopped || this.draining || myGeneration !== this.generation) {
      try {
        void connection;
      } finally {
        proc.kill("SIGKILL");
      }
      return;
    }
    this.connection = connection;

    connection.onData((chunk) => {
      for (const line of this.decoder.push(chunk)) {
        void this.routeLine(line);
      }
    });
    connection.onClose(() => {
      this.handleDisconnect(myGeneration);
    });

    // Watch the process exit too (covers a crash that doesn't emit a socket
    // close first, e.g. SIGKILL). Both signals carry the SAME generation token,
    // so whichever lands first handles the crash and the second is a no-op.
    void proc.exited.then(() => {
      this.handleDisconnect(myGeneration);
    });

    // Send the hello handshake (host → brain): host-authoritative identity +
    // persona (daemon brains get persona once, here — §5).
    try {
      await connection.write(
        encodeBrainEvent({
          v: 1,
          type: "hello",
          agent: this.agentId,
          persona: this.persona ?? "",
          protocol: "cortex-brain/v1",
        }) + "\n",
      );
    } catch (err) {
      process.stderr.write(
        `daemon-brain-host: hello write failed for "${this.agentId}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // Schedule the healthy-uptime reset: if THIS generation lives healthyResetMs
    // without crashing, the restart counter resets (§7.4).
    this.scheduleHealthyReset();
  }

  private processScratch: string | null = null;

  /** Reset the restart counter after a healthy uptime window (§7.4). */
  private scheduleHealthyReset(): void {
    if (this.healthyResetTimer !== undefined) {
      clearTimeout(this.healthyResetTimer);
    }
    this.healthyResetTimer = setTimeout(() => {
      this.restartCount = 0;
    }, this.healthyResetMs);
    // Don't keep the event loop alive solely for the reset timer.
    (this.healthyResetTimer as { unref?: () => void }).unref?.();
  }

  /**
   * The brain disconnected / the process exited. If this was an intentional
   * drain/stop, ignore. Otherwise it is a CRASH: fail every in-flight task
   * (`crashed`), then restart-or-degrade per §7.4.
   */
  private handleDisconnect(forGeneration: number): void {
    if (this.stopped || this.draining) return;
    // Ignore a disconnect from a STALE generation — a restart has already
    // advanced past it (the old process's exit landed after the new one
    // spawned). Only the LIVE generation's disconnect is a real crash.
    if (forGeneration !== this.generation) return;
    // Guard re-entry (socket close + process exit can both fire for the same
    // generation).
    if (this.connection === null && this.proc === null) return;
    this.connection = null;
    const crashedProc = this.proc;
    this.proc = null;

    // Fail every in-flight task of the crashed generation.
    const inFlight = Array.from(this.tasks.values());
    for (const record of inFlight) {
      void this.failTask(record, "crashed");
    }

    // Crash path: usually already dead, but a socket-close without process
    // exit (e.g. brain closed its socket and hung) must not leak the process.
    this.reapFailedProc(crashedProc);

    this.restartOrDegrade();
  }

  /**
   * A supervised restart spawn FAILED to connect (wrong/missing auth, transport
   * fault, or the process exited before connecting). Distinct from
   * {@link handleDisconnect}: there is no live proc/connection to tear down — the
   * connect never completed — so we must NOT re-enter the disconnect path (which
   * would no-op on the `proc === null` re-entry guard and silently swallow the
   * failure, leaving the budget unmoved). Clear any partial state for this
   * generation and count the failed spawn directly against the budget.
   */
  private handleSpawnFailure(forGeneration: number, err: unknown): void {
    if (this.stopped || this.draining) return;
    if (forGeneration !== this.generation) return;
    // Re-entry guard: if both are already cleared, this generation's failure was
    // handled (the internal connect-failure path and the `.catch` safety net can
    // both fire for the same generation). Don't double-count the budget.
    if (this.connection === null && this.proc === null) return;
    // The connect never resolved: no connection installed, and `this.proc` was
    // set to the failed proc in spawnGeneration. Clear both so no stale process
    // is left installed.
    this.connection = null;
    const failedProc = this.proc;
    this.proc = null;
    this.reapFailedProc(failedProc);
    process.stderr.write(
      `daemon-brain-host: restart spawn failed to connect for "${this.agentId}": ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    this.restartOrDegrade();
  }


  /**
   * Reap a process whose generation FAILED (connect failure / auth timeout) or
   * crashed: SIGTERM immediately, SIGKILL after killGraceMs if it lingers
   * (sage cortex#1035 round 2 — a failed spawn must never be left running
   * while the next generation starts).
   */
  private reapFailedProc(proc: DaemonBrainProcess | null): void {
    if (proc === null) return;
    try {
      proc.kill("SIGTERM");
    } catch (_err) {
      // already exited — nothing to reap
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch (_err) {
        // already exited
      }
    }, this.killGraceMs);
    void proc.exited
      .catch(() => undefined)
      .finally(() => { clearTimeout(killTimer); });
  }

  /**
   * Restart the brain if the budget allows, else mark degraded (§7.4). Shared by
   * the live-disconnect path ({@link handleDisconnect}) and the failed-connect
   * path ({@link handleSpawnFailure}) so every kind of failed generation — crash
   * OR failed restart spawn — advances the SAME budget toward degradation.
   */
  private restartOrDegrade(): void {
    if (this.restartCount < this.maxRestarts) {
      this.restartCount += 1;
      process.stderr.write(
        `daemon-brain-host: brain "${this.agentId}" crashed — restarting ` +
          `(${this.restartCount}/${this.maxRestarts})\n`,
      );
      // A failed restart CONNECT routes through handleSpawnFailure internally
      // (NOT a throw), so there is no recursion through the disconnect re-entry
      // guard — the budget advances on every failed spawn. The `.catch` is a
      // safety net for an UNEXPECTED throw (e.g. argv/env build) so the budget
      // still advances rather than the failure floating unhandled.
      // Sage cortex#1035 round 3: capture the generation AFTER spawnGeneration
      // increments it, not before — a throw after the increment would
      // otherwise carry a stale generation and be discarded by
      // handleSpawnFailure's staleness guard, never counting toward the
      // budget. spawnGeneration is async; by the time .catch runs the
      // increment has happened, so read the live value at catch time and
      // attribute the failure to it.
      void this.spawnGeneration(/* isRestart */ true).catch((err: unknown) => {
        this.handleSpawnFailure(this.generation, err);
      });
    } else {
      this.markDegraded();
    }
  }

  /** Mark the agent degraded + surface it via the injected presence callback. */
  private markDegraded(): void {
    if (this.degraded) return;
    this.degraded = true;
    if (this.healthyResetTimer !== undefined) {
      clearTimeout(this.healthyResetTimer);
      this.healthyResetTimer = undefined;
    }
    process.stderr.write(
      `daemon-brain-host: brain "${this.agentId}" DEGRADED — restart budget ` +
        `(${this.maxRestarts}) exhausted\n`,
    );
    try {
      this.onDegraded?.(this.agentId);
    } catch (err) {
      process.stderr.write(
        `daemon-brain-host: onDegraded callback threw for "${this.agentId}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Effect routing (per multiplexed task)
  // -------------------------------------------------------------------------

  /** Route one decoded JSONL line (a brain effect) to its task. */
  private async routeLine(line: string): Promise<void> {
    const parsed = parseBrainEffect(line);
    if (parsed.kind === "invalid") {
      process.stderr.write(
        `daemon-brain-host: dropped invalid effect from "${this.agentId}": ${parsed.detail}\n`,
      );
      return;
    }
    if (parsed.kind === "unknown") {
      // Forward-compat (§5): unknown effect type — drop and log.
      process.stderr.write(
        `daemon-brain-host: dropped unknown effect type from "${this.agentId}": ${String(parsed.raw.type)}\n`,
      );
      return;
    }
    const e = parsed.effect;

    // `log` is task-agnostic — no task_id correlation.
    if (e.type === "log") {
      // Route to whichever task's hooks if it correlates, else process stderr.
      process.stderr.write(
        `daemon-brain-host: [${e.level}] agent=${this.agentId}: ${e.text}\n`,
      );
      return;
    }

    const record = this.tasks.get(e.task_id);
    // task_id correlation (§5): an effect for a task this host does not own (or
    // already closed) is refused with effect_rejected (wont_do) and dropped.
    if (record === undefined) {
      await this.rejectEffect(e.task_id, e.type, "wont_do",
        `unknown or closed task_id ${e.task_id} for agent ${this.agentId}`);
      return;
    }

    switch (e.type) {
      case "post": {
        let confinedPath: string | undefined;
        if (e.attachment?.path !== undefined) {
          const confined = confineScratchPath(record.scratchReal, e.attachment.path);
          if (!confined.ok) {
            await this.rejectEffect(e.task_id, "post", "wont_do",
              "attachment path outside scratch dir");
            return;
          }
          confinedPath = confined.resolved;
        }
        if (e.attachment !== undefined) {
          const charge = record.budget.charge(e.attachment, confinedPath);
          if (!charge.ok) {
            await this.rejectEffect(e.task_id, "post", "wont_do", charge.detail);
            return;
          }
        }
        await record.hooks.onPost(e);
        return;
      }
      case "post_log": {
        // cortex#2256 — notify THIS agent's own bound log channel. The
        // effect carries no channel (intentional — protocol.ts); the target
        // is derived HERE from the agent's own binding, mirroring
        // `create_private_thread`'s host-derived-target pattern.
        //
        // NO liveness-timer pause, deliberately: the pause exists for
        // effects the BRAIN blocks on awaiting a response event
        // (`gate_verdict`, `thread_created` — cortex#1073). `post_log` is
        // fire-and-forget like `post`: there is no success event, the brain
        // continues immediately, and the host-side publish is a local bus
        // op — so brain liveness accounting is unaffected, exactly as it is
        // for the `post` case above.
        //
        // 1. Structural: no log-channel binding / no publish hook wired ⇒
        // this agent simply cannot do this, full stop. cant_do (not
        // not_now): it will never resolve on retry without a
        // redeploy/config change (same reasoning as the
        // `create_private_thread` structural gate — a brain must not burn
        // budget retrying a capability that can never appear).
        const logChannelId = this.logChannelId;
        // `.bind()` (not a bare method reference) so the hook keeps its own
        // receiver — the lint-enforced unbound-method discipline.
        const onPostLog = record.hooks.onPostLog?.bind(record.hooks);
        if (logChannelId === undefined || onPostLog === undefined) {
          await this.rejectEffect(
            e.task_id,
            "post_log",
            "cant_do",
            `agent "${this.agentId}" has no log channel binding configured`,
          );
          return;
        }

        // 2. Length cap — checked BEFORE the rate window so a refused-anyway
        // request never burns budget. wont_do: retrying the same text will
        // never succeed (mirror of the attachment budget's refusal kind).
        if (e.text.length > POST_LOG_MAX_TEXT_CHARS) {
          await this.rejectEffect(
            e.task_id,
            "post_log",
            "wont_do",
            `post_log text exceeds ${POST_LOG_MAX_TEXT_CHARS} chars ` +
              `(got ${e.text.length}) — summarise; the log channel is a breadcrumb surface`,
          );
          return;
        }

        // 3. Rate limit — 10/hour/agent (named constant), a real sliding
        // window, SEPARATE from the thread-create window. Reserved BEFORE
        // the publish attempt: an attempt costs real delivery budget
        // whether or not it succeeds (same reserve-before-I/O rule as
        // `create_private_thread`).
        if (this.isPostLogRateLimited()) {
          await this.rejectEffect(
            e.task_id,
            "post_log",
            "policy_denied",
            `agent "${this.agentId}" exceeded ${POST_LOG_RATE_LIMIT_PER_HOUR} ` +
              `post_log calls in the past hour`,
          );
          return;
        }
        this.recordPostLogAttempt();

        // 4. Publish via the consumer hook, handing it the HOST-derived
        // target. Fire-and-forget on success (no ack event — a lost log
        // note is a breadcrumb; the agent-state dashboard is the durable
        // record). A failed/throwing publish is transient ⇒ not_now.
        let outcome: { ok: true } | { ok: false; detail: string };
        try {
          outcome = await onPostLog(e, logChannelId);
        } catch (hookErr) {
          outcome = {
            ok: false,
            detail: hookErr instanceof Error ? hookErr.message : String(hookErr),
          };
        }
        // The task may have closed while the publish was in flight — never
        // send a rejection to a closed/replaced task (§7.5).
        if (record.settled) return;
        if (!outcome.ok) {
          await this.rejectEffect(e.task_id, "post_log", "not_now", outcome.detail);
        }
        return;
      }
      case "ask_principal": {
        // PAUSE the per-task liveness timeout while a human gate is open. The
        // timeout exists to fail a HUNG BRAIN, not a thinking human — an open
        // `ask_principal` is legitimately unbounded by brain liveness, and the
        // gate has its own deadline (SurfacePrincipalGate.timeoutMs). Without
        // this, the host timed the task out mid-gate, dropped the verdict
        // (record.settled), and the principal's reply orphaned (cortex#1073).
        // Re-arm for the remaining deterministic work once all gates close.
        if (record.openGates === 0 && record.timeoutTimer !== undefined) {
          clearTimeout(record.timeoutTimer);
          record.timeoutTimer = undefined;
        }
        record.openGates += 1;
        try {
          const verdict = await record.hooks.onAskPrincipal(e);
          // The task may have been drained/cancelled while the gate was open —
          // never forward a verdict to a closed/replaced task (§7.5).
          if (record.settled) return;
          await this.sendToConn(
            encodeBrainEvent({
              v: 1,
              type: "gate_verdict",
              task_id: e.task_id,
              gate: e.gate,
              verdict: verdict.verdict,
              principal: verdict.principal,
              ...(verdict.notes !== undefined && { notes: verdict.notes }),
            }) + "\n",
          );
        } finally {
          record.openGates = Math.max(0, record.openGates - 1);
          // Last gate closed and the task is still live → re-arm the liveness
          // timeout for the remaining (deterministic) steps.
          if (record.openGates === 0 && !record.settled && record.timeoutTimer === undefined) {
            record.timeoutTimer = setTimeout(() => {
              void this.failTask(record, "timeout");
            }, this.taskTimeoutMs);
          }
        }
        return;
      }
      case "dispatch": {
        const outcome = await record.hooks.onDispatch(e);
        if (outcome?.rejected) {
          await this.sendToConn(
            encodeBrainEvent({
              v: 1,
              type: "effect_rejected",
              task_id: e.task_id,
              effect: "dispatch",
              reason: outcome.reason,
            }) + "\n",
          );
        }
        return;
      }
      case "create_private_thread": {
        // cortex#2206 — open a private thread off THIS agent's own channel
        // binding. Every parameter that matters (channel, membership, rate
        // budget) is decided HERE, host-side — the effect payload carries no
        // channel at all (intentional), and `members` is enforced, not
        // trusted, before it ever reaches the adapter.
        //
        // PAUSE the per-task liveness timeout while the thread-create call
        // is in flight — identical reasoning to `ask_principal`
        // (cortex#1073): this is async I/O (a platform REST round-trip), not
        // brain liveness, so a slow (but honest) platform response must
        // never race the timeout and fail a task that isn't hung. Re-arm
        // once every open gate (ask_principal OR create_private_thread)
        // closes.
        if (record.openGates === 0 && record.timeoutTimer !== undefined) {
          clearTimeout(record.timeoutTimer);
          record.timeoutTimer = undefined;
        }
        record.openGates += 1;
        try {
          // 1. Structural: no channel binding / no adapter capability wired
          // for this agent ⇒ this agent simply cannot do this, full stop.
          // cant_do (not not_now): this will never resolve on retry without
          // a redeploy/config change, unlike the genuinely transient states
          // (degraded, draining, adapter I/O failure) that use not_now
          // elsewhere in this file — a brain must not burn rate-limit budget
          // retrying a capability that can never appear (code review, PR #2214).
          if (this.agentChannelId === undefined || this.createPrivateThreadFn === undefined) {
            await this.rejectEffect(
              e.task_id,
              "create_private_thread",
              "cant_do",
              `agent "${this.agentId}" has no thread-capable surface binding configured`,
            );
            return;
          }

          // 2. Anon-reachable gate (ADR cortex#2206 #1). An agent an
          // unmapped, zero-authority stranger can reach may NEVER have its
          // brain name arbitrary thread members — only "source" (the
          // triggering event's own author, resolved below in step 3) is
          // permitted. Checked BEFORE resolving members so a violating
          // request never even gets as far as touching the rate budget.
          if (this.anonReachable && e.members !== "source") {
            await this.rejectEffect(
              e.task_id,
              "create_private_thread",
              "policy_denied",
              `agent "${this.agentId}" is anon-reachable (openOnboarding); ` +
                `members must be "source" — an explicit member list is refused`,
            );
            return;
          }

          // 3. Resolve membership SERVER-SIDE. "source" is ALWAYS the
          // task's own recorded source user (record.task.source.user, set
          // by the host when the task was created from the inbound event) —
          // never anything the brain put on the wire. An explicit list
          // (only reachable for a non-anon-reachable agent, per step 2) is
          // the brain's own request, passed through as-is; per-recipient
          // authorization for that path is future work owned by whichever
          // trusted agent uses it, not this effect's job to second-guess
          // (ADR cortex#2206 #1).
          const memberIds =
            e.members === "source" ? [record.task.source.user] : e.members;

          // 4. Rate limit — 10/hour/agent (named constant), a real sliding
          // window. Checked (and reserved) AFTER the structural/policy
          // gates above so a request that was going to be refused anyway
          // never burns budget.
          if (this.isThreadCreateRateLimited()) {
            await this.rejectEffect(
              e.task_id,
              "create_private_thread",
              "policy_denied",
              `agent "${this.agentId}" exceeded ${CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR} ` +
                `create_private_thread calls in the past hour`,
            );
            return;
          }
          // Reserve the slot BEFORE the (possibly slow) adapter call — an
          // attempt costs real platform-API budget whether or not it
          // ultimately succeeds; counting only successes would let a brain
          // that keeps hitting a failing/slow path dodge the limit entirely.
          this.recordThreadCreateAttempt();

          // 5. Perform the actual I/O. Never throws by contract
          // (CreatePrivateThreadFn) — a platform failure comes back as
          // `{ ok: false, detail }`, not a rejection.
          const outcome = await this.createPrivateThreadFn({
            channelId: this.agentChannelId,
            name: e.name,
            memberIds,
          });

          // The task may have been drained/cancelled while the call was in
          // flight — never forward a result to a closed/replaced task
          // (§7.5, same rule `ask_principal` follows for `gate_verdict`).
          if (record.settled) return;

          if (!outcome.ok) {
            // A genuine adapter/platform failure is transient/retryable —
            // NOT the brain's fault and NOT a policy refusal.
            await this.rejectEffect(
              e.task_id,
              "create_private_thread",
              "not_now",
              outcome.detail,
            );
            return;
          }

          // cortex#2248 — HOST-SIDE RETARGET: inform the consumer that this
          // task's conversation moved into the created thread, BEFORE the
          // brain hears `thread_created`. Effects are handled off the socket
          // sequentially per line, but ordering the retarget first
          // guarantees any `post` the brain emits on seeing the event
          // already routes to the thread — never racing a post into the
          // parent channel. The hook is optional (per-task runners and
          // routing-agnostic tests omit it) and guarded: a hook failure is
          // logged, and `thread_created` still ships — the thread EXISTS,
          // so the brain must learn its id regardless.
          try {
            await record.hooks.onThreadCreated?.(outcome.threadId);
          } catch (hookErr) {
            process.stderr.write(
              `daemon-brain-host: onThreadCreated hook failed for agent="${this.agentId}" ` +
                `task=${e.task_id}: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}\n`,
            );
          }

          await this.sendToConn(
            encodeBrainEvent({
              v: 1,
              type: "thread_created",
              task_id: e.task_id,
              thread_id: outcome.threadId,
            }) + "\n",
          );
        } finally {
          record.openGates = Math.max(0, record.openGates - 1);
          // Last gate closed and the task is still live → re-arm the
          // liveness timeout for the remaining (deterministic) steps.
          if (record.openGates === 0 && !record.settled && record.timeoutTimer === undefined) {
            record.timeoutTimer = setTimeout(() => {
              void this.failTask(record, "timeout");
            }, this.taskTimeoutMs);
          }
        }
        return;
      }
      case "result":
        this.settleTask(record, e);
        return;
      default: {
        const _never: never = e;
        void _never;
        return;
      }
    }
  }

  /** Resolve a task with the brain's terminal `result`; clean up its scratch. */
  private settleTask(record: TaskRecord, result: ResultEffect): void {
    if (record.settled) return;
    record.settled = true;
    if (record.timeoutTimer !== undefined) clearTimeout(record.timeoutTimer);
    this.tasks.delete(record.task.task_id);
    record.resolve({
      result,
      logs: record.logs,
      stderrTail: "",
      exitCode: null,
    });
    void this.cleanupTaskScratch(record);
  }

  /**
   * Fail an in-flight task the host could not let the brain finish (crash /
   * drain / timeout). Synthesizes a `result: failed` and resolves the run.
   */
  private async failTask(
    record: TaskRecord,
    kind: HostTaskFailKind,
    extra?: string,
  ): Promise<void> {
    if (record.settled) return;
    record.settled = true;
    if (record.timeoutTimer !== undefined) clearTimeout(record.timeoutTimer);
    this.tasks.delete(record.task.task_id);
    const { reasonKind, detail } = hostFailReason(kind, this.agentId, extra);
    record.resolve({
      result: {
        v: 1,
        type: "result",
        task_id: record.task.task_id,
        status: "failed",
        reason: { kind: reasonKind, detail },
      },
      logs: record.logs,
      stderrTail: "",
      exitCode: null,
    });
    await this.cleanupTaskScratch(record);
  }

  /**
   * Post the "brain was upgraded; re-trigger the request" notice into a task's
   * thread before cancelling an open gate (§7.5). Reuses the task's own `onPost`
   * hook so it rides the normal `dispatch.task.post` path to the right surface.
   */
  private async postUpgradeNotice(record: TaskRecord): Promise<void> {
    try {
      await record.hooks.onPost({
        v: 1,
        type: "post",
        task_id: record.task.task_id,
        text:
          "The brain was upgraded while this request was awaiting your approval. " +
          "The pending request was cancelled — please re-trigger it.",
      });
    } catch (err) {
      process.stderr.write(
        `daemon-brain-host: upgrade-notice post failed for task ` +
          `${record.task.task_id} (agent ${this.agentId}): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /**
   * Send an `effect_rejected` for a refused effect. Best-effort.
   *
   * `kind` accepts the FULL host taxonomy ({@link HostReasonKind}) — not
   * just the 3-kind brain subset — because `create_private_thread`'s policy
   * refusals (anon-reachable agent naming its own members; rate limit trip)
   * are `policy_denied`, a host-only kind (cortex#2206). Every pre-existing
   * call site keeps passing one of the original 3 kinds, so this widening is
   * purely additive.
   */
  private async rejectEffect(
    taskId: string,
    effect: string,
    kind: HostReasonKind,
    detail: string,
  ): Promise<void> {
    await this.sendToConn(
      encodeBrainEvent({
        v: 1,
        type: "effect_rejected",
        task_id: taskId,
        effect,
        reason: { kind, detail },
      }) + "\n",
    );
  }

  /**
   * cortex#2206 — true when this agent has already made
   * {@link CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR} `create_private_thread`
   * ATTEMPTS within the trailing hour. Prunes expired entries first (a real
   * sliding window, not a fixed bucket that resets on the hour boundary).
   * Read-only — pair with {@link recordThreadCreateAttempt} to reserve a
   * slot once the caller has decided to proceed.
   */
  private isThreadCreateRateLimited(): boolean {
    const cutoff = this.now() - CREATE_PRIVATE_THREAD_RATE_LIMIT_WINDOW_MS;
    this.threadCreateAttempts = this.threadCreateAttempts.filter((t) => t > cutoff);
    return this.threadCreateAttempts.length >= CREATE_PRIVATE_THREAD_RATE_LIMIT_PER_HOUR;
  }

  /** Record one `create_private_thread` attempt against this agent's sliding window. */
  private recordThreadCreateAttempt(): void {
    this.threadCreateAttempts.push(this.now());
  }

  /**
   * cortex#2256 — true when this agent has already made
   * {@link POST_LOG_RATE_LIMIT_PER_HOUR} `post_log` ATTEMPTS within the
   * trailing hour. Same sliding-window mechanics as
   * {@link isThreadCreateRateLimited}, over its own separate window.
   */
  private isPostLogRateLimited(): boolean {
    const cutoff = this.now() - POST_LOG_RATE_LIMIT_WINDOW_MS;
    this.postLogAttempts = this.postLogAttempts.filter((t) => t > cutoff);
    return this.postLogAttempts.length >= POST_LOG_RATE_LIMIT_PER_HOUR;
  }

  /** Record one `post_log` attempt against this agent's sliding window. */
  private recordPostLogAttempt(): void {
    this.postLogAttempts.push(this.now());
  }

  /** Write a line to the live connection, swallowing a closed-socket error. */
  private async sendToConn(line: string): Promise<void> {
    const conn = this.connection;
    if (conn === null) return;
    try {
      await conn.write(line);
    } catch (err) {
      process.stderr.write(
        `daemon-brain-host: write failed for "${this.agentId}" (socket likely closed): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Teardown helpers
  // -------------------------------------------------------------------------

  /** SIGTERM → +killGraceMs SIGKILL the current process. Best-effort. */
  private async terminateProcess(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.connection = null;
    if (this.healthyResetTimer !== undefined) {
      clearTimeout(this.healthyResetTimer);
      this.healthyResetTimer = undefined;
    }
    if (proc === null) return;
    try {
      proc.kill("SIGTERM");
    } catch (err) {
      process.stderr.write(
        `daemon-brain-host: SIGTERM failed for "${this.agentId}" (likely exited): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const exitedOnOwn = await Promise.race([
      proc.exited.then(() => true).catch(() => true),
      sleep(this.killGraceMs).then(() => false),
    ]);
    if (!exitedOnOwn) {
      try {
        proc.kill("SIGKILL");
      } catch (err) {
        process.stderr.write(
          `daemon-brain-host: SIGKILL failed for "${this.agentId}" (likely exited): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /**
   * Remove the process-level scratch dir + the socket file (and the per-spawn
   * restricted dir the default factory created to hold it). Best-effort.
   */
  private async cleanupSocket(): Promise<void> {
    if (this.processScratch !== null) {
      await cleanupDir(this.processScratch);
      this.processScratch = null;
    }
    if (this.currentSocketPath !== null) {
      const sockPath = this.currentSocketPath;
      await cleanupDir(sockPath);
      // The default factory nests the socket in a per-spawn 0700 dir
      // (`…/cortex-brain-sock-XXXX/{agent}.sock`); remove that dir too so we do
      // not leak an empty restricted dir per spawn. Guarded to our own naming
      // so an injected `makeSocketPath` (e.g. a bare path) is never over-swept.
      const parent = dirname(sockPath);
      if (basename(parent).startsWith("cortex-brain-sock-")) {
        await cleanupDir(parent);
      }
      this.currentSocketPath = null;
    }
  }

  /** Remove one task's scratch dir. Best-effort. */
  private async cleanupTaskScratch(record: TaskRecord): Promise<void> {
    await cleanupDir(record.scratchDir);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a host-side task failure to a brain reason kind + detail. */
function hostFailReason(
  kind: HostTaskFailKind,
  agentId: string,
  extra?: string,
): { reasonKind: "cant_do" | "not_now"; detail: string } {
  switch (kind) {
    case "crashed":
      return {
        reasonKind: "cant_do",
        detail: `brain crashed${extra ? `: ${extra}` : ""}`,
      };
    case "timeout":
      return {
        reasonKind: "cant_do",
        detail: `brain task timed out (agent ${agentId})`,
      };
    case "drained":
      return {
        reasonKind: "not_now",
        detail: `brain was upgraded (hot-swap) — re-trigger the request`,
      };
  }
}

/** Synthesize a terminal `failed` result for a fast-fail in `runTask`. */
function synthHostFail(
  taskId: string,
  kind: "cant_do" | "not_now",
  detail: string,
): BrainTaskRunResult {
  return {
    result: {
      v: 1,
      type: "result",
      task_id: taskId,
      status: "failed",
      reason: { kind, detail },
    },
    logs: [],
    stderrTail: "",
    exitCode: null,
  };
}

/** Best-effort recursive removal of a dir or file. Never throws. */
async function cleanupDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `daemon-brain-host: cleanup of "${path}" failed: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default socket-path factory. Puts the socket inside a per-spawn directory
 * created mode-0700 (owner-only) under the OS temp dir, so the socket file is
 * not even traversable by other local users — a second, file-permission layer
 * under the per-spawn auth token. Belt-and-braces: the token authenticates the
 * connector; the 0700 dir narrows who can reach the socket at all. Falls back
 * to a bare tmpdir path if the restricted-dir create fails (the auth token
 * still protects the seam).
 */
function defaultMakeSocketPath(agentId: string): string {
  const unique = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), `cortex-brain-sock-`));
    // mkdtempSync creates 0700 on POSIX already, but set it explicitly so the
    // guarantee does not depend on the platform umask.
    try {
      chmodSync(dir, 0o700);
    } catch (err) {
      process.stderr.write(
        `daemon-brain-host: chmod 0700 on socket dir "${dir}" failed ` +
          `(continuing; auth token still protects the seam): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return join(dir, `${agentId}.sock`);
  } catch (err) {
    process.stderr.write(
      `daemon-brain-host: restricted socket-dir create failed ` +
        `(falling back to bare tmpdir; auth token still protects the seam): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return join(tmpdir(), `cortex-brain-${agentId}-${unique}.sock`);
  }
}

// ---------------------------------------------------------------------------
// Default Bun Unix-socket transport
// ---------------------------------------------------------------------------

/**
 * Verify a raw pre-protocol auth line against the expected token. The line is
 * `{ "v": 1, "type": "auth", "token": "…" }`. Tolerant of unknown extra fields
 * (forward-compat), strict on the token match. Returns true only on an exact,
 * constant-time-ish token match. Never throws.
 */
function verifyAuthLine(line: string, expected: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Malformed first line — not a valid auth proof.
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "auth" || typeof obj.token !== "string") return false;
  return timingSafeEqualStr(obj.token, expected);
}

/**
 * Constant-time-ish token equality. Compares the UTF-8 bytes via
 * `crypto.timingSafeEqual` when lengths match; a length mismatch is an
 * immediate false — the token is a fixed-length UUID, so length is not a
 * secret. Avoids leaking match progress through early-return timing on the
 * byte comparison itself. Never throws.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    // timingSafeEqual only throws on length mismatch (already guarded); any
    // other failure is treated as a non-match — fail closed.
    return false;
  }
}

/**
 * Production transport: bind a Unix domain socket, spawn the brain (with
 * `CORTEX_BRAIN_SOCKET` + `CORTEX_BRAIN_SOCKET_TOKEN` already in `env`), and
 * resolve `connection` ONLY after the brain proves the per-spawn token on its
 * first line. Logs ride stdio (§12.1); the protocol rides the socket.
 *
 * The auth line is consumed HERE, in the transport — before any protocol byte
 * reaches the host's codec. The host's `onData` pump (the protocol decoder) is
 * only wired AFTER `connection` resolves, so an unauthenticated connector never
 * gets an effect routed.
 *
 * Wrapped in a factory so the host's default is a stable reference; tests pass
 * their own `transport`.
 */
export const makeBunUnixTransport: DaemonTransport = (opts) => {
  let resolveConn!: (c: DaemonBrainConnection) => void;
  let rejectConn!: (e: unknown) => void;
  const connection = new Promise<DaemonBrainConnection>((res, rej) => {
    resolveConn = res;
    rejectConn = rej;
  });

  let dataHandler: ((chunk: Uint8Array | string) => void) | null = null;
    const pendingPostAuth: Uint8Array[] = [];
  let closeHandler: (() => void) | null = null;
  // The bound socket the brain connects on. Bun's socket data callback is
  // (socket, data); we expose a write/onData/onClose facade.
  interface BunServerSocket { write(data: string | Uint8Array): number; end(): void }
  let liveSocket: BunServerSocket | null = null;
  // Outbound backpressure (host → brain). Bun's `socket.write` returns the
  // number of bytes accepted and does NOT buffer the remainder — a large line
  // (e.g. a task carrying an inlined attachment) exceeding the send buffer is
  // PARTIALLY written, the rest dropped, so the brain reads a truncated line,
  // fails JSON.parse, and silently drops the task (it never runs). Queue the
  // unwritten bytes and flush them on the socket's `drain` event.
  let writeQueue: Uint8Array = new Uint8Array(0);
  const flushWriteQueue = (): void => {
    if (liveSocket === null || writeQueue.length === 0) return;
    const n = liveSocket.write(writeQueue);
    writeQueue = n >= writeQueue.length ? new Uint8Array(0) : writeQueue.subarray(n);
  };
  const enqueueWrite = (bytes: Uint8Array): void => {
    if (writeQueue.length === 0) {
      writeQueue = bytes;
    } else {
      const merged = new Uint8Array(writeQueue.length + bytes.length);
      merged.set(writeQueue);
      merged.set(bytes, writeQueue.length);
      writeQueue = merged;
    }
    flushWriteQueue();
  };
  // Auth state: until the first line proves the token, the connection is NOT
  // resolved and inbound bytes are buffered by the auth pre-reader, never the
  // protocol pump.
  let authed = false;
  let authClosed = false;
  let authBuffer = "";
  const authDecoder = new TextDecoder("utf-8");
  let authTimer: ReturnType<typeof setTimeout> | undefined;

  // `Bun.listen` with a `unix` path. The brain process connects via
  // `Bun.connect({ unix })`. Typed loosely because the Bun socket types vary
  // across versions; the host only needs write/onData/onClose.
  const bun = globalThis.Bun as unknown as {
    listen: (cfg: unknown) => { stop: (closeActive?: boolean) => void };
    spawn: (argv: string[], cfg: unknown) => {
      exited: Promise<number>;
      kill: (signal?: NodeJS.Signals | number) => void;
    };
  };

  /** Reject + tear down on a failed/timed-out auth. Idempotent. */
  const failAuth = (reason: string): void => {
    if (authClosed) return;
    authClosed = true;
    if (authTimer !== undefined) clearTimeout(authTimer);
    process.stderr.write(
      `daemon-brain-host(transport): rejecting unauthenticated connector on ` +
        `${opts.socketPath}: ${reason}\n`,
    );
    try {
      liveSocket?.end();
    } catch {
      // Socket already gone — nothing to close.
    }
    rejectConn(new Error(`brain socket auth failed: ${reason}`));
  };

  const server = bun.listen({
    unix: opts.socketPath,
    socket: {
      open(socket: BunServerSocket) {
        // SINGLE-CONNECTION socket: the first connector owns the auth attempt.
        // A second connector arriving while one is live (authed OR mid-auth) is
        // closed immediately — it cannot race in as the brain.
        if (liveSocket !== null) {
          process.stderr.write(
            `daemon-brain-host(transport): rejecting second connector on ` +
              `${opts.socketPath} (one already connected)\n`,
          );
          try {
            socket.end();
          } catch {
            // Already closing.
          }
          return;
        }
        liveSocket = socket;
        // Start the auth deadline: no valid proof within the window → reject.
        authTimer = setTimeout(
          () => { failAuth(`no auth line within ${SOCKET_AUTH_TIMEOUT_MS}ms`); },
          SOCKET_AUTH_TIMEOUT_MS,
        );
        (authTimer as { unref?: () => void }).unref?.();
      },
      data(_socket: BunServerSocket, data: Uint8Array) {
        if (authed) {
          // Post-auth: ordinary protocol bytes go to the host's decoder pump.
          dataHandler?.(data);
          return;
        }
        if (authClosed) return;
        // Pre-auth: buffer until the first newline, then verify the auth proof.
        authBuffer += authDecoder.decode(data, { stream: true });
        const nl = authBuffer.indexOf("\n");
        if (nl === -1) {
          // Bound the pre-auth buffer so a connector cannot stream unbounded
          // bytes without ever sending a newline.
          if (authBuffer.length > 64 * 1024) {
            failAuth("auth line exceeded 64 KiB without a newline");
          }
          return;
        }
        const rawLine = authBuffer.slice(0, nl);
        const rest = authBuffer.slice(nl + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!verifyAuthLine(line, opts.socketToken)) {
          failAuth("auth token mismatch or malformed auth line");
          return;
        }
        // Authenticated. Stop the deadline, resolve the connection, and replay
        // any bytes that arrived AFTER the auth line into the protocol pump.
        authed = true;
        if (authTimer !== undefined) clearTimeout(authTimer);
        resolveConn({
          write(chunk) {
            // Byte-accurate, backpressure-safe: queue + flush (a large line is
            // written across multiple `drain`s rather than truncated).
            enqueueWrite(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
          },
          onData(handler) {
            dataHandler = handler;
            // Flush bytes that arrived in the SAME chunk as the auth line
            // (sage cortex#1035 round 2): the host registers onData only
            // after the connection resolves; without buffering, protocol
            // bytes replayed before registration are silently dropped.
            if (pendingPostAuth.length > 0) {
              const flush = pendingPostAuth.splice(0, pendingPostAuth.length);
              for (const chunk of flush) handler(chunk);
            }
          },
          onClose(handler) {
            closeHandler = handler;
          },
        });
        if (rest.length > 0) {
          const restBytes = new TextEncoder().encode(rest);
          if (dataHandler !== null) {
            dataHandler(restBytes);
          } else {
            pendingPostAuth.push(restBytes);
          }
        }
      },
      drain() {
        // Send buffer has room again — flush any bytes a large line couldn't
        // fit on its first write (prevents truncated task/effect lines).
        flushWriteQueue();
      },
      close() {
        liveSocket = null;
        writeQueue = new Uint8Array(0);
        if (!authed) {
          // Closed before authenticating — surface as a failed connect.
          failAuth("connector closed before authenticating");
          return;
        }
        closeHandler?.();
      },
      error(_socket: BunServerSocket, err: unknown) {
        process.stderr.write(
          `daemon-brain-host(transport): socket error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      },
    },
  });

  const proc = bun.spawn(opts.argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: opts.env,
    cwd: opts.cwd,
  });

  // If the process exits before connecting, reject the connection promise so
  // `start()` surfaces the spawn failure.
  void proc.exited.then((code) => {
    if (liveSocket === null) {
      rejectConn(
        new Error(`brain process exited (code ${code}) before connecting on socket`),
      );
    }
  });

  return {
    connection,
    exited: proc.exited.then((c) => c).catch(() => null),
    kill(signal) {
      try {
        proc.kill(signal);
      } finally {
        try {
          server.stop(true);
        } catch (err) {
          process.stderr.write(
            `daemon-brain-host(transport): server.stop failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    },
  };
};
