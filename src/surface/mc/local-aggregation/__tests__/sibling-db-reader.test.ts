/**
 * #1008 — direct sibling MC-DB read aggregation tests (TDD, RED-first).
 *
 * The pane-of-glass mechanism reads each LOCAL sibling stack's own
 * `mission-control.db` READ-ONLY and merges its sessions+agents into the
 * serving daemon's API responses, origin-tagged. ADR-0011 unified the schema
 * across every stack's MC db, so a cross-db read is byte-safe.
 *
 * Coverage axes:
 *   1. dbPath resolution — per-slug default, the stack's configured `mc.dbPath`,
 *      and tilde expansion; self-exclusion.
 *   2. Multi-db open + merge — N fixture dbs (each canonical schema, seeded with
 *      sessions/agents) → one origin-tagged working-agents union.
 *   3. Graceful degrade — a MISSING / LOCKED-irrelevant / OLD-SCHEMA sibling db
 *      is SKIPPED (recorded degraded), the others still returned, NEVER a throw.
 *   4. /api/agents union — sibling agents projected into origin-tagged tiles.
 *   5. Read-only — the reader opens `{ readonly: true }`; a write attempt throws
 *      (proves query_only / readonly is in force), the request path never writes.
 */

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDatabase } from "../../db/init";
import type { SiblingStackDescriptor } from "../sibling-discovery";
import {
  resolveSiblingDbPath,
  aggregateWorkingAgents,
  aggregateAgentTiles,
  openReadableSiblingDbs,
} from "../sibling-db-reader";
import type { AgentPresenceSnapshotRecord } from "../../api/agents";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leaked tmp dir doesn't fail the test.
    }
  }
});

function freshTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mc-sibling-db-"));
  tmpDirs.push(d);
  return d;
}

