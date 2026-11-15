import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../db/init";
import { EscalationRulings, RULING_STATUS_FRESH_MS, RULING_STATUS_RETRY_MS } from "../desk/ruling";
import type { RangerRunner } from "../desk/actions";

const REF = "example/app#12";
const NOW = Date.parse("2026-11-15T12:00:00Z");
const openNode = { code: 0, stdout: JSON.stringify({ typed: true, status: "open", ref: { id: "12" } }), stderr: "" };

describe("persistent escalation status cache", () => {
  let directory: string;
  let db: Database;
  let now: number;
  let calls: number;
  let run: RangerRunner;
  const reopen = () => {
    db.close();
    db = initDatabase(join(directory, "mission-control.db"));
  };
  const reader = (source = "/opt/soma") => new EscalationRulings(source, run, () => now, db);

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "escalation-cache-"));
    db = initDatabase(join(directory, "mission-control.db"));
    now = NOW;
    calls = 0;
    run = async () => { calls++; return openNode; };
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reuses successful statuses after a database reopen without extending their expiry", async () => {
    await reader().warm([REF]);
    reopen();
    now += RULING_STATUS_FRESH_MS - 1;
    const restarted = reader();
    expect(restarted.read([REF]).get(REF)).toBeNull();
    await restarted.warm([REF]);
    expect(calls).toBe(1);
    reopen();
    now++;
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    run = async () => { calls++; await gate; return openNode; };
    const expired = reader();
    expect(expired.read([REF]).get(REF)).toContain("being checked");
    expect(calls).toBe(2);
    release();
    await expired.warm([REF]);
    expect(expired.read([REF]).get(REF)).toBeNull();
  });

  it("retains failed reads across restarts until their original retry deadline", async () => {
    run = async () => { calls++; return { code: 1, stdout: "", stderr: "unavailable" }; };
    await reader().warm([REF]);
    reopen();
    now += RULING_STATUS_RETRY_MS - 1;
    const restarted = reader();
    expect(restarted.read([REF]).get(REF)).toContain("could not be read");
    await restarted.warm([REF]);
    expect(calls).toBe(1);
    reopen();
    now++;
    await reader().warm([REF]);
    expect(calls).toBe(2);
  });

  it("keeps fresh omitted refs and isolates results from different Soma executables", async () => {
    await reader().warm([REF]);
    reopen();
    reader().read([]);
    const restarted = reader();
    await restarted.warm([REF]);
    expect(calls).toBe(1);
    await reader("/opt/other-soma").warm([REF]);
    expect(calls).toBe(2);
    reopen();
    await reader().warm([REF]);
    await reader("/opt/other-soma").warm([REF]);
    expect(calls).toBe(2);
  });

  it("starts the lifetime when the graph read completes and prunes expired disk entries", async () => {
    run = async () => { calls++; now += 60_000; return openNode; };
    await reader().warm([REF]);
    now = NOW + RULING_STATUS_FRESH_MS;
    reopen();
    await reader().warm([REF]);
    expect(calls).toBe(1);
    now += 60_000;
    reopen();
    reader();
    expect(db.query("SELECT COUNT(*) AS count FROM desk_escalation_statuses").get()).toEqual({ count: 0 });
  });

  it("keeps serving memory results and finishes its batch when persistence is unavailable", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      db.run("DROP TABLE desk_escalation_statuses");
      const refs = Array.from({ length: 6 }, (_, index) => `example/app#${index + 1}`);
      run = async argv => { calls++; return { ...openNode, stdout: JSON.stringify({ typed: true, status: "open", ref: { id: argv[3] } }) }; };
      const cache = reader();
      await cache.warm(refs);
      expect([...cache.read(refs).values()]).toEqual(Array(6).fill(null));
      await cache.warm(refs);
      expect(calls).toBe(6);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls.every(([message]) => String(message).includes("escalation status persistence failed"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
