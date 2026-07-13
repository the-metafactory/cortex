/**
 * XDG wave-5 (cortex#1903) — GATED STATE-dir migration tests.
 *
 * Hermetic scratch `$HOME`; `CORTEX_STATE_DIR` unset per test; a fake launchd
 * `GateEnv` (no real launchctl / processes). Covers the ACs:
 *   1. Migration ABORTS when a stack is loaded — via the X-09 service gate AND
 *      via the directory-occupancy precondition (gate-clear but a live `*.pid` in
 *      the state dir — the belt-insufficiency case #1932).
 *   2. The signature-verified network-cache roster survives the move intact.
 *   3. Exactly one live process per stack PID after the move (restore invariant).
 *   4. Copy-keep-source: source intact; idempotent; canonical-wins.
 *   5. An unclassifiable `*.pid` counts as PRESENT → abort (fail-safe).
 *
 * All test/describe names contain "state migration" for `bun test … -t`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { GateEnv, GateExec, ClearFleetOptions } from "../migration/migration-gate";
import { CORTEX_LABEL_PREFIX } from "../migration/migration-gate";
import { NetworkCache } from "../registry/network-cache";
import {
  executeStateDirMigration,
  migrateStateDir,
  planStateDirMigration,
  STATE_MIGRATION_JOURNAL_NAME,
  stateDirOccupancyCheck,
} from "../migrate-state-dir";
import {
  canonicalLogsDir,
  canonicalNetworkCacheDir,
  canonicalRelayDir,
  cortexStateDir,
  legacyGroveLogsDir,
  legacyNetworkCacheDir,
  legacyPidStateDir,
  legacyRelayDir,
} from "../state-path";

const FAST_DRAIN = { drainTimeoutMs: 100, pollIntervalMs: 10 };
const WORK_LABEL = `${CORTEX_LABEL_PREFIX}work`;

let home: string;
let launchAgentsDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.CORTEX_STATE_DIR;
  delete process.env.CORTEX_STATE_DIR;
  home = mkdtempSync(join(tmpdir(), "xdg1903-mig-"));
  launchAgentsDir = join(home, "Library", "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CORTEX_STATE_DIR;
  else process.env.CORTEX_STATE_DIR = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

// =============================================================================
// Fake launchd + controllable GateEnv (mirrors migration-gate.test.ts)
// =============================================================================

/** launchd fake. `loaded` = label→pid; `sticky` labels ignore bootout (they stay
 *  loaded + alive — a daemon that refuses to die). `alive` drives procAlive. */