/** Build a canonical MC db at `dbPath` seeded with one working agent + session. */
function seedDb(
  dbPath: string,
  opts: { agentId: string; agentName: string; taskTitle: string },
): void {
  const db = initDatabase(dbPath);
  const ts = "2026-06-12T00:00:00.000Z";
  db.run(
    `INSERT INTO agents (id, name, type, persistent) VALUES (?, ?, 'head', 1)`,
    [opts.agentId, opts.agentName],
  );
  db.run(
    `INSERT INTO tasks (id, title, priority, principal_id, source_system)
     VALUES ('task-1', ?, 2, 'andreas', 'internal')`,
    [opts.taskTitle],
  );
  db.run(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
     VALUES ('asg-1', ?, 'task-1', 'running')`,
    [opts.agentId],
  );
  db.run(
    `INSERT INTO sessions
       (id, assignment_id, endpoint_kind, started_at, substrate, agent_id, agent_name, principal_id, status)
     VALUES ('sess-1', 'asg-1', 'local.observed', ?, 'claude-code', ?, ?, 'andreas', 'running')`,
    [ts, opts.agentId, opts.agentName],
  );
  db.close();
}

function sibling(
  stack: string,
  overrides: Partial<SiblingStackDescriptor> = {},
): SiblingStackDescriptor {
  return {
    stack,
    principal: "andreas",
    url: "nats://127.0.0.1:4222",
    credential: { kind: "noauth" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. dbPath resolution
// ---------------------------------------------------------------------------

describe("resolveSiblingDbPath", () => {
  test("falls back to the per-slug default under the home share dir", () => {
    const configRoot = freshTmp();
    // No stacks/*.yaml mc.dbPath → per-slug default.
    const path = resolveSiblingDbPath(sibling("work"), {
      configRoot,
      homeShareDir: "/home/andreas/.local/share/cortex/mc",
    });
    expect(path).toBe("/home/andreas/.local/share/cortex/mc/work/mission-control.db");
  });

  test("honours the stack's configured mc.dbPath (with tilde expansion)", () => {
    const configRoot = freshTmp();
    const stackDir = join(configRoot, "work", "stacks");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(
      join(stackDir, "work.yaml"),
      `principal:\n  id: andreas\nstack:\n  id: andreas/work\nmc:\n  dbPath: "~/custom/work.db"\n`,
    );
    const path = resolveSiblingDbPath(sibling("work"), {
      configRoot,
      homeShareDir: "/home/andreas/.local/share/cortex/mc",
      home: "/home/andreas",
    });
    expect(path).toBe("/home/andreas/custom/work.db");
  });
});

// ---------------------------------------------------------------------------
// 2 + 4. Multi-db open + merge → origin-tagged unions
// ---------------------------------------------------------------------------

describe("aggregateWorkingAgents (cross-db merge)", () => {
  test("merges three stacks' working agents into one origin-tagged list", () => {
    const root = freshTmp();
    const share = freshTmp();
    // Three sibling dbs at the per-slug default path.
    for (const s of ["alpha", "beta", "gamma"]) {
      seedDb(join(share, s, "mission-control.db"), {
        agentId: `agent-${s}`,
        agentName: `Agent ${s}`,
        taskTitle: `task in ${s}`,
      });
    }
    // The serving (local) db has its OWN agent.
    const localDb = initDatabase(join(share, "self", "mission-control.db"));
    localDb.run(
      `INSERT INTO agents (id, name, type, persistent) VALUES ('agent-self', 'Self', 'head', 1)`,
    );
    localDb.run(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t','self task',2,'andreas','internal')`,
    );
    localDb.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('a','agent-self','t','running')`,
    );
    localDb.run(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, substrate)
       VALUES ('s','a','local.observed','2026-06-12T00:00:00.000Z','claude-code')`,
    );

    const siblings = ["alpha", "beta", "gamma"].map((s) => sibling(s));
    const tiles = aggregateWorkingAgents(localDb, siblings, {
      configRoot: root,
      homeShareDir: share,
    });

    // Local row is "local"; each sibling carries its own origin.
    const local = tiles.filter((t) => t.origin === "local");
    expect(local).toHaveLength(1);
    expect(local[0]!.agent_id).toBe("agent-self");

    for (const s of ["alpha", "beta", "gamma"]) {
      const row = tiles.find(
        (t) =>
          typeof t.origin === "object" &&
          t.origin.stack === s &&
          t.origin.principal === "andreas",
      );
      expect(row, `expected an origin-tagged tile for ${s}`).toBeDefined();
      expect(row!.agent_id).toBe(`agent-${s}`);
    }
    localDb.close();
  });

  test("self-exclusion: a sibling that resolves to the local db path is not double-read", () => {
    const root = freshTmp();
    const share = freshTmp();
    const localPath = join(share, "self", "mission-control.db");
    const localDb = initDatabase(localPath);
    localDb.run(
      `INSERT INTO agents (id, name, type, persistent) VALUES ('a','A','head',1)`,
    );
    localDb.run(
      `INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t','x',2,'andreas','internal')`,
    );
    localDb.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('asg','a','t','running')`,
    );
    localDb.run(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, substrate)
       VALUES ('s','asg','local.observed','2026-06-12T00:00:00.000Z','claude-code')`,
    );

    // A sibling descriptor that points at the SAME db path as the local db.
    const tiles = aggregateWorkingAgents(localDb, [sibling("self")], {
      configRoot: root,
      homeShareDir: share,
      selfDbPath: localPath,
    });
    // Only ONE tile (no duplicate from the self-pointed sibling).
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.origin).toBe("local");
    localDb.close();
  });
});

