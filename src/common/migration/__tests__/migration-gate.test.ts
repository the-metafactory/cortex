/**
 * cortex#1901 — migration gate tests (XDG epic #1867, P3c).
 *
 * The gate proves a stack fleet is DEAD (not merely deregistered) before a
 * config/state move, using the SERVICE MANAGER as the oracle and a three-leg
 * POSITIVE death proof: (1) the RIGHT service — discovered on Linux, never a
 * derived name; (2) a manager-REACHED down verdict; (3) confirmed PID death via
 * kill(pid,0). Every subprocess, the liveness probe, sleep, and the clock are
 * injected, so both platform paths run on ubuntu CI with no real launchd/systemd
 * and no real processes.
 *
 * These tests are the adversarial re-verdict surface for PR#1929's four
 * fail-opens: A-UNIT (wrong Linux unit), A-ISACTIVE (manager-unreachable),
 * A-TOCTOU (deregistration ≠ death), A-RESTORE (unpaired stop strands the fleet).
 *
 * All test/describe names contain "migration gate" for `bun test … -t`.
 */

import { describe, test, expect } from "bun:test";

import type { DaemonLocatorIO } from "../../../cli/cortex/commands/daemon-locator";
import {
  enumerateServiceTargets,
  runMigrationGate,
  withMigrationGate,
  CORTEX_LABEL_PREFIX,
  RELAY_LABEL,
  type GateEnv,
  type GateExec,
  type GateExecResult,
  type DrainPolicy,
  type ServiceTarget,
} from "../migration-gate";

// A fast drain so the death poll can't hold the runner hostage.
const FAST_DRAIN: DrainPolicy = { drainTimeoutMs: 100, pollIntervalMs: 10 };
const LAUNCH_DIR = "/tmp/x1901-LaunchAgents";
const SYSTEMD_DIR = "/tmp/x1901-systemd-user";
const CFG_DIR = "/tmp/x1901-config/cortex";

// =============================================================================
// Fakes — in-memory launchd + systemd, plus a controllable GateEnv
// =============================================================================

/** A GateEnv over a fake exec whose `procAlive` reads a shared `alive` set. The
 *  clock advances by each `sleep`, so the drain deadline is deterministic. */
function envOver(exec: GateExec, alive: Set<number>): GateEnv {
  let clock = 0;
  return {
    exec,
    procAlive: (pid) => alive.has(pid),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
}

/** launchd fake. `loaded` = label→pid; `killsProcess` = whether bootout also
 *  ends the process (true = clean death; false = the PID lingers = A-TOCTOU). */
function makeLaunchd(init: { loaded?: Record<string, number>; killsProcess?: boolean }): {
  exec: GateExec;
  calls: string[][];
  loaded: Map<string, number>;
  alive: Set<number>;
} {
  const loaded = new Map<string, number>(Object.entries(init.loaded ?? {}));
  const alive = new Set<number>(loaded.values());
  const killsProcess = init.killsProcess ?? true;
  const calls: string[][] = [];
  const labelOf = (t: string | undefined): string => (t ?? "").split("/").pop() ?? "";
  const exec: GateExec = (argv) => {
    calls.push(argv);
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
      const pid = loaded.get(label);
      loaded.delete(label);
      if (killsProcess && pid !== undefined) alive.delete(pid);
      return Promise.resolve({ code: pid !== undefined ? 0 : 3, stdout: "", stderr: "" });
    }
    if (sub === "bootstrap") {
      const label = (argv[3] ?? "").split("/").pop()?.replace(/\.plist$/, "") ?? "";
      const pid = 90000 + loaded.size;
      loaded.set(label, pid);
      alive.add(pid);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    if (sub === "kickstart") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    return Promise.resolve({ code: 1, stdout: "", stderr: `unknown launchctl ${String(sub)}` });
  };
  return { exec, calls, loaded, alive };
}

/** systemd fake. `active` = unit→MainPID. `isActiveOverride` lets a test force a
 *  manager-unreachable / weird `is-active` result (A-ISACTIVE). */
function makeSystemd(init: {
  active?: Record<string, number>;
  killsProcess?: boolean;
  isActiveOverride?: (unit: string) => GateExecResult;
}): {
  exec: GateExec;
  calls: string[][];
  active: Map<string, number>;
  alive: Set<number>;
} {
  const active = new Map<string, number>(Object.entries(init.active ?? {}));
  const alive = new Set<number>(active.values());
  const killsProcess = init.killsProcess ?? true;
  const calls: string[][] = [];
  const exec: GateExec = (argv) => {
    calls.push(argv);
    const verb = argv[2];
    const unit = argv[3] ?? "";
    if (verb === "is-active") {
      if (init.isActiveOverride) return Promise.resolve(init.isActiveOverride(unit));
      return Promise.resolve(
        active.has(unit)
          ? { code: 0, stdout: "active\n", stderr: "" }
          : { code: 3, stdout: "inactive\n", stderr: "" },
      );
    }
    if (verb === "show") {
      const pid = active.get(unit) ?? 0;
      return Promise.resolve({ code: 0, stdout: `${pid.toString()}\n`, stderr: "" });
    }
    if (verb === "stop") {
      const pid = active.get(unit);
      active.delete(unit);
      if (killsProcess && pid !== undefined) alive.delete(pid);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    if (verb === "start") {
      const pid = 70000 + active.size;
      active.set(unit, pid);
      alive.add(pid);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 1, stdout: "", stderr: `unknown systemctl ${String(verb)}` });
  };
  return { exec, calls, active, alive };
}

/** An in-memory {@link DaemonLocatorIO} over a { path: contents } map. */
function fakeIO(files: Record<string, string>, dirs: string[]): DaemonLocatorIO {
  return {
    exists: (p) => p in files || dirs.includes(p),
    listDir: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(dir + "/"))
        .map((p) => p.slice(dir.length + 1))
        .filter((rest) => !rest.includes("/")),
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
  };
}

