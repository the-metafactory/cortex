/**
 * #1008 — direct sibling MC-DB read aggregation (the pane-of-glass mechanism).
 *
 * The principal-chosen PRIMARY way the localhost Mission Control shows ALL of a
 * principal's LOCAL stacks. Every stack already runs an MC with a COMPLETE local
 * picture in its OWN `mission-control.db` (sessions + agents). The serving daemon
 * (the one with `mc.enabled`) reads each SIBLING stack's db READ-ONLY and MERGES
 * its sessions+agents into the MC API responses, tagged by stack origin — so all
 * of a principal's local stacks render as distinct hubs with their session trees
 * on one pane.
 *
 * ## Why a cross-db read is safe
 *
 * ADR-0011 unified the MC session schema across every stack's db (the canonical
 * `sessions` columns in `db/canonical-session.ts`, asserted by the parity test).
 * Every stack's `mission-control.db` is therefore the SAME shape — opening a
 * sibling's db and running THIS stack's own queries against it is byte-safe.
 *
 * ## Why this is NOT a trust-boundary crossing (ADR-0005 / ADR-0007)
 *
 * Every sibling db is the PRINCIPAL'S OWN data on the principal's OWN machine —
 * same principal, same host. The interior-locality rule (ADR-0005) governs
 * crossing a TRUST boundary (another principal / another machine); reading your
 * own stacks' dbs on your own box does not cross one. Cross-PRINCIPAL peers
 * (whose dbs live on another machine, unreadable here) stay on the #989 bus
 * presence path — the clean reach/depth split this module's `#989 reconciliation`
 * relies on (see `cortex.ts` boot wiring).
 *
 * ## Freshness: per-request open→query→close
 *
 * The reader opens each sibling db `{ readonly: true }` PER CALL and closes it
 * when done. A SQLite open is cheap, this keeps every read always-fresh, and it
 * sidesteps the stale-handle-after-a-sibling-restart problem (a restarted stack
 * recreates its db file/inode — a cached handle would point at the old inode).
 *
 * ## Graceful degradation (never throw into a request)
 *
 * A sibling db that is MISSING / unreadable / locked / corrupt / too-old-schema
 * is SKIPPED (recorded in `degraded[]`, logged to stderr) — that stack is simply
 * absent from the pane, never a 5xx. An old-schema sibling is detected via a
 * cheap `pragma_table_info` canonical-columns check BEFORE any query, so a
 * pre-ADR-0011 db is skipped rather than crashed on with `no such column`.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";

import type { SiblingStackDescriptor } from "./sibling-discovery";
import {
  listWorkingAgents,
  type WorkingAgentTile,
} from "../db/working-agents";
import type {
  AgentOrigin,
  AgentPresenceSnapshotRecord,
  AgentPresenceTile,
} from "../api/agents";

/**
 * The resolved local-aggregation context the MC server reads per request.
 *
 * `cortex.ts` builds ONE of these at boot (from the discovered siblings + the
 * serving stack's config root + its own db path) and hands the MC server a
 * getter that returns it (or `null` when DB-read aggregation is OFF, mirroring
 * the `agentPresence` lazy-getter pattern). The working-agents + agents handlers
 * call into the reader with this context to produce the origin-tagged union.
 */
export interface LocalAggregationContext {
  /** The principal's discovered LOCAL sibling stacks (from `discoverSiblingStacks`). */
  siblings: readonly SiblingStackDescriptor[];
  /** Path resolution inputs (config root, share dir, self db path for exclusion). */
  resolve: SiblingDbResolveOptions;
}

/** Lazy accessor for the local-aggregation context; `null` ⇒ DB-read OFF. */
export type LocalAggregationProvider = () => LocalAggregationContext | null;

/** The conventional per-slug MC db root: `~/.local/share/cortex/mc`. */
function defaultHomeShareDir(home: string): string {
  return join(home, ".local", "share", "cortex", "mc");
}