function makeLaunchd(init: { loaded?: Record<string, number>; sticky?: string[] }): {
  env: GateEnv;
  loaded: Map<string, number>;
  alive: Set<number>;
} {
  const loaded = new Map<string, number>(Object.entries(init.loaded ?? {}));
  const alive = new Set<number>(loaded.values());
  const sticky = new Set(init.sticky ?? []);
  const labelOf = (t: string | undefined): string => (t ?? "").split("/").pop() ?? "";
  let nextPid = 90000;
  const exec: GateExec = (argv) => {
    const sub = argv[1];
    if (sub === "print") {
      const pid = loaded.get(labelOf(argv[2]));
      return Promise.resolve(
        pid !== undefined
          ? { code: 0, stdout: `\tstate = running\n\tpid = ${pid.toString()}\n`, stderr: "" }
          : { code: 113, stdout: "", stderr: "Could not find service" },
      );
    }
    if (sub === "bootout") {
      const label = labelOf(argv[2]);
      if (sticky.has(label)) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      const pid = loaded.get(label);
      loaded.delete(label);
      if (pid !== undefined) alive.delete(pid);
      return Promise.resolve({ code: pid !== undefined ? 0 : 3, stdout: "", stderr: "" });
    }
    if (sub === "bootstrap") {
      const label = (argv[3] ?? "").split("/").pop()?.replace(/\.plist$/, "") ?? "";
      const pid = nextPid++;
      loaded.set(label, pid);
      alive.add(pid);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    if (sub === "kickstart") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    return Promise.resolve({ code: 1, stdout: "", stderr: `unknown ${String(sub)}` });
  };
  let clock = 0;
  const env: GateEnv = {
    exec,
    procAlive: (pid) => alive.has(pid),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { env, loaded, alive };
}

/** Batteries-included darwin gate opts with an empty belt (hermetic — never
 *  reads a real pidfile) and one discovered stack slug ("work"). */
function gateOpts(env: GateEnv): ClearFleetOptions {
  return {
    platform: "darwin",
    uid: 501,
    env,
    drain: FAST_DRAIN,
    launchAgentsDir,
    home,
    discoverSlugs: () => ["work"],
    belt: { stackConfigPaths: [], readPidFile: () => undefined },
  };
}

/** A minimal valid signed-roster cache record (passes NetworkCache's shape +
 *  BASE64_ED25519 grammar gate). */
function signedRosterJson(networkId: string): string {
  const pubkey = "A".repeat(43) + "="; // 43 base64 chars + '=' padding
  return JSON.stringify(
    {
      schema_version: 1,
      cached_at: "2026-01-01T00:00:00.000Z",
      descriptor: { network_id: networkId, hub_url: "nats://hub", leaf_port: 4222, members: [] },
      roster: {
        network_id: networkId,
        members: [{ principal_id: "p1", principal_pubkey: pubkey }],
      },
    },
    null,
    2,
  );
}

// =============================================================================
// AC1a — X-09 service gate: a LOADED stack aborts the move
// =============================================================================

describe("state migration — AC1 gate refuses while a stack is loaded", () => {
  test("a sticky-loaded stack daemon → gate refuses → NOTHING carried", async () => {
    // A stack whose bootout is ignored (won't die) → the gate cannot prove it dead.
    const lc = makeLaunchd({ loaded: { [WORK_LABEL]: 4242 }, sticky: [WORK_LABEL] });
    // Plant a legacy roster so we can prove it was NOT carried on a refusal.
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    writeFileSync(join(legacyNetworkCacheDir(home), "n-x.json"), signedRosterJson("n-x"));

    const run = await migrateStateDir({ ...gateOpts(lc.env), home });

    expect(run.outcome).toBe("gate-refused");
    expect(run.gate.cleared).toBe(false);
    expect(run.journal).toBeUndefined();
    // Canonical state root must not have been created by a refused migration.
    expect(existsSync(join(canonicalNetworkCacheDir(home), "n-x.json"))).toBe(false);
    // Source roster is untouched.
    expect(existsSync(join(legacyNetworkCacheDir(home), "n-x.json"))).toBe(true);
  });
});

// =============================================================================
// AC1b / AC5 — directory-occupancy precondition (belt-insufficiency #1932)
// =============================================================================

describe("state migration — AC1b/AC5 directory-occupancy precondition", () => {
  test("gate clears but a LIVE *.pid in the state dir → dir-occupied abort", async () => {
    const lc = makeLaunchd({}); // nothing loaded → service gate clears
    lc.alive.add(7777); // a hand-started daemon the service gate can't see
    mkdirSync(legacyPidStateDir(home), { recursive: true });
    writeFileSync(join(legacyPidStateDir(home), "cortex-custom.pid"), "7777\n");
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    writeFileSync(join(legacyNetworkCacheDir(home), "n-x.json"), signedRosterJson("n-x"));

    const run = await migrateStateDir({ ...gateOpts(lc.env), home });

    expect(run.gate.cleared).toBe(true); // the SERVICE gate cleared…
    expect(run.outcome).toBe("dir-occupied"); // …but the dir-occupancy belt refused
    expect(run.occupancy?.occupied).toBe(true);
    expect(run.occupancy?.refused.some((r) => r.reason === "live" && r.pid === 7777)).toBe(true);
    expect(run.journal).toBeUndefined();
    expect(existsSync(join(canonicalNetworkCacheDir(home), "n-x.json"))).toBe(false);
  });

  test("an UNCLASSIFIABLE *.pid counts as PRESENT → abort (fail-safe)", async () => {
    const lc = makeLaunchd({});
    mkdirSync(legacyPidStateDir(home), { recursive: true });
    writeFileSync(join(legacyPidStateDir(home), "cortex.pid"), "not-a-pid");

    const run = await migrateStateDir({ ...gateOpts(lc.env), home });

    expect(run.gate.cleared).toBe(true);
    expect(run.outcome).toBe("dir-occupied");
    expect(run.occupancy?.refused.some((r) => r.reason === "unparseable")).toBe(true);
    expect(run.journal).toBeUndefined();
  });

  test("stateDirOccupancyCheck: dead pid is NOT an occupant; skips absent dirs", () => {
    mkdirSync(legacyPidStateDir(home), { recursive: true });
    writeFileSync(join(legacyPidStateDir(home), "cortex.pid"), "5"); // pid 5, reported dead
    const res = stateDirOccupancyCheck(
      [legacyPidStateDir(home), join(home, "does-not-exist")],
      () => false, // nothing alive
    );
    expect(res.occupied).toBe(false);
    expect(res.scanned).toEqual([legacyPidStateDir(home)]);
  });
});

// =============================================================================
// AC2 — the signature-verified roster survives the move
// =============================================================================

describe("state migration — AC2 signed roster survives intact", () => {
  test("network-cache roster is carried byte-identical and still loads/verifies", async () => {
    const lc = makeLaunchd({}); // clear gate
    const legacyDir = legacyNetworkCacheDir(home);
    mkdirSync(legacyDir, { recursive: true });
    const original = signedRosterJson("n-prod");
    writeFileSync(join(legacyDir, "n-prod.json"), original);

    const run = await migrateStateDir({ ...gateOpts(lc.env), home });
    expect(run.outcome).toBe("migrated");

    const canonicalFile = join(canonicalNetworkCacheDir(home), "n-prod.json");
    expect(existsSync(canonicalFile)).toBe(true);
    // Byte-identical — no re-serialize, no truncation.
    expect(readFileSync(canonicalFile, "utf-8")).toBe(original);
    // Source kept.
    expect(existsSync(join(legacyDir, "n-prod.json"))).toBe(true);
    // The shape + BASE64_ED25519 signature grammar still passes at the canonical
    // location → the offline-fallback roster survived and verifies.
    const loaded = new NetworkCache({ cacheDir: canonicalNetworkCacheDir(home) }).load("n-prod");
    expect(loaded).not.toBeUndefined();
    expect(loaded?.roster.members[0]?.principal_id).toBe("p1");
  });
});

// =============================================================================
// AC3 — exactly one live process per stack after the move
// =============================================================================

describe("state migration — AC3 one live process per stack after move", () => {
  test("a running stack is stopped, migrated, then restored to exactly one live pid", async () => {
    const lc = makeLaunchd({ loaded: { [WORK_LABEL]: 4242 } }); // one live stack
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    writeFileSync(join(legacyNetworkCacheDir(home), "n-x.json"), signedRosterJson("n-x"));

    const run = await migrateStateDir({ ...gateOpts(lc.env), home });

    expect(run.outcome).toBe("migrated");
    expect(run.gate.cleared).toBe(true);
    // The migration carried the roster forward.
    expect(existsSync(join(canonicalNetworkCacheDir(home), "n-x.json"))).toBe(true);
    // Restore brought the fleet back: exactly ONE launchd entry for the stack,
    // holding exactly ONE live pid (no duplicate, no orphan).
    expect(run.restore.restored).toEqual(["work"]);
    expect(lc.loaded.has(WORK_LABEL)).toBe(true);
    const livePid = lc.loaded.get(WORK_LABEL);
    expect(livePid).toBeDefined();
    expect(lc.alive.has(livePid!)).toBe(true);
    // The OLD pid is gone (proven dead before the move) — not two processes.
    expect(lc.alive.has(4242)).toBe(false);
    expect([...lc.loaded.keys()].filter((l) => l === WORK_LABEL)).toHaveLength(1);
  });
});

// =============================================================================
// AC4 — copy-keep-source: source intact, idempotent, canonical-wins
// =============================================================================

describe("state migration — AC4 copy-keep-source + idempotent", () => {
  test("logs + roster carried; source kept; journal written; re-run is a no-op", async () => {
    const lc = makeLaunchd({});
    mkdirSync(legacyGroveLogsDir(home), { recursive: true });
    writeFileSync(join(legacyGroveLogsDir(home), "cortex.log"), "line1\n");
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    writeFileSync(join(legacyNetworkCacheDir(home), "n-x.json"), signedRosterJson("n-x"));

    const run1 = await migrateStateDir({ ...gateOpts(lc.env), home, stampedAt: "2026-07-13T00:00:00Z" });
    expect(run1.outcome).toBe("migrated");

    // Carried to canonical.
    expect(readFileSync(join(canonicalLogsDir(home), "cortex.log"), "utf-8")).toBe("line1\n");
    // Source kept.
    expect(existsSync(join(legacyGroveLogsDir(home), "cortex.log"))).toBe(true);
    // Journal written at the canonical root with the applied records.
    const journalPath = join(cortexStateDir(home), STATE_MIGRATION_JOURNAL_NAME);
    expect(existsSync(journalPath)).toBe(true);
    const applied = (run1.journal?.carried ?? []).filter((m) => m.applied);
    expect(applied.length).toBeGreaterThanOrEqual(2); // log + roster

    // Second run: canonical-wins → everything skippedExisting, nothing re-applied.
    const run2 = await migrateStateDir({ ...gateOpts(lc.env), home });
    expect(run2.outcome).toBe("migrated");
    expect((run2.journal?.carried ?? []).every((m) => m.skippedExisting === true || m.applied !== true)).toBe(
      true,
    );
  });

  test("planStateDirMigration is EMPTY under a $CORTEX_STATE_DIR override", () => {
    process.env.CORTEX_STATE_DIR = "/ov/state";
    mkdirSync(legacyNetworkCacheDir(home), { recursive: true });
    writeFileSync(join(legacyNetworkCacheDir(home), "n-x.json"), signedRosterJson("n-x"));
    const plan = planStateDirMigration({ home });
    expect(plan.carried).toHaveLength(0); // self-contained root — no legacy counterpart
  });

  test("relay pidfile is carried but relay-policy.yaml (config) is NOT", () => {
    // Direct plan/execute exercise (no gate) — relay dir holds both a pidfile
    // (STATE, carried) and a policy (CONFIG, left behind).
    mkdirSync(legacyRelayDir(home), { recursive: true });
    writeFileSync(join(legacyRelayDir(home), "relay.pid"), "123");
    writeFileSync(join(legacyRelayDir(home), "relay-policy.yaml"), "policy: {}\n");
    executeStateDirMigration(planStateDirMigration({ home }), "2026-07-13T00:00:00Z");
    expect(existsSync(join(canonicalRelayDir(home), "relay.pid"))).toBe(true);
    expect(existsSync(join(canonicalRelayDir(home), "relay-policy.yaml"))).toBe(false);
  });
});