/** A systemd `.service` unit body with a given ExecStart. */
function unit(execStart: string): string {
  return `[Unit]\nDescription=x\n[Service]\nExecStart=${execStart}\nRestart=always\n[Install]\nWantedBy=default.target\n`;
}

// Convenience: darwin targets from a slug list (label-by-convention).
function darwinTargets(slugs: string[]): ServiceTarget[] {
  return enumerateServiceTargets({
    platform: "darwin",
    launchAgentsDir: LAUNCH_DIR,
    configDir: CFG_DIR,
    discoverSlugs: () => slugs,
  });
}

// =============================================================================
// Enumeration — Linux discovers REAL units (A-UNIT), darwin stays by-convention
// =============================================================================

describe("migration gate — enumeration", () => {
  test("migration gate (linux) discovers REAL unit ids from ExecStart, not <label>.service", () => {
    const files = {
      // Real stack daemon — NON-conventional name, matched by --config.
      [`${SYSTEMD_DIR}/cortex-bot.service`]: unit(`/usr/bin/bun /opt/cortex/src/cortex.ts --config ${CFG_DIR}/meta-factory/meta-factory.yaml`),
      // Real relay — matched by the relay.ts entrypoint (no --config).
      [`${SYSTEMD_DIR}/cortex-relay.service`]: unit(`/usr/bin/bun /opt/cortex/src/taps/cc-events/relay.ts start`),
      // A non-cortex unit — must be ignored.
      [`${SYSTEMD_DIR}/postgresql.service`]: unit(`/usr/bin/postgres -D /var/lib/pg`),
    };
    const io = fakeIO(files, [SYSTEMD_DIR]);
    const targets = enumerateServiceTargets({
      platform: "linux",
      systemdUserDir: SYSTEMD_DIR,
      configDir: CFG_DIR,
      io,
    });
    const units = targets.map((t) => t.unit);

    expect(units).toContain("cortex-bot.service"); // the REAL name, discovered
    expect(units).toContain("cortex-relay.service");
    expect(units).not.toContain("ai.meta-factory.cortex.meta-factory.service"); // never derived
    expect(units).not.toContain("postgresql.service"); // non-cortex ignored
    expect(targets.find((t) => t.unit === "cortex-relay.service")?.kind).toBe("relay");
    expect(targets.find((t) => t.unit === "cortex-bot.service")?.kind).toBe("stack");
  });

  test("migration gate (linux) unions legacy units by-name only when the file exists", () => {
    const files = {
      [`${SYSTEMD_DIR}/com.grove.bot.service`]: unit(`/usr/bin/bun /opt/grove/bot.ts`),
    };
    const io = fakeIO(files, [SYSTEMD_DIR]);
    const targets = enumerateServiceTargets({
      platform: "linux",
      systemdUserDir: SYSTEMD_DIR,
      configDir: CFG_DIR,
      io,
    });
    const units = targets.map((t) => t.unit);
    // Present legacy file → unioned; absent legacy files → NOT enumerated.
    expect(units).toContain("com.grove.bot.service");
    expect(units).not.toContain("com.grove.relay.service");
  });

  test("migration gate (darwin) enumerates labels by convention + relay + legacy", () => {
    const targets = darwinTargets(["meta-factory", "work"]);
    const labels = targets.map((t) => t.label);
    expect(labels).toContain(`${CORTEX_LABEL_PREFIX}meta-factory`);
    expect(labels).toContain(RELAY_LABEL);
    expect(labels).toContain("com.grove.bot");
    expect(labels).toContain("com.grove.relay");
    expect(labels).toContain(`${CORTEX_LABEL_PREFIX}bot`);
  });
});

