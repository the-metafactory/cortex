/**
 * cortex#2094 (L3) — `cortex quickstart` CLI dispatcher tests.
 *
 * Exercises the full 8-step orchestration through `dispatchQuickstart` with
 * an INJECTED fake `QuickstartPorts` bundle (never a real `systemctl` /
 * `loginctl` / `claude` spawn, never a real HTTP call, never a real
 * wall-clock wait in the gate poll loop — `gate.sleep`/`gate.now` are a fake
 * deterministic clock). Steps 3-5 (nats conf / scaffold / config patch) do
 * real fs I/O against a fresh tmp `--config-dir`/`--nats-dir` per test —
 * NEVER the real `~/.config/cortex`.
 *
 * `$HOME` is sandboxed for the whole file (mirrors `stack-cli.test.ts`):
 * `stack create --apply`'s workspace-dir creation (cortex#2097) resolves off
 * `homedir()`, not `--config-dir`, so it must be redirected too.
 *
 * Covers: preflight failure modes (incl. the cortex#2068 auth-failure
 * message reuse), env-contract gating, nats-conf write/refuse/--force,
 * scaffold + idempotent re-run, the injectable systemd seam (unit files
 * missing / enable failure / happy path, all on a FAKED "linux"
 * `process.platform` — never a real systemd host), the gate's bounded-wait
 * timeout, and — end to end — that the Discord bot token NEVER appears
 * anywhere in `stdout` across a full run, and that a second run mutates
 * NOTHING (a full before/after fs snapshot of the config + nats trees).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchQuickstart } from "../quickstart";
import { daemonErrorLogPath, daemonLogPath, launchdStackLabel } from "../quickstart-lib";
import type {
  CommandResult,
  GatePort,
  PreflightPorts,
  ProvisionPort,
  QuickstartPorts,
  ServicePort,
} from "../quickstart-ports";

const SECRET_TOKEN = "THE-REAL-DISCORD-BOT-TOKEN-VALUE-abc123";

// =============================================================================
// $HOME sandbox (cortex#2097 workspace-dir creation resolves off homedir())
// =============================================================================

let sandboxHome: string;
let savedHome: string | undefined;
beforeAll(() => {
  savedHome = process.env.HOME;
  sandboxHome = mkdtempSync(join(tmpdir(), "c2094-quickstart-home-"));
  process.env.HOME = sandboxHome;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(sandboxHome, { recursive: true, force: true });
});

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "c2094-quickstart-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// =============================================================================
// process.platform sandbox — Linux-only step 7 is exercised via a FAKED
// platform value, never a real systemd host.
// =============================================================================

// `dispatchQuickstart` is async — step 7's `process.platform` read happens
// well after several `await`s, so the override must stay in place across the
// WHOLE awaited call, not just the synchronous call-setup. Restoring in a
// non-awaited `finally` (the naive version) resets `platform` before step 7
// ever runs.
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
  }
}

// =============================================================================
// CTX_* env sandbox
// =============================================================================

const CTX_KEYS = [
  "CTX_PRINCIPAL",
  "CTX_SLUG",
  "CTX_NATS_PORT",
  "CTX_NATS_MON",
  "CTX_GUILD_ID",
  "CTX_CHANNEL_ID",
  "CTX_LOG_CHANNEL_ID",
  "CTX_MY_DISCORD_ID",
  "CTX_DISCORD_TOKEN",
  // cortex#2153 — web surface contract keys (cleared/restored per test too).
  "CTX_WEB_HOST",
  "CTX_WEB_PORT",
  "CTX_WEB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

function withEnv<T>(env: Partial<Record<(typeof CTX_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of CTX_KEYS) saved[k] = process.env[k];
  for (const k of CTX_KEYS) Reflect.deleteProperty(process.env, k);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return fn().finally(() => {
    for (const k of CTX_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });
}

function validCtxEnv(overrides: Partial<Record<(typeof CTX_KEYS)[number], string>> = {}): Record<string, string> {
  return {
    CTX_PRINCIPAL: "andreas",
    CTX_SLUG: "work",
    CTX_NATS_PORT: "4222",
    CTX_NATS_MON: "8222",
    CTX_GUILD_ID: "111111111111111111",
    CTX_CHANNEL_ID: "222222222222222222",
    CTX_LOG_CHANNEL_ID: "333333333333333333",
    CTX_MY_DISCORD_ID: "444444444444444444",
    CTX_DISCORD_TOKEN: SECRET_TOKEN,
    ...overrides,
  };
}

const WEB_SECRET_TOKEN = "THE-REAL-WEB-AUTH-TOKEN-VALUE-xyz789";

/** A valid WEB env — the shared identity keys + host/port/token, NO Discord
 *  snowflakes (cortex#2153). */
function validWebCtxEnv(overrides: Partial<Record<(typeof CTX_KEYS)[number], string>> = {}): Record<string, string> {
  return {
    CTX_PRINCIPAL: "andreas",
    CTX_SLUG: "gateway",
    CTX_NATS_PORT: "4222",
    CTX_NATS_MON: "8222",
    CTX_WEB_HOST: "127.0.0.1",
    CTX_WEB_PORT: "8090",
    CTX_WEB_TOKEN: WEB_SECRET_TOKEN,
    ...overrides,
  };
}

// =============================================================================
// Fake ports
// =============================================================================

const FULL_HEALTHY_LOG = [
  "Stack: andreas/work",
  "connected to nats://127.0.0.1:4222",
  "policy-engine active — principals=2",
  "discord adapter started (… Guild: 111111111111111111)",
  "connected as Bot#0001",
].join("\n");

interface FakeOverrides {
  which?: (bin: string) => string | undefined;
  claudeVersion?: () => CommandResult;
  lingerStatus?: () => "yes" | "no" | "unknown";
  unitFileExists?: (unit: string) => boolean;
  daemonReload?: () => CommandResult;
  enableNow?: (units: string[]) => CommandResult;
  // cortex#2283 — restart-on-re-run seams. Defaults: try-restart/kickstart
  // succeed; isActive false (fresh boot); launchd NOT loaded (so darwin tests
  // that don't opt in keep the pre-#2283 "handled by arc" skip path).
  tryRestart?: (units: string[]) => CommandResult;
  isActive?: (unit: string) => boolean;
  launchdServiceLoaded?: (label: string) => boolean;
  launchdKickstart?: (label: string) => CommandResult;
  // cortex#2264/#2283 — records the per-file log truncations step 7 performs
  // before the (re)start: called TWICE, once for the main `.log` and once for
  // the `.error.log` (so a test can assert both ran, with what paths, and in
  // what order relative to the restart).
  truncateLog?: (logPath: string) => void;
  provisionSeed?: () => CommandResult;
  // cortex#2264 — takes the polled path so a test can return DIFFERENT content
  // for the main `.log` vs the `.error.log` sibling. Existing zero-arg lambdas
  // stay assignable (a `() => T` satisfies `(p: string) => T`).
  readLog?: (logPath: string) => string | undefined;
  fetchHealthz?: () => Promise<boolean>;
}