describe("aggregateAgentTiles (/api/agents union)", () => {
  test("merges the local registry view with sibling-db-derived agent tiles", () => {
    const root = freshTmp();
    const share = freshTmp();
    seedDb(join(share, "work", "mission-control.db"), {
      agentId: "luna",
      agentName: "Luna",
      taskTitle: "work task",
    });

    const localRecords: AgentPresenceSnapshotRecord[] = [
      {
        key: "andreas/meta-factory/echo",
        origin: "local",
        agentId: "echo",
        nkeyPublicKey: "NKEYECHO",
        assistantName: "Echo",
        principal: "andreas",
        stack: "meta-factory",
        capabilities: ["code-review"],
        state: "online",
        lastSeenAt: 1,
      },
    ];

    const tiles = aggregateAgentTiles(
      localRecords,
      [sibling("work")],
      { configRoot: root, homeShareDir: share },
    );

    const echo = tiles.find((t) => t.agent_id === "echo");
    expect(echo).toBeDefined();
    expect(echo!.origin).toBe("local");

    const luna = tiles.find((t) => t.agent_id === "luna");
    expect(luna).toBeDefined();
    expect(luna!.origin).toEqual({ principal: "andreas", stack: "work" });
  });

  test("#989 dedup — a sibling already live in the registry (bus fold) is NOT double-counted from its db", () => {
    // The reconciliation: the bus aggregator folds a local sibling's LIVE
    // presence into the registry (`localRecords`), AND the same sibling has a
    // live session in its db. Both paths produce the SAME key
    // (`andreas/work/luna`) — `aggregateAgentTiles` must emit ONE tile (the
    // bus-folded record wins, carrying real liveness), never two (which would be
    // a duplicate React key in the Network view).
    const root = freshTmp();
    const share = freshTmp();
    seedDb(join(share, "work", "mission-control.db"), {
      agentId: "luna",
      agentName: "Luna",
      taskTitle: "work task",
    });

    const localRecords: AgentPresenceSnapshotRecord[] = [
      {
        // The SAME sibling agent, already folded into the registry via the bus.
        key: "andreas/work/luna",
        origin: { kind: "foreign", principal: "andreas", stack: "work" },
        agentId: "luna",
        nkeyPublicKey: "NKEYLUNA",
        assistantName: "Luna",
        principal: "andreas",
        stack: "work",
        capabilities: ["chat"],
        state: "online",
        lastSeenAt: 42,
      },
    ];

    const tiles = aggregateAgentTiles(
      localRecords,
      [sibling("work")],
      { configRoot: root, homeShareDir: share },
    );

    const lunas = tiles.filter((t) => t.key === "andreas/work/luna");
    expect(lunas).toHaveLength(1); // deduped — not two
    // The registry (bus-folded) record wins: it carries the real capabilities +
    // nkey, which the db live-session projection leaves empty.
    expect(lunas[0]!.capabilities).toEqual(["chat"]);
    expect(lunas[0]!.nkey_public_key).toBe("NKEYLUNA");
    // Both paths agree online → stays online.
    expect(lunas[0]!.state).toBe("online");
  });

  test("#989 dedup is state-aware — a live db session revives an offline-by-TTL registry tile", () => {
    // The degraded-bus case: the sibling's bus went quiet so the TTL reaper marked
    // its registry record `offline` (the reaper keeps the record, never deletes),
    // BUT the sibling still has a LIVE SESSION in its db. The db fallback exists
    // for exactly this — so the agent must read ONLINE, not offline. The registry's
    // richer fields (capabilities/nkey) are still preserved.
    const root = freshTmp();
    const share = freshTmp();
    seedDb(join(share, "work", "mission-control.db"), {
      agentId: "luna",
      agentName: "Luna",
      taskTitle: "still working",
    });

    const localRecords: AgentPresenceSnapshotRecord[] = [
      {
        key: "andreas/work/luna",
        origin: { kind: "foreign", principal: "andreas", stack: "work" },
        agentId: "luna",
        nkeyPublicKey: "NKEYLUNA",
        assistantName: "Luna",
        principal: "andreas",
        stack: "work",
        capabilities: ["chat"],
        state: "offline", // heartbeat lapsed — but a session is still live in the db
        offlineReason: "ttl_lapse",
        lastSeenAt: 1,
      },
    ];

    const tiles = aggregateAgentTiles(
      localRecords,
      [sibling("work")],
      { configRoot: root, homeShareDir: share },
    );

    const lunas = tiles.filter((t) => t.key === "andreas/work/luna");
    expect(lunas).toHaveLength(1); // still one tile
    expect(lunas[0]!.state).toBe("online"); // live db session revived liveness
    expect(lunas[0]!.offline_reason).toBeNull();
    // Richer registry fields are preserved through the liveness upgrade.
    expect(lunas[0]!.capabilities).toEqual(["chat"]);
    expect(lunas[0]!.nkey_public_key).toBe("NKEYLUNA");
  });
});