/** Expand a leading `~` to the given home dir (matches the loader's expandTilde). */
function expandTildeWith(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Shared resolution inputs — injectable so tests pin paths deterministically. */
export interface SiblingDbResolveOptions {
  /** Config root scanned for sibling stack dirs (`<root>/<slug>/stacks/*.yaml`). */
  configRoot: string;
  /**
   * Root for the per-slug default db path. Defaults to
   * `~/.local/share/cortex/mc`. Injected by tests; production passes the same
   * root `cortex.ts` derives the serving stack's `defaultDbPath` from.
   */
  homeShareDir?: string;
  /** Home dir for tilde expansion. Defaults to `os.homedir()`. */
  home?: string;
  /**
   * The SERVING stack's own db path. A sibling whose resolved db path equals
   * this is EXCLUDED — the local db is already queried directly, never twice.
   */
  selfDbPath?: string;
}

/**
 * Resolve a sibling stack's `mission-control.db` PATH.
 *
 * Mirrors `cortex.ts`'s own resolution exactly: the stack's configured
 * `mc.dbPath` (read from its `stacks/*.yaml`, tilde-expanded) when set, else the
 * per-slug default `{homeShareDir}/{stack}/mission-control.db`.
 */
export function resolveSiblingDbPath(
  sibling: SiblingStackDescriptor,
  opts: SiblingDbResolveOptions,
): string {
  const home = opts.home ?? homedir();
  const shareDir = opts.homeShareDir ?? defaultHomeShareDir(home);

  const configured = readConfiguredDbPath(opts.configRoot, sibling.stack);
  if (configured !== null && configured !== "") {
    return expandTildeWith(configured, home);
  }
  return join(shareDir, sibling.stack, "mission-control.db");
}

/**
 * Read a sibling stack's configured `mc.dbPath` from its `stacks/*.yaml`, if any.
 * Returns `null` when the dir / file / field is absent or unreadable — the
 * caller falls back to the per-slug default. Never throws.
 */
function readConfiguredDbPath(configRoot: string, stack: string): string | null {
  const stacksDir = join(configRoot, stack, "stacks");
  if (!existsSync(stacksDir)) return null;
  let files: string[];
  try {
    files = readdirSync(stacksDir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort();
  } catch {
    return null;
  }
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(join(stacksDir, f), "utf8"));
    } catch {
      continue; // a malformed stack file is skipped; try the next.
    }
    const dbPath = (parsed as { mc?: { dbPath?: unknown } } | null)?.mc?.dbPath;
    if (typeof dbPath === "string" && dbPath.length > 0) return dbPath;
  }
  return null;
}

/**
 * The canonical session columns whose presence proves a sibling db is at least
 * ADR-0011 shape. A pre-ADR-0011 db lacking these is skipped (degraded), not
 * crashed on. We probe a representative subset (not the full list) — these are
 * the columns the federated queries actually read.
 */
const REQUIRED_SESSION_COLUMNS = [
  "agent_id",
  "agent_name",
  "parent_session_id",
  "substrate",
] as const;

/** A degraded sibling — its db could not be read — with the reason. */
export interface DegradedSiblingDb {
  stack: string;
  reason: string;
}

/** A readable sibling db handle, tagged with its origin. */
export interface SiblingDbHandle {
  /** The sibling's origin — `{principal, stack}` (always foreign-shaped). */
  origin: { principal: string; stack: string };
  /** Read-only bun:sqlite handle. Caller MUST `.db.close()` when done. */
  db: Database;
}

/** Result of {@link openReadableSiblingDbs}. */
export interface OpenSiblingDbsResult {
  handles: SiblingDbHandle[];
  degraded: DegradedSiblingDb[];
}

/**
 * Open every readable sibling db READ-ONLY. A sibling that is missing / locked /
 * corrupt / too-old-schema, or that resolves to the serving stack's OWN db path
 * (self-exclusion), is SKIPPED — recorded in `degraded[]` (self-exclusion is
 * silent, not degraded) and logged to stderr. NEVER throws.
 *
 * Caller owns the returned handles' lifetime: close every `handles[i].db`.
 */
