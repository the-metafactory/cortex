/**
 * Integration: the hook poller runs the retention prune on its tick (throttled,
 * best-effort), without breaking ingestion or the cursor (#857/#864).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SCHEMA_SQL } from "../db/schema";
import { applyTransition } from "../db/transitions";
import { registerOrphanSession } from "../db/sessions";
import { HookStreamPoller } from "../hooks/poller";
import { ORPHAN_RETENTION_MS } from "../db/retention";
import type { HooksConfig } from "../types";

const DAY = 24 * 60 * 60 * 1000;

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

describe("HookStreamPoller retention prune wiring", () => {
  let db: Database;
  let tmp: string;
  let config: HooksConfig;

  beforeEach(() => {
    db = setupDb();
    tmp = mkdtempSync(join(tmpdir(), "mc-poller-retention-"));
    config = {
      // A dir with no .jsonl files: poll() ingests nothing but still runs the
      // tail of the cycle (cursor save + prune).
      rawEventsDir: tmp,
      cursorPath: join(tmp, "cursor.json"),
      pollInterval: 2000,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prunes an old terminal orphan on the first poll tick", () => {
    const orphan = registerOrphanSession(db, "cc-poll-old")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "complete" });
    db.query(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(
      new Date(Date.now() - ORPHAN_RETENTION_MS - DAY).toISOString(),
      orphan.sessionId
    );

    const poller = new HookStreamPoller(db, config);
    poller.poll(); // first tick → throttle fires

    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(orphan.sessionId)).toBeNull();
    // ST-P2: the session prunes, but the REAL owning agent (here observed:{cc}
    // for a nameless register) is retained — only legacy mc-orphan- agents are
    // ever agent-deleted. The 1,044-tile fix collapses tiles via owning-agent
    // attach; agent-row cleanup is no longer the prune's job for new-model rows.
    expect(db.query(`SELECT 1 FROM agents WHERE id = ?`).get(orphan.agentId)).toBeTruthy();
    poller.stop();
  });

  it("retains a fresh orphan and the orphan-task anchor", () => {
    const orphan = registerOrphanSession(db, "cc-poll-fresh")!;
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "start" });
    applyTransition(db, orphan.assignmentId, orphan.sessionId, { type: "complete" });
    db.query(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(
      new Date(Date.now() - DAY).toISOString(),
      orphan.sessionId
    );

    const poller = new HookStreamPoller(db, config);
    poller.poll();

    expect(db.query(`SELECT 1 FROM sessions WHERE id = ?`).get(orphan.sessionId)).toBeTruthy();
    expect(db.query(`SELECT 1 FROM tasks WHERE id = 'mc-orphan-task'`).get()).toBeTruthy();
    poller.stop();
  });

  it("poll() does not throw even if the db is in a bad state for the prune", () => {
    const poller = new HookStreamPoller(db, config);
    db.close(); // prune will fail; best-effort path must swallow it
    let threw = false;
    try {
      poller.poll();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // re-open a throwaway so afterEach's db.close() is safe
    db = setupDb();
  });
});