function fakePorts(overrides: FakeOverrides = {}): QuickstartPorts {
  let clock = 0;
  const preflight: PreflightPorts = {
    which: overrides.which ?? ((bin) => `/usr/bin/${bin}`),
    claudeVersion: overrides.claudeVersion ?? (() => ({ exitCode: 0, stdout: "2.1.0", stderr: "" })),
    lingerStatus: overrides.lingerStatus ?? (() => "yes"),
  };
  const service: ServicePort = {
    unitFileExists: overrides.unitFileExists ?? (() => true),
    daemonReload: overrides.daemonReload ?? (() => ({ exitCode: 0, stdout: "", stderr: "" })),
    truncateLog: overrides.truncateLog ?? (() => {}),
    enableNow: overrides.enableNow ?? (() => ({ exitCode: 0, stdout: "", stderr: "" })),
    tryRestart: overrides.tryRestart ?? (() => ({ exitCode: 0, stdout: "", stderr: "" })),
    isActive: overrides.isActive ?? (() => false),
    launchdServiceLoaded: overrides.launchdServiceLoaded ?? (() => false),
    launchdKickstart: overrides.launchdKickstart ?? (() => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
  const provision: ProvisionPort = {
    provisionSeed: overrides.provisionSeed ?? (() => ({ exitCode: 0, stdout: "  ⊘ NKey already exists — reusing\n", stderr: "" })),
  };
  const gate: GatePort = {
    readLog: overrides.readLog ?? (() => FULL_HEALTHY_LOG),
    fetchHealthz: overrides.fetchHealthz ?? (() => Promise.resolve(true)),
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
  return { preflight, service, provision, gate };
}

/** Recursive snapshot of every file's size + mtime under `dirs` — used to
 *  prove a re-run mutates NOTHING (cortex#2094 acceptance criteria). */
function snapshotTree(dirs: string[]): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[full] = { size: st.size, mtimeMs: st.mtimeMs };
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

// =============================================================================
// --help / usage
// =============================================================================

describe("dispatchQuickstart — usage", () => {
  test("--help → exit 0, describes the 8 steps", async () => {
    const res = await dispatchQuickstart(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex quickstart");
    expect(res.stdout).toContain("CTX_PRINCIPAL");
  });

  test("unknown flag → exit 2", async () => {
    const res = await dispatchQuickstart(["--bogus"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unknown flag: --bogus");
  });

  test("--config-dir with no value → exit 2", async () => {
    const res = await dispatchQuickstart(["--config-dir"]);
    expect(res.exitCode).toBe(2);
  });
});

// =============================================================================
// Step 1 — preflight
// =============================================================================

describe("dispatchQuickstart — step 1 preflight", () => {
  test("bun missing on PATH → exit 1, stops before env validation", async () => {
    const res = await withEnv({}, () =>
      dispatchQuickstart([], () => fakePorts({ which: (bin) => (bin === "bun" ? undefined : `/usr/bin/${bin}`) })),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("bun on PATH");
    // never reached step 2 — no env-contract table printed.
    expect(res.stdout).not.toContain("Validate env contract");
  });

  test("claude missing on PATH → exit 1, actionable install hint", async () => {
    const res = await withEnv({}, () =>
      dispatchQuickstart([], () => fakePorts({ which: (bin) => (bin === "claude" ? undefined : `/usr/bin/${bin}`) })),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("claude on PATH — install Claude Code first");
  });

  test("claude present but auth expired → cortex#2068 message verbatim", async () => {
    const res = await withEnv({}, () =>
      dispatchQuickstart([], () =>
        fakePorts({
          claudeVersion: () => ({
            exitCode: 1,
            stdout: "",
            stderr: "Error: OAuth token has expired. Please run `claude login` to re-authenticate.",
          }),
        }),
      ),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("the host's authentication has expired");
    expect(res.stdout).toContain("run `claude` in a terminal");
  });

  test("nats-server missing on PATH → exit 1", async () => {
    const res = await withEnv({}, () =>
      dispatchQuickstart([], () => fakePorts({ which: (bin) => (bin === "nats-server" ? undefined : `/usr/bin/${bin}`) })),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("nats-server on PATH");
  });

  test("Linux + linger disabled → exit 1, prints the exact sudo command", async () => {
    const savedUser = process.env.USER;
    process.env.USER = "andreas";
    try {
      const res = await withPlatform("linux", () =>
        withEnv({}, () => dispatchQuickstart([], () => fakePorts({ lingerStatus: () => "no" }))),
      );
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toContain('sudo loginctl enable-linger "andreas"');
    } finally {
      if (savedUser === undefined) delete process.env.USER;
      else process.env.USER = savedUser;
    }
  });

  test("Linux + linger status unknown → soft warning only, proceeds past preflight", async () => {
    const res = await withPlatform("linux", () =>
      withEnv({}, () => dispatchQuickstart([], () => fakePorts({ lingerStatus: () => "unknown" }))),
    );
    // env is empty in this test → step 2 fails (exit 2), proving step 1 passed.
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("linger status unknown");
  });

  test("macOS host never checks linger at all", async () => {
    const res = await withPlatform("darwin", () =>
      withEnv({}, () => dispatchQuickstart([], () => fakePorts())),
    );
    expect(res.stdout).not.toContain("linger");
  });
});

// =============================================================================
// Step 2 — env contract (integration-level; the full matrix is in
// quickstart-lib.test.ts)
// =============================================================================

describe("dispatchQuickstart — step 2 env contract", () => {
  test("no CTX_* set at all → exit 2 with the table, preflight already passed", async () => {
    const res = await withEnv({}, () => dispatchQuickstart([], () => fakePorts()));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("✓ bun on PATH");
    expect(res.stdout).toContain("✗ CTX_SLUG: missing");
  });

  test("CTX_DISCORD_TOKEN missing → exit 2 (it gates, never silently proceeds)", async () => {
    const env = validCtxEnv();
    delete (env as Record<string, string | undefined>).CTX_DISCORD_TOKEN;
    const res = await withEnv(env, () => dispatchQuickstart([], () => fakePorts()));
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("CTX_DISCORD_TOKEN: missing");
  });
});

// =============================================================================
// Step 3 — nats conf write / refuse / --force
// =============================================================================

describe("dispatchQuickstart — step 3 nats conf", () => {
  test("a hand-written DIFFERENT .conf is refused without --force, and left untouched", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const confPath = join(natsDir, "work.conf");
    writeFileSync(confPath, "# a principal's hand-tuned conf\nlisten: 127.0.0.1:9999\n");

    const res = await withEnv(validCtxEnv(), () =>
      dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir], () => fakePorts()),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("refusing to overwrite without --force");
    expect(readFileSync(confPath, "utf-8")).toContain("a principal's hand-tuned conf");
  });

  test("--force overwrites a differing .conf", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const confPath = join(natsDir, "work.conf");
    writeFileSync(confPath, "# stale\nlisten: 127.0.0.1:9999\n");

    const res = await withEnv(validCtxEnv(), () =>
      dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--force"], () => fakePorts()),
    );
    // step 3 itself must succeed (may still fail later steps — that's fine,
    // this test only asserts the conf got overwritten).
    expect(res.stdout).toContain("overwritten (--force)");
    expect(readFileSync(confPath, "utf-8")).toContain("listen: 127.0.0.1:4222");
  });

  // cortex#2229 — the DEFAULT nats-dir ("~/.config/nats") must be tilde-expanded.
  // Prior tests always passed an explicit --nats-dir, so the literal-`~` default
  // was never exercised: path.join left the `~` literal (a `./~/.config/nats`
  // dir under cwd) and the rendered store_dir kept a `~` nats-server can't resolve.
  test("default nats-dir expands ~ — conf lands under $HOME, not a literal ~ (cortex#2229)", async () => {
    const configDir = freshDir();
    // Deliberately NO --nats-dir → exercises the "~/.config/nats" default.
    // $HOME is sandboxed (beforeAll), so it expands inside the sandbox.
    await withEnv(validCtxEnv(), () =>
      dispatchQuickstart(["--config-dir", configDir], () => fakePorts()),
    );
    const natsHome = join(process.env.HOME!, ".config", "nats");
    const expandedConf = join(natsHome, "work.conf");
    // The conf was written at the EXPANDED path (proves join saw an absolute dir).
    expect(existsSync(expandedConf)).toBe(true);
    const conf = readFileSync(expandedConf, "utf-8");
    // store_dir is expanded — no literal `~` that nats-server would choke on.
    expect(conf).toContain(`store_dir: ${natsHome}/work-jetstream`);
    expect(conf).not.toContain("store_dir: ~");
  });

  test("--nats-dir given a literal ~ path is expanded (cortex#2229)", async () => {
    const configDir = freshDir();
    await withEnv(validCtxEnv(), () =>
      dispatchQuickstart(["--config-dir", configDir, "--nats-dir", "~/natsq"], () => fakePorts()),
    );
    const expandedConf = join(process.env.HOME!, "natsq", "work.conf");
    expect(existsSync(expandedConf)).toBe(true);
    expect(readFileSync(expandedConf, "utf-8")).not.toContain("store_dir: ~");
  });
});

// =============================================================================
// Step 7 — the injectable systemd seam (FAKED "linux", never a real host)
// =============================================================================

describe("dispatchQuickstart — step 7 services (injected, faked platform)", () => {
  test("missing L1 unit files → exit 1, names cortex#2071 as the dependency", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () => fakePorts({ unitFileExists: () => false }),
        ),
      ),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("REQUIRES cortex#2071");
  });

  test("enable --now failure surfaces systemctl's stderr and exits 1", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              enableNow: () => ({ exitCode: 1, stdout: "", stderr: "Failed to enable unit: Unit not found." }),
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Unit not found");
  });

  test("--skip-services bypasses the whole step even on a faked Linux platform", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir, "--skip-services"],
          () => fakePorts({ unitFileExists: () => false }), // would fail step 7 if NOT skipped
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--skip-services passed");
  });
});

// =============================================================================
// Step 8 — bounded-wait gate timeout (fake deterministic clock, no real wait)
// =============================================================================

describe("dispatchQuickstart — step 8 gate", () => {
  test("gate never satisfied → times out at the configured window, exit 1", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withEnv(validCtxEnv(), () =>
      dispatchQuickstart(
        ["--config-dir", configDir, "--nats-dir", natsDir, "--gate-timeout-ms", "5000"],
        () => fakePorts({ readLog: () => undefined, fetchHealthz: () => Promise.resolve(false) }),
      ),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("timed out after 5000ms");
    expect(res.stdout).toContain("✗ Stack:");
    expect(res.stdout).toContain("✗ nats /healthz");
  });

  // cortex#2264 — a bus-connect failure lands in the .error.log SIBLING, not
  // the polled .log. The gate must FAIL FAST surfacing the real error, never
  // silently burn the whole timeout window.
  test("cortex#2264: a bus-connect failure in the .error.log fast-fails and surfaces the real error", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const FAILURE_LINE =
      "myelin-runtime: failed to connect — continuing without NATS: ENOENT: no such file or directory, open '~/.config/nats/work-bot.creds'";
    let sleepCalls = 0;
    const res = await withEnv(validCtxEnv(), () =>
      dispatchQuickstart(
        // A LONG timeout: a pre-fix silent-wait would burn the full window.
        ["--config-dir", configDir, "--nats-dir", natsDir, "--gate-timeout-ms", "600000"],
        () => {
          const ports = fakePorts({
            // Main .log carries a PARTIAL boot (no "connected to nats" — the
            // connect failed), so the success gate never passes; the .error.log
            // sibling carries the real failure. nats-server itself is up →
            // healthz true (exactly the bench repro: bus dark, nats alive).
            readLog: (p: string) => (p.endsWith(".error.log") ? FAILURE_LINE : "Stack: andreas/work\npolicy-engine active\n"),
            fetchHealthz: () => Promise.resolve(true),
          });
          // Count sleeps to prove we did NOT poll the full window.
          const origSleep = ports.gate.sleep;
          ports.gate.sleep = (ms: number) => {
            sleepCalls++;
            return origSleep(ms);
          };
          return ports;
        },
      ),
    );
    expect(res.exitCode).toBe(1);
    // FAST-FAIL: not the silent timeout message.
    expect(res.stdout).not.toContain("timed out after");
    // The ACTUAL error is surfaced, with its root cause.
    expect(res.stdout).toContain("bus connect FAILED");
    expect(res.stdout).toContain(FAILURE_LINE);
    expect(res.stdout).toContain(".error.log");
    // It fast-failed on the FIRST poll — no wait-window burn.
    expect(sleepCalls).toBe(0);
  });

  // cortex#2264 STALENESS (the realistic window the adversarial review caught):
  // a fresh boot the gate actually WAITS on — main log partial on poll 1, healthy
  // on poll 2 — with a STALE prior-boot failure line in the append-mode
  // .error.log. Step 7 truncates that .error.log before the (re)start, so the gate
  // must PASS on poll 2 and NEVER fast-fail on the stale line at poll 1.
  test("cortex#2264: a fresh boot with a partial→healthy log PASSES despite a stale .error.log failure (step 7 truncated it)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const STALE_FAILURE = "myelin-runtime: failed to connect — continuing without NATS: (a PRIOR boot's failure)";
    // Append-mode error log: starts with the stale prior-boot failure. Step 7's
    // truncate clears it before the daemon (re)starts.
    let errorLogContent = STALE_FAILURE;
    let mainPolls = 0;
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir, "--gate-timeout-ms", "600000"],
          () =>
            fakePorts({
              // Step 7 (Linux) truncates the append-mode error log before restart.
              truncateLog: () => {
                errorLogContent = "";
              },
              readLog: (p: string) => {
                if (p.endsWith(".error.log")) return errorLogContent;
                mainPolls++;
                // Poll 1: fresh daemon not yet connected (partial). Poll 2+: healthy.
                return mainPolls >= 2 ? FULL_HEALTHY_LOG : "Stack: andreas/work\npolicy-engine active\n";
              },
              // nats-server up throughout (bench repro shape).
              fetchHealthz: () => Promise.resolve(true),
            }),
        ),
      ),
    );
    // Truncation cleared the stale line before the gate ran → no false fast-fail;
    // the gate waits one poll and PASSES on the now-healthy boot.
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("bus connect FAILED");
    expect(res.stdout).toContain("Healthy-boot gate ✓");
  });

  // cortex#2264/#2283 — step 7 pair-truncates BOTH append-mode daemon logs at
  // the EXACT daemonLogPath + daemonErrorLogPath, BEFORE it (re)starts the
  // daemon (enable --now). Both directions matter: a stale .error.log failure
  // false-FAILS the gate (#2264); stale healthy .log lines false-PASS it over
  // a daemon that dies on relaunch (#2283 review F1).
  test("cortex#2264/#2283: step 7 truncates BOTH daemon logs (correct paths) before enable --now", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const calls: string[] = [];
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              truncateLog: (p: string) => calls.push(`truncate:${p}`),
              enableNow: (u: string[]) => {
                calls.push(`enable:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    const home = process.env.HOME ?? "";
    // BOTH truncations happened, targeting the exact gate-polled paths…
    expect(calls).toContain(`truncate:${daemonLogPath(home, "work")}`);
    expect(calls).toContain(`truncate:${daemonErrorLogPath(home, "work")}`);
    // …and BOTH happened BEFORE the (re)start.
    const lastTruncIdx = calls.map((c, i) => (c.startsWith("truncate:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const enableIdx = calls.findIndex((c) => c.startsWith("enable:"));
    expect(lastTruncIdx).toBeGreaterThanOrEqual(0);
    expect(enableIdx).toBeGreaterThan(lastTruncIdx);
  });
});

// =============================================================================
// cortex#2282 — macOS: unified log paths make the gate live on darwin
// =============================================================================

describe("dispatchQuickstart — cortex#2282 macOS gate (unified log paths)", () => {
  // The structural fix itself: the launchd stack plist template writes
  // Std{Out,Error}Path to the EXACT paths the gate greps (daemonLogPath /
  // daemonErrorLogPath). Substitute the renderer's tokens (plist-render.sh
  // sed) and compare byte-for-byte — the three log-path authorities (launchd
  // plist, systemd unit, gate) can no longer diverge silently on this axis.
  test("cortex#2282: stack plist template Std{Out,Error}Path match daemonLogPath/daemonErrorLogPath after token substitution", () => {
    const template = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "services", "ai.meta-factory.cortex.stack.plist"),
      "utf-8",
    );
    const home = "/home/principal";
    const slug = "work";
    const rendered = template.split("__HOME__").join(home).split("__STACK_SLUG__").join(slug);
    const outPath = /<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/.exec(rendered)?.[1];
    const errPath = /<key>StandardErrorPath<\/key>\s*<string>([^<]+)<\/string>/.exec(rendered)?.[1];
    expect(outPath).toBe(daemonLogPath(home, slug));
    expect(errPath).toBe(daemonErrorLogPath(home, slug));
  });

  // Simulated healthy boot on darwin: the fake readLog is PATH-STRICT — it
  // returns the 5 healthy lines ONLY for the exact daemonLogPath, so the test
  // fails if the gate ever polls any other path (the pre-fix macOS symptom:
  // polling a file launchd never wrote → silent 60s timeout).
  test("cortex#2282: darwin — healthy lines at daemonLogPath pass the gate", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const expectedLogPath = daemonLogPath(process.env.HOME ?? "", "work");
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              readLog: (p: string) => (p === expectedLogPath ? FULL_HEALTHY_LOG : undefined),
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Healthy-boot gate ✓");
  });

  // A1's (#2297) negative-space tripwire — "darwin NEVER truncates" — guarded
  // the UNPAIRED state and is superseded by cortex#2283: darwin now truncates
  // exactly when a restart follows (loaded → truncate + kickstart, covered in
  // the #2283 block below). What survives of the invariant is its real core:
  // NO restart → NO truncate. This test pins that on the not-loaded path.
  test("cortex#2283: darwin, service NOT loaded — no truncate, no kickstart (unpaired truncate stays impossible)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const truncateCalls: string[] = [];
    const kickstartCalls: string[] = [];
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              launchdServiceLoaded: () => false,
              truncateLog: (p: string) => truncateCalls.push(p),
              launchdKickstart: (label: string) => {
                kickstartCalls.push(label);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(truncateCalls).toEqual([]);
    expect(kickstartCalls).toEqual([]);
    expect(res.stdout).not.toContain("cleared prior-boot");
    // Today's arc-owned skip survives, and names the action taken.
    expect(res.stdout).toContain("launchd is handled by arc");
    expect(res.stdout).toContain("skip (not loaded — arc owns launchd load)");
  });

  // Linux ordering survives the cortex#2282 helper extraction (+ the
  // cortex#2283 both-logs widening): the truncate still happens between
  // daemon-reload and enable --now (covered in depth by the cortex#2264 tests
  // above — this is the regression tripwire for the step-7 output line
  // surviving the shared-helper refactors).
  test("cortex#2282: linux — step 7 still emits the cleared-logs line before enable --now", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cleared prior-boot logs");
    expect(res.stdout).toContain("enable --now");
  });
});

// =============================================================================
// cortex#2283 — A2: quickstart re-run restarts a running daemon
// =============================================================================

describe("dispatchQuickstart — cortex#2283 restart-on-re-run", () => {
  // The label authority pin: the helper step 7 kickstarts with must equal the
  // Label the plist template actually declares (after the renderer's
  // __STACK_SLUG__ substitution) — mirrors the cortex#2282 log-path pin.
  test("cortex#2283: launchdStackLabel matches the stack plist template Label after token substitution", () => {
    const template = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "services", "ai.meta-factory.cortex.stack.plist"),
      "utf-8",
    );
    const slug = "work";
    const rendered = template.split("__STACK_SLUG__").join(slug);
    const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(rendered)?.[1];
    expect(label).toBe(launchdStackLabel(slug));
  });

  // Linux recovery re-run (the issue's #1 newcomer trap): daemon RUNNING with
  // a broken-then-fixed config. `enable --now` is a silent no-op on active
  // units, so the try-restart of the probed-active units is what re-applies
  // the config. Full ordering contract asserted:
  // truncate(both logs) → enable --now → try-restart → gate.
  test("cortex#2283: linux, daemon running — active units try-restarted, ordering truncate(×2) → enable → try-restart → gate", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const calls: string[] = [];
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              isActive: (u: string) => {
                calls.push(`isActive:${u}`);
                return true; // daemon (and nats) running — the recovery re-run case
              },
              truncateLog: (p: string) => calls.push(`truncate:${p}`),
              enableNow: (u: string[]) => {
                calls.push(`enable:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
              tryRestart: (u: string[]) => {
                calls.push(`try-restart:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
              readLog: (p: string) => {
                calls.push("gate:readLog");
                return p.endsWith(".error.log") ? "" : FULL_HEALTHY_LOG;
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    // The exact restart invocation: BOTH units probed active → both restarted.
    expect(calls).toContain("try-restart:nats@work,cortex@work");
    // BOTH logs truncated (F1: stale healthy .log lines must not survive into
    // the gate any more than stale .error.log failures may).
    const home = process.env.HOME ?? "";
    expect(calls).toContain(`truncate:${daemonLogPath(home, "work")}`);
    expect(calls).toContain(`truncate:${daemonErrorLogPath(home, "work")}`);
    // Ordering: BOTH truncates strictly before the (re)start pair, gate after.
    const lastTruncIdx = calls.map((c, i) => (c.startsWith("truncate:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const enableIdx = calls.findIndex((c) => c.startsWith("enable:"));
    const restartIdx = calls.findIndex((c) => c.startsWith("try-restart:"));
    const gateIdx = calls.findIndex((c) => c === "gate:readLog");
    expect(lastTruncIdx).toBeGreaterThanOrEqual(0);
    expect(enableIdx).toBeGreaterThan(lastTruncIdx);
    expect(restartIdx).toBeGreaterThan(enableIdx);
    expect(gateIdx).toBeGreaterThan(restartIdx);
    // Output honesty: the action taken is named, per unit.
    expect(res.stdout).toContain("systemctl --user try-restart nats@work cortex@work");
    expect(res.stdout).toContain("restarted (config re-applied): nats@work cortex@work");
    expect(res.stdout).not.toContain("started (first boot)");
  });

  // Fresh boot: nothing active. enable --now does the starting (`--now` =
  // `start` — it STARTS stopped units) and NO try-restart is issued: the
  // probed-inactive units were just started by enable --now, and restarting
  // them mid-bus-connect would land a one-shot `failed to connect` marker in
  // the freshly-truncated .error.log → gate fast-fail on a healthy system
  // (adversarial review F2; the earlier "no-op on stopped units" framing was
  // a false model — try-restart of a just-STARTED unit is a real kill).
  test("cortex#2283: linux, fresh boot — started via enable --now; NO try-restart issued", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const calls: string[] = [];
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              isActive: () => false,
              enableNow: (u: string[]) => {
                calls.push(`enable:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
              tryRestart: (u: string[]) => {
                calls.push(`try-restart:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    // enable --now started everything; try-restart NEVER ran.
    expect(calls).toEqual(["enable:nats@work,cortex@work"]);
    expect(res.stdout).toContain("started (first boot): nats@work cortex@work");
    expect(res.stdout).not.toContain("restarted (config re-applied)");
    expect(res.stdout).not.toContain("try-restart");
  });

  // Stopped-after-failure (boot failed → daemon exited → fix config → re-run):
  // same call sequence as fresh boot — enable --now starts the stopped units,
  // NO try-restart — and the stale prior-boot .error.log is truncated so the
  // gate passes on the now-healthy boot instead of fast-failing stale.
  test("cortex#2283: linux, stopped-after-failure — started (no try-restart), stale .error.log truncated, gate passes", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const calls: string[] = [];
    let errorLogContent = "myelin-runtime: failed to connect — continuing without NATS: (the failed prior boot)";
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              isActive: () => false, // daemon exited after the failed boot
              truncateLog: (p: string) => {
                calls.push("truncate");
                if (p.endsWith(".error.log")) errorLogContent = "";
              },
              enableNow: (u: string[]) => {
                calls.push(`enable:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
              tryRestart: (u: string[]) => {
                calls.push(`try-restart:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
              readLog: (p: string) => (p.endsWith(".error.log") ? errorLogContent : FULL_HEALTHY_LOG),
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    // Both logs truncated, then started — never a try-restart of cold units.
    expect(calls).toEqual(["truncate", "truncate", "enable:nats@work,cortex@work"]);
    expect(res.stdout).toContain("started (first boot)");
    expect(res.stdout).not.toContain("bus connect FAILED");
    expect(res.stdout).toContain("Healthy-boot gate ✓");
  });

  // Mixed state (nats survived the failed boot, cortex died): try-restart is
  // scoped to EXACTLY the probed-active unit; the cold one is only started by
  // enable --now. Per-unit output honesty reports both actions accurately.
  test("cortex#2283: linux, mixed active/inactive — try-restart ONLY the active unit; per-unit honesty lines", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const calls: string[] = [];
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              isActive: (u: string) => u === "nats@work", // cortex@work is down
              enableNow: (u: string[]) => {
                calls.push(`enable:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
              tryRestart: (u: string[]) => {
                calls.push(`try-restart:${u.join(",")}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    // enable --now still targets both (enablement is idempotent; it also
    // STARTS the cold cortex@work) — then try-restart hits ONLY nats@work.
    expect(calls).toEqual(["enable:nats@work,cortex@work", "try-restart:nats@work"]);
    // Per-unit honesty: each unit reported under the action actually taken.
    expect(res.stdout).toContain("restarted (config re-applied): nats@work");
    expect(res.stdout).toContain("started (first boot): cortex@work");
  });

  test("cortex#2283: linux — try-restart failure surfaces systemctl's stderr and exits 1 (gate never runs)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    let readLogCalls = 0;
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              isActive: () => true, // running units — the try-restart path
              tryRestart: () => ({ exitCode: 1, stdout: "", stderr: "Job for cortex@work.service failed." }),
              readLog: () => {
                readLogCalls++;
                return FULL_HEALTHY_LOG;
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("try-restart");
    expect(res.stdout).toContain("Job for cortex@work.service failed.");
    expect(readLogCalls).toBe(0);
  });

  // macOS recovery re-run: service LOADED → kickstart -k, with the truncate
  // A1 (#2297) deliberately deferred now landing PAIRED with it. Full darwin
  // ordering contract asserted: truncate → kickstart → gate.
  test("cortex#2283: darwin, service loaded — truncate PAIRED with launchctl kickstart -k, ordering truncate → restart → gate", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const calls: string[] = [];
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              launchdServiceLoaded: (label: string) => {
                calls.push(`loaded?:${label}`);
                return true;
              },
              truncateLog: (p: string) => calls.push(`truncate:${p}`),
              launchdKickstart: (label: string) => {
                calls.push(`kickstart:${label}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              },
              readLog: (p: string) => {
                calls.push("gate:readLog");
                return p.endsWith(".error.log") ? "" : FULL_HEALTHY_LOG;
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    // The guard probed, then kickstart hit the EXACT plist Label.
    expect(calls).toContain(`loaded?:${launchdStackLabel("work")}`);
    expect(calls).toContain(`kickstart:${launchdStackLabel("work")}`);
    // BOTH truncates targeted the exact gate-polled paths (F1)…
    const home = process.env.HOME ?? "";
    expect(calls).toContain(`truncate:${daemonLogPath(home, "work")}`);
    expect(calls).toContain(`truncate:${daemonErrorLogPath(home, "work")}`);
    // …and the pairing/ordering holds: truncate(×2) → kickstart → gate.
    const lastTruncIdx = calls.map((c, i) => (c.startsWith("truncate:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const kickIdx = calls.findIndex((c) => c.startsWith("kickstart:"));
    const gateIdx = calls.findIndex((c) => c === "gate:readLog");
    expect(lastTruncIdx).toBeGreaterThanOrEqual(0);
    expect(kickIdx).toBeGreaterThan(lastTruncIdx);
    expect(gateIdx).toBeGreaterThan(kickIdx);
    // Output honesty.
    expect(res.stdout).toContain("launchctl kickstart -k");
    expect(res.stdout).toContain("restarted (config re-applied)");
  });

  test("cortex#2283: darwin — kickstart failure surfaces launchctl's stderr and exits 1 (gate never runs on a stale daemon)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    let readLogCalls = 0;
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              launchdServiceLoaded: () => true,
              launchdKickstart: () => ({ exitCode: 150, stdout: "", stderr: "Could not find service in domain" }),
              readLog: () => {
                readLogCalls++;
                return FULL_HEALTHY_LOG;
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("launchctl kickstart -k");
    expect(res.stdout).toContain("Could not find service in domain");
    // The gate never ran: after the truncate wiped prior-boot evidence, gating
    // a daemon we failed to restart could false-GREEN on stale healthy lines.
    expect(readLogCalls).toBe(0);
  });

  // --skip-services regression (byte-identical bypass): NO service-port method
  // is invoked at all — no probe, no truncate, no start, no restart — on
  // either platform's branch.
  test("cortex#2283: --skip-services still bypasses step 7 entirely — zero service-port calls (linux + darwin)", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const configDir = freshDir();
      const natsDir = freshDir();
      const calls: string[] = [];
      const res = await withPlatform(platform, () =>
        withEnv(validCtxEnv(), () =>
          dispatchQuickstart(
            ["--config-dir", configDir, "--nats-dir", natsDir, "--skip-services"],
            () =>
              fakePorts({
                unitFileExists: () => {
                  calls.push("unitFileExists");
                  return true;
                },
                daemonReload: () => {
                  calls.push("daemonReload");
                  return { exitCode: 0, stdout: "", stderr: "" };
                },
                isActive: () => {
                  calls.push("isActive");
                  return false;
                },
                truncateLog: () => calls.push("truncate"),
                enableNow: () => {
                  calls.push("enable");
                  return { exitCode: 0, stdout: "", stderr: "" };
                },
                tryRestart: () => {
                  calls.push("try-restart");
                  return { exitCode: 0, stdout: "", stderr: "" };
                },
                launchdServiceLoaded: () => {
                  calls.push("loaded?");
                  return true;
                },
                launchdKickstart: () => {
                  calls.push("kickstart");
                  return { exitCode: 0, stdout: "", stderr: "" };
                },
              }),
          ),
        ),
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("--skip-services passed — skipping");
      expect(calls).toEqual([]);
    }
  });

  // Output honesty in --json: the step-7 item names the action taken, per
  // unit on Linux (mixed states report both actions accurately).
  test("cortex#2283: --json step-7 item carries the per-unit action note (linux running/fresh/mixed, darwin restarted/skip)", async () => {
    interface Parsed {
      status: string;
      items?: { step: string; ok: string; note?: string }[];
    }
    const stepNote = (out: string): string | undefined =>
      (JSON.parse(out) as Parsed).items?.find((i) => i.step === "7. Services")?.note;

    const runJson = (platform: NodeJS.Platform, overrides: FakeOverrides) => {
      const configDir = freshDir();
      const natsDir = freshDir();
      return withPlatform(platform, () =>
        withEnv(validCtxEnv(), () =>
          dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--json"], () => fakePorts(overrides)),
        ),
      );
    };

    const linuxRunning = await runJson("linux", { isActive: () => true });
    expect(linuxRunning.exitCode).toBe(0);
    expect(stepNote(linuxRunning.stdout)).toBe("restarted (config re-applied): nats@work cortex@work");

    const linuxFresh = await runJson("linux", { isActive: () => false });
    expect(linuxFresh.exitCode).toBe(0);
    expect(stepNote(linuxFresh.stdout)).toBe("started (first boot): nats@work cortex@work");

    // Mixed state: per-unit honesty in the combined note.
    const linuxMixed = await runJson("linux", { isActive: (u: string) => u === "nats@work" });
    expect(linuxMixed.exitCode).toBe(0);
    expect(stepNote(linuxMixed.stdout)).toBe(
      "restarted (config re-applied): nats@work; started (first boot): cortex@work",
    );

    const darwinLoaded = await runJson("darwin", { launchdServiceLoaded: () => true });
    expect(darwinLoaded.exitCode).toBe(0);
    expect(stepNote(darwinLoaded.stdout)).toBe("restarted (config re-applied)");

    const darwinNotLoaded = await runJson("darwin", { launchdServiceLoaded: () => false });
    expect(darwinNotLoaded.exitCode).toBe(0);
    expect(stepNote(darwinNotLoaded.stdout)).toBe("skip (not loaded — arc owns launchd load)");
  });
});

// =============================================================================
// --container — skip step 8 (cortex#2155, L4 container standup)
// =============================================================================

describe("dispatchQuickstart — --container skips the healthy-boot gate", () => {
  test("--container skips step 8 with NO log-grep / healthz probe, and does not stall or fail", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    let readLogCalls = 0;
    let healthzCalls = 0;
    const res = await withEnv(validCtxEnv(), () =>
      dispatchQuickstart(
        // A gate that would NEVER pass if it ran (empty log + failing healthz)
        // — plus a tiny timeout that WOULD have surfaced a timeout message.
        ["--config-dir", configDir, "--nats-dir", natsDir, "--container", "--gate-timeout-ms", "5000"],
        () =>
          fakePorts({
            readLog: () => {
              readLogCalls++;
              return undefined;
            },
            fetchHealthz: () => {
              healthzCalls++;
              return Promise.resolve(false);
            },
          }),
      ),
    );
    // Exit 0 even though the gate ports are rigged to fail — because step 8
    // never ran.
    expect(res.exitCode).toBe(0);
    // Explicit skip marker (mirrors step 7's --skip-services convention).
    expect(res.stdout).toContain("--container passed");
    // No log-grep, no /healthz probe — the two things that cost the ~60s stall.
    expect(readLogCalls).toBe(0);
    expect(healthzCalls).toBe(0);
    // The gate's bounded-wait timeout path was never entered.
    expect(res.stdout).not.toContain("timed out after");
  });

  test("--container implies --skip-services (step 7 is skipped too, even on a faked Linux host)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir, "--container"],
          () => fakePorts({ unitFileExists: () => false }), // would fail step 7 if NOT skipped
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--skip-services passed");
    expect(res.stdout).toContain("--container passed");
  });

  test("--json under --container: envelope is ok and step 8 is reported (skipped), not omitted", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir, "--container", "--json"],
          () => fakePorts({ readLog: () => undefined, fetchHealthz: () => Promise.resolve(false) }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { status: string; items?: { step: string; ok: string }[] };
    expect(parsed.status).toBe("ok");
    // The trace still carries step 8 as an ok (skipped) entry — an observer
    // sees it explicitly skipped, not silently absent.
    expect(parsed.items?.some((i) => i.step === "8. Healthy-boot gate" && i.ok === "true")).toBe(true);
    expect(res.stdout).not.toContain(SECRET_TOKEN);
  });

  test("WITHOUT --container the gate still runs (default behaviour unchanged): the log IS grepped", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    let readLogCalls = 0;
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir],
          () =>
            fakePorts({
              readLog: () => {
                readLogCalls++;
                return FULL_HEALTHY_LOG;
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    // The gate ran — the log was grepped at least once — proving --container
    // is what suppresses it, not some unrelated change.
    expect(readLogCalls).toBeGreaterThan(0);
    expect(res.stdout).not.toContain("--container passed");
  });
});

// =============================================================================
// --skip-gate — defer step 8 to the supervisor healthcheck (cortex#2275)
// =============================================================================

describe("dispatchQuickstart — --skip-gate defers the healthy-boot gate", () => {
  test("--skip-gate skips step 8 with NO log-grep / healthz probe and exits 0", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    let readLogCalls = 0;
    let healthzCalls = 0;
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          // A gate that would NEVER pass if it ran (empty log + failing healthz).
          ["--config-dir", configDir, "--nats-dir", natsDir, "--skip-gate", "--gate-timeout-ms", "5000"],
          () =>
            fakePorts({
              readLog: () => {
                readLogCalls++;
                return undefined;
              },
              fetchHealthz: () => {
                healthzCalls++;
                return Promise.resolve(false);
              },
            }),
        ),
      ),
    );
    // Exit 0 even though the gate ports are rigged to fail — step 8 never ran.
    expect(res.exitCode).toBe(0);
    // Explicit deferral marker (mirrors step 7's --skip-services convention).
    expect(res.stdout).toContain("--skip-gate passed — deferred to supervisor healthcheck");
    expect(readLogCalls).toBe(0);
    expect(healthzCalls).toBe(0);
    expect(res.stdout).not.toContain("timed out after");
  });

  test("--skip-gate does NOT imply --skip-services (step 7 still runs — and can still fail)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir, "--skip-gate"],
          () => fakePorts({ unitFileExists: () => false }), // fails step 7 — proving it RAN
        ),
      ),
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("systemd template units not found");
    expect(res.stdout).not.toContain("--skip-services passed");
  });

  test("--json with --skip-services --skip-gate: step 8 is ok + skipped with the deferral note, envelope is ok", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir, "--skip-services", "--skip-gate", "--json"],
          // Rigged-to-fail gate ports + unit files absent — neither may matter.
          () => fakePorts({ unitFileExists: () => false, readLog: () => undefined, fetchHealthz: () => Promise.resolve(false) }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      status: string;
      items?: { step: string; ok: string; skipped?: string; note?: string }[];
    };
    expect(parsed.status).toBe("ok");
    // Step 8 is present, ok, and EXPLICITLY marked deferred — never a bare
    // green check for work that didn't run, never silently absent.
    const gate = parsed.items?.find((i) => i.step === "8. Healthy-boot gate");
    expect(gate).toBeDefined();
    expect(gate?.ok).toBe("true");
    expect(gate?.skipped).toBe("true");
    expect(gate?.note).toBe("deferred to supervisor healthcheck");
    // Steps 1–7 carry the pre-#2275 shape untouched (no skipped/note keys
    // except step 7's own skip is NOT marked — only --skip-gate marks one).
    for (const item of parsed.items ?? []) {
      if (item.step !== "8. Healthy-boot gate") {
        expect(item.skipped).toBeUndefined();
        expect(item.note).toBeUndefined();
      }
    }
    expect(res.stdout).not.toContain(SECRET_TOKEN);
  });

  test("WITHOUT --skip-gate the gate still runs and its JSON item carries NO skipped/note keys (default unchanged)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    let readLogCalls = 0;
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(
          ["--config-dir", configDir, "--nats-dir", natsDir, "--json"],
          () =>
            fakePorts({
              readLog: () => {
                readLogCalls++;
                return FULL_HEALTHY_LOG;
              },
            }),
        ),
      ),
    );
    expect(res.exitCode).toBe(0);
    // The gate ran — proving --skip-gate is what suppresses it.
    expect(readLogCalls).toBeGreaterThan(0);
    const parsed = JSON.parse(res.stdout) as {
      status: string;
      items?: { step: string; ok: string; skipped?: string; note?: string }[];
    };
    expect(parsed.status).toBe("ok");
    const gate = parsed.items?.find((i) => i.step === "8. Healthy-boot gate");
    expect(gate?.ok).toBe("true");
    expect(gate?.skipped).toBeUndefined();
    expect(gate?.note).toBeUndefined();
  });

  test("--help documents --skip-gate", async () => {
    const res = await dispatchQuickstart(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--skip-gate");
    expect(res.stdout).toContain("deferred");
  });
});

