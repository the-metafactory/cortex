/**
 * EBH-3a (cortex#2345) — tests for the `macos-sbpl` `SessionSandbox` backend.
 *
 * macOS-ONLY: every test in this file spawns a real `sandbox-exec` (and, for
 * the denial-observation tests, a real `log stream`). CI is `ubuntu-latest`
 * only (no macOS runner — see `.github/workflows/ci.yml`), so the whole file
 * is gated with `describe.skipIf(process.platform !== "darwin")`, matching
 * the established pattern for platform-gated integration coverage in this
 * repo (`cc-plugin-dir-pin.integration.test.ts`'s `test.skipIf(!CLAUDE_BIN)`).
 * On a real macOS dev host (where this was authored and run) every test here
 * executes for real — no mocking of `sandbox-exec`/`log stream` themselves,
 * because the whole point of EBH-3a is empirically-verified enforcement, not
 * a simulation of it.
 *
 * Fixture discipline: every test that exercises the built-in "sensitive set"
 * (config dir / ssh / aws / settings.json / hooks) does so against a
 * FIXTURE `$HOME` (`opts.homeDir` override) — never the real developer
 * machine's `~/.ssh` etc. A profile that accidentally denied (or, worse,
 * appeared to pass while silently not covering) the REAL `~/.ssh` on the
 * machine running these tests would be its own small incident.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SandboxProfile } from "../session-sandbox";
import {
  generateMacosSbplProfile,
  MacosSbplSandbox,
  parseSandboxDenialLogLine,
  runMacosCanarySelfTest,
} from "../session-sandbox-macos";

const isDarwin = process.platform === "darwin";

/** `Subprocess.stdout`'s static type is `number | ReadableStream | undefined`
 *  (the `number` arm covers fd-passthrough opts this file never uses) — a
 *  small runtime-checked helper so every test that reads a spawned child's
 *  stdout doesn't repeat the narrowing. */
async function readAllStdout(stdout: number | ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (typeof stdout !== "object" || stdout === null) return "";
  return new Response(stdout).text();
}

