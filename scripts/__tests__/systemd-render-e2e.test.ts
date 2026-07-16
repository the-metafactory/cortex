// Real end-to-end coverage for scripts/lib/systemd-render.sh against an
// ACTUAL systemd --user session: render → enable --now nats@/cortex@ → is-
// active → the restart-on-upgrade path (cortex#2071 executor addendum's
// verification recipe). This is deliberately split out of
// systemd-render.test.ts (which is fully mocked and safe to run anywhere) —
// this file drives the real `systemctl --user` against the real inherited
// $HOME, because the running systemd user MANAGER resolves its unit search
// path from ITS OWN startup environment, not from whatever $HOME this test
// process exports — so a scratch-HOME trick (as the mocked suite uses)
// cannot isolate this test the way it isolates that one.
//
// Runs ONLY in the dedicated `systemd-e2e` CI job (cortex#2092, dbus/
// XDG_RUNTIME_DIR bootstrap), gated on an explicit `SYSTEMD_E2E=1` opt-in env
// var that ONLY that job's test step sets (.github/workflows/ci.yml) — NOT on
// "CI=true" (GitHub Actions sets that in EVERY job, including the plain Test
// job, which has no systemd-user session bootstrap but — on a GitHub-hosted
// Ubuntu runner — still satisfies a bare "is there a systemd-user bus"
// probe, so that check alone let this test leak into the wrong job) and NOT
// on "Linux + a live systemd-user session" alone, which would also match a
// real developer's Linux desktop, where blindly stubbing ~/.local/bin/cortex,
// enabling/disabling units, or touching an existing nats@.service/
// cortex@.service could clobber a REAL install. Test name and describe block
// both carry "systemd-e2e" so the CI job's `--test-name-pattern systemd-e2e`
// picks this up.
//
// Every mutation this test makes to the real $HOME (stub binaries, unit
// files, the workspace dir) is backed up before and restored in `finally` —
// on the off chance this ever ran on a box with a genuine install present
// (it shouldn't, given the gate above), it must not orphan a live stack.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LIB = join(REPO_ROOT, "scripts", "lib", "systemd-render.sh");

function sh(cmd: string, args: string[]) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

function hasSystemdUserSession(): boolean {
  if (process.platform !== "linux") return false;
  const probe = sh("systemctl", ["--user", "show-environment"]);
  return probe.status === 0;
}

// Opt-in gate (see file header) — deliberately an explicit env var the CI job
// sets on its OWN test step, not a general "looks like CI" or "looks like
// Linux with systemd" signal. Either of those leaked this test into the plain
// Test job in practice (cortex#2103 review).
const RUN_E2E = process.env.SYSTEMD_E2E === "1" && hasSystemdUserSession();

const SLUG = "e2e2071";
const HOME_DIR = homedir();
const UNIT_DIR = join(HOME_DIR, ".config", "systemd", "user");
const LOCAL_BIN = join(HOME_DIR, ".local", "bin");
const WORKSPACE_DIR = join(HOME_DIR, ".local", "share", "metafactory", "cortex", SLUG);
const NATS_LOGS_DIR = join(HOME_DIR, ".local", "state", "nats", "logs");
const CORTEX_LOGS_DIR = join(HOME_DIR, ".local", "state", "metafactory", "cortex", "logs");

// Captures `systemctl --user status` + the tail of `journalctl --user` for a
// unit so a future CI failure explains itself instead of just reporting "not
// active" — this is exactly the diagnostic gap that made the cortex#2103
// review round-trip necessary; verified against a real systemd user session
// that this is enough to see the actual failing ExecStartPre/exec (e.g.
// `code=exited, status=200/CHDIR` or `status=209/STDOUT`).
function diagnose(unit: string): string {
  const status = sh("systemctl", ["--user", "status", unit, "--no-pager", "-l"]);
  const journal = sh("journalctl", ["--user", "-u", unit, "--no-pager"]);
  const journalTail = journal.stdout.trim().split("\n").slice(-20).join("\n");
  return (
    `--- systemctl --user status ${unit} --no-pager -l ---\n${status.stdout}${status.stderr}\n` +
    `--- journalctl --user -u ${unit} --no-pager | tail -20 ---\n${journalTail}\n${journal.stderr}`
  );
}