// =============================================================================
// --surface (cortex#2153) — web/gateway surface mode
// =============================================================================

describe("dispatchQuickstart — --surface flag parsing", () => {
  test("--surface with no value → exit 2", async () => {
    const res = await dispatchQuickstart(["--surface"]);
    expect(res.exitCode).toBe(2);
  });

  test("--surface bogus → exit 2 with a clear message", async () => {
    const res = await dispatchQuickstart(["--surface", "telegram"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('--surface must be "discord" or "web"');
  });

  test("--help documents the --surface flag and the web contract", async () => {
    const res = await dispatchQuickstart(["--help"]);
    expect(res.stdout).toContain("--surface");
    expect(res.stdout).toContain("CTX_WEB_HOST");
    expect(res.stdout).toContain("CTX_WEB_TOKEN");
  });
});

describe("dispatchQuickstart — --surface web (macOS: step 7 auto-skips)", () => {
  test("a full web run validates the web contract, scaffolds a web: binding, and NEVER echoes the token", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("darwin", () =>
      withEnv(validWebCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--surface", "web"], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex quickstart: complete");
    // secret hygiene: the web token never appears in ANY output.
    expect(res.stdout).not.toContain(WEB_SECRET_TOKEN);
    expect(res.stderr).not.toContain(WEB_SECRET_TOKEN);

    // surfaces.yaml carries a WEB binding, no Discord snowflakes.
    const surfaces = readFileSync(join(configDir, "gateway", "surfaces", "surfaces.yaml"), "utf-8");
    expect(surfaces).toContain("web:");
    expect(surfaces).not.toContain("discord:");
    expect(surfaces).toContain("host: 127.0.0.1");
    expect(surfaces).toContain("port: 8090");
    expect(surfaces).toContain(`token: "${WEB_SECRET_TOKEN}"`); // the FILE carries it — only stdout must not
    // shared parts still ran: nats conf + stack scaffold.
    expect(existsSync(join(natsDir, "gateway.conf"))).toBe(true);
    expect(existsSync(join(configDir, "gateway", "stacks", "gateway.yaml"))).toBe(true);
  });

  test("web run requires NO Discord snowflakes — a web env with none of them still succeeds", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const env = validWebCtxEnv();
    // Prove the discord contract keys are entirely absent from this run.
    expect(env.CTX_GUILD_ID).toBeUndefined();
    expect(env.CTX_DISCORD_TOKEN).toBeUndefined();
    const res = await withPlatform("darwin", () =>
      withEnv(env, () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--surface", "web"], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(0);
  });

  test("a second web run mutates NOTHING (idempotent re-run)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const run = () =>
      withPlatform("darwin", () =>
        withEnv(validWebCtxEnv(), () =>
          dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--surface", "web"], () => fakePorts()),
        ),
      );
    const first = await run();
    expect(first.exitCode).toBe(0);
    const before = snapshotTree([configDir, natsDir]);
    const second = await run();
    expect(second.exitCode).toBe(0);
    const after = snapshotTree([configDir, natsDir]);
    expect(after).toEqual(before);
    expect(second.stdout).toContain("already up to date (skip)");
    expect(second.stdout).not.toContain(WEB_SECRET_TOKEN);
  });
});

describe("dispatchQuickstart — --surface mismatch is rejected clearly", () => {
  test("--surface web but only Discord env set → exit 2, names the missing web keys", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--surface", "web"], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("✗ CTX_WEB_HOST: missing");
    expect(res.stdout).toContain("CTX_WEB_TOKEN: missing");
    // it never scaffolded anything (env gate is step 2, before scaffold).
    expect(existsSync(join(configDir, "work"))).toBe(false);
  });

  test("--surface discord (default) but only web env set → exit 2, names the missing snowflakes", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("darwin", () =>
      withEnv(validWebCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("✗ CTX_GUILD_ID: missing");
    expect(res.stdout).toContain("CTX_DISCORD_TOKEN: missing");
  });
});

describe("dispatchQuickstart — --surface discord is the default (back-compat)", () => {
  test("explicit --surface discord is byte-identical to omitting it", async () => {
    const configDirA = freshDir();
    const configDirB = freshDir();
    const natsDirA = freshDir();
    const natsDirB = freshDir();
    const withDefault = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDirA, "--nats-dir", natsDirA], () => fakePorts()),
      ),
    );
    const withExplicit = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDirB, "--nats-dir", natsDirB, "--surface", "discord"], () => fakePorts()),
      ),
    );
    expect(withDefault.exitCode).toBe(0);
    expect(withExplicit.exitCode).toBe(0);
    // Same scaffold shape: both wrote a discord surfaces binding.
    const surfacesA = readFileSync(join(configDirA, "work", "surfaces", "surfaces.yaml"), "utf-8");
    const surfacesB = readFileSync(join(configDirB, "work", "surfaces", "surfaces.yaml"), "utf-8");
    expect(surfacesA).toBe(surfacesB);
    expect(surfacesA).toContain("discord:");
  });
});