function baseProfile(overrides: Partial<SandboxProfile> = {}): SandboxProfile {
  return {
    readWrite: [],
    readOnly: [],
    execAllow: [],
    egressAllow: [],
    mode: "audit",
    posture: "guarded",
    internalReadOnly: [],
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// generateMacosSbplProfile — pure function, runs everywhere (no sandbox-exec)
// -----------------------------------------------------------------------------

describe("generateMacosSbplProfile", () => {
  let fixtureHome: string;

  beforeEach(() => {
    // realpathSync immediately — `tmpdir()` on macOS is itself under
    // `/var/folders/...`, and `/var` is ALSO a symlink to `/private/var`
    // (the same E3 shape as `/tmp` → `/private/tmp`). The generator
    // correctly resolves every path before it enters the profile (that's
    // the whole point of this module), so a test that compares against the
    // UNRESOLVED fixture path would be asserting the wrong thing — this is
    // the fixture-side half of the same E3 discipline the generator itself
    // implements.
    fixtureHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-sbpl-fixture-home-")));
  });

  afterEach(() => {
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  test("always opens with '(version 1)' then '(allow default)' — DD-10 v1 guarded posture", () => {
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    const lines = generated.text.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines[1]).toBe("(allow default)");
  });

  test("never emits '(deny default)' — E4 forbids strict deny-default for v1", () => {
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    expect(generated.text).not.toContain("deny default");
  });

  test("denies read+write on the config dir tree (CONFIG IMMUTABILITY, F1)", () => {
    // The config dir need not exist — resolveProspectiveRealpath tolerates
    // a not-yet-created leaf by walking up to the nearest existing ancestor
    // (fixtureHome itself, created by mkdtempSync).
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    const configDir = join(fixtureHome, ".config", "metafactory", "cortex");
    expect(generated.text).toContain(`(deny file-read* (subpath "${configDir}"))`);
    expect(generated.text).toContain(`(deny file-write* (subpath "${configDir}"))`);
  });

  test("denies read+write on ~/.ssh and ~/.aws (arbitrary-secret read, F1)", () => {
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    const ssh = join(fixtureHome, ".ssh");
    const aws = join(fixtureHome, ".aws");
    expect(generated.text).toContain(`(deny file-read* (subpath "${ssh}"))`);
    expect(generated.text).toContain(`(deny file-write* (subpath "${ssh}"))`);
    expect(generated.text).toContain(`(deny file-read* (subpath "${aws}"))`);
    expect(generated.text).toContain(`(deny file-write* (subpath "${aws}"))`);
  });

  test("cortex#2409 — denies read+write on every extended sensitive-set entry (except Keychains, see next test)", () => {
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    const extended = [
      join(fixtureHome, ".gnupg"),
      join(fixtureHome, ".docker", "config.json"),
      join(fixtureHome, ".config", "gh", "hosts.yml"),
      join(fixtureHome, ".netrc"),
      join(fixtureHome, ".git-credentials"),
      join(fixtureHome, ".kube", "config"),
      join(fixtureHome, ".npmrc"),
      join(fixtureHome, ".pypirc"),
      join(fixtureHome, ".cargo", "credentials.toml"),
      join(fixtureHome, ".config", "op"),
    ];
    for (const p of extended) {
      expect(generated.text).toContain(`(deny file-read* (subpath "${p}"))`);
      expect(generated.text).toContain(`(deny file-write* (subpath "${p}"))`);
    }
  });

  test("cortex#2409 — ~/Library/Keychains denies WRITE only, read stays open (empirically forced — see module doc's two-round story)", () => {
    // Measured on a real host, TWICE: a real `claude --print` session both
    // stats the keychain (file-read-metadata) AND reads its login-
    // credential DATA (file-read-data) on every start — `claude` itself
    // uses the OS keychain for auth state. `file-read*` broke a real
    // session outright; even the narrower `file-read-data` still broke
    // login ("Not logged in · Please run /login"). Read must stay fully
    // open here; only WRITE (tamper) is denied. See the module doc + the
    // real end-to-end acceptance test (cc-session-macos-sandbox-e2e).
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    const keychains = join(fixtureHome, "Library", "Keychains");
    expect(generated.text).toContain(`(deny file-write* (subpath "${keychains}"))`);
    expect(generated.text).not.toContain(`(deny file-read* (subpath "${keychains}"))`);
    expect(generated.text).not.toContain(`(deny file-read-data (subpath "${keychains}"))`);
  });

  test("cortex#2409 — deliberately does NOT deny ~/.gitconfig or shell histories (see module doc rationale)", () => {
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    const excluded = [
      join(fixtureHome, ".gitconfig"),
      join(fixtureHome, ".zsh_history"),
      join(fixtureHome, ".bash_history"),
    ];
    for (const p of excluded) {
      expect(generated.text).not.toContain(`(subpath "${p}")`);
    }
  });

  test("denies WRITE (not read) on settings.json and hooks/ — self-modification, compat contract needs hook read+exec", () => {
    const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
    const settings = join(fixtureHome, ".claude", "settings.json");
    const hooks = join(fixtureHome, ".claude", "hooks");
    expect(generated.text).toContain(`(deny file-write* (subpath "${settings}"))`);
    expect(generated.text).not.toContain(`(deny file-read* (subpath "${settings}"))`);
    expect(generated.text).toContain(`(deny file-write* (subpath "${hooks}"))`);
    expect(generated.text).not.toContain(`(deny file-read* (subpath "${hooks}"))`);
  });

  test("readOnly dirs get WRITE-deny only (F6) — read stays allowed via (allow default)", () => {
    const roDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-ro-"));
    try {
      const generated = generateMacosSbplProfile(
        baseProfile({ readOnly: [roDir] }),
        { homeDir: fixtureHome },
      );
      const real = realpathSync(roDir);
      expect(generated.text).toContain(`(deny file-write* (subpath "${real}"))`);
      expect(generated.text).not.toContain(`(deny file-read* (subpath "${real}"))`);
    } finally {
      rmSync(roDir, { recursive: true, force: true });
    }
  });

  test("extraDenyPaths get read+write deny — the generic 'out of scope' escape hatch", () => {
    const otherDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-other-stack-"));
    try {
      const generated = generateMacosSbplProfile(baseProfile(), {
        homeDir: fixtureHome,
        extraDenyPaths: [otherDir],
      });
      const real = realpathSync(otherDir);
      expect(generated.text).toContain(`(deny file-read* (subpath "${real}"))`);
      expect(generated.text).toContain(`(deny file-write* (subpath "${real}"))`);
      expect(generated.resolvedDenyPaths).toContain(real);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("E3 REGRESSION (generator-level): extraDenyPaths given a SYMLINK resolves+denies the REAL target, not the literal alias", () => {
    // The generator-side half of the E3 discipline: prove
    // generateMacosSbplProfile itself resolves a symlinked INPUT before
    // writing the deny rule, using a real filesystem symlink (not `/tmp`,
    // which the dedicated real-sandbox-exec E3 tests below already cover
    // for the well-known-alias case). A caller passing a symlinked path
    // into extraDenyPaths (e.g. a stack dir reached via a symlinked
    // Developer/ checkout) must still get the REAL target denied.
    const realTargetParent = mkdtempSync(join(tmpdir(), "cortex-sbpl-e3gen-real-"));
    const realTarget = join(realTargetParent, "actual-dir");
    mkdirSync(realTarget);
    const symlinkParent = mkdtempSync(join(tmpdir(), "cortex-sbpl-e3gen-link-"));
    const symlinkPath = join(symlinkParent, "via-symlink");
    symlinkSync(realTarget, symlinkPath);
    try {
      const generated = generateMacosSbplProfile(baseProfile(), {
        homeDir: fixtureHome,
        extraDenyPaths: [symlinkPath], // the UNRESOLVED alias, deliberately
      });
      const resolvedReal = realpathSync(realTarget);
      // The deny rule targets the RESOLVED real path…
      expect(generated.text).toContain(`(deny file-read* (subpath "${resolvedReal}"))`);
      // …NOT the literal symlink path string.
      expect(generated.text).not.toContain(symlinkPath);
      expect(generated.resolvedDenyPaths).toContain(resolvedReal);
    } finally {
      rmSync(realTargetParent, { recursive: true, force: true });
      rmSync(symlinkParent, { recursive: true, force: true });
    }
  });

  test("readWrite/execAllow/egressAllow are NOT projected into the text — (allow default) already covers them", () => {
    const workDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-work-"));
    try {
      const generated = generateMacosSbplProfile(
        baseProfile({ readWrite: [workDir], execAllow: ["claude"], egressAllow: ["api.anthropic.com"] }),
        { homeDir: fixtureHome },
      );
      expect(generated.text).not.toContain(realpathSync(workDir));
      expect(generated.text).not.toContain("process-exec");
      expect(generated.text).not.toContain("api.anthropic.com");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("a path that fails to realpath-resolve (NUL byte) is EXCLUDED from the profile and reported in `unresolved` — fail closed, not fail open", () => {
    const nulPath = join(fixtureHome, "a") + String.fromCharCode(0) + "b";
    const generated = generateMacosSbplProfile(baseProfile(), {
      homeDir: fixtureHome,
      extraDenyPaths: [nulPath],
    });
    expect(generated.text).not.toContain(String.fromCharCode(0));
    const unresolvedInputs = generated.unresolved.map((u) => u.input);
    expect(unresolvedInputs).toContain(nulPath);
  });

  test("SBPL string-literal escaping: a path containing a double quote is escaped, not left to break the profile syntax", () => {
    // Construct (don't create on disk — just prove the escaping happens on
    // the STRING regardless of whether the path resolves) a deny entry with
    // an embedded quote via extraDenyPaths pointing at a real dir, then spot
    // check the quoting helper indirectly: a resolvable dir with no quote
    // never needs escaping, so assert on the direct sbplQuote-shaped output
    // by using a dir name that legitimately contains a quote character.
    const quotedDirName = 'weird"name';
    const parent = mkdtempSync(join(tmpdir(), "cortex-sbpl-quote-"));
    const quotedDir = join(parent, quotedDirName);
    try {
      mkdirSync(quotedDir);
      const generated = generateMacosSbplProfile(baseProfile(), {
        homeDir: fixtureHome,
        extraDenyPaths: [quotedDir],
      });
      const real = realpathSync(quotedDir);
      const escaped = real.replace(/"/g, '\\"');
      expect(generated.text).toContain(escaped);
      // No UNESCAPED quote should appear inside a subpath string literal.
      expect(generated.text).not.toContain(`"${real}"`.replace('\\"', '"'));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// parseSandboxDenialLogLine — pure parser, verified against THIS host's real
// `log stream --style ndjson` output shape (module doc comment)
// -----------------------------------------------------------------------------

describe("parseSandboxDenialLogLine", () => {
  const REAL_LINE = JSON.stringify({
    eventMessage: "Sandbox: cat(2081) deny(1) file-read-data /private/tmp/x/secret.txt",
    timestamp: "2026-07-26 01:42:39.367453+1200",
  });

  test("parses a real-shaped denial line for the matching pid", () => {
    const denial = parseSandboxDenialLogLine(REAL_LINE, 2081);
    expect(denial).toBeDefined();
    expect(denial?.path).toBe("/private/tmp/x/secret.txt");
    expect(denial?.reason).toBe("file-read-data denied");
    expect(denial?.timestamp).toBe("2026-07-26 01:42:39.367453+1200");
  });

  test("write-deny operation shape (file-write-create) also parses", () => {
    const line = JSON.stringify({
      eventMessage: "Sandbox: tee(3894) deny(1) file-write-create /private/tmp/x/out.txt",
      timestamp: "2026-07-26 01:43:57.575665+1200",
    });
    const denial = parseSandboxDenialLogLine(line, 3894);
    expect(denial?.reason).toBe("file-write-create denied");
  });

  test("a denial for a DIFFERENT pid is ignored (undefined)", () => {
    expect(parseSandboxDenialLogLine(REAL_LINE, 9999)).toBeUndefined();
  });

  test("malformed (non-JSON) lines never throw — return undefined", () => {
    expect(parseSandboxDenialLogLine("Filtering the log data using…", 2081)).toBeUndefined();
    expect(parseSandboxDenialLogLine("", 2081)).toBeUndefined();
    expect(parseSandboxDenialLogLine("{not json", 2081)).toBeUndefined();
  });

  test("a well-formed JSON line with an unrelated eventMessage is ignored", () => {
    const line = JSON.stringify({ eventMessage: "some other kernel line", timestamp: "x" });
    expect(parseSandboxDenialLogLine(line, 2081)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Everything below spawns real `sandbox-exec` (and, for denial tests, real
// `log stream`) — macOS only.
// -----------------------------------------------------------------------------

describe.skipIf(!isDarwin)("DD-9 canary self-test — runMacosCanarySelfTest (real sandbox-exec)", () => {
  test("passes on this host: EPERM on the unresolved /tmp alias, deny rule authored against the resolved realpath", async () => {
    const result = await runMacosCanarySelfTest();
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("EPERM");
  }, 15_000);

  test("E3 regression, exact repro shape: a deny rule authored against the UNRESOLVED /tmp alias silently fails to deny", async () => {
    // This directly reproduces docs/design-session-sandbox-platforms.md's E3
    // finding on THIS host: the profile generator must NEVER do what this
    // test deliberately does (author a deny rule against an unresolved
    // path) — that's exactly why generateMacosSbplProfile always resolves
    // first. This test proves the underlying platform hazard is real, which
    // is what makes the canary (and the resolver) necessary in the first
    // place, not a redundant check.
    const marker = `cortex-e3-regression-${Date.now()}`;
    const unresolvedDir = join("/tmp", marker);
    const unresolvedFile = join(unresolvedDir, "secret.txt");
    mkdirSync(unresolvedDir, { recursive: true });
    writeFileSync(unresolvedFile, "should-be-unreadable");
    const profileDir = mkdtempSync(join(tmpdir(), "cortex-e3-profile-"));
    try {
      const badProfilePath = join(profileDir, "bad.sb");
      // Deliberately UNRESOLVED — the exact anti-pattern DD-9 exists to catch.
      writeFileSync(
        badProfilePath,
        `(version 1)\n(allow default)\n(deny file-read* (subpath "${unresolvedDir}"))\n`,
      );
      const proc = Bun.spawn(["sandbox-exec", "-f", badProfilePath, "/bin/cat", unresolvedFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      // The E3 failure: the read SUCCEEDS despite the deny rule "covering"
      // the same literal path string used to read it.
      expect(exitCode).toBe(0);
      expect(stdout).toContain("should-be-unreadable");
    } finally {
      rmSync(unresolvedDir, { recursive: true, force: true });
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("the correct form (resolved realpath) DOES deny the same content via the unresolved alias — proves the mitigation, not just the hazard", async () => {
    const marker = `cortex-e3-fixed-${Date.now()}`;
    const unresolvedDir = join("/tmp", marker);
    const unresolvedFile = join(unresolvedDir, "secret.txt");
    mkdirSync(unresolvedDir, { recursive: true });
    writeFileSync(unresolvedFile, "should-be-unreadable");
    const resolvedDir = realpathSync(unresolvedDir);
    const profileDir = mkdtempSync(join(tmpdir(), "cortex-e3-profile-fixed-"));
    try {
      const goodProfilePath = join(profileDir, "good.sb");
      writeFileSync(
        goodProfilePath,
        `(version 1)\n(allow default)\n(deny file-read* (subpath "${resolvedDir}"))\n`,
      );
      const proc = Bun.spawn(["sandbox-exec", "-f", goodProfilePath, "/bin/cat", unresolvedFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Operation not permitted");
    } finally {
      rmSync(unresolvedDir, { recursive: true, force: true });
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(!isDarwin)("The four §5 'stops' — real sandbox-exec, fixture $HOME, forced enforce", () => {
  let fixtureHome: string;
  let allowedDir: string;
  let otherStackDir: string;

  beforeEach(() => {
    // realpathSync immediately — see the same-named fixture in the
    // `generateMacosSbplProfile` describe block above for why: `tmpdir()`
    // on macOS is itself under the `/var` → `/private/var` symlink (the E3
    // shape), and these tests read files via `fixtureHome`-joined paths
    // that must match what the generator resolved into the profile.
    fixtureHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-sbpl-stops-home-")));
    mkdirSync(join(fixtureHome, ".ssh"), { recursive: true });
    writeFileSync(join(fixtureHome, ".ssh", "id_ed25519"), "FAKE-PRIVATE-KEY");
    mkdirSync(join(fixtureHome, ".config", "metafactory", "cortex", "system"), { recursive: true });
    writeFileSync(
      join(fixtureHome, ".config", "metafactory", "cortex", "system", "system.yaml"),
      "token: FAKE-TOKEN",
    );
    allowedDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-stops-allowed-"));
    writeFileSync(join(allowedDir, "readonly.txt"), "ro-content");
    otherStackDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-stops-other-stack-"));
    writeFileSync(join(otherStackDir, "secret.txt"), "other-stack-secret");
  });

  afterEach(() => {
    rmSync(fixtureHome, { recursive: true, force: true });
    rmSync(allowedDir, { recursive: true, force: true });
    rmSync(otherStackDir, { recursive: true, force: true });
  });

  function runUnderProfile(argv: string[], extraDenyPaths: string[] = []): { exitCode: number; stdout: string; stderr: string } {
    const profile = baseProfile({ readOnly: [allowedDir] });
    const generated = generateMacosSbplProfile(profile, { homeDir: fixtureHome, extraDenyPaths });
    const profileDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-stops-profile-"));
    try {
      const profilePath = join(profileDir, "stop.sb");
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

  test("stop 1 — out-of-scope read (another stack's repo) is denied via extraDenyPaths", () => {
    const target = join(otherStackDir, "secret.txt");
    const r = runUnderProfile(["/bin/cat", target], [otherStackDir]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Operation not permitted");
    expect(r.stdout).not.toContain("other-stack-secret");
  });

  test("stop 2 — config-dir read is denied (CONFIG IMMUTABILITY)", () => {
    const target = join(fixtureHome, ".config", "metafactory", "cortex", "system", "system.yaml");
    const r = runUnderProfile(["/bin/cat", target]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Operation not permitted");
    expect(r.stdout).not.toContain("FAKE-TOKEN");
  });

  test("stop 3 — ~/.ssh read is denied", () => {
    const target = join(fixtureHome, ".ssh", "id_ed25519");
    const r = runUnderProfile(["/bin/cat", target]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Operation not permitted");
    expect(r.stdout).not.toContain("FAKE-PRIVATE-KEY");
  });

  test("stop 4 — write into a readOnlyDir is denied (F6)", () => {
    const target = join(allowedDir, "readonly.txt");
    const r = runUnderProfile(["/usr/bin/tee", target], []);
    // tee still exits non-zero here because the write is denied — spot
    // check via stderr rather than relying on tee's own exit-code contract.
    expect(r.stderr).toContain("Operation not permitted");
  });

  test("positive control — reading INSIDE the readOnlyDir (not writing) stays allowed", () => {
    const target = join(allowedDir, "readonly.txt");
    const r = runUnderProfile(["/bin/cat", target]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ro-content");
  });
});

describe.skipIf(!isDarwin)(
  "cortex#2409 — sensitive-set extension, real sandbox-exec against a fixture $HOME",
  () => {
    let fixtureHome: string;

    beforeEach(() => {
      // Same realpathSync-immediately discipline as the other fixture blocks
      // above (E3 shape under macOS's /var → /private/var symlink).
      fixtureHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-sbpl-2409-home-")));
    });

    afterEach(() => {
      rmSync(fixtureHome, { recursive: true, force: true });
    });

    function runProbe(relPath: string[], content: string, argv: (target: string) => string[]) {
      const dir = join(fixtureHome, ...relPath.slice(0, -1));
      mkdirSync(dir, { recursive: true });
      const target = join(fixtureHome, ...relPath);
      writeFileSync(target, content);

      const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
      const profileDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-2409-profile-"));
      try {
        const profilePath = join(profileDir, "probe.sb");
        writeFileSync(profilePath, generated.text);
        const result = Bun.spawnSync(["sandbox-exec", "-f", profilePath, ...argv(target)], {
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

    const readDenyCases: { name: string; relPath: string[] }[] = [
      { name: "~/.gnupg", relPath: [".gnupg", "secring.gpg"] },
      { name: "~/.docker/config.json", relPath: [".docker", "config.json"] },
      { name: "~/.config/gh/hosts.yml", relPath: [".config", "gh", "hosts.yml"] },
      { name: "~/.netrc", relPath: [".netrc"] },
      { name: "~/.git-credentials", relPath: [".git-credentials"] },
      { name: "~/.kube/config", relPath: [".kube", "config"] },
      { name: "~/.npmrc", relPath: [".npmrc"] },
      { name: "~/.pypirc", relPath: [".pypirc"] },
      { name: "~/.cargo/credentials.toml", relPath: [".cargo", "credentials.toml"] },
      { name: "~/.config/op", relPath: [".config", "op", "session.json"] },
    ];

    for (const c of readDenyCases) {
      test(`${c.name} read is denied — explicit EPERM ("Operation not permitted"), no content leak`, () => {
        const marker = `SECRET-${c.name}`;
        const r = runProbe(c.relPath, marker, (target) => ["/bin/cat", target]);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain("Operation not permitted");
        expect(r.stdout).not.toContain(marker);
      });
    }

    test("~/Library/Keychains WRITE is denied — explicit EPERM", () => {
      // Read is deliberately NOT tested as denied here — see the module doc
      // + the unit test above: read must stay open (empirically forced,
      // twice) for a real session's `claude` login-state check to work.
      const target = join(fixtureHome, "Library", "Keychains", "login.keychain-db");
      mkdirSync(join(fixtureHome, "Library", "Keychains"), { recursive: true });
      writeFileSync(target, "not-a-real-keychain");
      const generated = generateMacosSbplProfile(baseProfile(), { homeDir: fixtureHome });
      const profileDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-2409-profile-"));
      try {
        const profilePath = join(profileDir, "probe.sb");
        writeFileSync(profilePath, generated.text);
        // A shell redirect (not `tee`) — it never reads stdin, so the
        // denied open() is the entire command; no stdin-lifecycle question
        // (same pattern as the "stop 4" / "enforce" write-deny tests above).
        const result = Bun.spawnSync(
          ["sandbox-exec", "-f", profilePath, "/bin/sh", "-c", `echo appended >> ${target}`],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(result.stderr.toString()).toContain("Operation not permitted");
      } finally {
        rmSync(profileDir, { recursive: true, force: true });
      }
    });

    test("control — ~/Library/Keychains READ stays allowed (empirically forced compat exception)", () => {
      const r = runProbe(
        ["Library", "Keychains", "login.keychain-db"],
        "not-a-real-keychain",
        (target) => ["/bin/cat", target],
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("not-a-real-keychain");
    });

    test("control — ~/.gitconfig stays readable (deliberately NOT in the deny set)", () => {
      const r = runProbe([".gitconfig"], "[user]\n\tname = fixture\n", (target) => ["/bin/cat", target]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("[user]");
    });

    test("control — an ordinary workspace file stays readable ((allow default) still holds)", () => {
      const r = runProbe(["project", "README.md"], "hello world", (target) => ["/bin/cat", target]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hello world");
    });
  },
);

describe.skipIf(!isDarwin)("MacosSbplSandbox — spawn() mode gating", () => {
  test("mode 'off' — byte-identical Bun.spawn pass-through, no .sb profile, no canary", () => {
    const spy = spyOn(Bun, "spawn");
    try {
      const sandbox = new MacosSbplSandbox();
      const profile = baseProfile({ mode: "off" });
      const proc = sandbox.spawn(["/bin/echo", "hi"], profile, {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [argv] = spy.mock.calls[0] as [string[], unknown];
      expect(argv).toEqual(["/bin/echo", "hi"]);
      expect(sandbox.canaryResult).toBeUndefined();
      proc.kill();
    } finally {
      spy.mockRestore();
    }
  });

  test("mode 'audit' wraps argv with sandbox-exec -f <profile> and runs the canary", async () => {
    const sandbox = new MacosSbplSandbox();
    const profile = baseProfile({ mode: "audit" });
    const proc = sandbox.spawn(["/bin/echo", "hi"], profile, {
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await readAllStdout(proc.stdout);
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("hi");
    expect(sandbox.canaryResult?.passed).toBe(true);
  }, 15_000);

  test("audit mode with a FAILING canary logs a warning but still launches (does not block)", async () => {
    // Force the canary to observe "READ_OK" (the E3 failure shape) by
    // mocking Bun.spawnSync ONLY for the canary's own subprocess — spawn()
    // itself uses the async Bun.spawn for the actual session, so this does
    // not interfere with the real launch.
    const spy = spyOn(Bun, "spawnSync").mockImplementation(
      (() => ({
        exitCode: 0,
        stdout: Buffer.from("READ_OK"),
        stderr: Buffer.from(""),
        success: true,
        resourceUsage: undefined,
        signalCode: undefined,
      })) as unknown as typeof Bun.spawnSync,
    );
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const sandbox = new MacosSbplSandbox();
      const profile = baseProfile({ mode: "audit" });
      const proc = sandbox.spawn(["/bin/echo", "hi"], profile, {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0); // still launched — audit does not block
      expect(sandbox.canaryResult?.passed).toBe(false);
      const warned = stderrSpy.mock.calls.some((c) =>
        String(c[0]).includes("DD-9 canary self-test failed in audit mode"),
      );
      expect(warned).toBe(true);
    } finally {
      spy.mockRestore();
      stderrSpy.mockRestore();
    }
  }, 15_000);

  test("enforce mode with a FAILING canary REFUSES to launch (throws) — DD-9 fail-closed, HELD (mechanism only, no live caller sets 'enforce')", () => {
    const spy = spyOn(Bun, "spawnSync").mockImplementation(
      (() => ({
        exitCode: 0,
        stdout: Buffer.from("READ_OK"),
        stderr: Buffer.from(""),
        success: true,
        resourceUsage: undefined,
        signalCode: undefined,
      })) as unknown as typeof Bun.spawnSync,
    );
    try {
      const sandbox = new MacosSbplSandbox();
      const profile = baseProfile({ mode: "enforce" });
      expect(() =>
        sandbox.spawn(["/bin/echo", "hi"], profile, { env: {}, stdout: "pipe", stderr: "pipe" }),
      ).toThrow(/DD-9 canary self-test failed/);
    } finally {
      spy.mockRestore();
    }
  });

  test("enforce mode with a PASSING canary launches normally (real canary, no mocking)", async () => {
    const sandbox = new MacosSbplSandbox();
    const profile = baseProfile({ mode: "enforce" });
    const proc = sandbox.spawn(["/bin/echo", "hi"], profile, {
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(sandbox.canaryResult?.passed).toBe(true);
  }, 15_000);

  test("acceptance: a §5 'stop' (read-only-dir write, F6) IS denied end-to-end via the real class, under a locally-forced enforce", async () => {
    // Goes through the REAL production call site — `MacosSbplSandbox.spawn()`
    // with `mode: "enforce"` — rather than hand-driving `sandbox-exec`
    // directly (as the dedicated "four stops" describe block above does with
    // a homeDir-overridden fixture, since `spawn()` itself has no homeDir
    // override and always resolves the real `$HOME`). `readOnly` is a
    // profile-controlled fixture dir either way, so this is safe to run
    // against the real class without touching the machine's real
    // ~/.ssh/~/.config/metafactory/cortex.
    const roDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-enforce-stop-ro-"));
    writeFileSync(join(roDir, "f.txt"), "ro-content");
    try {
      const sandbox = new MacosSbplSandbox();
      const profile = baseProfile({ mode: "enforce", readOnly: [roDir] });
      // A shell redirect (not `tee`) — it never reads stdin at all, so the
      // denied open() is the ENTIRE command; no stdin-lifecycle question.
      const target = join(roDir, "f.txt");
      const proc = sandbox.spawn(["/bin/sh", "-c", `echo attempted-write > ${target}`], profile, {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await readAllStdout(proc.stderr);
      await proc.exited;
      expect(sandbox.canaryResult?.passed).toBe(true); // enforce actually ran (didn't refuse to launch)
      expect(stderr).toContain("Operation not permitted");
    } finally {
      rmSync(roDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(!isDarwin)("MacosSbplSandbox — denial observation end-to-end (real sandbox-exec + log stream)", () => {
  test("a real denied read under audit mode is observed via denials()", async () => {
    // realpathSync immediately — same E3-shaped `/var` → `/private/var`
    // rationale as the fixtures above.
    const fixtureHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-sbpl-denial-home-")));
    mkdirSync(join(fixtureHome, ".ssh"), { recursive: true });
    writeFileSync(join(fixtureHome, ".ssh", "id_ed25519"), "FAKE-KEY");
    try {
      const sandbox = new MacosSbplSandbox();
      const profile = baseProfile({ mode: "audit" });
      // Spawn a session that (after a short delay, to clear log-stream's
      // measured ~1s startup latency — module doc) attempts to read the
      // denied ~/.ssh fixture file, using the profile's OWN generated text
      // by constructing the argv the way spawn() itself would, but with a
      // homeDir override — spawn() doesn't take opts for homeDir, so this
      // test drives generateMacosSbplProfile + sandbox-exec directly and
      // asserts the PARSER against a live log-stream tail, rather than
      // routing through spawn() (which always resolves $HOME for real).
      const generated = generateMacosSbplProfile(profile, { homeDir: fixtureHome });
      const profileDir = mkdtempSync(join(tmpdir(), "cortex-sbpl-denial-profile-"));
      const profilePath = join(profileDir, "denial.sb");
      writeFileSync(profilePath, generated.text);

      const target = join(fixtureHome, ".ssh", "id_ed25519");
      // 2500ms — the module doc's measured ~1s `log stream` startup latency
      // plus headroom. This test flaked at 1200ms under load (other tests'
      // recently-spawned sandbox-exec/log processes appear to add jitter to
      // unified-log delivery) — this is the SAME observability gap the
      // module doc discloses, not a new one; the wider margin is a test
      // robustness fix, not evidence the underlying enforcement is delayed
      // (SBPL enforcement itself is not delayed — only the LOG ENTRY is).
      const script = `setTimeout(() => { try { require("fs").readFileSync(${JSON.stringify(target)}); } catch (e) { } }, 2500);`;

      const logProc = Bun.spawn(
        ["sandbox-exec", "-f", profilePath, "bun", "-e", script],
        { stdout: "ignore", stderr: "ignore" },
      );

      const observed: { path?: string; reason: string }[] = [];
      const denialAbort = new AbortController();
      const tail = (async () => {
        const proc = Bun.spawn(
          ["log", "stream", "--style", "ndjson", "--predicate", `eventMessage CONTAINS "(${logProc.pid}) deny"`],
          { stdout: "pipe", stderr: "ignore" },
        );
        denialAbort.signal.addEventListener("abort", () => { try { proc.kill(); } catch { /* already exited */ } });
        if (!proc.stdout || typeof proc.stdout === "number") return;
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const denial = parseSandboxDenialLogLine(line, logProc.pid);
              if (denial) observed.push(denial);
            }
          }
        } catch { /* stream closed on abort — expected */ }
      })();

      await logProc.exited;
      // Grace period AFTER the subject process has exited — the log entry
      // for a denial that happened right before exit can still be in-flight
      // through the unified-log pipeline (module doc's observability gap).
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      denialAbort.abort();
      await tail;

      expect(observed.length).toBeGreaterThan(0);
      expect(observed[0]?.path).toContain("id_ed25519");
      rmSync(profileDir, { recursive: true, force: true });
    } finally {
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  }, 20_000);
});
