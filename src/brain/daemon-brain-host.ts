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
 *      `CORTEX_BRAIN_SOCKET` env naming the socket to connect back on, and
 *      `lifecycle: daemon`-marking `CORTEX_BRAIN_LIFECYCLE=daemon`;
 *   2. waits for the brain to connect, then sends the `hello` handshake
 *      (host → brain: agent id, persona, protocol version — §5 "Persona
 *      delivery"; identity is HOST-AUTHORITATIVE);
 *   3. accepts `runTask(task, hooks)` calls — writes the `task` event, routes
 *      the brain's effects (post / ask_principal / dispatch / log / result) to
 *      the per-task hooks, and resolves when that task's `result` arrives;
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

import { mkdtempSync, realpathSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import {
  encodeBrainEvent,
  parseBrainEffect,
  JsonlDecoder,
  type TaskEvent,
  type ResultEffect,
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
 */
export type DaemonTransport = (opts: {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  socketPath: string;
}) => DaemonBrainProcess;

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
   * keep running). Defaults to 120_000 (2 min).
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
    this.taskTimeoutMs = opts.taskTimeoutMs ?? 120_000;
    this.killGraceMs = opts.killGraceMs ?? 5_000;
    this.transport = opts.transport ?? makeBunUnixTransport;
    this.makeScratchDir =
      opts.makeScratchDir ??
      (() => mkdtempSync(join(tmpdir(), "cortex-brain-daemon-")));
    this.makeSocketPath =
      opts.makeSocketPath ??
      ((id) =>
        join(
          tmpdir(),
          `cortex-brain-${id}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`,
        ));
    this.onDegraded = opts.onDegraded;
    this.now = opts.now ?? (() => Date.now());
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
    await this.spawnGeneration();
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

    const scratchDir = this.makeScratchDir();
    let scratchReal: string;
    try {
      scratchReal = realpathSync(scratchDir);
    } catch {
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

  /** Spawn a fresh brain generation, connect, hello, wire the data/close pumps. */
  private async spawnGeneration(): Promise<void> {
    const argv = buildArgv(this.run, this.packDir);
    const socketPath = this.makeSocketPath(this.agentId);
    this.currentSocketPath = socketPath;
    // Minimal env (shared discipline with the per-task runner) PLUS the socket
    // env naming where the brain connects back, and the daemon lifecycle marker.
    const baseScratch = this.makeScratchDir();
    const env = {
      ...buildEnv(baseScratch, this.secrets),
      CORTEX_BRAIN_SOCKET: socketPath,
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
    const proc = this.transport({ argv, env, cwd: baseScratch, socketPath });
    this.proc = proc;

    const connection = await proc.connection;
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

    void crashedProc?.exited.catch(() => undefined);

    // Restart-or-degrade.
    if (this.restartCount < this.maxRestarts) {
      this.restartCount += 1;
      process.stderr.write(
        `daemon-brain-host: brain "${this.agentId}" crashed — restarting ` +
          `(${this.restartCount}/${this.maxRestarts})\n`,
      );
      void this.spawnGeneration().catch((err: unknown) => {
        process.stderr.write(
          `daemon-brain-host: restart spawn failed for "${this.agentId}": ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
        // A failed restart spawn counts as another crash toward the budget. The
        // failed spawn already advanced `this.generation`; treat it as that
        // generation's disconnect so the budget advances (or degrades).
        this.handleDisconnect(this.generation);
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
      case "ask_principal": {
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

  /** Send an `effect_rejected` for a refused effect. Best-effort. */
  private async rejectEffect(
    taskId: string,
    effect: string,
    kind: "cant_do" | "not_now" | "wont_do",
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

  /** Remove the process-level scratch dir + the socket file. Best-effort. */
  private async cleanupSocket(): Promise<void> {
    if (this.processScratch !== null) {
      await cleanupDir(this.processScratch);
      this.processScratch = null;
    }
    if (this.currentSocketPath !== null) {
      await cleanupDir(this.currentSocketPath);
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

// ---------------------------------------------------------------------------
// Default Bun Unix-socket transport
// ---------------------------------------------------------------------------

/**
 * Production transport: bind a Unix domain socket, spawn the brain (with
 * `CORTEX_BRAIN_SOCKET` already in `env`), resolve `connection` when the brain
 * connects. Logs ride stdio (§12.1); the protocol rides the socket.
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
  let closeHandler: (() => void) | null = null;
  // The bound socket the brain connects on. Bun's socket data callback is
  // (socket, data); we expose a write/onData/onClose facade.
  type BunServerSocket = { write(data: string | Uint8Array): number; end(): void };
  let liveSocket: BunServerSocket | null = null;

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

  const server = bun.listen({
    unix: opts.socketPath,
    socket: {
      open(socket: BunServerSocket) {
        liveSocket = socket;
        resolveConn({
          write(chunk) {
            socket.write(chunk);
          },
          onData(handler) {
            dataHandler = handler;
          },
          onClose(handler) {
            closeHandler = handler;
          },
        });
      },
      data(_socket: BunServerSocket, data: Uint8Array) {
        dataHandler?.(data);
      },
      close() {
        liveSocket = null;
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
