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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchNetwork, joinBlockerMessage, shouldReplaceCredsPreflightError } from "../network";
import type { OwnAdmissionState } from "../../../../common/registry/admission-state";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";

// #753 — a reader returning an EMPTY config so derivation tests are
// deterministic (no dependence on the dev machine's real ~/.config/cortex).
// With an empty config + no flags, every derived field is absent, so the
// derivation surfaces its actionable "cannot resolve …" usage error.
const EMPTY_READER = (): LoadedConfig => ({
  config: {} as AgentConfig,
  inlineAgents: [],
});

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

  test("#753 — no principal anywhere → actionable usage error (exit 2)", async () => {
    // With an empty config and no --principal flag, derivation names the
    // missing config field + the override flag (the flag-wall is gone; #753).
    const res = await dispatchNetwork(["join", "metafactory"], EMPTY_READER);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("cannot resolve principal");
    expect(res.stderr).toContain("principal.id");
  });

  test("#753 — principal flagged, empty config → names the next missing field (exit 2)", async () => {
    const res = await dispatchNetwork(
      ["join", "metafactory", "--principal", "andreas"],
      EMPTY_READER,
    );
    expect(res.exitCode).toBe(2);
    // cortex#1228 — the registry is no longer a missing-field error (it falls
    // back to the default anchor), so the seed is the first underivable
    // required value with an empty config.
    expect(res.stderr).toContain("cannot resolve signing seed");
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
    ], EMPTY_READER);
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
    ], EMPTY_READER);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("prefix matching");
  });

  // ADR-0015 (R2) — the Model-A leaf-package INGESTION flag `--from-package`
  // (O-4b) is retired. `cortex network join` no longer accepts an injected
  // operator JWT + account JWT package; a Model-B stack mints its own and joins
  // via the sovereign secret-auth pipe (or the O-3 operator-mode flags for its
  // OWN NSC operator-mode bus). The flag must now be rejected as unknown rather
  // than silently consuming an injected hub-minted package.
  test("ADR-0015 — `--from-package` (Model-A ingestion) is rejected as unknown (exit 2)", async () => {
    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--from-package", "/tmp/leaf-package.json",
    ], EMPTY_READER);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unknown flag: --from-package");
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
    ], EMPTY_READER);

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
    ], EMPTY_READER);
    // Failure output goes to stderr; it still carries the dry-run banner.
    expect(res.stderr).toContain("dry-run");
  });
});

// =============================================================================
// cortex#1228 — TOFU is never silent for a custom registry; pinned ⇒ no warning
// =============================================================================

describe("#1228 — custom-registry TOFU warning", () => {
  test("custom registry, NO pubkey → emits the explicit TOFU warning", async () => {
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0", // custom + unreachable by construction
      "--seed-path", join(dir, "seed.nk"),
      "--creds", join(dir, "andreas.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
    ], EMPTY_READER);
    // The warning is emitted before the (failing) register step.
    expect(res.stderr).toContain("TOFU");
    expect(res.stderr).toContain("custom");
  });

  test("custom registry WITH --registry-pubkey → NO TOFU warning (pinned)", async () => {
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0",
      "--registry-pubkey", "Z".repeat(43) + "=",
      "--seed-path", join(dir, "seed.nk"),
      "--creds", join(dir, "andreas.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
    ], EMPTY_READER);
    expect(res.stderr).not.toContain("Trusting it on first use");
  });
});

// =============================================================================
// #763 — Linux/systemd: `--unit` join is accepted + writes nothing on dry-run
// =============================================================================

