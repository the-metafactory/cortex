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
  provisionSeed?: () => CommandResult;
  readLog?: () => string | undefined;
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
    enableNow: overrides.enableNow ?? (() => ({ exitCode: 0, stdout: "", stderr: "" })),
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
