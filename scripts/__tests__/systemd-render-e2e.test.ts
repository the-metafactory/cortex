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
// XDG_RUNTIME_DIR bootstrap + `bun test --test-name-pattern systemd-e2e`),
// gated on BOTH `CI=true` (GitHub Actions sets this) AND a live systemd-user
// bus — never on a real developer machine, even a Linux desktop with its own
// systemd-user session, where blindly stubbing ~/.local/bin/cortex or
// enabling/disabling units could clobber a REAL install. Test name and
// describe block both carry "systemd-e2e" so the CI job's
// `--test-name-pattern systemd-e2e` picks this up.
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

// CI-only gate (see file header) — deliberately NOT just "Linux with a
// systemd-user session", which would also match a real developer desktop.
const RUN_E2E = process.env.CI === "true" && hasSystemdUserSession();

const SLUG = "e2e2071";
const HOME_DIR = homedir();
const UNIT_DIR = join(HOME_DIR, ".config", "systemd", "user");
const LOCAL_BIN = join(HOME_DIR, ".local", "bin");

describe("systemd-e2e: real render + enable + restart (cortex#2071)", () => {
  test.skipIf(!RUN_E2E)("render → enable --now nats@/cortex@ → is-active → restart-on-upgrade", () => {
    mkdirSync(LOCAL_BIN, { recursive: true });

    // Stub nats-server/cortex — a real long-running Type=simple process that
    // ignores its args, so `systemctl --user enable --now` has something
    // real to mark active without needing an actual NATS server or a linked
    // cortex CLI on the bare CI runner. Back up + restore anything already
    // there (belt-and-braces; a fresh Actions runner never has these, but a
    // stub must never end up permanently shadowing a real binary).
    const backups: Array<{ path: string; backup: string }> = [];
    for (const name of ["nats-server", "cortex"]) {
      const p = join(LOCAL_BIN, name);
      if (existsSync(p)) {
        const backup = `${p}.systemd-e2e-backup`;
        renameSync(p, backup);
        backups.push({ path: p, backup });
      }
      writeFileSync(p, "#!/bin/sh\nexec sleep 3600\n");
      chmodSync(p, 0o755);
    }

    let configDir = "";
    try {
      // 1. Render the real checked-in templates into the real unit dir.
      const render = sh("bash", ["-c", `source "${LIB}" && render_cortex_systemd_units "${REPO_ROOT}" "${UNIT_DIR}"`]);
      if (render.status !== 0) throw new Error(`render_cortex_systemd_units failed:\n${render.stdout}${render.stderr}`);
      expect(existsSync(join(UNIT_DIR, "nats@.service"))).toBe(true);
      expect(existsSync(join(UNIT_DIR, "cortex@.service"))).toBe(true);

      // 2. Enable + start both instances for the e2e slug.
      const enableNats = sh("systemctl", ["--user", "enable", "--now", `nats@${SLUG}`]);
      if (enableNats.status !== 0) throw new Error(`enable nats@${SLUG} failed:\n${enableNats.stdout}${enableNats.stderr}`);
      const enableCortex = sh("systemctl", ["--user", "enable", "--now", `cortex@${SLUG}`]);
      if (enableCortex.status !== 0) throw new Error(`enable cortex@${SLUG} failed:\n${enableCortex.stdout}${enableCortex.stderr}`);

      // 3. is-active.
      expect(sh("systemctl", ["--user", "is-active", "--quiet", `nats@${SLUG}`]).status).toBe(0);
      expect(sh("systemctl", ["--user", "is-active", "--quiet", `cortex@${SLUG}`]).status).toBe(0);

      // 4. Restart-on-upgrade path — restart_running_systemd_stacks discovers
      //    the slug from a config-dir fixture and must restart the ACTIVE
      //    cortex@e2e2071 instance (mirrors what postupgrade.sh does after
      //    `arc upgrade cortex`).
      configDir = mkdtempSync(join(tmpdir(), "cortex-systemd-e2e-config-"));
      mkdirSync(join(configDir, SLUG, "system"), { recursive: true });
      writeFileSync(join(configDir, SLUG, `${SLUG}.yaml`), "");
      writeFileSync(join(configDir, SLUG, "system", "system.yaml"), "");

      const restart = sh("bash", ["-c", `source "${LIB}" && restart_running_systemd_stacks "${configDir}"`]);
      if (restart.status !== 0) throw new Error(`restart_running_systemd_stacks failed:\n${restart.stdout}${restart.stderr}`);
      expect(restart.stdout).toContain(`cortex@${SLUG} restarted`);
      expect(sh("systemctl", ["--user", "is-active", "--quiet", `cortex@${SLUG}`]).status).toBe(0);
    } finally {
      // Stop + disable the e2e instances and remove the rendered units + stub
      // binaries, restoring any pre-existing binary from its backup — leaves
      // the runner's systemd-user state exactly as found.
      sh("systemctl", ["--user", "disable", "--now", `cortex@${SLUG}`]);
      sh("systemctl", ["--user", "disable", "--now", `nats@${SLUG}`]);
      rmSync(join(UNIT_DIR, "nats@.service"), { force: true });
      rmSync(join(UNIT_DIR, "cortex@.service"), { force: true });
      sh("systemctl", ["--user", "daemon-reload"]);
      for (const name of ["nats-server", "cortex"]) {
        rmSync(join(LOCAL_BIN, name), { force: true });
      }
      for (const { path, backup } of backups) {
        renameSync(backup, path);
      }
      if (configDir) rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// Documents the skip reason in CI output when the gate isn't satisfied (e.g.
// this file running under the plain `test` job, which has no systemd-user
// session bootstrap) so "0 tests ran" doesn't read as a silent hole.
afterAll(() => {
  if (!RUN_E2E) {
    console.log("systemd-e2e: skipped (requires CI=true + a live systemd --user session — see file header)");
  }
});
