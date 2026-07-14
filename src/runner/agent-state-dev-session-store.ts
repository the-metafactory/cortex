/**
 * cortex#1720 S4b — AgentState-backed warm-session store for the `dev.implement`
 * consumer. Retires the file-backed bridge (`FileDevSessionStore`) onto
 * agent-state's KV surface (agent-state v0.3.0 / PR #13: `errands.ts get`,
 * `annotate`) WITHOUT touching the `DevSessionStore` seam the dev-consumer
 * depends on — callers are byte-identical.
 *
 * ## What this maps, and why it owns its own work_items
 *
 * The seam maps `correlationChainId → ccSessionId` (a chain spans the implement
 * dispatch AND its fix cycles — the SAME chain id, per `devCorrelationChainId`).
 * The dispatch-state recorder (S3) keys work_items by the PER-DISPATCH
 * `envelope.id`, and — crucially — the `dev.implement` path runs through
 * `DevConsumer`, which does NOT flow through the BrainConsumer, so NO recorder
 * work_item exists for a dev dispatch to hang the session id off of. Threading
 * the recorder's private per-dispatch map into a different consumer would also
 * conflate two concerns the S4b assessment deliberately kept apart: "the durable
 * dispatch queue" vs "session continuity per chain."
 *
 * So this store owns a SEPARATE, host-namespaced slice of `work_items`: kind
 * `dev-session`, one row per chain, keyed by the chainId as the work_item id.
 * That id is stable across the whole chain (the chain's FIRST dispatch and every
 * fix cycle carry it), which is exactly constraint (4)'s "annotate the work item
 * for the chain's first dispatch" — resolved without any recorder change.
 *
 * ## Latency contract (the load-bearing rule — AnnotateWorkItem.md / GetWorkItem.md)
 *
 *   - **Hot read stays in-process.** `get(chainId)` is a pure `Map.get` — it
 *     NEVER spawns. The warm-resume read is correctness-affecting (a missed read
 *     means a wrong/cold resume), so it must not depend on a subprocess.
 *   - **Rehydrate ONCE at construction.** A single `errands.ts list` pass reads
 *     the `dev-session` rows and parses each row's `notes.session_id` into the
 *     map — NOT a `get` per read.
 *   - **Writes go off-path.** `set()` updates the map SYNCHRONOUSLY (so the very
 *     next `get` sees it), then fire-and-forgets `enqueue` (idempotent — the
 *     bundle no-ops on an existing id) + `annotate --notes-json {"session_id":…}`.
 *     A spawn error / non-zero exit / throw logs ONE line and never rejects.
 *
 * ## Field ownership (the annotate contract)
 *
 * `annotate` is metadata-only: it merges host-namespaced keys into `notes` and
 * NEVER touches `status`/`kind`/`payload`/`owner_agent`, and the bundle emits
 * `work_item_annotated` itself (this host never appends events). The row is
 * created once by `enqueue` (empty payload — the session interior lives in the
 * substrate, not here) and thereafter only annotated.
 */

import { existsSync } from "node:fs";
import { resolveInstanceDir } from "../common/agents/agent-state-scaffold";
// cortex#2007 — shared `defaultErrandsScript()` (was triplicated); routes
// through `resolveArcPackReposDir()`, env override + lazy resolution preserved.
import { defaultErrandsScript } from "../common/agents/agent-state-scripts";
import {
  defaultAgentStateSpawn,
  type AgentStateSpawn,
} from "../common/agents/agent-state-spawn";
import { FileDevSessionStore, type DevSessionStore } from "./dev-session-store";

/** Host label baked into the bundle env (matches the S1–S4a recorder). */
const DEFAULT_HOST = "cortex";

/**
 * The `work_items.kind` this store owns. Host-namespaced (§ the `kind` column is
 * agent-defined) so the session-continuity KV never collides with the dispatch
 * recorder's per-dispatch rows. The `notes.session_id` key is likewise host-owned.
 */
export const DEV_SESSION_WORK_ITEM_KIND = "dev-session";

