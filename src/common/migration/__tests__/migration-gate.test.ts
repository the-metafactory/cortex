/**
 * cortex#1901 — migration gate tests (XDG epic #1867, P3c).
 *
 * The gate proves a stack fleet is stopped before a config/state move, using the
 * SERVICE MANAGER as the oracle (never a pidfile). Every launchctl/systemctl call
 * is faked via an injected {@link GateExec}, so the darwin AND linux paths run on
 * any POSIX CI host (cortex CI is ubuntu) with no real launchd/systemd.
 *
 * The fakes model the two properties that make this issue exist:
 *   - a launchd job stays loaded (`print` → 0) until `bootout`, and a "stubborn"
 *     job models KeepAlive/TOCTOU — it stays loaded even after a bootout attempt,
 *     which the gate MUST catch via its post-stop verify and refuse to clear;
 *   - a systemd unit stays `active` until `stop`, and `is-active` is the oracle.
 *
 * Test/describe names all contain "migration gate" so the epic's
 * `bun test … -t "migration gate"` selector picks them up.
 */

import { describe, test, expect } from "bun:test";

import {
  enumerateServiceTargets,
  runMigrationGate,
  CORTEX_LABEL_PREFIX,
  RELAY_LABEL,
  LEGACY_LABELS,
  type GateExec,
  type ServiceTarget,
} from "../migration-gate";

// =============================================================================
// Fakes — in-memory launchd + systemd that capture every argv
// =============================================================================

const LAUNCH_DIR = "/tmp/x1901-LaunchAgents";

/** Build the gate's target set from a slug list without touching the filesystem. */
function targetsFor(slugs: string[]): ServiceTarget[] {
  return enumerateServiceTargets({
    launchAgentsDir: LAUNCH_DIR,
    configDir: "/unused",
    discoverSlugs: () => slugs,
  });
}

/** launchd fake. `loaded` = jobs currently in the domain; `stubborn` = jobs a
 *  bootout can NOT unload (models KeepAlive / a supervisor respawn / TOCTOU). */