// =============================================================================
// A-UNIT — Linux queries the discovered unit, so a name mismatch can't fail-open
// =============================================================================

describe("migration gate — A-UNIT (right service)", () => {
  test("migration gate (linux) stops the DISCOVERED unit name, not a derived one", async () => {
    const files = {
      [`${SYSTEMD_DIR}/cortex-bot.service`]: unit(`/usr/bin/bun /opt/cortex/src/cortex.ts --config ${CFG_DIR}/meta-factory/meta-factory.yaml`),
    };
    const io = fakeIO(files, [SYSTEMD_DIR]);
    const targets = enumerateServiceTargets({ platform: "linux", systemdUserDir: SYSTEMD_DIR, configDir: CFG_DIR, io });

    const sd = makeSystemd({ active: { "cortex-bot.service": 4321 } });
    const res = await runMigrationGate({ platform: "linux", uid: 1000, env: envOver(sd.exec, sd.alive), targets, drain: FAST_DRAIN });

    expect(res.cleared).toBe(true);
    const stops = sd.calls.filter((c) => c[2] === "stop").map((c) => c[3]);
    expect(stops).toContain("cortex-bot.service"); // real unit — the fail-open fix
    expect(stops).not.toContain("ai.meta-factory.cortex.meta-factory.service");
  });
});

// =============================================================================
// A-ISACTIVE — manager-unreachable must read PRESENT (key on the stdout WORD)
// =============================================================================