/** The host-namespaced notes key carrying the CC session id. */
const SESSION_ID_NOTE_KEY = "session_id";

/** Minimal shape this store needs off an agent — id, plus the opt-in `state`. */
export interface DevSessionStoreAgent {
  id: string;
  /** Present ⇒ stateful (AgentState-backed); absent ⇒ stateless (file store). */
  state?: { blueprint: string; version: string };
}

export interface AgentStateDevSessionStoreOptions {
  /** Override the resolved instance dir (test seam). Default: ~/.config/cortex/agents/<id>. */
  instanceDir?: string;
  /** Override the host label baked into the env (test seam). Default: "cortex". */
  host?: string;
  /** Override path to the bundle's errands.ts (test seam / non-standard install). */
  errandsScript?: string;
  /** Override the spawn used to invoke the bundle (test seam). */
  spawn?: AgentStateSpawn;
  /** Override the logger (test seam). Default: stderr. */
  log?: (line: string) => void;
}

/**
 * AgentState-backed `DevSessionStore`. Durable across restarts (the §3.6b
 * requirement the file store also met), but now the durable backing is the
 * bundle's `work_items` rather than a JSON file. The hot read is a process-local
 * map, rehydrated once on construction — the file store's read cost profile,
 * with agent-state as the source of truth.
 */
export class AgentStateDevSessionStore implements DevSessionStore {
  private readonly agentId: string;
  private readonly host: string;
  private readonly instanceDir: string;
  private readonly errandsScript: string;
  private readonly spawn: AgentStateSpawn;
  private readonly log: (line: string) => void;

  /**
   * chainId → ccSessionId. THE hot-read source. Rehydrated once at construction
   * from the bundle's `dev-session` rows; updated synchronously on every `set`.
   */
  private readonly map = new Map<string, string>();

  /**
   * chainIds we have already `enqueue`d a row for (seen at rehydrate or created
   * by a prior `set`). Lets a repeat `set` on the same chain skip the redundant
   * (idempotent-anyway) enqueue and go straight to `annotate`.
   */
  private readonly enqueued = new Set<string>();

  constructor(agent: DevSessionStoreAgent, opts: AgentStateDevSessionStoreOptions = {}) {
    this.agentId = agent.id;
    this.host = opts.host ?? DEFAULT_HOST;
    this.instanceDir = opts.instanceDir ?? resolveInstanceDir(agent.id, this.host);
    this.errandsScript = opts.errandsScript ?? defaultErrandsScript();
    this.spawn = opts.spawn ?? defaultAgentStateSpawn;
    this.log = opts.log ?? ((line) => process.stderr.write(line));
    this.rehydrate();
  }

  /** Hot path — pure in-memory read. NEVER spawns (the load-bearing rule). */
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(chainId: string): Promise<string | undefined> {
    return this.map.get(chainId);
  }