// =============================================================================
// End to end — happy path, secret non-echo, and idempotent re-run
// =============================================================================

describe("dispatchQuickstart — end to end (macOS: step 7 auto-skips)", () => {
  test("a full run succeeds, patches the scaffold, and NEVER echoes the token", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex quickstart: complete");
    // the non-negotiable one: the real token value never appears in ANY
    // output this whole run produced (stdout + stderr).
    expect(res.stdout).not.toContain(SECRET_TOKEN);
    expect(res.stderr).not.toContain(SECRET_TOKEN);

    const surfaces = readFileSync(join(configDir, "work", "surfaces", "surfaces.yaml"), "utf-8");
    expect(surfaces).toContain(`token: "${SECRET_TOKEN}"`); // the FILE carries it — only stdout/stderr must not
    const stack = readFileSync(join(configDir, "work", "stacks", "work.yaml"), "utf-8");
    expect(stack).toContain('discordId: "444444444444444444"');
    expect(existsSync(join(natsDir, "work.conf"))).toBe(true);
  });

  test("a second run against the same state mutates NOTHING (checksum both trees)", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const run = () =>
      withPlatform("darwin", () =>
        withEnv(validCtxEnv(), () =>
          dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir], () => fakePorts()),
        ),
      );

    const first = await run();
    expect(first.exitCode).toBe(0);

    const before = snapshotTree([configDir, natsDir]);
    const second = await run();
    expect(second.exitCode).toBe(0);
    const after = snapshotTree([configDir, natsDir]);

    expect(after).toEqual(before);
    // Every step reported a skip/verified outcome, not a fresh write.
    expect(second.stdout).toContain("already up to date (skip)");
    expect(second.stdout).toContain("already exists with matching identity");
    expect(second.stdout).not.toContain(SECRET_TOKEN);
  });

  test("re-running with a DIFFERENT principal for the same slug is refused, not silently accepted", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const first = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir], () => fakePorts()),
      ),
    );
    expect(first.exitCode).toBe(0);

    const second = await withPlatform("darwin", () =>
      withEnv(validCtxEnv({ CTX_PRINCIPAL: "someone-else" }), () =>
        // --force: a different principal also renders a different nats .conf
        // (server_name/domain embed the principal) — force past step 3 so
        // this test isolates step 4's identity-mismatch refusal.
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--force"], () => fakePorts()),
      ),
    );
    expect(second.exitCode).toBe(1);
    expect(second.stdout).toContain("does not match the expected");
  });
});