describe("migration gate — A-ISACTIVE (manager-reached verdict)", () => {
  test("migration gate (linux) FAILS CLOSED when systemctl runs but can't reach the manager (non-zero + empty stdout)", async () => {
    const targets: ServiceTarget[] = [
      { id: "meta-factory", kind: "stack", label: "cortex-bot.service", unit: "cortex-bot.service", plistPath: `${SYSTEMD_DIR}/cortex-bot.service` },
    ];
    // is-active returns non-zero + EMPTY stdout — the D-Bus-unreachable signature.
    // An exit-code-keyed impl would wrongly treat this as "down".
    const sd = makeSystemd({
      active: { "cortex-bot.service": 555 },
      isActiveOverride: () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" }),
    });
    const res = await runMigrationGate({ platform: "linux", uid: 1000, env: envOver(sd.exec, sd.alive), targets, drain: FAST_DRAIN });

    expect(res.cleared).toBe(false);
    expect(res.stillPresent.map((t) => t.unit)).toEqual(["cortex-bot.service"]);
    expect(res.reason).toContain("fail-closed");
  });

  test("migration gate (linux) treats is-active 'unknown' as PRESENT (not a clean down word)", async () => {
    const targets: ServiceTarget[] = [
      { id: "s", kind: "stack", label: "cortex-bot.service", unit: "cortex-bot.service", plistPath: "" },
    ];
    const sd = makeSystemd({
      active: {},
      isActiveOverride: () => ({ code: 4, stdout: "unknown\n", stderr: "" }),
    });
    const res = await runMigrationGate({ platform: "linux", uid: 1000, env: envOver(sd.exec, sd.alive), targets, drain: FAST_DRAIN });
    expect(res.cleared).toBe(false);
  });

  test("migration gate (linux) 'activating' + non-zero exit is PRESENT (stdout-property lock)", async () => {
    // Correlated-fakes gap guard: an exit-code-keyed impl would pass this because
    // exit is non-zero, but the WORD says the unit is (re)starting → must be PRESENT.
    const targets: ServiceTarget[] = [
      { id: "s", kind: "stack", label: "cortex-bot.service", unit: "cortex-bot.service", plistPath: "" },
    ];
    const sd = makeSystemd({
      active: {},
      isActiveOverride: () => ({ code: 3, stdout: "activating\n", stderr: "" }),
    });
    const res = await runMigrationGate({ platform: "linux", uid: 1000, env: envOver(sd.exec, sd.alive), targets, drain: FAST_DRAIN });
    expect(res.cleared).toBe(false);
  });

  test("migration gate (linux) clears on a clean 'inactive' word + PID death", async () => {
    const targets: ServiceTarget[] = [
      { id: "s", kind: "stack", label: "cortex-bot.service", unit: "cortex-bot.service", plistPath: "" },
    ];
    const sd = makeSystemd({ active: { "cortex-bot.service": 999 } }); // stop → inactive + pid dies
    const res = await runMigrationGate({ platform: "linux", uid: 1000, env: envOver(sd.exec, sd.alive), targets, drain: FAST_DRAIN });
    expect(res.cleared).toBe(true);
  });
});

// =============================================================================
// A-TOCTOU — deregistration ≠ death; the PID must reach ESRCH
// =============================================================================

describe("migration gate — A-TOCTOU (confirmed process death)", () => {
  test("migration gate (darwin) does NOT clear while the booted-out PID is still draining", async () => {
    const targets = darwinTargets(["meta-factory"]);
    const stackLabel = `${CORTEX_LABEL_PREFIX}meta-factory`;
    // bootout deregisters (print goes non-zero) but the process LINGERS (drain).
    const ld = makeLaunchd({ loaded: { [stackLabel]: 4242, [RELAY_LABEL]: 4243, "com.grove.bot": 0 }, killsProcess: false });
    const res = await runMigrationGate({ platform: "darwin", uid: 501, env: envOver(ld.exec, ld.alive), targets, drain: FAST_DRAIN });

    expect(res.cleared).toBe(false); // print said gone, but kill(pid,0) still alive
    expect(res.stillPresent.map((t) => t.label)).toContain(stackLabel);
  });

  test("migration gate (darwin) clears once the PID reaches ESRCH after drain", async () => {
    const targets = darwinTargets(["meta-factory"]);
    const stackLabel = `${CORTEX_LABEL_PREFIX}meta-factory`;
    const ld = makeLaunchd({ loaded: { [stackLabel]: 4242, [RELAY_LABEL]: 4243 }, killsProcess: true });
    const res = await runMigrationGate({ platform: "darwin", uid: 501, env: envOver(ld.exec, ld.alive), targets, drain: FAST_DRAIN });
    expect(res.cleared).toBe(true);
  });

  test("migration gate (linux) requires PID death (from MainPID), not just is-active inactive", async () => {
    const targets: ServiceTarget[] = [
      { id: "s", kind: "stack", label: "cortex-bot.service", unit: "cortex-bot.service", plistPath: "" },
    ];
    // stop → is-active inactive, but the forked child LINGERS (KillMode=process).
    const sd = makeSystemd({ active: { "cortex-bot.service": 8080 }, killsProcess: false });
    const res = await runMigrationGate({ platform: "linux", uid: 1000, env: envOver(sd.exec, sd.alive), targets, drain: FAST_DRAIN });
    expect(res.cleared).toBe(false);
    expect(res.stillPresent.map((t) => t.unit)).toEqual(["cortex-bot.service"]);
  });
});

// =============================================================================
// A-RESTORE — withMigrationGate try/finally ALWAYS restores the pre-running set
// =============================================================================

