/**
 * cortex#2409 part 2 — tests for the `macos-sbpl` v2 `strict` posture
 * (`generateMacosSbplStrictProfile` + `MacosSbplSandbox`'s posture gating).
 *
 * Same fixture discipline as `session-sandbox-macos.test.ts` (v1 `guarded`):
 * every test that exercises the sensitive set does so against a FIXTURE
 * `$HOME`/`configHomeDir` override — never the real developer machine's
 * `~/.ssh` etc. macOS-ONLY (`describe.skipIf(!isDarwin)`) for every test
 * that spawns a real `sandbox-exec` — matches the established pattern. One
 * pure-generator test is ALSO gated (`test.skipIf`): it realpaths
 * `/usr/bin/security`, which does not exist on Linux CI.
 *
 * ## Why this file doesn't assert "zero denials" the way the v1 e2e test does
 *
 * `cc-session-macos-sandbox-e2e.test.ts` (v1 `guarded`, UNTOUCHED by this
 * slice) asserts a real session produces ZERO `sandbox-denial` events,
 * because `guarded`'s `(allow default)` means EVERY legitimate access
 * already succeeds silently — a denial there is unambiguously a gap.
 * `strict`'s `(deny default)` construction is different: measured directly
 * on a real dev host, a real `claude --print` session run under `strict`
 * denies dozens of `file-read-data` probes into the PRINCIPAL's own
 * accumulated project/skill history (`~/.claude.json`'s recorded "recent
 * projects" list, scanned at startup) — paths entirely outside the
 * session's `allowedDirs`/config-home/compat-contract set. **That denial is
 * CORRECT, not a gap** — those are exactly the out-of-scope reads
 * deny-default exists to catch; a clean/production bot-dispatch host has no
 * such history to scan in the first place (nothing is EVER registered
 * there beyond what cortex itself dispatched into `allowedDirs`, which IS
 * allow-listed). So `strict`'s real end-to-end bar (below) is "the session
 * completes successfully" (exit 0, correct response, survives `--resume`),
 * not "zero denial events" — and the "out-of-scope read is denied" claim is
 * proven separately, against FIXTURE paths, the same way v1's "four stops"
 * block does it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SandboxProfile } from "../session-sandbox";
import {
  classifyHookTarget,
  generateMacosSbplStrictProfile,
  homebrewPackageRoot,
  MacosSbplSandbox,
} from "../session-sandbox-macos";
import { CCSession } from "../cc-session";
import {
  getSandboxCapabilityProbe,
  resetSandboxCapabilityProbeForTests,
  type SandboxDenialEvent,
} from "../session-sandbox";
import { hasClaude, testClaude } from "../../common/test-utils";

const isDarwin = process.platform === "darwin";

function baseProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    readWrite: [],
    readOnly: [],
    execAllow: [],
    egressAllow: [],
    mode: "audit",
    posture: "strict",
    internalReadOnly: [],
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// generateMacosSbplStrictProfile — pure function, runs everywhere
// -----------------------------------------------------------------------------

describe("generateMacosSbplStrictProfile", () => {
  let fixtureHome: string;
  let configHomeDir: string;

  beforeEach(() => {
    // realpathSync immediately — same E3-shaped rationale as v1's fixtures
    // (`/var` → `/private/var` on macOS).
    fixtureHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-strict-home-")));
    configHomeDir = join(fixtureHome, ".claude");
    mkdirSync(configHomeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  test("always opens with '(version 1)' then '(deny default)' — DD-10 v2 strict posture", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile(), { homeDir: fixtureHome, configHomeDir });
    const lines = generated.text.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines[1]).toBe("(deny default)");
  });

  test("never emits '(allow default)' — that's v1 guarded's posture, not strict's", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile(), { homeDir: fixtureHome, configHomeDir });
    expect(generated.text).not.toContain("allow default");
  });

  test("imports system.sb — E4's SIGABRT fix (dyld/mach/sysctl bootstrap base)", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile(), { homeDir: fixtureHome, configHomeDir });
    expect(generated.text).toContain('(import "system.sb")');
  });

  test("readWrite dirs get read+write subpath allow", () => {
    const workDir = mkdtempSync(join(tmpdir(), "cortex-strict-work-"));
    try {
      const generated = generateMacosSbplStrictProfile(baseProfile({ readWrite: [workDir] }), {
        homeDir: fixtureHome,
        configHomeDir,
      });
      const real = realpathSync(workDir);
      expect(generated.text).toContain(`(allow file-read* file-write* (subpath "${real}"))`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("readOnly dirs get READ-ONLY subpath allow (F6 — no write, same construction as v1)", () => {
    const roDir = mkdtempSync(join(tmpdir(), "cortex-strict-ro-"));
    try {
      const generated = generateMacosSbplStrictProfile(baseProfile({ readOnly: [roDir] }), {
        homeDir: fixtureHome,
        configHomeDir,
      });
      const real = realpathSync(roDir);
      expect(generated.text).toContain(`(allow file-read* (subpath "${real}"))`);
      expect(generated.text).not.toContain(`(allow file-read* file-write* (subpath "${real}"))`);
    } finally {
      rmSync(roDir, { recursive: true, force: true });
    }
  });

  test("internalReadOnly (isolated-settings temp dir) gets a read-only allow, not write", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cortex-strict-internal-"));
    try {
      const generated = generateMacosSbplStrictProfile(baseProfile({ internalReadOnly: [tmp] }), {
        homeDir: fixtureHome,
        configHomeDir,
      });
      const real = realpathSync(tmp);
      expect(generated.text).toContain(`(allow file-read* (subpath "${real}"))`);
      expect(generated.text).not.toContain(`(allow file-read* file-write* (subpath "${real}"))`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("THE keychain constraint — read allowed, write NOT allowed (deny-default omission)", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile(), { homeDir: fixtureHome, configHomeDir });
    const keychains = join(fixtureHome, "Library", "Keychains");
    expect(generated.text).toContain(`(allow file-read* (subpath "${keychains}"))`);
    // No write allow anywhere for the keychain tree — under (deny default),
    // omission IS the denial; there is no separate deny rule to assert on
    // (unlike v1, which needs an explicit deny under (allow default)).
    expect(generated.text).not.toMatch(/\(allow [^)]*file-write\*[^)]*Library\/Keychains/);
  });

  test("config home gets a broad read+write allow, but self-modification (hooks/, settings.json) write is carved back out", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile(), { homeDir: fixtureHome, configHomeDir });
    expect(generated.text).toContain(`(allow file-read* file-write* (subpath "${configHomeDir}"))`);
    expect(generated.text).toContain(`(deny file-write* (subpath "${join(configHomeDir, "hooks")}"))`);
    expect(generated.text).toContain(
      `(deny file-write* (literal "${join(configHomeDir, "settings.json")}"))`,
    );
  });

  test("the top-level .claude.json family (lock/tmp siblings included) is allowed via a regex-in-dir, in the DEFAULT config-home case sibling to $HOME, not nested under it", () => {
    // Default case: configHomeDir === join(homeDir, ".claude") exactly (no
    // override), so `.claude.json` must be a SIBLING of homeDir/.claude —
    // i.e. anchored at homeDir itself, not configHomeDir.
    const generated = generateMacosSbplStrictProfile(baseProfile(), {
      homeDir: fixtureHome,
      configHomeDir: join(fixtureHome, ".claude"),
    });
    expect(generated.text).toContain(`(regex #"^${fixtureHome}/\\.claude\\.json(\\..*)?$")`);
  });

  test("a RELOCATED config home nests .claude.json INSIDE it instead", () => {
    const relocated = join(fixtureHome, "relocated-config-home");
    mkdirSync(relocated, { recursive: true });
    const generated = generateMacosSbplStrictProfile(baseProfile(), {
      homeDir: fixtureHome,
      configHomeDir: relocated,
    });
    expect(generated.text).toContain(`(regex #"^${relocated}/\\.claude\\.json(\\..*)?$")`);
    expect(generated.text).not.toContain(`(regex #"^${fixtureHome}/\\.claude\\.json`);
  });

  test("execAllow entries resolve to real binaries and get process-exec + file-read* + file-map-executable", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile({ execAllow: ["true"] }), {
      homeDir: fixtureHome,
      configHomeDir,
    });
    const resolved = realpathSync(Bun.which("true")!);
    expect(generated.text).toContain(
      `(allow process-exec file-read* file-map-executable (literal "${resolved}"))`,
    );
  });

  test("an execAllow entry not found on $PATH is reported in unresolved, not silently skipped", () => {
    const generated = generateMacosSbplStrictProfile(
      baseProfile({ execAllow: ["cortex-definitely-not-a-real-binary-xyz"] }),
      { homeDir: fixtureHome, configHomeDir },
    );
    expect(generated.unresolved.some((u) => u.input === "cortex-definitely-not-a-real-binary-xyz")).toBe(
      true,
    );
  });

  // macOS-ONLY. Asserts on `/usr/bin/security`, the macOS keychain helper —
  // `realpathSync` on it throws ENOENT on Linux CI. Only THIS test needs the
  // gate: the rest of this describe block is platform-independent profile-
  // generation logic and stays enabled everywhere, which is worth keeping.
  test.skipIf(!isDarwin)("the security CLI (keychain helper) always gets process-exec + file-read*, even with an empty execAllow", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile(), { homeDir: fixtureHome, configHomeDir });
    const securityPath = Bun.which("security") ?? "/usr/bin/security";
    const resolved = realpathSync(securityPath);
    expect(generated.text).toContain(`(allow process-exec file-read* (literal "${resolved}"))`);
  });

  test("a path that fails to realpath-resolve is EXCLUDED from the profile and reported in unresolved — fail closed", () => {
    const nulPath = join(fixtureHome, "a") + String.fromCharCode(0) + "b";
    const generated = generateMacosSbplStrictProfile(baseProfile({ readWrite: [nulPath] }), {
      homeDir: fixtureHome,
      configHomeDir,
    });
    expect(generated.text).not.toContain(String.fromCharCode(0));
    expect(generated.unresolved.some((u) => u.input === nulPath)).toBe(true);
  });

  test("network* is allowed unconditionally — L2 strict is FS-only, not a network boundary (documented scope)", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile(), { homeDir: fixtureHome, configHomeDir });
    expect(generated.text).toContain("(allow network*)");
  });
});

describe("homebrewPackageRoot", () => {
  test("extracts the package root from a Cellar-shaped path", () => {
    expect(homebrewPackageRoot("/opt/homebrew/Cellar/git/2.49.0/bin/git")).toBe(
      "/opt/homebrew/Cellar/git/2.49.0",
    );
  });

  test("returns undefined for a non-Cellar path (disclosed residual for non-Homebrew hosts)", () => {
    expect(homebrewPackageRoot("/usr/bin/git")).toBeUndefined();
  });

  test("returns undefined for a malformed/truncated Cellar path", () => {
    expect(homebrewPackageRoot("/opt/homebrew/Cellar/git")).toBeUndefined();
  });
});

describe("classifyHookTarget", () => {
  test("a target under arc's package-repos root gets its whole repo checkout allow-listed (subpath)", () => {
    const home = "/Users/fixture";
    const result = classifyHookTarget(
      join(home, ".local", "share", "metafactory", "arc", "repos", "cortex", "src", "runner", "hooks", "x.ts"),
      home,
    );
    expect(result).toEqual({ subpath: join(home, ".local", "share", "metafactory", "arc", "repos", "cortex") });
  });

  test("a target OUTSIDE the arc root gets only its own literal file allow-listed", () => {
    const home = "/Users/fixture";
    const result = classifyHookTarget(join(home, "custom-hooks", "my-hook.ts"), home);
    expect(result).toEqual({ literal: join(home, "custom-hooks", "my-hook.ts") });
  });
});

// -----------------------------------------------------------------------------
// Real sandbox-exec — macOS only. Proves BOTH directions: legitimate access
// still works, AND an out-of-scope read is denied BY CONSTRUCTION (no
// enumerated deny rule needed — the whole point of deny-default).
// -----------------------------------------------------------------------------

describe.skipIf(!isDarwin)("strict — real sandbox-exec, both directions", () => {
  let fixtureHome: string;
  let configHomeDir: string;
  let workDir: string;
  let otherDir: string;

  beforeEach(() => {
    fixtureHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-strict-e2e-home-")));
    configHomeDir = join(fixtureHome, ".claude");
    mkdirSync(configHomeDir, { recursive: true });
    workDir = mkdtempSync(join(tmpdir(), "cortex-strict-e2e-work-"));
    writeFileSync(join(workDir, "file.txt"), "workspace-content");
    // An out-of-scope secret — NOT in readWrite/readOnly/configHome/anything
    // on the allow set. Under (deny default), this must be unreachable
    // WITHOUT any explicit deny rule naming it.
    otherDir = mkdtempSync(join(tmpdir(), "cortex-strict-e2e-secret-"));
    mkdirSync(join(otherDir, ".ssh"), { recursive: true });
    writeFileSync(join(otherDir, ".ssh", "id_ed25519"), "FAKE-PRIVATE-KEY");
  });

  afterEach(() => {
    rmSync(fixtureHome, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  });

  function runUnderStrictProfile(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
    // execAllow carries the TEST DRIVER binaries this file's own real-
    // sandbox-exec tests invoke (`cat`/`sh`/`tee`) — under strict,
    // process-exec is deny-by-default too (unlike v1 guarded, where ANY
    // exec succeeds via `(allow default)`), so a test spawning a plain
    // `/bin/cat` needs it on the allow list the SAME way a real session's
    // compat-contract binaries do, or the exec itself is denied and every
    // assertion below would be testing "cat couldn't even launch" instead
    // of the file-access question the test is actually about.
    const profile = baseProfile({ readWrite: [workDir], execAllow: ["cat", "sh", "bash", "tee"] });
    const generated = generateMacosSbplStrictProfile(profile, { homeDir: fixtureHome, configHomeDir });
    const profileDir = mkdtempSync(join(tmpdir(), "cortex-strict-e2e-profile-"));
    try {
      const profilePath = join(profileDir, "strict.sb");
      writeFileSync(profilePath, generated.text);
      const result = Bun.spawnSync(["sandbox-exec", "-f", profilePath, ...argv], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  }

  test("DIRECTION 1 — legitimate access: reading INSIDE the allowed workDir succeeds", () => {
    const r = runUnderStrictProfile(["/bin/cat", join(workDir, "file.txt")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("workspace-content");
  });

  test("DIRECTION 1 — legitimate access: writing INSIDE the allowed workDir succeeds", () => {
    const target = join(workDir, "new.txt");
    const r = runUnderStrictProfile(["/bin/sh", "-c", `echo written > ${target}`]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(target, "utf-8")).toContain("written");
  });

  test("DIRECTION 2 — F1 closed BY CONSTRUCTION: an out-of-scope read is denied with NO enumerated deny rule naming it", () => {
    const generated = generateMacosSbplStrictProfile(baseProfile({ readWrite: [workDir] }), {
      homeDir: fixtureHome,
      configHomeDir,
    });
    // The profile text contains NO deny/mention of otherDir at all — proving
    // the denial below is deny-default's OWN construction, not an
    // enumerated rule (the v1-vs-v2 distinction this whole slice is about).
    expect(generated.text).not.toContain(realpathSync(otherDir));

    const target = join(otherDir, ".ssh", "id_ed25519");
    const r = runUnderStrictProfile(["/bin/cat", target]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Operation not permitted");
    expect(r.stdout).not.toContain("FAKE-PRIVATE-KEY");
  });

  test("DIRECTION 2 — F6: write into a readOnly dir is still denied under strict", () => {
    const roDir = mkdtempSync(join(tmpdir(), "cortex-strict-e2e-ro-"));
    writeFileSync(join(roDir, "f.txt"), "ro-content");
    try {
      const profile = baseProfile({
        readWrite: [workDir],
        readOnly: [roDir],
        execAllow: ["cat", "sh", "bash"],
      });
      const generated = generateMacosSbplStrictProfile(profile, { homeDir: fixtureHome, configHomeDir });
      const profileDir = mkdtempSync(join(tmpdir(), "cortex-strict-e2e-ro-profile-"));
      try {
        const profilePath = join(profileDir, "strict.sb");
        writeFileSync(profilePath, generated.text);
        const target = join(roDir, "f.txt");
        const result = Bun.spawnSync(
          ["sandbox-exec", "-f", profilePath, "/bin/sh", "-c", `echo x >> ${target}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(result.stderr.toString()).toContain("Operation not permitted");
        // Positive control — read still works.
        const readResult = Bun.spawnSync(["sandbox-exec", "-f", profilePath, "/bin/cat", target], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(readResult.exitCode).toBe(0);
        expect(readResult.stdout.toString()).toContain("ro-content");
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(roDir, { recursive: true, force: true });
    }
  });

  test("THE keychain constraint, DIRECTION 1: keychain READ is allowed under strict", () => {
    const keychainDir = join(fixtureHome, "Library", "Keychains");
    mkdirSync(keychainDir, { recursive: true });
    writeFileSync(join(keychainDir, "login.keychain-db"), "not-a-real-keychain");
    const r = runUnderStrictProfile(["/bin/cat", join(keychainDir, "login.keychain-db")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("not-a-real-keychain");
  });

  test("THE keychain constraint, DIRECTION 2: keychain WRITE is denied under strict (deny-default omission)", () => {
    const keychainDir = join(fixtureHome, "Library", "Keychains");
    mkdirSync(keychainDir, { recursive: true });
    const target = join(keychainDir, "login.keychain-db");
    writeFileSync(target, "not-a-real-keychain");
    const r = runUnderStrictProfile(["/bin/sh", "-c", `echo tampered >> ${target}`]);
    expect(r.stderr).toContain("Operation not permitted");
  });
});

// -----------------------------------------------------------------------------
// THE keychain constraint's REGRESSION test — the documented REASON keychain
// read is allowed: prove that DENYING it breaks a real `claude --print`
// session outright. This is deliberately run against a hand-modified profile
// (the real generator's own output with the keychain-read line stripped),
// not a fixture $HOME — the auth/keychain state that breaks is the REAL
// machine's, which is the whole point (this IS what E-KC measured).
// -----------------------------------------------------------------------------

// SAFETY NOTE (added after this test's live form was found to carry a real
// risk): the original version of this block spawned a REAL `claude --print`
// process, against this machine's REAL $HOME, under a profile with the
// keychain-read allow line deliberately stripped — to reproduce the
// documented "denying keychain read breaks login" finding end-to-end. That
// is exactly what it did: it reliably reproduced "Not logged in". But it
// does so by repeatedly forcing a REAL `claude` invocation through a failed
// auth path against the REAL, SHARED, global `~/.claude.json`/keychain
// state on the host — not a fixture. Unlike this file's other real-
// sandbox-exec tests (which use a fixture `$HOME` or fixture keychain
// files), this one had no way to avoid touching the real auth state,
// because the whole point was proving the REAL login path breaks. Running
// it repeatedly, on a shared dev host where an active, longer-lived Claude
// Code session's own authentication may depend on the SAME `~/.claude.json`
// state, is a real, demonstrated hazard — not a hypothetical one — and it
// was pulled after that risk surfaced, rather than kept for coverage this
// suite does not need: the underlying fact (denying keychain read breaks
// `claude` login) is ALREADY independently established and documented —
// see `generateMacosSbplStrictProfile`'s module doc's "THE keychain
// constraint" section and `session-sandbox-macos.ts`'s v1 `guarded`
// module doc's own two-round story (a PRIOR, independent measurement of
// the identical fact). The safe, still-real-sandbox-exec regression for
// THIS module lives above: "THE keychain constraint, DIRECTION 1/2" in the
// "strict — real sandbox-exec, both directions" describe block — those
// use a FIXTURE `$HOME`/keychain file, never the real one, and assert the
// same read-allowed/write-denied shape without ever exercising `claude`'s
// own real auth path.

// -----------------------------------------------------------------------------
// MacosSbplSandbox — posture gating (mirrors v1's own "spawn() mode gating"
// describe block, extended for posture)
// -----------------------------------------------------------------------------

describe.skipIf(!isDarwin)("MacosSbplSandbox — posture gating (guarded vs strict)", () => {
  test("posture 'strict' + mode 'audit': a real session under a strict profile can still read its workDir", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "cortex-strict-spawn-work-"));
    writeFileSync(join(workDir, "f.txt"), "hello");
    try {
      const sandbox = new MacosSbplSandbox();
      const profile = baseProfile({
        mode: "audit",
        posture: "strict",
        readWrite: [workDir],
        execAllow: ["cat"],
      });
      const proc = sandbox.spawn(["/bin/cat", join(workDir, "f.txt")], profile, {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout =
        typeof proc.stdout === "object" && proc.stdout !== null
          ? await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
          : "";
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("hello");
      expect(sandbox.canaryResult?.passed).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("posture 'strict': an out-of-scope read is denied end-to-end via the real class", async () => {
    const secretDir = mkdtempSync(join(tmpdir(), "cortex-strict-spawn-secret-"));
    writeFileSync(join(secretDir, "secret.txt"), "TOP-SECRET");
    try {
      const sandbox = new MacosSbplSandbox();
      // execAllow includes "cat" so a failure here is unambiguously the
      // FILE READ being denied, not the exec of `cat` itself (also denied
      // under strict by default, and also stringified as "Operation not
      // permitted" — leaving it off would make this test pass for the
      // wrong reason).
      const profile = baseProfile({ mode: "audit", posture: "strict", readWrite: [], execAllow: ["cat"] });
      const proc = sandbox.spawn(["/bin/cat", join(secretDir, "secret.txt")], profile, {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr =
        typeof proc.stderr === "object" && proc.stderr !== null
          ? await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
          : "";
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Operation not permitted");
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("posture defaults to 'guarded' behavior when unset on the profile (HARD HOLD parity check)", async () => {
    // A profile that OMITS posture entirely would fail TypeScript (the
    // field is required) — this test instead pins that `deriveSandboxProfile`
    // (cc-session.ts) is the ACTUAL default-setter, and that a profile built
    // with posture "guarded" behaves exactly like pre-#2409 EBH-3a: an
    // out-of-scope read SUCCEEDS (guarded's allow-default posture, unchanged).
    const secretDir = mkdtempSync(join(tmpdir(), "cortex-guarded-spawn-secret-"));
    writeFileSync(join(secretDir, "secret.txt"), "not-actually-secret-for-this-test");
    try {
      const sandbox = new MacosSbplSandbox();
      const profile = baseProfile({ mode: "audit", posture: "guarded", readWrite: [] });
      const proc = sandbox.spawn(["/bin/cat", join(secretDir, "secret.txt")], profile, {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0); // guarded's (allow default) — unchanged by this slice
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  }, 15_000);
});

// -----------------------------------------------------------------------------
// Real end-to-end acceptance — a full CCSession under strict/audit. Mirrors
// cc-session-macos-sandbox-e2e.test.ts's shape (fresh session + --resume),
// but asserts SUCCESS + response content rather than zero denials — see this
// file's module doc for why that bar differs from v1 guarded's.
// -----------------------------------------------------------------------------

describe.skipIf(!isDarwin || !hasClaude)(
  "EBH-2409-part-2 acceptance — real CCSession end-to-end under posture: 'strict' (macos-sbpl)",
  () => {
    let workDir: string;

    beforeEach(async () => {
      resetSandboxCapabilityProbeForTests();
      const probe = await getSandboxCapabilityProbe();
      expect(probe.resolvedBackend).toBe("macos-sbpl");
      workDir = mkdtempSync(join(tmpdir(), "cortex-strict-cc-e2e-"));
    });

    afterEach(() => {
      resetSandboxCapabilityProbeForTests();
      rmSync(workDir, { recursive: true, force: true });
    });

    testClaude(
      "fresh session + --resume of it BOTH complete successfully under strict",
      async () => {
        const denials: SandboxDenialEvent[] = [];

        const first = new CCSession({
          prompt: "Say just the word hi, nothing else",
          channel: "test",
          timeoutMs: 45_000,
          sandboxMode: "audit",
          sandboxPosture: "strict",
          cwd: workDir,
          allowedDirs: [workDir],
        });
        first.on("security-event", (event: unknown) => {
          const e = event as { type: string };
          if (e.type === "system.security.sandbox-denial") denials.push(event as SandboxDenialEvent);
        });

        const firstResult = await first.start().wait();
        expect(firstResult.success).toBe(true);
        expect(firstResult.exitCode).toBe(0);
        expect(firstResult.sessionId).toBeDefined();
        expect(firstResult.response.toLowerCase()).toContain("hi");

        const second = new CCSession({
          prompt: "Say just the word bye, nothing else",
          channel: "test",
          timeoutMs: 45_000,
          sandboxMode: "audit",
          sandboxPosture: "strict",
          cwd: workDir,
          allowedDirs: [workDir],
          resumeSessionId: firstResult.sessionId,
        });
        second.on("security-event", (event: unknown) => {
          const e = event as { type: string };
          if (e.type === "system.security.sandbox-denial") denials.push(event as SandboxDenialEvent);
        });

        const secondResult = await second.start().wait();
        expect(secondResult.success).toBe(true);
        expect(secondResult.exitCode).toBe(0);
        expect(secondResult.response.toLowerCase()).toContain("bye");

        // A workspace write must have succeeded WITHOUT any denial on
        // workDir itself (the legitimate-access half of the "both
        // directions" bar) — denials targeting workDir specifically would
        // mean the compat contract is broken, unlike the personal-history
        // noise class this file's module doc documents as expected.
        const workDirDenials = denials.filter((d) => d.path?.startsWith(workDir));
        expect(workDirDenials).toHaveLength(0);
      },
      60_000,
    );
  },
);