export function openReadableSiblingDbs(
  siblings: readonly SiblingStackDescriptor[],
  opts: SiblingDbResolveOptions,
): OpenSiblingDbsResult {
  const handles: SiblingDbHandle[] = [];
  const degraded: DegradedSiblingDb[] = [];

  for (const sibling of siblings) {
    const dbPath = resolveSiblingDbPath(sibling, opts);

    // Self-exclusion — the serving stack's own db is already queried directly.
    if (opts.selfDbPath !== undefined && dbPath === opts.selfDbPath) {
      continue;
    }

    if (!existsSync(dbPath)) {
      degraded.push({ stack: sibling.stack, reason: `db not found at ${dbPath}` });
      process.stderr.write(
        `sibling-db-reader: "${sibling.stack}" absent — db not found at ${dbPath}\n`,
      );
      continue;
    }

    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
      // Belt-and-braces: refuse any write at the connection level too. A
      // readonly handle already rejects writes; query_only makes the intent
      // explicit and survives a future open-mode change.
      db.run("PRAGMA query_only = ON");
    } catch (err) {
      degraded.push({
        stack: sibling.stack,
        reason: `open failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      process.stderr.write(
        `sibling-db-reader: "${sibling.stack}" absent — open failed: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }

    // Schema-shape gate: an old (pre-ADR-0011) db lacking the canonical session
    // columns is skipped here rather than crashing the query below. The probe is
    // itself wrapped — a corrupt file that opened but errors on pragma is caught.
    let okSchema: boolean;
    try {
      okSchema = hasCanonicalSessionColumns(db);
    } catch (err) {
      db.close();
      degraded.push({
        stack: sibling.stack,
        reason: `schema probe failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      process.stderr.write(
        `sibling-db-reader: "${sibling.stack}" absent — schema probe failed: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    if (!okSchema) {
      db.close();
      degraded.push({
        stack: sibling.stack,
        reason: "schema too old (missing canonical session columns)",
      });
      process.stderr.write(
        `sibling-db-reader: "${sibling.stack}" absent — schema too old (pre-ADR-0011)\n`,
      );
      continue;
    }

    handles.push({
      origin: { principal: sibling.principal, stack: sibling.stack },
      db,
    });
  }

  return { handles, degraded };
}

/** Cheap `pragma_table_info` check that the sessions table carries the canonical columns. */
function hasCanonicalSessionColumns(db: Database): boolean {
  const rows = db
    .query(`SELECT name FROM pragma_table_info('sessions')`)
    .all() as { name: string }[];
  const present = new Set(rows.map((r) => r.name));
  return REQUIRED_SESSION_COLUMNS.every((c) => present.has(c));
}

/**
 * A {@link WorkingAgentTile} tagged with the stack it came from. The local db's
 * tiles carry `origin: "local"`; each sibling's carry `{principal, stack}`. The
 * dashboard's G-1114 multi-hub adapter groups by origin → siblings render as
 * distinct hubs automatically.
 */
export type OriginTaggedWorkingAgentTile = WorkingAgentTile & {
  origin: AgentOrigin;
};

/**
 * `/api/working-agents` federation: the origin-tagged UNION of the local db's
 * working agents (`origin: "local"`) and each readable sibling db's, by running
 * the EXISTING `listWorkingAgents` query against each db handle and concatenating.
 *
 * Per-request open→query→close: sibling handles are opened, queried, and closed
 * within this call (always fresh). A sibling that can't be read is simply absent
 * (logged via `openReadableSiblingDbs`), never a throw.
 */
export function aggregateWorkingAgents(
  localDb: Database,
  siblings: readonly SiblingStackDescriptor[],
  opts: SiblingDbResolveOptions,
): OriginTaggedWorkingAgentTile[] {
  const out: OriginTaggedWorkingAgentTile[] = listWorkingAgents(localDb).map(
    (t) => ({ ...t, origin: "local" as const }),
  );

  const { handles } = openReadableSiblingDbs(siblings, opts);
  try {
    for (const h of handles) {
      const origin: AgentOrigin = {
        principal: h.origin.principal,
        stack: h.origin.stack,
      };
      // REUSE the existing query — run it per-db, then origin-tag + concat.
      for (const tile of listWorkingAgents(h.db)) {
        out.push({ ...tile, origin });
      }
    }
  } finally {
    for (const h of handles) h.db.close();
  }
  return out;
}

/**
 * Project a sibling db's agents into the `/api/agents` presence-tile shape.
 *
 * The presence registry (`/api/agents`) is bus-liveness-derived (nkey,
 * capabilities, online/offline, heartbeat). A sibling db carries no bus presence
 * — its ground truth for "this agent is present in this stack" is "the agent owns
 * a non-terminal session here." We derive a tile per such agent: `state: online`
 * (it has live work), `origin: {principal, stack}`. Bus-only fields the db can't
 * supply are null/empty — an honest projection, not synthesized liveness.
 */
function siblingAgentTiles(
  db: Database,
  origin: { principal: string; stack: string },
): AgentPresenceTile[] {
  const rows = db
    .query(
      `SELECT DISTINCT ag.id AS agent_id, ag.name AS agent_name
         FROM agents ag
         JOIN agent_task_assignment a ON a.agent_id = ag.id
         JOIN sessions s ON s.assignment_id = a.id
        WHERE s.ended_at IS NULL
          AND ag.id != 'mc-shadow-agent'
        ORDER BY ag.id ASC`,
    )
    .all() as { agent_id: string; agent_name: string | null }[];

  const now = Date.now();
  return rows.map((r) => ({
    key: `${origin.principal}/${origin.stack}/${r.agent_id}`,
    origin: { principal: origin.principal, stack: origin.stack },
    agent_id: r.agent_id,
    assistant_name: r.agent_name,
    nkey_public_key: "",
    principal: origin.principal,
    stack: origin.stack,
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: now,
  }));
}

/**
 * `/api/agents` federation: the UNION of the local registry view (projected into
 * tiles by the caller's existing `toTile`) and each readable sibling db's
 * db-derived agent tiles, origin-tagged.
 *
 * Takes the local presence RECORDS (the registry's `getAgents()` snapshot) so it
 * can reuse the API's own record→tile projection, then appends the sibling tiles.
 */
export function aggregateAgentTiles(
  localRecords: readonly AgentPresenceSnapshotRecord[],
  siblings: readonly SiblingStackDescriptor[],
  opts: SiblingDbResolveOptions,
): AgentPresenceTile[] {
  const out: AgentPresenceTile[] = localRecords.map(recordToTile);
  // #989/#1008 — the registry (`localRecords`) now folds local siblings' LIVE
  // bus presence (idle-or-active) via the bus aggregator. The db-derived sibling
  // tiles below are a live-SESSION fallback for the same agents, deduped by key
  // (`{principal}/{stack}/{agent_id}` — identical on both paths) so an active
  // sibling on BOTH paths is ONE tile (no dup React key).
  //
  // The registry record wins on its RICHER fields (capabilities/nkey, which the
  // db projection leaves empty) — BUT liveness is state-aware: the TTL reaper
  // keeps a record as `state:offline` after a heartbeat lapse (it never deletes),
  // so a sibling whose bus went quiet WHILE a session is still live would read
  // `offline` from the registry yet `online` from its db. That is the exact
  // degraded-bus case the db fallback exists for, so an `online` db tile upgrades
  // an `offline` registry tile's liveness (keeping the registry's richer fields).
  const idxByKey = new Map<string, number>();
  out.forEach((t, i) => idxByKey.set(t.key, i));

  const { handles } = openReadableSiblingDbs(siblings, opts);
  try {
    for (const h of handles) {
      for (const tile of siblingAgentTiles(h.db, h.origin)) {
        const existingIdx = idxByKey.get(tile.key);
        if (existingIdx === undefined) {
          idxByKey.set(tile.key, out.length);
          out.push(tile);
          continue;
        }
        // Collision with a bus-folded registry tile: keep it, but let a live db
        // session revive an offline-by-TTL liveness (bus quiet, work ongoing).
        const existing = out[existingIdx];
        if (existing?.state === "offline" && tile.state === "online") {
          out[existingIdx] = {
            ...existing,
            state: "online",
            offline_reason: null,
            last_seen_at: Math.max(existing.last_seen_at, tile.last_seen_at),
          };
        }
      }
    }
  } finally {
    for (const h of handles) h.db.close();
  }
  return out;
}

/**
 * Local registry record → API tile. Mirrors `api/agents.ts#toTile` exactly (the
 * surface layer's snake_case DTO). Kept here so this module can build the union
 * without importing the handler's private projector; the shapes are pinned by
 * the `AgentPresenceTile` type both sides use.
 */
function recordToTile(r: AgentPresenceSnapshotRecord): AgentPresenceTile {
  const origin: AgentOrigin =
    r.origin === "local"
      ? "local"
      : { principal: r.origin.principal, stack: r.origin.stack };
  return {
    key: r.key,
    origin,
    agent_id: r.agentId,
    assistant_name: r.assistantName,
    nkey_public_key: r.nkeyPublicKey,
    principal: r.principal,
    stack: r.stack,
    capabilities: r.capabilities,
    state: r.state,
    offline_reason: r.offlineReason ?? null,
    started_at: r.startedAt ?? null,
    last_heartbeat_at: r.lastHeartbeatAt ?? null,
    last_seen_at: r.lastSeenAt,
  };
}