describe("migration gate — A-RESTORE (finally-guaranteed restore)", () => {
  test("migration gate withMigrationGate runs the migration after clear and restores in finally", async () => {
    const stackLabel = `${CORTEX_LABEL_PREFIX}meta-factory`;
    const ld = makeLaunchd({ loaded: { [stackLabel]: 100, [RELAY_LABEL]: 101 } });
    let migrated = false;

    const run = await withMigrationGate(
      { platform: "darwin", uid: 501, env: envOver(ld.exec, ld.alive), launchAgentsDir: LAUNCH_DIR, configDir: CFG_DIR, discoverSlugs: () => ["meta-factory"], drain: FAST_DRAIN },
      () => {
        migrated = true;
        return Promise.resolve("moved");
      },
    );

    expect(run.cleared).toBe(true);
    expect(migrated).toBe(true);
    expect(run.result).toBe("moved");
    // Fleet is back up after the (successful) migration — nothing stranded.
    expect(ld.loaded.has(stackLabel)).toBe(true);
    expect(ld.loaded.has(RELAY_LABEL)).toBe(true);
    expect(run.restore.failed).toHaveLength(0);
  });

  test("migration gate withMigrationGate restores the fleet even when the migration THROWS", async () => {
    const stackLabel = `${CORTEX_LABEL_PREFIX}meta-factory`;
    const ld = makeLaunchd({ loaded: { [stackLabel]: 100, [RELAY_LABEL]: 101 } });

    let threw = false;
    try {
      await withMigrationGate(
        { platform: "darwin", uid: 501, env: envOver(ld.exec, ld.alive), launchAgentsDir: LAUNCH_DIR, configDir: CFG_DIR, discoverSlugs: () => ["meta-factory"], drain: FAST_DRAIN },
        () => {
          throw new Error("state move failed midway");
        },
      );
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("state move failed");
    }

    expect(threw).toBe(true);
    // The finally restored the fleet despite the throw — the G-36 guarantee.
    expect(ld.loaded.has(stackLabel)).toBe(true);
    expect(ld.loaded.has(RELAY_LABEL)).toBe(true);
  });

  test("migration gate withMigrationGate does NOT run the migration when the gate refuses", async () => {
    const stackLabel = `${CORTEX_LABEL_PREFIX}meta-factory`;
    // Draining PID → gate refuses to clear.
    const ld = makeLaunchd({ loaded: { [stackLabel]: 100, [RELAY_LABEL]: 101 }, killsProcess: false });
    let migrated = false;

    const run = await withMigrationGate(
      { platform: "darwin", uid: 501, env: envOver(ld.exec, ld.alive), launchAgentsDir: LAUNCH_DIR, configDir: CFG_DIR, discoverSlugs: () => ["meta-factory"], drain: FAST_DRAIN },
      () => {
        migrated = true;
        return Promise.resolve("nope");
      },
    );

    expect(run.cleared).toBe(false);
    expect(migrated).toBe(false); // migration NEVER ran under a red gate
    // The pre-running set the gate stopped was restored.
    expect(ld.loaded.has(stackLabel)).toBe(true);
  });
});

// =============================================================================
// Empty-target guard + restore mechanics
// =============================================================================