// =============================================================================
// End to end — Linux happy path (faked platform + injected systemd seam)
// =============================================================================

describe("dispatchQuickstart — end to end (faked Linux, step 7 exercised)", () => {
  test("full run through services + gate on a faked Linux host", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("linux", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("systemctl --user daemon-reload");
    expect(res.stdout).toContain("systemctl --user enable --now nats@work cortex@work");
    expect(res.stdout).not.toContain(SECRET_TOKEN);
  });
});

// =============================================================================
// --json envelope
// =============================================================================

describe("dispatchQuickstart — --json", () => {
  test("failure envelope carries no secret and reports the failing step", async () => {
    const res = await withEnv({}, () => dispatchQuickstart(["--json"], () => fakePorts()));
    expect(res.exitCode).toBe(2);
    const parsed = JSON.parse(res.stdout) as { status: string; error?: { reason: string } };
    expect(parsed.status).toBe("error");
    expect(parsed.error?.reason).toBe("2. Validate env contract");
    expect(res.stdout).not.toContain(SECRET_TOKEN);
  });

  test("success envelope on a full run", async () => {
    const configDir = freshDir();
    const natsDir = freshDir();
    const res = await withPlatform("darwin", () =>
      withEnv(validCtxEnv(), () =>
        dispatchQuickstart(["--config-dir", configDir, "--nats-dir", natsDir, "--json"], () => fakePorts()),
      ),
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { status: string };
    expect(parsed.status).toBe("ok");
    expect(res.stdout).not.toContain(SECRET_TOKEN);
  });
});
