/**
 * F-2.1 (cortex#835) — warm-session store for the `dev.implement` consumer.
 *
 * Design ref: `docs/design-agentic-dev-pipeline.md` §3.6b — "agent-state
 * durably maps errand → session id so a restarted agent resumes rather than
 * restarts." This is the **smallest honest durable version** of that map:
 * a single JSON file, one process owns it, written atomically (temp +
 * rename) so a crash mid-write never corrupts it.
 *
 * **Why a file, not sqlite / agent-state.** §3.6b assigns the durable
 * errand→session map to agent-state in the fully-composed dev-loop (F-3/F-6).
 * That substrate isn't wired into cortex's runner yet (the in-process
 * `dev.implement` consumer is the FIRST piece — F-2 per the design's "what's
 * new" table). Standing up agent-state here would be over-engineering ahead
 * of F-3; a JSON file is the lightweight, dependency-free bridge that makes
 * warm-resume work TODAY and is trivially swapped for the agent-state store
 * when F-3 lands (the `DevSessionStore` interface is the seam). Per the
 * pragmatic-solutions principle: port/bridge over heavy-dep.
 *
 * **The map.** `correlationChainId → ccSessionId`. The chain id is the
 * `dev-events.devCorrelationChainId` value (the request's `correlation_id`,
 * or its `id` when first-of-chain); the CC session id is the value
 * `CCSessionResult.sessionId` carries after the implement session runs. A
 * subsequent fix-cycle task on the same chain reads the stored id and passes
 * it as `resumeSessionId` so the CC session `--resume`s instead of
 * cold-starting.
 *
 * **What this file is NOT:**
 *   - NOT a general KV — two methods (`get` / `set`) plus a `delete` for
 *     cleanup. No TTL, no eviction (a chain is short-lived; the principal /
 *     a future F-3 reaper prunes stale entries — flagged, not built).
 *   - NOT concurrency-safe across PROCESSES — one cortex daemon owns one
 *     store file (the single-instance PID-file model the daemon already
 *     enforces). In-process concurrent `set`s serialise through the async
 *     write; the last write wins, which is correct for the
 *     one-session-per-chain invariant.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";

/**
 * The warm-session store seam. The consumer depends on this interface, not
 * the file-backed implementation, so tests inject an in-memory fake (mirrors
 * how `review-consumer.ts` injects every dependency) and the F-3 agent-state
 * store can replace `FileDevSessionStore` without touching the consumer.
 */
export interface DevSessionStore {
  /** CC session id last recorded for this chain, or `undefined` if cold. */
  get(chainId: string): Promise<string | undefined>;
  /** Record (or overwrite) the CC session id for this chain. */
  set(chainId: string, sessionId: string): Promise<void>;
  /** Drop a chain's entry (terminal success/failure cleanup; optional use). */
  delete(chainId: string): Promise<void>;
}

/**
 * In-memory `DevSessionStore`. Volatile — loses the map on restart, so it
 * does NOT satisfy §3.6b's "a restarted agent resumes" durability clause. Use
 * it only in tests; production wires {@link FileDevSessionStore}.
 */
export class MemoryDevSessionStore implements DevSessionStore {
  private readonly map = new Map<string, string>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(chainId: string): Promise<string | undefined> {
    return this.map.get(chainId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set(chainId: string, sessionId: string): Promise<void> {
    this.map.set(chainId, sessionId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(chainId: string): Promise<void> {
    this.map.delete(chainId);
  }
}

/**
 * JSON-file-backed `DevSessionStore`. Durable across restarts (the §3.6b
 * requirement). The whole map is held in memory and the file is rewritten
 * atomically on every `set` / `delete` — fine for the small, short-lived
 * chain set a single stack carries (typically a handful of in-flight
 * errands). When the map grows large enough that whole-file rewrites hurt,
 * the seam swaps to the F-3 agent-state store (the cost is per-chain, not
 * per-write, so this scales to the realistic dev-loop fleet size).
 */
export class FileDevSessionStore implements DevSessionStore {
  private readonly path: string;
  private map: Map<string, string>;

  constructor(path: string) {
    this.path = path;
    this.map = loadMap(path);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(chainId: string): Promise<string | undefined> {
    return this.map.get(chainId);
  }

  async set(chainId: string, sessionId: string): Promise<void> {
    this.map.set(chainId, sessionId);
    await this.flush();
  }

  async delete(chainId: string): Promise<void> {
    if (this.map.delete(chainId)) {
      await this.flush();
    }
  }

  /**
   * Atomic write: serialise to a temp sibling, then `rename` over the real
   * file. `rename` is atomic on a single filesystem, so a crash mid-write
   * leaves either the old file or the new one — never a half-written one.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  private async flush(): Promise<void> {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const obj: Record<string, string> = {};
    for (const [k, v] of this.map) obj[k] = v;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}

/**
 * Load the persisted map from disk. A missing file → empty map (cold first
 * boot). A corrupt / unreadable file → empty map + a stderr warning rather
 * than a boot crash: a lost warm-session map degrades to cold-starting the
 * next fix cycle (a slower-but-correct fallback), which is strictly better
 * than refusing to boot. (CLAUDE.md: never swallow silently — we log.)
 */
function loadMap(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      process.stderr.write(
        `dev-session-store: ${path} is not a JSON object — starting with an empty warm-session map\n`,
      );
      return new Map();
    }
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") map.set(k, v);
    }
    return map;
  } catch (err) {
    process.stderr.write(
      `dev-session-store: failed to read ${path} (${
        err instanceof Error ? err.message : String(err)
      }) — starting with an empty warm-session map\n`,
    );
    return new Map();
  }
}