// Backs up path (rename aside) if it already exists, returning a restore
// function. Used for every real-$HOME path this test touches (stub
// binaries AND the unit files — PR#2103 review finding: only the binaries
// were backed up in the previous round, the unit files were unconditionally
// overwritten/removed) so a pre-existing file is never lost, and only files
// this test itself created get deleted in cleanup.
function backup(path: string): () => void {
  if (!existsSync(path)) {
    return () => rmSync(path, { force: true, recursive: true });
  }
  const savedAt = `${path}.systemd-e2e-backup`;
  renameSync(path, savedAt);
  return () => {
    rmSync(path, { force: true, recursive: true });
    renameSync(savedAt, path);
  };
}

describe("systemd-e2e: real render + enable + restart (cortex#2071)", () => {
  test.skipIf(!RUN_E2E)("render → enable --now nats@/cortex@ → is-active → restart-on-upgrade", () => {
    mkdirSync(LOCAL_BIN, { recursive: true });
    mkdirSync(UNIT_DIR, { recursive: true });

    const restoreFns: Array<() => void> = [];
    // Unit files first (mirrors render_cortex_systemd_units writing them),
    // then the stub binaries, then the workspace dir — order doesn't matter
    // for correctness, but restoring in reverse in `finally` undoes them
    // cleanly regardless.
    restoreFns.push(backup(join(UNIT_DIR, "nats@.service")));
    restoreFns.push(backup(join(UNIT_DIR, "cortex@.service")));
    restoreFns.push(backup(WORKSPACE_DIR));

    // Stub nats-server/cortex — a real long-running Type=simple process that
    // ignores its args, so `systemctl --user enable --now` has something
    // real to mark active without needing an actual NATS server or a linked
    // cortex CLI on the bare CI runner. `sleep infinity` (not a bounded
    // duration) so it can never exit on its own during the test.
    for (const name of ["nats-server", "cortex"]) {
      const p = join(LOCAL_BIN, name);
      restoreFns.push(backup(p));
      writeFileSync(p, "#!/bin/sh\nexec sleep infinity\n");
      chmodSync(p, 0o755);
    }

    // Config-dir fixture (created BEFORE render, not after) so render_cortex_
    // systemd_units' ensure_stack_workspace_dirs sees this slug and creates
    // the workspace dir before cortex@ is ever enabled.
    const configDir = mkdtempSync(join(tmpdir(), "cortex-systemd-e2e-config-"));
    mkdirSync(join(configDir, SLUG, "system"), { recursive: true });
    writeFileSync(join(configDir, SLUG, `${SLUG}.yaml`), "");
    writeFileSync(join(configDir, SLUG, "system", "system.yaml"), "");

    // Deliberately NOT pre-creating the nats log dir or the workspace dir
    // here — render_cortex_systemd_units (ensure_stack_log_dirs +
    // ensure_stack_workspace_dirs) must create both itself. Asserting that
    // below is the actual regression test for the PR#2103 review BLOCKER 1
    // fix (a fresh host with neither pre-created used to fail
    // EXIT_STDOUT/EXIT_CHDIR before this fix).
    //
    // The CORTEX log dir is the one exception: ensure_stack_log_dirs
    // deliberately does NOT create it (see its docstring — that's
    // postinstall.sh's §1b state-bootstrap's authority alone, gated by the
    // XDG wave-5 migration, cortex#1903; a second PR#2103 review round found
    // the renderer creating it anyway broke that invariant in CI's plain Test
    // job). This test drives render_cortex_systemd_units in isolation,
    // without postinstall.sh's §1b ever running, so — exactly like a real
    // arc-managed flow, where §1b already ran before anyone gets to enabling
    // a unit — it has to create this one prerequisite itself.
    //
    // Neither log dir is in restoreFns: they're host-wide permanent
    // infrastructure (same class as ~/.claude/events — created once, kept
    // forever), not slug/test-scoped state, so leaving them behind after this
    // test matches what a real install would do too. Only the workspace dir
    // (slug-scoped) and the unit/binary files this test wrote are unwound.
    mkdirSync(CORTEX_LOGS_DIR, { recursive: true });

    try {
      // 1. Render the real checked-in templates into the real unit dir,
      //    passing the config-dir fixture so the workspace + log dirs get
      //    created deterministically (not relying on test setup order).
      const render = sh("bash", ["-c", `source "${LIB}" && render_cortex_systemd_units "${REPO_ROOT}" "${UNIT_DIR}" "${configDir}"`]);
      if (render.status !== 0) throw new Error(`render_cortex_systemd_units failed:\n${render.stdout}${render.stderr}`);
      expect(existsSync(join(UNIT_DIR, "nats@.service"))).toBe(true);
      expect(existsSync(join(UNIT_DIR, "cortex@.service"))).toBe(true);
      expect(existsSync(join(WORKSPACE_DIR, "workspace"))).toBe(true);
      expect(existsSync(NATS_LOGS_DIR)).toBe(true);
      expect(existsSync(CORTEX_LOGS_DIR)).toBe(true);

      // 2. Enable + start both instances for the e2e slug.
      const enableNats = sh("systemctl", ["--user", "enable", "--now", `nats@${SLUG}`]);
      if (enableNats.status !== 0) throw new Error(`enable nats@${SLUG} failed:\n${enableNats.stdout}${enableNats.stderr}\n${diagnose(`nats@${SLUG}`)}`);
      const enableCortex = sh("systemctl", ["--user", "enable", "--now", `cortex@${SLUG}`]);
      if (enableCortex.status !== 0) throw new Error(`enable cortex@${SLUG} failed:\n${enableCortex.stdout}${enableCortex.stderr}\n${diagnose(`cortex@${SLUG}`)}`);

      // 3. is-active.
      const activeNats = sh("systemctl", ["--user", "is-active", "--quiet", `nats@${SLUG}`]);
      if (activeNats.status !== 0) throw new Error(`nats@${SLUG} is not active:\n${diagnose(`nats@${SLUG}`)}`);
      expect(activeNats.status).toBe(0);
      const activeCortex = sh("systemctl", ["--user", "is-active", "--quiet", `cortex@${SLUG}`]);
      if (activeCortex.status !== 0) throw new Error(`cortex@${SLUG} is not active:\n${diagnose(`cortex@${SLUG}`)}`);
      expect(activeCortex.status).toBe(0);

      // 4. Restart-on-upgrade path — restart_running_systemd_stacks discovers
      //    the slug from the config-dir fixture and must restart the ACTIVE
      //    cortex@e2e2071 instance (mirrors what postupgrade.sh does after
      //    `arc upgrade cortex`).
      const restart = sh("bash", ["-c", `source "${LIB}" && restart_running_systemd_stacks "${configDir}"`]);
      if (restart.status !== 0) throw new Error(`restart_running_systemd_stacks failed:\n${restart.stdout}${restart.stderr}`);
      expect(restart.stdout).toContain(`cortex@${SLUG} restarted`);
      const stillActive = sh("systemctl", ["--user", "is-active", "--quiet", `cortex@${SLUG}`]);
      if (stillActive.status !== 0) throw new Error(`cortex@${SLUG} not active after restart:\n${diagnose(`cortex@${SLUG}`)}`);
      expect(stillActive.status).toBe(0);
    } finally {
      // Stop + disable the e2e instances FIRST (before any file is removed/
      // restored underneath a still-running unit), then unwind every backup
      // in reverse — restoring any pre-existing unit file/binary/workspace
      // dir and deleting only what this test itself created.
      sh("systemctl", ["--user", "disable", "--now", `cortex@${SLUG}`]);
      sh("systemctl", ["--user", "disable", "--now", `nats@${SLUG}`]);
      for (const restore of restoreFns.reverse()) restore();
      sh("systemctl", ["--user", "daemon-reload"]);
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// Documents the skip reason in CI output when the gate isn't satisfied (e.g.
// this file running under the plain `test` job, which never sets
// SYSTEMD_E2E) so "0 tests ran" doesn't read as a silent hole.
afterAll(() => {
  if (!RUN_E2E) {
    console.log("systemd-e2e: skipped (requires SYSTEMD_E2E=1 + a live systemd --user session — see file header)");
  }
});