function makeLaunchd(init?: { loaded?: string[]; stubborn?: string[] }): {
  exec: GateExec;
  calls: string[][];
  loaded: Set<string>;
} {
  const loaded = new Set(init?.loaded ?? []);
  const stubborn = new Set(init?.stubborn ?? []);
  const calls: string[][] = [];
  const labelOf = (target: string): string => target.split("/").pop() ?? "";
  const exec: GateExec = (argv) => {
    calls.push(argv);
    const sub = argv[1];
    if (argv[0] !== "launchctl") throw new Error(`unexpected cmd ${String(argv[0])}`);
    if (sub === "print") {
      const label = labelOf(argv[2] ?? "");
      return Promise.resolve(
        loaded.has(label)
          ? { code: 0, stdout: `${label} = { state = running }`, stderr: "" }
          : { code: 113, stdout: "", stderr: "Could not find service" },
      );
    }
    if (sub === "bootout") {
      const label = labelOf(argv[2] ?? "");
      const was = loaded.has(label);
      if (!stubborn.has(label)) loaded.delete(label);
      return Promise.resolve({ code: was ? 0 : 3, stdout: "", stderr: "" });
    }
    if (sub === "bootstrap") {
      // launchctl bootstrap gui/<uid> <plistPath>
      const label = (argv[3] ?? "").split("/").pop()?.replace(/\.plist$/, "") ?? "";
      loaded.add(label);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    if (sub === "kickstart") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    return Promise.resolve({ code: 1, stdout: "", stderr: `unknown launchctl ${String(sub)}` });
  };
  return { exec, calls, loaded };
}

/** systemd fake. `active` = units currently up; `stubborn` = units `stop` can NOT
 *  bring down (models Restart=always defeating a naive stop). */
function makeSystemd(init?: { active?: string[]; stubborn?: string[] }): {
  exec: GateExec;
  calls: string[][];
  active: Set<string>;
} {
  const active = new Set(init?.active ?? []);
  const stubborn = new Set(init?.stubborn ?? []);
  const calls: string[][] = [];
  const exec: GateExec = (argv) => {
    calls.push(argv);
    // systemctl --user <verb> <unit>
    const verb = argv[2];
    const unit = argv[3] ?? "";
    if (verb === "is-active") {
      return Promise.resolve(
        active.has(unit)
          ? { code: 0, stdout: "active\n", stderr: "" }
          : { code: 3, stdout: "inactive\n", stderr: "" },
      );
    }
    if (verb === "stop") {
      if (!stubborn.has(unit)) active.delete(unit);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    if (verb === "start") {
      active.add(unit);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    return Promise.resolve({ code: 1, stdout: "", stderr: `unknown systemctl ${String(verb)}` });
  };
  return { exec, calls, active };
}

/** An exec that always throws — models the service-manager binary being absent
 *  (ENOENT). The gate must FAIL CLOSED against this. */
const throwingExec: GateExec = () => {
  throw new Error("spawn systemctl ENOENT");
};

// =============================================================================
// Enumeration
// =============================================================================

describe("migration gate — enumeration (slugs + relay + legacy)", () => {
  test("migration gate enumerates every stack slug, the relay, and the legacy labels", () => {
    const targets = targetsFor(["meta-factory", "work"]);
    const labels = targets.map((t) => t.label);

    expect(labels).toContain(`${CORTEX_LABEL_PREFIX}meta-factory`);
    expect(labels).toContain(`${CORTEX_LABEL_PREFIX}work`);
    expect(labels).toContain(RELAY_LABEL);
    for (const legacy of LEGACY_LABELS) expect(labels).toContain(legacy);
    // com.grove.* legacy set is present (G-35).
    expect(labels).toContain("com.grove.bot");
    expect(labels).toContain("com.grove.relay");

    // Each target carries both platform identities + a bootstrap path.
    const relay = targets.find((t) => t.label === RELAY_LABEL)!;
    expect(relay.unit).toBe(`${RELAY_LABEL}.service`);
    expect(relay.plistPath).toBe(`${LAUNCH_DIR}/${RELAY_LABEL}.plist`);
    expect(relay.kind).toBe("relay");
  });

  test("migration gate dedupes a stack slug colliding with relay/bot", () => {
    const targets = targetsFor(["relay", "bot"]);
    const labels = targets.map((t) => t.label);
    const relayCount = labels.filter((l) => l === RELAY_LABEL).length;
    const botCount = labels.filter((l) => l === `${CORTEX_LABEL_PREFIX}bot`).length;
    expect(relayCount).toBe(1);
    expect(botCount).toBe(1);
  });
});

// =============================================================================
// macOS — clear vs block, oracle is the service manager
// =============================================================================

describe("migration gate — darwin oracle (launchctl bootout, not pidfile)", () => {
  test("migration gate (darwin) clears only after bootout of every slug + relay", async () => {
    const targets = targetsFor(["meta-factory", "work"]);
    const ld = makeLaunchd({ loaded: targets.map((t) => t.label) });

    const res = await runMigrationGate({ platform: "darwin", uid: 501, exec: ld.exec, targets });

    expect(res.cleared).toBe(true);
    expect(res.stillPresent).toHaveLength(0);
    // Every stack label + relay + legacy was booted out.
    const bootouts = ld.calls.filter((c) => c[1] === "bootout").map((c) => c[2]);
    for (const t of targets) expect(bootouts).toContain(`gui/501/${t.label}`);
    // Oracle is the service manager — every call is launchctl, nothing filesystem.
    expect(ld.calls.every((c) => c[0] === "launchctl")).toBe(true);
    // Verification uses `print` (never a pidfile check).
    expect(ld.calls.some((c) => c[1] === "print")).toBe(true);
  });

  test("migration gate (darwin) BLOCKS while a KeepAlive daemon stays loaded (pidfile absent is irrelevant)", async () => {
    const targets = targetsFor(["meta-factory", "work"]);
    const stubborn = `${CORTEX_LABEL_PREFIX}work`; // KeepAlive: bootout can't unload it
    const ld = makeLaunchd({ loaded: targets.map((t) => t.label), stubborn: [stubborn] });

    const res = await runMigrationGate({ platform: "darwin", uid: 501, exec: ld.exec, targets });

    expect(res.cleared).toBe(false);
    expect(res.stillPresent.map((t) => t.label)).toEqual([stubborn]);
    expect(res.reason).toContain("fail-closed");
    expect(res.reason).toContain(stubborn);
    // The gate DID try to bootout it — the daemon simply survived, so the gate
    // (correctly) refuses to clear rather than trusting the stop succeeded.
    expect(ld.calls.some((c) => c[1] === "bootout" && c[2] === `gui/501/${stubborn}`)).toBe(true);
  });

  test("migration gate (darwin) clears when nothing is loaded (bootout is idempotent)", async () => {
    const targets = targetsFor(["meta-factory"]);
    const ld = makeLaunchd({ loaded: [] });

    const res = await runMigrationGate({ platform: "darwin", uid: 501, exec: ld.exec, targets });

    expect(res.cleared).toBe(true);
    expect(res.running).toHaveLength(0); // nothing was up → nothing to restore
  });
});

// =============================================================================
// Linux — REQUIRED path + FAIL-CLOSED (G-08). Runs on ubuntu CI via fakes.
// =============================================================================

describe("migration gate — linux oracle (systemctl stop + is-active)", () => {
  test("migration gate (linux) stops via systemctl and clears when is-active reports inactive", async () => {
    const targets = targetsFor(["meta-factory", "work"]);
    const sd = makeSystemd({ active: targets.map((t) => t.unit) });

    const res = await runMigrationGate({ platform: "linux", uid: 1000, exec: sd.exec, targets });

    expect(res.cleared).toBe(true);
    const stops = sd.calls.filter((c) => c[2] === "stop").map((c) => c[3]);
    for (const t of targets) expect(stops).toContain(t.unit);
    // Oracle is `systemctl --user is-active`, never launchctl or a pidfile.
    expect(sd.calls.every((c) => c[0] === "systemctl" && c[1] === "--user")).toBe(true);
    expect(sd.calls.some((c) => c[2] === "is-active")).toBe(true);
  });

  test("migration gate (linux) FAILS CLOSED when systemctl is unavailable (exec throws)", async () => {
    const targets = targetsFor(["meta-factory"]);

    const res = await runMigrationGate({ platform: "linux", uid: 1000, exec: throwingExec, targets });

    // Cannot prove anything down → must refuse to clear (never silently pass).
    expect(res.cleared).toBe(false);
    expect(res.stillPresent).toHaveLength(targets.length);
    expect(res.reason).toContain("fail-closed");
    // Pre-check also couldn't prove absence, so the whole set is the restore set.
    expect(res.running).toHaveLength(targets.length);
  });

  test("migration gate (linux) BLOCKS while a Restart=always unit stays active after stop", async () => {
    const targets = targetsFor(["meta-factory", "work"]);
    const stubborn = targets[0]!.unit; // stop can't bring it down
    const sd = makeSystemd({ active: targets.map((t) => t.unit), stubborn: [stubborn] });

    const res = await runMigrationGate({ platform: "linux", uid: 1000, exec: sd.exec, targets });

    expect(res.cleared).toBe(false);
    expect(res.stillPresent.map((t) => t.unit)).toEqual([stubborn]);
  });
});

// =============================================================================
// Restore-on-failure (G-36) — bootout is persistent; an abort must bring the fleet back
// =============================================================================

describe("migration gate — restore-on-failure (G-36)", () => {
  test("migration gate restore brings daemons back after a mid-migration failure (darwin)", async () => {
    const targets = targetsFor(["meta-factory", "work"]);
    const originallyUp = targets.map((t) => t.label);
    const ld = makeLaunchd({ loaded: [...originallyUp] });

    const res = await runMigrationGate({ platform: "darwin", uid: 501, exec: ld.exec, targets });
    expect(res.cleared).toBe(true);
    // After the gate, the whole fleet is DOWN (bootout is persistent).
    expect(ld.loaded.size).toBe(0);

    // Caller starts the migration and it THROWS midway — the restore contract.
    let restoreResult;
    try {
      throw new Error("state move failed midway");
    } catch {
      restoreResult = await res.restore();
    }

    // Every daemon that was up is loaded again — symmetry preserved.
    expect(restoreResult.failed).toHaveLength(0);
    expect(restoreResult.restored.sort()).toEqual([...targets.map((t) => t.id)].sort());
    for (const label of originallyUp) expect(ld.loaded.has(label)).toBe(true);
  });

  test("migration gate restore re-bootstraps ONLY the pre-running set (symmetry)", async () => {
    const targets = targetsFor(["meta-factory", "work"]);
    const upLabel = `${CORTEX_LABEL_PREFIX}meta-factory`; // only this one is up
    const ld = makeLaunchd({ loaded: [upLabel] });

    const res = await runMigrationGate({ platform: "darwin", uid: 501, exec: ld.exec, targets });
    expect(res.cleared).toBe(true);
    expect(res.running.map((t) => t.label)).toEqual([upLabel]);

    const restoreResult = await res.restore();

    // Only the pre-running stack is brought back; the one that was already down
    // is NOT started (nothing that was down is started).
    expect(ld.loaded.has(upLabel)).toBe(true);
    expect(ld.loaded.has(`${CORTEX_LABEL_PREFIX}work`)).toBe(false);
    expect(restoreResult.restored).toEqual([targets.find((t) => t.label === upLabel)!.id]);
    // bootstrap targeted the correct plist path.
    const bootstraps = ld.calls.filter((c) => c[1] === "bootstrap").map((c) => c[3]);
    expect(bootstraps).toContain(`${LAUNCH_DIR}/${upLabel}.plist`);
  });

  test("migration gate restore restarts the pre-running linux set via systemctl start", async () => {
    const targets = targetsFor(["meta-factory"]);
    const sd = makeSystemd({ active: targets.map((t) => t.unit) });

    const res = await runMigrationGate({ platform: "linux", uid: 1000, exec: sd.exec, targets });
    expect(res.cleared).toBe(true);

    const restoreResult = await res.restore();
    expect(restoreResult.failed).toHaveLength(0);
    expect(restoreResult.restored).toEqual(targets.map((t) => t.id));
    for (const t of targets) expect(sd.active.has(t.unit)).toBe(true);
    // restore used `systemctl --user start` + verified with `is-active`.
    expect(sd.calls.some((c) => c[2] === "start")).toBe(true);
  });

  test("migration gate restore reports failure when a daemon refuses to come back (darwin)", async () => {
    const targets = targetsFor(["meta-factory"]);
    const label = `${CORTEX_LABEL_PREFIX}meta-factory`;
    // Custom exec: bootout works, but bootstrap does NOT re-load (print stays non-zero).
    const calls: string[][] = [];
    const loaded = new Set([label]);
    const exec: GateExec = (argv) => {
      calls.push(argv);
      const sub = argv[1];
      const lbl = (argv[2] ?? "").split("/").pop() ?? "";
      if (sub === "print") return Promise.resolve(loaded.has(lbl) ? { code: 0, stdout: "running", stderr: "" } : { code: 113, stdout: "", stderr: "" });
      if (sub === "bootout") { loaded.delete(lbl); return Promise.resolve({ code: 0, stdout: "", stderr: "" }); }
      if (sub === "bootstrap") return Promise.resolve({ code: 5, stdout: "", stderr: "Input/output error" }); // fails to load
      if (sub === "kickstart") return Promise.resolve({ code: 3, stdout: "", stderr: "" });
      return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    };

    const res = await runMigrationGate({ platform: "darwin", uid: 501, exec, targets });
    expect(res.cleared).toBe(true);

    const restoreResult = await res.restore();
    // The restore is HONEST about not bringing it back — a caller can escalate.
    expect(restoreResult.restored).toHaveLength(0);
    expect(restoreResult.failed).toHaveLength(1);
    expect(restoreResult.failed[0]!.id).toBe(targets[0]!.id);
  });
});
