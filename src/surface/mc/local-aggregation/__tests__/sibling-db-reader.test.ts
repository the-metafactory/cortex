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

import { describe, expect, test, afterEach } from "bun:test";
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
