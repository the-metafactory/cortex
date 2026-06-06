/**
 * S4 (#738) — `cortex network` CLI dispatcher tests.
 *
 * Covers the command surface: parsing, usage errors, help, dry-run SAFETY (the
 * default — no disk/daemon mutation), apply/dry-run exclusivity, and status
 * rendering against a real (temp) stack config file. The deep join/leave/status
 * FLOW logic is covered by `network-lib.test.ts` with fake ports; here we
 * exercise the wiring + the real adapters' read/no-op-write behaviour.
 *
 * No live mutation: every test points the adapters at a fresh tmp dir and
 * asserts that a dry-run writes NOTHING.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchNetwork } from "../network";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "s4-network-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// =============================================================================
// dispatch / usage / help
// =============================================================================

describe("dispatch", () => {
  test("no subcommand → exit 2 with usage", async () => {
    const res = await dispatchNetwork([]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("no subcommand specified");
  });

  test("unknown subcommand → exit 2", async () => {
    const res = await dispatchNetwork(["frobnicate"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('unknown subcommand "frobnicate"');
  });

  test("--help → exit 0 with usage", async () => {
    const res = await dispatchNetwork(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex network");
    expect(res.stdout).toContain("join");
    expect(res.stdout).toContain("leave");
    expect(res.stdout).toContain("status");
  });
});

// =============================================================================
// join — usage validation
// =============================================================================

describe("join usage", () => {
  test("rejects a bad network id (exit 2)", async () => {
    const res = await dispatchNetwork(["join", "BAD_CAPS", "--principal", "andreas"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must be lowercase");
  });

  test("requires --principal (exit 2)", async () => {
    const res = await dispatchNetwork(["join", "metafactory"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--principal is required");
  });

  test("requires the live-config flags (exit 2)", async () => {
    const res = await dispatchNetwork(["join", "metafactory", "--principal", "andreas"]);
    expect(res.exitCode).toBe(2);
    // First missing required flag surfaces.
    expect(res.stderr).toMatch(/--registry-url is required/);
  });

  test("--apply and --dry-run are mutually exclusive (exit 2)", async () => {
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://r.test",
      "--seed-path", join(dir, "seed.nk"),
      "--creds", join(dir, "x.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
      "--apply", "--dry-run",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });

  test("rejects --stack whose prefix mismatches --principal (exit 2)", async () => {
    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--stack", "someoneelse/research",
      "--registry-url", "http://r.test",
      "--seed-path", "/tmp/x",
      "--creds", "/tmp/x.creds",
      "--account", "A" + "B".repeat(55),
      "--nats-config", "/tmp/local.conf",
      "--plist", "/tmp/nats.plist",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("prefix matching");
  });
});

// =============================================================================
// join — dry-run SAFETY (the default): no disk mutation
// =============================================================================

describe("join dry-run safety", () => {
  test("dry-run join does NOT write the leaf file, plist, or config (no --apply)", async () => {
    const dir = freshDir();
    const seedPath = join(dir, "seed.nk");
    // A real-ish seed is not needed: dry-run register fails gracefully but we
    // assert NO files are written regardless. Use a non-existent registry so
    // there is no network I/O hang.
    const natsConfig = join(dir, "nats", "local.conf");
    const plist = join(dir, "nats.plist");

    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0", // unreachable by construction
      "--seed-path", seedPath,
      "--creds", join(dir, "andreas.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", natsConfig,
      "--plist", plist,
    ]);

    // The join FAILS (no seed / unreachable registry) — but the critical S4
    // SAFETY assertion is that NOTHING was written to disk on a dry-run.
    expect(existsSync(natsConfig)).toBe(false);
    expect(existsSync(join(dir, "nats"))).toBe(false);
    expect(existsSync(plist)).toBe(false);
    // It reports a failure (register failed), exit 1.
    expect(res.exitCode).toBe(1);
  });

  test("dry-run banner is present in human output", async () => {
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0",
      "--seed-path", join(dir, "seed.nk"),
      "--creds", join(dir, "andreas.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
    ]);
    // Failure output goes to stderr; it still carries the dry-run banner.
    expect(res.stderr).toContain("dry-run");
  });
});

// =============================================================================
// status — renders against a real (temp) stack config
// =============================================================================

describe("status", () => {
  test("requires --principal (exit 2)", async () => {
    const res = await dispatchNetwork(["status"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--principal is required");
  });

  test("reports 'no networks joined' when the stack config is absent", async () => {
    // Point at a principal whose stacks/<slug>.yaml does not exist under the
    // home config dir. Using a unique slug guarantees absence.
    const uniqueSlug = `s4test${Date.now().toString()}`;
    const res = await dispatchNetwork([
      "status",
      "--principal", "andreas",
      "--stack", `andreas/${uniqueSlug}`,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("no networks joined");
  });

  test("--json emits an envelope", async () => {
    const uniqueSlug = `s4test${Date.now().toString()}j`;
    const res = await dispatchNetwork([
      "status",
      "--principal", "andreas",
      "--stack", `andreas/${uniqueSlug}`,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { status: string; items: unknown[] };
    expect(env.status).toBe("ok");
    expect(Array.isArray(env.items)).toBe(true);
  });
});

// =============================================================================
// leave — usage + idempotent no-op
// =============================================================================

describe("leave usage", () => {
  test("requires --principal (exit 2)", async () => {
    const res = await dispatchNetwork(["leave", "metafactory"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--principal is required");
  });

  test("leaving an un-joined network is a clean no-op (exit 0)", async () => {
    const dir = freshDir();
    const uniqueSlug = `s4leave${Date.now().toString()}`;
    const res = await dispatchNetwork([
      "leave", "metafactory",
      "--principal", "andreas",
      "--stack", `andreas/${uniqueSlug}`,
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("not joined");
  });
});

// =============================================================================
// S5 (#739) — `join public` / `leave public` (the open square)
// =============================================================================

describe("join public usage", () => {
  test("rejects a malformed --capabilities id (exit 2)", async () => {
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "public",
      "--principal", "andreas",
      "--registry-url", "http://r.test",
      "--seed-path", join(dir, "seed.nk"),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
      "--capabilities", "BAD_CAP",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("capability");
  });

  test("rejects a malformed --allow principal id (exit 2)", async () => {
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "public",
      "--principal", "andreas",
      "--registry-url", "http://r.test",
      "--seed-path", join(dir, "seed.nk"),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
      "--allow", "BAD_PRINCIPAL",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("allow");
  });

  test("does NOT require --creds / --account (public has no leaf)", async () => {
    // The public path validates its OWN required flags — creds/account are
    // federated-only. Omitting them must NOT surface a creds/account error.
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "public",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0", // unreachable by construction
      "--seed-path", join(dir, "seed.nk"),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
      "--capabilities", "code-review.typescript",
    ]);
    // It will FAIL at announce (no seed / unreachable registry) — exit 1 — but
    // NOT a usage error about creds/account.
    expect(res.exitCode).not.toBe(2);
    expect(res.stderr).not.toContain("--creds");
    expect(res.stderr).not.toContain("--account");
  });
});

describe("join public dry-run safety (OQ1 + no live mutation)", () => {
  test("dry-run join public writes NOTHING to disk", async () => {
    const dir = freshDir();
    const natsConfig = join(dir, "nats", "local.conf");
    const plist = join(dir, "nats.plist");
    const uniqueSlug = `s5pub${Date.now().toString()}`;

    const res = await dispatchNetwork([
      "join", "public",
      "--principal", "andreas",
      "--stack", `andreas/${uniqueSlug}`,
      "--registry-url", "http://127.0.0.1:0",
      "--seed-path", join(dir, "seed.nk"),
      "--nats-config", natsConfig,
      "--plist", plist,
      "--capabilities", "code-review.typescript",
    ]);

    // Critical S5 SAFETY: a dry-run touches no disk + no daemon.
    expect(existsSync(natsConfig)).toBe(false);
    expect(existsSync(join(dir, "nats"))).toBe(false);
    expect(existsSync(plist)).toBe(false);
    // Output carries the dry-run banner.
    expect(res.stderr + res.stdout).toContain("dry-run");
  });
});

describe("leave public", () => {
  test("leaving public when never joined is a clean no-op (exit 0)", async () => {
    const dir = freshDir();
    const uniqueSlug = `s5publeave${Date.now().toString()}`;
    const res = await dispatchNetwork([
      "leave", "public",
      "--principal", "andreas",
      "--stack", `andreas/${uniqueSlug}`,
      "--registry-url", "http://127.0.0.1:0",
      "--seed-path", join(dir, "seed.nk"),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("nothing to do");
  });
});