  /**
   * Record the session id for a chain. Updates the map SYNCHRONOUSLY (the very
   * next `get` sees it), then fires the durable write OFF-PATH (fire-and-forget)
   * so a slow/failed bundle never blocks or fails the dispatch. Resolves as soon
   * as the map is updated — it does NOT await the subprocesses.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async set(chainId: string, sessionId: string): Promise<void> {
    this.map.set(chainId, sessionId);
    // Off-path: do not await. A throw inside the async IIFE can't escape (it is
    // caught within), so this never produces an unhandled rejection.
    void this.persist(chainId, sessionId);
  }

  /**
   * Drop a chain's entry (optional terminal cleanup). Synchronous map delete,
   * then an off-path best-effort `resolve --status cancelled` on the row (the
   * only lifecycle verb that closes it — annotate can't change status).
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(chainId: string): Promise<void> {
    const had = this.map.delete(chainId);
    this.enqueued.delete(chainId);
    if (had) void this.retire(chainId);
  }

  /**
   * Rehydrate the map from the bundle's `dev-session` rows in ONE `list` pass.
   * Bundle absent / spawn error / non-zero exit → empty (cold) map + one log
   * line. A cold map degrades to cold-resume (slower-but-correct), never a boot
   * crash — same failure posture as the file store's corrupt-file path.
   */
  private rehydrate(): void {
    if (!existsSync(this.errandsScript)) {
      this.log(
        `cortex: agent-state — dev-session rehydrate SKIPPED for "${this.agentId}" ` +
          `(reason=script-absent) — starting with a cold warm-session map\n`,
      );
      return;
    }
    const stdout = this.run([
      "list",
      "--kind",
      DEV_SESSION_WORK_ITEM_KIND,
      "--owner",
      this.agentId,
    ]);
    if (stdout === null) {
      // run() already logged the failure with the rehydrate context.
      return;
    }
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = this.parseRow(trimmed);
      if (parsed === null) continue;
      this.enqueued.add(parsed.id);
      if (parsed.sessionId !== undefined) this.map.set(parsed.id, parsed.sessionId);
    }
  }

  /**
   * The durable write behind a `set`. enqueue-if-absent (idempotent — the bundle
   * no-ops on an existing id) then annotate the `session_id`. TOTAL +
   * NON-THROWING: any failure logs one line and returns; the map already holds
   * the value.
   */
  private async persist(chainId: string, sessionId: string): Promise<void> {
    // Yield so `set` resolves (map-updated) before the subprocesses run — keeps
    // the write strictly off the awaited path even for an in-process spawn seam.
    await Promise.resolve();
    if (!existsSync(this.errandsScript)) {
      this.log(
        `cortex: agent-state — dev-session write SKIPPED for "${this.agentId}" ` +
          `(reason=script-absent; chain=${chainId})\n`,
      );
      return;
    }
    if (!this.enqueued.has(chainId)) {
      // enqueue --id <chainId> --kind dev-session --payload {} --owner <agent>.
      // Empty payload: the session interior lives in the substrate, not here.
      // The bundle inserts-or-no-ops on the id, so a race that double-enqueues
      // is harmless. Mark enqueued regardless so we don't loop on re-enqueue.
      this.enqueued.add(chainId);
      const enqueue = this.run([
        "enqueue",
        "--id",
        chainId,
        "--kind",
        DEV_SESSION_WORK_ITEM_KIND,
        "--payload",
        "{}",
        "--owner",
        this.agentId,
      ]);
      if (enqueue === null) {
        // Enqueue failed — drop the optimistic mark so a later `set` retries it,
        // and skip the annotate (nothing to annotate). One line already logged.
        this.enqueued.delete(chainId);
        return;
      }
    }
    // annotate --id <chainId> --notes-json {"session_id":<sessionId>}. Merges
    // the host-namespaced key; the bundle emits `work_item_annotated` itself.
    this.run([
      "annotate",
      "--id",
      chainId,
      "--notes-json",
      JSON.stringify({ [SESSION_ID_NOTE_KEY]: sessionId }),
    ]);
  }

  /** Off-path terminal close for `delete`. Best-effort; failure logged, non-fatal. */
  private async retire(chainId: string): Promise<void> {
    await Promise.resolve();
    if (!existsSync(this.errandsScript)) return;
    this.run(["resolve", "--id", chainId, "--status", "cancelled"]);
  }

  /**
   * Run one `errands.ts` subcommand. TOTAL + NON-THROWING: a spawn error /
   * non-zero exit / throw logs one line (naming the subcommand + chain context)
   * and returns null; success returns the captured stdout. The dispatch path
   * must never see a state failure.
   */
  private run(args: string[]): string | null {
    let result;
    try {
      result = this.spawn("bun", [this.errandsScript, ...args], { env: this.stdEnv() });
    } catch (err) {
      this.log(this.failLine(args, `spawn threw: ${errText(err)}`));
      return null;
    }
    if (result.error) {
      this.log(this.failLine(args, `spawn-error: ${result.error.message}`));
      return null;
    }
    if (result.status !== 0) {
      const stderr = result.stderr ? String(result.stderr).slice(0, 200) : "";
      this.log(
        this.failLine(args, `nonzero-exit status=${result.status}${stderr ? `; stderr: ${stderr}` : ""}`),
      );
      return null;
    }
    return result.stdout !== undefined ? String(result.stdout) : "";
  }

  /** One consistent failure line naming the subcommand + chain (when present). */
  private failLine(args: string[], reason: string): string {
    const sub = args[0] === "list" ? "rehydrate" : `dev-session ${args[0]}`;
    const idIdx = args.indexOf("--id");
    const chain = idIdx >= 0 ? `; chain=${args[idIdx + 1]}` : "";
    return (
      `cortex: agent-state — ${sub} FAILED for "${this.agentId}" ` +
      `(non-fatal; ${reason}${chain})\n`
    );
  }

  /** The standard bundle env (`MF_AGENT_NAME`, `MF_HOST`, `MF_INSTANCE_DIR`). */
  private stdEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MF_AGENT_NAME: this.agentId,
      MF_HOST: this.host,
      MF_INSTANCE_DIR: this.instanceDir,
    };
  }

  /** Parse one `list` JSON row → `{ id, sessionId? }`. Null on any shape miss. */
  private parseRow(line: string): { id: string; sessionId?: string } | null {
    let row: { id?: unknown; notes?: unknown };
    try {
      row = JSON.parse(line) as { id?: unknown; notes?: unknown };
    } catch {
      return null;
    }
    if (typeof row.id !== "string" || row.id.length === 0) return null;
    const out: { id: string; sessionId?: string } = { id: row.id };
    // `notes` is a JSON-object string per the annotate contract; a session id we
    // wrote lives under `session_id`. A NULL / non-object / non-JSON notes cell
    // simply means "no session yet" for this chain — the id still counts as
    // enqueued so a later `set` skips the re-enqueue.
    if (typeof row.notes === "string" && row.notes.length > 0) {
      try {
        const notes = JSON.parse(row.notes) as Record<string, unknown>;
        const sid = notes[SESSION_ID_NOTE_KEY];
        if (typeof sid === "string" && sid.length > 0) out.sessionId = sid;
      } catch {
        /* non-JSON freeform notes → no session id; leave undefined. */
      }
    }
    return out;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Options for the per-agent store factory. */
export interface CreateDevSessionStoreOptions extends AgentStateDevSessionStoreOptions {
  /** Path the FileDevSessionStore fallback writes to (the pre-S4b file bridge). */
  fileStorePath: string;
}

/**
 * Choose the warm-session store for an agent at wiring time (constraint 5 + 6):
 *
 *   - **Stateless agent** (no `state`) → {@link FileDevSessionStore}, with ZERO
 *     bundle probing. A stateless agent takes no new code paths.
 *   - **Stateful agent, bundle present** → {@link AgentStateDevSessionStore}
 *     (rehydrates on construction).
 *   - **Stateful agent, bundle ABSENT** → {@link FileDevSessionStore} FALLBACK
 *     with ONE log line, so a machine without the v0.3.0 bundle never regresses.
 */
export function createDevSessionStore(
  agent: DevSessionStoreAgent,
  opts: CreateDevSessionStoreOptions,
): DevSessionStore {
  const log = opts.log ?? ((line: string) => process.stderr.write(line));

  // Stateless — the pre-S4b behaviour, unchanged. No bundle probe.
  if (!agent.state) {
    return new FileDevSessionStore(opts.fileStorePath);
  }

  // Stateful — prefer the bundle, but fall back to the file store (loud) when
  // the bundle isn't installed so nothing regresses on a bundle-less machine.
  const errandsScript = opts.errandsScript ?? defaultErrandsScript();
  if (!existsSync(errandsScript)) {
    log(
      `cortex: agent-state — dev-session store fallback to FILE for "${agent.id}" ` +
        `(reason=bundle-absent at ${errandsScript}) — warm-resume still durable via the JSON bridge\n`,
    );
    return new FileDevSessionStore(opts.fileStorePath);
  }
  return new AgentStateDevSessionStore(agent, { ...opts, errandsScript });
}