describe("migration gate — guards + restore mechanics", () => {
  test("migration gate refuses an EMPTY target set (fail-closed, not a vacuous clear)", async () => {
    const ld = makeLaunchd({ loaded: {} });
    let threw = false;
    let msg = "";
    try {
      await runMigrationGate({ platform: "darwin", uid: 501, env: envOver(ld.exec, ld.alive), targets: [], drain: FAST_DRAIN });
    } catch (err) {
      threw = true;
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(threw).toBe(true);
    expect(msg).toContain("EMPTY target set");
  });

  test("migration gate restore re-bootstraps ONLY the pre-running set (symmetry)", async () => {
    const targets = darwinTargets(["meta-factory", "work"]);
    const up = `${CORTEX_LABEL_PREFIX}meta-factory`;
    const ld = makeLaunchd({ loaded: { [up]: 200, [RELAY_LABEL]: 201 } }); // 'work' is down
    const res = await runMigrationGate({ platform: "darwin", uid: 501, env: envOver(ld.exec, ld.alive), targets, drain: FAST_DRAIN });
    expect(res.cleared).toBe(true);
    expect(res.running.map((t) => t.label).sort()).toEqual([RELAY_LABEL, up].sort());

    const restore = await res.restore();
    expect(restore.failed).toHaveLength(0);
    expect(ld.loaded.has(up)).toBe(true);
    expect(ld.loaded.has(RELAY_LABEL)).toBe(true);
    expect(ld.loaded.has(`${CORTEX_LABEL_PREFIX}work`)).toBe(false); // was down → stays down
  });

  test("migration gate restore reports failure when a daemon refuses to come back", async () => {
    const targets = darwinTargets(["meta-factory"]);
    const label = `${CORTEX_LABEL_PREFIX}meta-factory`;
    const alive = new Set<number>([300]);
    const loaded = new Map<string, number>([[label, 300]]);
    const exec: GateExec = (argv) => {
      const sub = argv[1];
      const lbl = (argv[2] ?? "").split("/").pop() ?? "";
      if (sub === "print") {
        const pid = loaded.get(lbl);
        return Promise.resolve(pid !== undefined ? { code: 0, stdout: `pid = ${pid.toString()}`, stderr: "" } : { code: 113, stdout: "", stderr: "" });
      }
      if (sub === "bootout") { const pid = loaded.get(lbl); loaded.delete(lbl); if (pid !== undefined) alive.delete(pid); return Promise.resolve({ code: 0, stdout: "", stderr: "" }); }
      if (sub === "bootstrap") return Promise.resolve({ code: 5, stdout: "", stderr: "Input/output error" }); // never re-loads
      if (sub === "kickstart") return Promise.resolve({ code: 3, stdout: "", stderr: "" });
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };
    const res = await runMigrationGate({ platform: "darwin", uid: 501, env: envOver(exec, alive), targets, drain: FAST_DRAIN });
    expect(res.cleared).toBe(true);

    const restore = await res.restore();
    expect(restore.restored).toHaveLength(0);
    expect(restore.failed.map((f) => f.id)).toContain("meta-factory");
  });
});

// =============================================================================
// Pidfile-liveness belt — the DEAD claim holds even for hand-started daemons
// =============================================================================

describe("migration gate — pidfile-liveness belt (out-of-model daemons)", () => {
  const HAND_CFG = `${CFG_DIR}/meta-factory/meta-factory.yaml`;
  const HAND_PID_PATH = "/state/cortex-meta-factory-abc12345.pid";

  test("migration gate belt REFUSES when a hand-started stack has a LIVE pidfile and NO service unit", async () => {
    const targets = darwinTargets(["meta-factory"]);
    // Every service target is up and cleanly killed by the gate...
    const stackLabel = `${CORTEX_LABEL_PREFIX}meta-factory`;
    const ld = makeLaunchd({ loaded: { [stackLabel]: 500, [RELAY_LABEL]: 501 }, killsProcess: true });
    // ...but a hand-started daemon (pid 9999) runs with NO unit/label — never killed.
    ld.alive.add(9999);
    const env = envOver(ld.exec, ld.alive);

    const res = await runMigrationGate({
      platform: "darwin",
      uid: 501,
      env,
      targets,
      drain: FAST_DRAIN,
      belt: {
        stackConfigPaths: [HAND_CFG],
        pidFilePathFor: () => HAND_PID_PATH,
        readPidFile: (p) => (p === HAND_PID_PATH ? 9999 : undefined),
      },
    });

    expect(res.stillPresent).toHaveLength(0); // all service targets proven dead
    expect(res.cleared).toBe(false); // ...yet the gate refuses — the belt caught it
    expect(res.livePidfiles.map((l) => l.pid)).toEqual([9999]);
    expect(res.reason).toContain("LIVE pidfile");
  });

  test("migration gate belt does NOT false-refuse a unit-managed daemon it just killed", async () => {
    const targets = darwinTargets(["meta-factory"]);
    const stackLabel = `${CORTEX_LABEL_PREFIX}meta-factory`;
    // The stack's pidfile holds pid 500 — the SAME process the unit runs. The gate
    // kills 500 via bootout; the belt (run AFTER the stop) must see it dead.
    const ld = makeLaunchd({ loaded: { [stackLabel]: 500, [RELAY_LABEL]: 501 }, killsProcess: true });
    const env = envOver(ld.exec, ld.alive);

    const res = await runMigrationGate({
      platform: "darwin",
      uid: 501,
      env,
      targets,
      drain: FAST_DRAIN,
      belt: {
        stackConfigPaths: [HAND_CFG],
        pidFilePathFor: () => HAND_PID_PATH,
        readPidFile: () => 500, // same pid the gate just killed
      },
    });

    expect(res.livePidfiles).toHaveLength(0); // 500 is dead post-stop → no false refusal
    expect(res.cleared).toBe(true);
  });

  test("migration gate belt clears when every pidfile is dead + service is down", async () => {
    const targets = darwinTargets(["meta-factory"]);
    const ld = makeLaunchd({ loaded: {} }); // nothing loaded → service side trivially clear
    const env = envOver(ld.exec, ld.alive);

    const res = await runMigrationGate({
      platform: "darwin",
      uid: 501,
      env,
      targets,
      drain: FAST_DRAIN,
      belt: {
        stackConfigPaths: [HAND_CFG],
        pidFilePathFor: () => HAND_PID_PATH,
        readPidFile: () => 4242, // pid exists in the file but is NOT alive (not in `alive`)
      },
    });

    expect(res.cleared).toBe(true);
    expect(res.livePidfiles).toHaveLength(0);
  });

  test("migration gate belt refuses an EMPTY target set when a live pidfile exists (not a throw)", async () => {
    const alive = new Set<number>([7777]);
    const noop: GateExec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const res = await runMigrationGate({
      platform: "linux",
      uid: 1000,
      env: envOver(noop, alive),
      targets: [],
      drain: FAST_DRAIN,
      belt: {
        stackConfigPaths: [HAND_CFG],
        pidFilePathFor: () => HAND_PID_PATH,
        readPidFile: () => 7777,
      },
    });
    expect(res.cleared).toBe(false);
    expect(res.livePidfiles.map((l) => l.pid)).toEqual([7777]);
  });

  test("migration gate belt reuses pidFileFor semantics: '(default)' cortex.pid is checked too", async () => {
    // No expected stacks, but the single-instance default daemon (cortex.pid) is live.
    const alive = new Set<number>([333]);
    const noop: GateExec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const targets = darwinTargets([]); // relay + legacy only
    const res = await runMigrationGate({
      platform: "darwin",
      uid: 501,
      env: envOver(noop, alive),
      targets,
      drain: FAST_DRAIN,
      belt: {
        stackConfigPaths: [], // no stacks
        pidFilePathFor: (cfg) => (cfg === undefined ? "/state/cortex.pid" : `/state/${cfg}.pid`),
        readPidFile: (p) => (p === "/state/cortex.pid" ? 333 : undefined),
      },
    });
    expect(res.cleared).toBe(false);
    expect(res.livePidfiles[0]?.configPath).toBe("(default)");
  });
});

// =============================================================================
// XDG — the systemd user dir honours $XDG_CONFIG_HOME (G-38)
// =============================================================================

describe("migration gate — XDG systemd dir", () => {
  test("migration gate (linux) discovery honours $XDG_CONFIG_HOME for the systemd user dir", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/xdg";
    try {
      const files = {
        [`/xdg/systemd/user/cortex-bot.service`]: unit(`/usr/bin/bun /opt/cortex/src/cortex.ts --config ${CFG_DIR}/meta-factory/meta-factory.yaml`),
      };
      const io = fakeIO(files, ["/xdg/systemd/user"]);
      // NOTE: systemdUserDir intentionally omitted → default must resolve under $XDG_CONFIG_HOME.
      const targets = enumerateServiceTargets({ platform: "linux", configDir: CFG_DIR, io });
      expect(targets.map((t) => t.unit)).toContain("cortex-bot.service");
      expect(targets.find((t) => t.unit === "cortex-bot.service")?.plistPath).toBe("/xdg/systemd/user/cortex-bot.service");
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});
