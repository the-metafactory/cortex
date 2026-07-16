// Real end-to-end coverage for scripts/lib/systemd-remove.sh against an
// ACTUAL systemd --user session (cortex#2093, the L1 rollback half of
// cortex#2071's systemd-render-e2e.test.ts): render → enable --now → remove
// (disable + delete + reload) → assert `systemctl --user list-unit-files`
// no longer lists either unit — the exact verification recipe from the issue.
//
// Deliberately split out of systemd-remove.test.ts (fully mocked, safe
// anywhere) for the same reason systemd-render-e2e.test.ts is split from
// systemd-render.test.ts: the running systemd --user MANAGER resolves its
// unit search path from ITS OWN startup environment, not from whatever
// $HOME this test process exports, so a scratch-HOME trick cannot isolate
// this test the way it isolates the mocked one.
//
// Runs ONLY in the dedicated `systemd-e2e` CI job (cortex#2092), gated on
// SYSTEMD_E2E=1 — identical gate to systemd-render-e2e.test.ts, for the
// identical reason (must never leak into the plain Test job, must never run
// unattended against a real developer's Linux desktop). The "systemd-e2e" in
// this file's describe/test names is what the CI job's
// `--test-name-pattern systemd-e2e` picks up; no separate CI wiring needed.
//
// Every mutation this test makes to the real $HOME is backed up before and
// restored in `finally`, mirroring systemd-render-e2e.test.ts's backup()
// helper exactly.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RENDER_LIB = join(REPO_ROOT, "scripts", "lib", "systemd-render.sh");
const REMOVE_LIB = join(REPO_ROOT, "scripts", "lib", "systemd-remove.sh");

function sh(cmd: string, args: string[]) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

function hasSystemdUserSession(): boolean {
  if (process.platform !== "linux") return false;
  const probe = sh("systemctl", ["--user", "show-environment"]);
  return probe.status === 0;
}

// Same opt-in gate as systemd-render-e2e.test.ts — see file header.
const RUN_E2E = process.env.SYSTEMD_E2E === "1" && hasSystemdUserSession();

const SLUG = "e2e2093";
const HOME_DIR = homedir();
const UNIT_DIR = join(HOME_DIR, ".config", "systemd", "user");
const LOCAL_BIN = join(HOME_DIR, ".local", "bin");
const WORKSPACE_DIR = join(HOME_DIR, ".local", "share", "metafactory", "cortex", SLUG);
const NATS_LOGS_DIR = join(HOME_DIR, ".local", "state", "nats", "logs");
const CORTEX_LOGS_DIR = join(HOME_DIR, ".local", "state", "metafactory", "cortex", "logs");

function listUnitFiles(): string {
  const res = sh("systemctl", ["--user", "list-unit-files"]);
  return res.stdout;
}

// Backs up path (rename aside) if it already exists, returning a restore
// function — byte-identical helper to systemd-render-e2e.test.ts's backup().
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

describe("systemd-e2e: real render + enable + remove (cortex#2093)", () => {
  test.skipIf(!RUN_E2E)("render → enable --now nats@/cortex@ → remove → list-unit-files empty", () => {
    mkdirSync(LOCAL_BIN, { recursive: true });
    mkdirSync(UNIT_DIR, { recursive: true });

    const restoreFns: Array<() => void> = [];
    restoreFns.push(backup(join(UNIT_DIR, "nats@.service")));
    restoreFns.push(backup(join(UNIT_DIR, "cortex@.service")));
    restoreFns.push(backup(WORKSPACE_DIR));

    // Stub nats-server/cortex — same real-long-running-process approach as
    // systemd-render-e2e.test.ts, so enable --now has something real to mark
    // active without needing an actual NATS server or a linked cortex CLI.
    for (const name of ["nats-server", "cortex"]) {
      const p = join(LOCAL_BIN, name);
      restoreFns.push(backup(p));
      writeFileSync(p, "#!/bin/sh\nexec sleep infinity\n");
      chmodSync(p, 0o755);
    }

    const configDir = mkdtempSync(join(tmpdir(), "cortex-systemd-remove-e2e-config-"));
    mkdirSync(join(configDir, SLUG, "system"), { recursive: true });
    writeFileSync(join(configDir, SLUG, `${SLUG}.yaml`), "");
    writeFileSync(join(configDir, SLUG, "system", "system.yaml"), "");

    mkdirSync(CORTEX_LOGS_DIR, { recursive: true });

    try {
      // 1. Render + enable — the exact precondition state removal must clean
      //    up (mirrors what a real `arc install cortex` + `systemctl --user
      //    enable --now` sequence leaves behind).
      const render = sh("bash", ["-c", `source "${RENDER_LIB}" && render_cortex_systemd_units "${REPO_ROOT}" "${UNIT_DIR}" "${configDir}"`]);
      if (render.status !== 0) throw new Error(`render_cortex_systemd_units failed:\n${render.stdout}${render.stderr}`);

      const enableNats = sh("systemctl", ["--user", "enable", "--now", `nats@${SLUG}`]);
      if (enableNats.status !== 0) throw new Error(`enable nats@${SLUG} failed:\n${enableNats.stdout}${enableNats.stderr}`);
      const enableCortex = sh("systemctl", ["--user", "enable", "--now", `cortex@${SLUG}`]);
      if (enableCortex.status !== 0) throw new Error(`enable cortex@${SLUG} failed:\n${enableCortex.stdout}${enableCortex.stderr}`);

      const activeBefore = sh("systemctl", ["--user", "is-active", "--quiet", `cortex@${SLUG}`]);
      expect(activeBefore.status).toBe(0);

      // 2. The actual thing under test: remove_cortex_systemd_units — the
      //    exact function scripts/preremove.sh calls on `arc remove cortex`.
      const remove = sh("bash", ["-c", `source "${REMOVE_LIB}" && remove_cortex_systemd_units "${UNIT_DIR}" "${configDir}"`]);
      if (remove.status !== 0) throw new Error(`remove_cortex_systemd_units failed:\n${remove.stdout}${remove.stderr}`);

      // 3. Acceptance criterion, verbatim from the issue: the enabled
      //    instance is stopped, both template files are gone, and
      //    `list-unit-files | grep -E "cortex@|nats@"` has nothing left.
      const activeAfter = sh("systemctl", ["--user", "is-active", "--quiet", `cortex@${SLUG}`]);
      expect(activeAfter.status).not.toBe(0);
      expect(existsSync(join(UNIT_DIR, "nats@.service"))).toBe(false);
      expect(existsSync(join(UNIT_DIR, "cortex@.service"))).toBe(false);

      const unitFiles = listUnitFiles();
      expect(unitFiles).not.toMatch(/cortex@|nats@/);
    } finally {
      // Belt-and-braces: if the assertions above failed before remove ran
      // (or remove itself failed), make sure the e2e instances are never
      // left running before we restore/replace the unit files underneath
      // them.
      sh("systemctl", ["--user", "disable", "--now", `cortex@${SLUG}`]);
      sh("systemctl", ["--user", "disable", "--now", `nats@${SLUG}`]);
      for (const restore of restoreFns.reverse()) restore();
      sh("systemctl", ["--user", "daemon-reload"]);
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// Documents the skip reason in CI output when the gate isn't satisfied — same
// rationale as systemd-render-e2e.test.ts's afterAll.
afterAll(() => {
  if (!RUN_E2E) {
    console.log("systemd-e2e: skipped (requires SYSTEMD_E2E=1 + a live systemd --user session — see file header)");
  }
});