describe("#763 — systemd `--unit` join", () => {
  test("dry-run join with --unit (no --plist) writes nothing and routes to systemd", async () => {
    const dir = freshDir();
    const unit = join(dir, "nats-server.service");
    const natsConfig = join(dir, "nats", "local.conf");

    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "jc",
      "--registry-url", "http://127.0.0.1:0", // unreachable by construction
      "--seed-path", join(dir, "seed.nk"),
      "--creds", join(dir, "jc.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", natsConfig,
      "--unit", unit, // systemd descriptor — self-describing, platform-independent
    ], EMPTY_READER);

    // DRY-RUN SAFETY: the systemd unit + config are NOT written/created.
    expect(existsSync(unit)).toBe(false);
    expect(existsSync(natsConfig)).toBe(false);
    expect(existsSync(join(dir, "nats"))).toBe(false);
    // Join fails on the unreachable registry (register step), exit 1 — but it
    // got PAST descriptor resolution (no "cannot resolve … unit" usage error).
    expect(res.exitCode).toBe(1);
    expect(res.stderr).not.toContain("cannot resolve");
  });

  test("passing BOTH --plist and --unit is a clear usage error (exit 2)", async () => {
    const dir = freshDir();
    const res = await dispatchNetwork([
      "join", "metafactory",
      "--principal", "jc",
      "--registry-url", "http://r.test",
      "--seed-path", join(dir, "seed.nk"),
      "--creds", join(dir, "x.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(dir, "local.conf"),
      "--plist", join(dir, "nats.plist"),
      "--unit", join(dir, "nats-server.service"),
    ], EMPTY_READER);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("only one of --plist");
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

  test("reports 'no networks registered or joined' when config AND cache are absent", async () => {
    // Point at a principal whose stacks/<slug>.yaml does not exist under the
    // home config dir. Using a unique slug guarantees absence.
    // C-850 — status now also reads the global network-cache; a temp $HOME keeps
    // BOTH the config read AND the cache read hermetic (else the developer's real
    // ~/.config/cortex/network-cache leaks registered rows into this assertion).
    const home = mkdtempSync(join(tmpdir(), "s4-empty-status-"));
    tmpDirs.push(home);
    mkdirSync(join(home, ".config", "cortex"), { recursive: true });
    const uniqueSlug = `s4test${Date.now().toString()}`;
    const res = await withHome(home, () =>
      dispatchNetwork([
        "status",
        "--principal", "andreas",
        "--stack", `andreas/${uniqueSlug}`,
      ]),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("no networks registered or joined");
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
// #814 — status resolves the NAMED stack's config, layout-aware.
//
// The bug: `cortex network status --principal andreas --stack andreas/community`
// reported "no networks joined" even though the config-split stack's
// stacks/community.yaml carried policy.federated.networks. The status SPEC took
// no --config, so cortexConfigPath fell through to the default monolith
// ~/.config/cortex/cortex.yaml and readNetworks read the wrong file.
//
// expandTilde reads $HOME, so each test points $HOME at a temp dir and builds
// the config layout under <tmp>/.config/cortex/ (NEVER touches the real one).
// =============================================================================

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

/** Scaffold a config-split stack under <home>/.config/cortex/<slug>/ with a
 *  joined network in stacks/<slug>.yaml. Returns the cortex config dir. */
function scaffoldSplitStack(home: string, slug: string, networkId: string): string {
  const configDir = join(home, ".config", "cortex");
  const stackDir = join(configDir, slug);
  mkdirSync(join(stackDir, "system"), { recursive: true });
  mkdirSync(join(stackDir, "stacks"), { recursive: true });
  // The split-layout marker the resolver keys on.
  writeFileSync(join(stackDir, "system", "system.yaml"), "nats:\n  subjects: []\n", "utf-8");
  // The per-stack sentinel (the path the resolver returns + the daemon loads).
  writeFileSync(join(stackDir, `${slug}.yaml`), `stack:\n  id: andreas/${slug}\n`, "utf-8");
  // The policy-bearing file readNetworks reads (derived from the sentinel #813).
  writeFileSync(
    join(stackDir, "stacks", `${slug}.yaml`),
    `policy:\n  federated:\n    networks:\n      - id: ${networkId}\n        leaf_node: ${networkId}\n        max_hop: 1\n        peers: []\n        accept_subjects:\n          - federated.andreas.${slug}.>\n        deny_subjects: []\n        announce_capabilities: []\n`,
    "utf-8",
  );
  return configDir;
}

describe("#814 — status resolves the named config-split stack's config", () => {
  test("--stack drives resolution: a joined config-split stack reports the network (NOT 'no networks joined')", async () => {
    const home = mkdtempSync(join(tmpdir(), "c814-split-"));
    tmpDirs.push(home);
    scaffoldSplitStack(home, "community", "metafactory-community");

    const res = await withHome(home, () =>
      dispatchNetwork([
        "status",
        "--principal", "andreas",
        "--stack", "andreas/community",
        // unreachable monitor → leaf link degrades to unknown, but the JOINED
        // network must still be read from stacks/community.yaml.
        "--monitor-url", "http://127.0.0.1:0",
      ]),
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("no networks joined");
    expect(res.stdout).toContain("metafactory-community");
  });

  test("explicit --config override is honoured (highest precedence)", async () => {
    const home = mkdtempSync(join(tmpdir(), "c814-cfg-"));
    tmpDirs.push(home);
    const configDir = scaffoldSplitStack(home, "community", "metafactory-community");
    const sentinel = join(configDir, "community", "community.yaml");

    // No --stack at all; the explicit --config must drive the read.
    const res = await withHome(home, () =>
      dispatchNetwork([
        "status",
        "--principal", "andreas",
        "--config", sentinel,
        "--monitor-url", "http://127.0.0.1:0",
      ]),
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("metafactory-community");
  });

  test("monolith on the default path is unchanged — absent config reports 'no networks registered or joined'", async () => {
    // A home with NO config-split dir and no monolith for the slug: the resolver
    // returns <home>/.config/cortex/cortex.<slug>.yaml (absent) → empty read. The
    // temp $HOME also isolates the C-850 cache read (no network-cache dir → no
    // registered rows).
    const home = mkdtempSync(join(tmpdir(), "c814-mono-"));
    tmpDirs.push(home);
    mkdirSync(join(home, ".config", "cortex"), { recursive: true });

    const res = await withHome(home, () =>
      dispatchNetwork([
        "status",
        "--principal", "andreas",
        "--stack", "andreas/community",
      ]),
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("no networks registered or joined");
  });

  test("#814 review (MAJOR) — monolith default-stack: no --stack resolves cortex.yaml (meta-factory), NOT cortex.default.yaml", async () => {
    const home = mkdtempSync(join(tmpdir(), "c814-monodef-"));
    tmpDirs.push(home);
    const configDir = join(home, ".config", "cortex");
    mkdirSync(configDir, { recursive: true });
    // No --stack ⇒ resolveStackSlug returns "default", which the status resolver
    // maps to the canonical bare-name default `meta-factory` ⇒ monolith
    // cortex.yaml (config_file_to_slug: cortex.yaml → meta-factory). The joined
    // network must be read from cortex.yaml, the REAL default monolith.
    writeFileSync(
      join(configDir, "cortex.yaml"),
      `policy:\n  federated:\n    networks:\n      - id: metafactory\n        leaf_node: metafactory\n        max_hop: 1\n        peers: []\n        accept_subjects:\n          - federated.andreas.meta-factory.>\n        deny_subjects: []\n        announce_capabilities: []\n`,
      "utf-8",
    );
    // Belt-and-braces: a stray cortex.default.yaml (the WRONG pre-review target)
    // must NOT be what status reads. Leave it absent — its absence proves the
    // assertion below is satisfied only by cortex.yaml.

    const res = await withHome(home, () =>
      dispatchNetwork([
        "status",
        "--principal", "andreas",
        "--monitor-url", "http://127.0.0.1:0",
      ]),
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("metafactory");
  });

  test("#814 review (MAJOR) — config-split default-stack: no --stack reads ~/.config/cortex/meta-factory/meta-factory.yaml", async () => {
    // The most common invocation on a config-split default deployment: no
    // --stack. resolveStackSlug → "default" → mapped to `meta-factory` → the
    // split sentinel meta-factory/meta-factory.yaml (policy in
    // meta-factory/stacks/meta-factory.yaml). Pre-review this resolved the
    // nonexistent cortex.default.yaml and falsely reported "no networks joined".
    const home = mkdtempSync(join(tmpdir(), "c814-splitdef-"));
    tmpDirs.push(home);
    scaffoldSplitStack(home, "meta-factory", "metafactory");

    const res = await withHome(home, () =>
      dispatchNetwork([
        "status",
        "--principal", "andreas",
        "--monitor-url", "http://127.0.0.1:0",
      ]),
    );

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("no networks joined");
    expect(res.stdout).toContain("metafactory");
  });
});

// =============================================================================
// leave — usage + idempotent no-op
// =============================================================================

describe("leave usage", () => {
  test("#753 — no principal/nats-config derivable → actionable usage error (exit 2)", async () => {
    const res = await dispatchNetwork(["leave", "metafactory"], EMPTY_READER);
    expect(res.exitCode).toBe(2);
    // Empty config + no flags: principal is the first underivable value.
    expect(res.stderr).toContain("cannot resolve principal");
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
    ], EMPTY_READER);
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
    ], EMPTY_READER);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("nothing to do");
  });
});

// =============================================================================
// C-1315 — joinBlockerMessage: the actionable admission-state message that
// REPLACES the misleading legacy `.creds not found (#821)` preflight on a
// Model-B join with no resolved leaf secret.
// =============================================================================

describe("joinBlockerMessage (C-1315)", () => {
  const NET = "metafactory";
  function st(over: Partial<OwnAdmissionState>): OwnAdmissionState {
    return {
      state: over.state ?? "pending",
      networkId: NET,
      hasSealedSecret: over.hasSealedSecret ?? false,
      peerPubkey: over.peerPubkey ?? "PUBKEY==",
      ...(over.requestId !== undefined && { requestId: over.requestId }),
    };
  }

  test("no-row → 'register first', names the network, NOT a .creds fix", () => {
    const m = joinBlockerMessage(NET, st({ state: "no-row" }));
    expect(m).toContain("no admission request exists");
    expect(m).toContain(NET);
    expect(m).toContain("register");
    expect(m).toContain(".creds file is NOT the fix");
  });

  test("pending → surfaces the request-id + admit command", () => {
    const m = joinBlockerMessage(NET, st({ state: "pending", requestId: "req-9" }));
    expect(m).toContain("PENDING");
    expect(m).toContain("req-9");
    expect(m).toContain("cortex network admit req-9 --apply");
  });

  test("admitted-unsealed → tells the admin to seal (add-member <net> <pubkey>)", () => {
    const m = joinBlockerMessage(NET, st({ state: "admitted-unsealed", requestId: "r", peerPubkey: "PK==" }));
    expect(m).toContain("ADMITTED");
    expect(m).toContain("cortex network secret add-member metafactory PK== --apply");
    expect(m).toContain("auto-fetches");
  });

  test("admitted-sealed (open failed) → wrong-pubkey / re-seal guidance", () => {
    const m = joinBlockerMessage(NET, st({ state: "admitted-sealed", hasSealedSecret: true, peerPubkey: "PK==" }));
    expect(m).toContain("could not open it");
    expect(m).toContain("PK==");
  });

  test("revoked / rejected → their own messages", () => {
    expect(joinBlockerMessage(NET, st({ state: "revoked", requestId: "r" }))).toContain("REVOKED");
    expect(joinBlockerMessage(NET, st({ state: "rejected", requestId: "r" }))).toContain("REJECTED");
  });

  test("unknown status → undefined (keep the original error)", () => {
    expect(joinBlockerMessage(NET, st({ state: "unknown" }))).toBeUndefined();
  });
});

// =============================================================================
// C-1315 (review major, #1397) — shouldReplaceCredsPreflightError: the #821
// creds-preflight error is rewritten to the Model-B admission message ONLY on
// the Model-B no-secret path, and NEVER on an explicit `--creds` / `--leaf-
// secret` join or a non-#821 failure.
// =============================================================================

describe("shouldReplaceCredsPreflightError (C-1315 #821 guard, #1397)", () => {
  const CREDS_821 =
    "leaf creds file not found at /tmp/typo.creds — refusing to render a leaf remote " +
    "that cannot authenticate to the hub. Set stack.nats_infra.creds_path (or pass --creds) " +
    "to an existing .creds file (cortex#821).";

  test("Model-B no-secret path (no --creds, no leaf secret, #821) → replace", () => {
    expect(
      shouldReplaceCredsPreflightError({
        joinOk: false,
        resolvedLeafSecret: undefined,
        explicitCredsFlag: undefined,
        reason: CREDS_821,
      }),
    ).toBe(true);
  });

  test("explicit --creds <bad-path> join → KEEP the original creds-not-found error (NOT the Model-B rewrite)", () => {
    // The review-major regression: a user who opted into creds-file auth and
    // typo'd the path must see the genuine error, never "a .creds file is NOT the fix".
    expect(
      shouldReplaceCredsPreflightError({
        joinOk: false,
        resolvedLeafSecret: undefined,
        explicitCredsFlag: "/tmp/typo.creds",
        reason: CREDS_821,
      }),
    ).toBe(false);
  });

  test("explicit --leaf-secret join (leaf secret resolved) → keep original", () => {
    expect(
      shouldReplaceCredsPreflightError({
        joinOk: false,
        resolvedLeafSecret: "SECRET",
        explicitCredsFlag: undefined,
        reason: CREDS_821,
      }),
    ).toBe(false);
  });

  test("a non-#821 failure → keep original (marker absent)", () => {
    expect(
      shouldReplaceCredsPreflightError({
        joinOk: false,
        resolvedLeafSecret: undefined,
        explicitCredsFlag: undefined,
        reason: "some other join failure",
      }),
    ).toBe(false);
  });

  test("a successful join → never replace", () => {
    expect(
      shouldReplaceCredsPreflightError({
        joinOk: true,
        resolvedLeafSecret: undefined,
        explicitCredsFlag: undefined,
        reason: CREDS_821,
      }),
    ).toBe(false);
  });
});