/**
 * Shared in-memory daemon-brain test double (Bot Packs B-2).
 *
 * A scripted "brain" on the other side of the {@link DaemonBrainHost} transport
 * seam — no real socket, no real subprocess. The host writes cortex → brain
 * events to the connection's `write`; the test inspects them via `received` and
 * replies by calling `emit(line)` (brain → cortex effects). `crash()` fires the
 * close handler; `exit(code)` / `kill` resolve `exited`.
 *
 * Both the host's own unit tests (`daemon-brain-host.test.ts`) and the
 * consumer↔host integration tests (`brain-consumer.test.ts`) drive this same
 * double, so a protocol-shape change updates ONE place instead of fanning out
 * across two near-identical copies (sage cortex#1035 round 1).
 *
 * NOT a `.test.ts` file on purpose — it defines no suite; it is imported by the
 * suites that need it.
 */

import {
  parseBrainEvent,
  type BrainEvent,
  type TaskEvent,
} from "../protocol";
import type {
  DaemonBrainConnection,
  DaemonBrainProcess,
  DaemonTransport,
} from "../daemon-brain-host";

/** A scripted brain the host talks to over an in-memory connection. */
export class FakeDaemonBrain {
  private dataHandler: ((chunk: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  /** Every cortex → brain event the host wrote, parsed. */
  readonly received: BrainEvent[] = [];
  /** Raw lines (for assertions on wire shape). */
  readonly receivedLines: string[] = [];
  /** The signal the host killed the process with (if any). */
  killedWith: NodeJS.Signals | number | undefined;

  private exitResolve!: (code: number | null) => void;
  readonly exited: Promise<number | null>;
  readonly connection: DaemonBrainConnection;

  constructor() {
    this.exited = new Promise((res) => {
      this.exitResolve = res;
    });
    this.connection = {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim().length === 0) continue;
          this.receivedLines.push(line);
          const parsed = parseBrainEvent(line);
          if (parsed.kind === "ok") this.received.push(parsed.event);
        }
      },
      onData: (handler) => {
        this.dataHandler = handler as (c: string) => void;
      },
      onClose: (handler) => {
        this.closeHandler = handler;
      },
    };
  }

  /** Brain → host: emit one effect line. */
  emit(line: string): void {
    this.dataHandler?.(line + "\n");
  }

  /** Simulate a crash — fire the connection close handler + resolve `exited`. */
  crash(): void {
    this.closeHandler?.();
    this.exitResolve(1);
  }

  /** Simulate a clean exit. */
  exit(code = 0): void {
    this.exitResolve(code);
  }

  /** A killed process exits — resolve `exited` so teardown settles promptly. */
  killed(): void {
    this.exitResolve(137);
  }

  /** Did the host write an event of this type? */
  hasEvent(type: BrainEvent["type"]): boolean {
    return this.received.some((e) => e.type === type);
  }

  /** Did the host write at least one `task` event? */
  hasTask(): boolean {
    return this.hasEvent("task");
  }

  /** The FIRST task's id (consumer integration tests dispatch one task). */
  taskId(): string | undefined {
    const t = this.received.find((e) => e.type === "task");
    return t?.type === "task" ? t.task_id : undefined;
  }

  /** The LAST task the host wrote (multiplex tests dispatch several). */
  lastTask(): TaskEvent | undefined {
    const tasks = this.received.filter((e): e is TaskEvent => e.type === "task");
    return tasks[tasks.length - 1];
  }
}

/**
 * A transport that hands out a fixed SEQUENCE of brains — one per spawn
 * (generation 0, then restarts). The test pre-seeds the list; each spawn pops
 * the next. Exposes a live `spawns` count.
 */
export function makeFakeDaemonTransport(brains: FakeDaemonBrain[]): {
  transport: DaemonTransport;
  readonly spawns: number;
} {
  const state = { spawns: 0 };
  const transport: DaemonTransport = () => {
    const brain = brains[state.spawns];
    state.spawns += 1;
    if (brain === undefined) {
      throw new Error(
        `fake transport: no brain seeded for spawn #${state.spawns - 1}`,
      );
    }
    const proc: DaemonBrainProcess = {
      connection: Promise.resolve(brain.connection),
      exited: brain.exited,
      kill: (signal) => {
        brain.killedWith = signal;
        brain.exit(137);
      },
    };
    return proc;
  };
  return {
    transport,
    get spawns() {
      return state.spawns;
    },
  };
}

/**
 * A single-brain transport (the common case for the consumer integration
 * tests). On `kill`, resolves the brain's `exited` so the host's
 * SIGTERM→grace race settles promptly rather than waiting the full grace.
 */
export function singleFakeDaemonTransport(brain: FakeDaemonBrain): DaemonTransport {
  return () => ({
    connection: Promise.resolve(brain.connection),
    exited: brain.exited,
    kill: () => brain.killed(),
  });
}