// ---------------------------------------------------------------------------
// XDG wave-5 (#1902) AC1 — sibling aggregation resolves peers AFTER the data move
// ---------------------------------------------------------------------------
//
// The load-bearing hazard: the serving daemon discovers a sibling's
// `mission-control.db` BY its on-disk shape. When the per-stack MC db moves from
// `~/.local/share/cortex/mc/<stack>/…` to the metafactory data root
// `~/.local/share/metafactory/cortex/mc/<stack>/…`, sibling resolution must move
// IN LOCKSTEP — and must still find a peer that has NOT migrated yet (mixed
// fleet). These tests omit `homeShareDir` (the production path) so resolution
// runs through the existence-gated data-path resolver, against a scratch $HOME.

describe("XDG wave-5 (#1902) — sibling discovery after the data move", () => {
  let savedDataDirEnv: string | undefined;
  beforeEach(() => {
    // A stray ambient CORTEX_DATA_DIR would short-circuit existence-gated
    // resolution — unset it so every path derives from the scratch home.
    savedDataDirEnv = process.env.CORTEX_DATA_DIR;
    delete process.env.CORTEX_DATA_DIR;
  });
  afterEach(() => {
    if (savedDataDirEnv === undefined) delete process.env.CORTEX_DATA_DIR;
    else process.env.CORTEX_DATA_DIR = savedDataDirEnv;
  });

  const canonicalDb = (home: string, stack: string) =>
    join(home, ".local", "share", "metafactory", "cortex", "mc", stack, "mission-control.db");
  const legacyDb = (home: string, stack: string) =>
    join(home, ".local", "share", "cortex", "mc", stack, "mission-control.db");

  test("resolveSiblingDbPath (homeShareDir omitted) prefers the migrated metafactory path", () => {
    const home = freshTmp();
    const configRoot = freshTmp();
    // A MIGRATED peer: its db exists under the new metafactory data root.
    seedDb(canonicalDb(home, "work"), { agentId: "w", agentName: "W", taskTitle: "t" });
    const path = resolveSiblingDbPath(sibling("work"), { configRoot, home });
    expect(path).toBe(canonicalDb(home, "work"));
  });

  test("resolveSiblingDbPath falls back to the legacy path for an un-migrated peer", () => {
    const home = freshTmp();
    const configRoot = freshTmp();
    // An UN-migrated peer: its db exists ONLY under the legacy cortex tree.
    seedDb(legacyDb(home, "halden"), { agentId: "h", agentName: "H", taskTitle: "t" });
    const path = resolveSiblingDbPath(sibling("halden"), { configRoot, home });
    expect(path).toBe(legacyDb(home, "halden"));
  });

  test("aggregateWorkingAgents resolves a MIXED fleet — migrated + un-migrated peers both appear", () => {
    const home = freshTmp();
    const configRoot = freshTmp();
    // alpha migrated (new root); beta not yet (legacy root).
    seedDb(canonicalDb(home, "alpha"), { agentId: "agent-alpha", agentName: "Alpha", taskTitle: "a" });
    seedDb(legacyDb(home, "beta"), { agentId: "agent-beta", agentName: "Beta", taskTitle: "b" });

    // The serving (local) db lives at the new root too.
    const localPath = canonicalDb(home, "self");
    const localDb = initDatabase(localPath);
    localDb.run(`INSERT INTO agents (id, name, type, persistent) VALUES ('agent-self','Self','head',1)`);
    localDb.run(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t','self',2,'andreas','internal')`);
    localDb.run(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('a','agent-self','t','running')`);
    localDb.run(`INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at, substrate) VALUES ('s','a','local.observed','2026-06-12T00:00:00.000Z','claude-code')`);

    // homeShareDir OMITTED → existence-gated resolution; selfDbPath excludes self.
    const tiles = aggregateWorkingAgents(
      localDb,
      [sibling("alpha"), sibling("beta")],
      { configRoot, home, selfDbPath: localPath },
    );

    for (const [stack, agentId] of [["alpha", "agent-alpha"], ["beta", "agent-beta"]] as const) {
      const row = tiles.find(
        (t) => typeof t.origin === "object" && t.origin.stack === stack,
      );
      expect(row, `expected an origin-tagged tile for ${stack} after the move`).toBeDefined();
      expect(row!.agent_id).toBe(agentId);
    }
    // Self is the single local-origin row (self-exclusion held despite the move).
    expect(tiles.filter((t) => t.origin === "local")).toHaveLength(1);
    localDb.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Graceful degrade
// ---------------------------------------------------------------------------

describe("openReadableSiblingDbs (graceful degrade)", () => {
  test("a MISSING sibling db is skipped (degraded), others still open", () => {
    const root = freshTmp();
    const share = freshTmp();
    seedDb(join(share, "good", "mission-control.db"), {
      agentId: "g",
      agentName: "G",
      taskTitle: "ok",
    });
    // "ghost" has no db file on disk.
    const { handles, degraded } = openReadableSiblingDbs(
      [sibling("good"), sibling("ghost")],
      { configRoot: root, homeShareDir: share },
    );
    try {
      expect(handles.map((h) => h.origin.stack).sort()).toEqual(["good"]);
      expect(degraded.map((d) => d.stack)).toContain("ghost");
    } finally {
      for (const h of handles) h.db.close();
    }
  });

  test("an OLD-SCHEMA sibling db (missing canonical session columns) is skipped, not crashed-on", () => {
    const root = freshTmp();
    const share = freshTmp();
    seedDb(join(share, "modern", "mission-control.db"), {
      agentId: "m",
      agentName: "M",
      taskTitle: "ok",
    });
    // An ancient db: a sessions table WITHOUT the canonical denormalized columns.
    const oldPath = join(share, "ancient", "mission-control.db");
    mkdirSync(join(share, "ancient"), { recursive: true });
    const old = new Database(oldPath, { create: true });
    old.run(
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, assignment_id TEXT, started_at TEXT)`,
    );
    old.close();

    const { handles, degraded } = openReadableSiblingDbs(
      [sibling("modern"), sibling("ancient")],
      { configRoot: root, homeShareDir: share },
    );
    try {
      expect(handles.map((h) => h.origin.stack)).toEqual(["modern"]);
      expect(degraded.map((d) => d.stack)).toContain("ancient");
    } finally {
      for (const h of handles) h.db.close();
    }
  });

  test("a corrupt / non-sqlite sibling file is skipped, never throws", () => {
    const root = freshTmp();
    const share = freshTmp();
    const badPath = join(share, "corrupt", "mission-control.db");
    mkdirSync(join(share, "corrupt"), { recursive: true });
    writeFileSync(badPath, "this is not a sqlite database");

    const { handles, degraded } = openReadableSiblingDbs([sibling("corrupt")], {
      configRoot: root,
      homeShareDir: share,
    });
    try {
      expect(handles).toHaveLength(0);
      expect(degraded.map((d) => d.stack)).toContain("corrupt");
    } finally {
      for (const h of handles) h.db.close();
    }
  });

  test("opened sibling handles are READ-ONLY (a write throws)", () => {
    const root = freshTmp();
    const share = freshTmp();
    seedDb(join(share, "ro", "mission-control.db"), {
      agentId: "r",
      agentName: "R",
      taskTitle: "ok",
    });
    const { handles } = openReadableSiblingDbs([sibling("ro")], {
      configRoot: root,
      homeShareDir: share,
    });
    try {
      expect(handles).toHaveLength(1);
      expect(() =>
        handles[0]!.db.run(
          `INSERT INTO agents (id,name,type,persistent) VALUES ('x','X','head',1)`,
        ),
      ).toThrow();
    } finally {
      for (const h of handles) h.db.close();
    }
  });
});
