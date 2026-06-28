/**
 * C-1257 — tests for the pure make-live orchestration behind
 * `cortex network make-live <stack>` (the daemon-switch). All arc/fs/launchctl
 * effects are injected ports recording their calls — no real arc/nsc/fs/services.
 *
 * The anti-rot guard (sibling of the #255 provision-integration guard): asserts
 * the daemon-switch contract end-to-end against a faithful fake — creds minted
 * under the agents account, the agents JWT appended to resolver_preload exactly
 * once, both services restarted ONLY when state changed (and in the right order:
 * nats BEFORE the daemon), idempotent re-runs, and that the orchestrator never
 * touches the stack config (so encryption / federated config survives).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import {
  makeLiveStack,
  planMakeLive,
  type MakeLiveInputs,
  type MakeLivePorts,
  type MakeLiveState,
} from "../network-make-live-lib";
import { insertIntoResolverPreload, findNatsServerDescriptor, buildResolverPreloadAdapter } from "../network-make-live-adapters";
import type { DaemonLocatorIO } from "../daemon-locator";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const AGENTS_PUB = "A" + "R".repeat(55);
const AGENTS_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBQVJSIn0.sig";

function makeInputs(state: MakeLiveState, over?: Partial<MakeLiveInputs>): MakeLiveInputs {
  return {
    principal: "andreas",
    stackSlug: "work",
    stackId: "andreas/work",
    agentsAccountName: "ANDREAS_WORK_AGENTS",
    agentsAccountPubkey: AGENTS_PUB,
    botName: "cortex-work",
    credsPath: "~/.config/nats/cortex-work.creds",
    cortexConfigPath: "/Users/x/.config/cortex/work/work.yaml",
    natsConfigPath: "~/.config/nats/local.conf",
    force: false,
    apply: true,
    state,
    ...over,
  };
}

/** Spy ports recording every effectful call in order. */
function makePorts(over?: {
  resolverHas?: boolean;
  /** M3 — resolver_preload block present (operator-mode bus). Default true. */
  hasResolverPreload?: boolean;
  /** Whether the append actually mutates (changed). Default true. */
  appendChanged?: boolean;
  /** cortex#1265 — whether bootstrapOperatorMode reports a change. Default true. */
  bootstrapChanged?: boolean;
  /** cortex#1265 — make bootstrapOperatorMode fail (refuse/error). */
  bootstrapFails?: boolean;
  /** BLOCK 3 — pubkey the export port returns (default the matching AGENTS_PUB). */
  exportPubKey?: string;
  /** BLOCK 2 — descriptors resolveTargets returns. */
  natsDescriptor?: string | undefined;
  daemonDescriptor?: string | undefined;
  exportFails?: boolean;
  mintFails?: boolean;
}): { ports: MakeLivePorts; calls: string[] } {
  const calls: string[] = [];
  const ports: MakeLivePorts = {
    creds: {
      mint: async ({ botName, account, credsPath }) => {
        calls.push(`mint:${botName}@${account}->${credsPath}`);
        if (over?.mintFails) return { ok: false, reason: "add-bot boom" };
        return { ok: true, credsPath, userPubkey: "U" + "Z".repeat(55) };
      },
    },
    accountExport: {
      exportAccount: async (account) => {
        calls.push(`export:${account}`);
        if (over?.exportFails) return { ok: false, reason: "export boom" };
        return { ok: true, pubKey: over?.exportPubKey ?? AGENTS_PUB, jwt: AGENTS_JWT, seedPath: null };
      },
    },
    resolver: {
      hasAccount: () => over?.resolverHas ?? false,
      hasResolverPreload: () => over?.hasResolverPreload ?? true,
      appendAccount: ({ accountPubkey }) => {
        calls.push(`resolver-append:${accountPubkey}`);
        return { ok: true, changed: over?.appendChanged ?? true };
      },
      bootstrapOperatorMode: ({ natsConfigPath }) => {
        calls.push(`bootstrap:${natsConfigPath}`);
        if (over?.bootstrapFails) return { ok: false, reason: "operator-mode under a different operator" };
        return { ok: true, changed: over?.bootstrapChanged ?? true };
      },
    },
    restart: {
      resolveTargets: () => ({
        natsDescriptor: "natsDescriptor" in (over ?? {}) ? over?.natsDescriptor : "/LA/nats.plist",
        daemonDescriptor: "daemonDescriptor" in (over ?? {}) ? over?.daemonDescriptor : "/LA/cortex.plist",
      }),
      restartNats: async () => {
        calls.push("restart-nats");
        return { ok: true };
      },
      restartDaemon: async () => {
        calls.push("restart-daemon");
        return { ok: true };
      },
    },
  };
  return { ports, calls };
}

// ── plan ──────────────────────────────────────────────────────────────────────

describe("planMakeLive", () => {
  test("first migration (resolver absent) needs every step", () => {
    const p = planMakeLive(makeInputs({ credsFileExists: true, resolverHasAccount: false }));
    expect(p.resolverNeeded).toBe(true);
    expect(p.credsNeeded).toBe(true); // re-mint even though a (stale) creds file exists
    expect(p.natsRestartNeeded).toBe(true);
    expect(p.daemonRestartNeeded).toBe(true);
  });

  test("converged (resolver present + creds file present) needs nothing", () => {
    const p = planMakeLive(makeInputs({ credsFileExists: true, resolverHasAccount: true }));
    expect(p.resolverNeeded).toBe(false);
    expect(p.credsNeeded).toBe(false);
    expect(p.natsRestartNeeded).toBe(false);
    expect(p.daemonRestartNeeded).toBe(false);
  });

  test("--force re-mints everything even when converged", () => {
    const p = planMakeLive(makeInputs({ credsFileExists: true, resolverHasAccount: true }, { force: true }));
    expect(p.resolverNeeded).toBe(true);
    expect(p.credsNeeded).toBe(true);
  });
});

// ── apply: ordering + completeness (the anti-rot guard) ─────────────────────────

describe("makeLiveStack — apply", () => {
  test("first migration: resolver → nats restart → creds → daemon restart, in order", async () => {
    const { ports, calls } = makePorts();
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);

    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    // The exact execution order — nats-server BEFORE the daemon so the creds
    // never name an account the running server hasn't loaded yet.
    expect(calls).toEqual([
      `export:ANDREAS_WORK_AGENTS`,
      `resolver-append:${AGENTS_PUB}`,
      "restart-nats",
      `mint:cortex-work@ANDREAS_WORK_AGENTS->~/.config/nats/cortex-work.creds`,
      "restart-daemon",
    ]);
  });

  test("idempotent: converged re-run mints nothing and restarts nothing", async () => {
    const { ports, calls } = makePorts({ resolverHas: true });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: true }), ports);

    expect(res.ok).toBe(true);
    expect(calls).toEqual([]); // zero effects
    expect(res.steps.join("\n")).toContain("Already live");
  });

  test("guard: missing agents_account fails fast (run provision first)", async () => {
    const { ports, calls } = makePorts();
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: false, resolverHasAccount: false }, { agentsAccountPubkey: "" }),
      ports,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("provision");
    expect(calls).toEqual([]); // nothing mutated
  });

  test("export failure aborts BEFORE any creds mint or restart", async () => {
    const { ports, calls } = makePorts({ exportFails: true });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("export-account");
    expect(calls).toEqual([`export:ANDREAS_WORK_AGENTS`]); // no mint, no restart
  });

  test("dry-run mutates nothing", async () => {
    const { ports, calls } = makePorts();
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }, { apply: false }), ports);
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(calls).toEqual([]);
  });

  // M3 — operator-mode guard ──────────────────────────────────────────────────
  test("M3: refuses a bus with no resolver_preload block (halden pattern)", async () => {
    const { ports, calls } = makePorts({ hasResolverPreload: false });
    const res = await makeLiveStack(makeInputs({ credsFileExists: false, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(false);
    expect(res.reason).toContain("not");
    expect(res.reason).toContain("operator-mode");
    expect(res.reason).toContain("resolver_preload");
    expect(calls).toEqual([]); // nothing minted/restarted
  });

  test("M3: refuses even in dry-run (preview catches the category error)", async () => {
    const { ports, calls } = makePorts({ hasResolverPreload: false });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: false, resolverHasAccount: false }, { apply: false }),
      ports,
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  // cortex#1265 — operator-mode bootstrap (local-only path) ─────────────────────
  const FAKE_PKG = {
    operatorJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJPQUZBS0UifQ.sig",
    account: "A" + "F".repeat(55),
    accountJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBRkVEIn0.sig",
  };

  test("bootstrap: no resolver_preload BUT package present → bootstrap → append → restart", async () => {
    const { ports, calls } = makePorts({ hasResolverPreload: false });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: false, resolverHasAccount: false }, { operatorModePackage: FAKE_PKG }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    // Bootstrap FIRST (creates the resolver_preload), then the agents append, then
    // a SINGLE nats restart, then creds mint, then daemon restart.
    expect(calls).toEqual([
      `bootstrap:~/.config/nats/local.conf`,
      `export:ANDREAS_WORK_AGENTS`,
      `resolver-append:${AGENTS_PUB}`,
      "restart-nats",
      `mint:cortex-work@ANDREAS_WORK_AGENTS->~/.config/nats/cortex-work.creds`,
      "restart-daemon",
    ]);
    expect(res.steps.join("\n")).toContain("operator-mode bootstrap");
  });

  test("bootstrap: a refuse (different operator) aborts before any append/restart", async () => {
    const { ports, calls } = makePorts({ hasResolverPreload: false, bootstrapFails: true });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: false, resolverHasAccount: false }, { operatorModePackage: FAKE_PKG }),
      ports,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("operator-mode bootstrap failed");
    expect(calls).toEqual([`bootstrap:~/.config/nats/local.conf`]); // nothing after
  });

  test("bootstrap: the plan shows the bootstrap step in dry-run", async () => {
    const { ports, calls } = makePorts({ hasResolverPreload: false });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: false, resolverHasAccount: false }, { apply: false, operatorModePackage: FAKE_PKG }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.steps.join("\n")).toContain("operator-mode bootstrap");
    expect(calls).toEqual([]); // dry-run mutates nothing
  });

  test("bootstrap: refuses when NO package AND no resolver_preload (the #794 floor)", async () => {
    const { ports, calls } = makePorts({ hasResolverPreload: false });
    const res = await makeLiveStack(makeInputs({ credsFileExists: false, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("no operator-mode JWTs");
    expect(res.reason).toContain("provision");
    expect(calls).toEqual([]);
  });

  // BLOCK 3 — pubkey drift cross-check ─────────────────────────────────────────
  test("BLOCK 3: export-account pubkey ≠ config pubkey aborts before resolver write", async () => {
    const driftKey = "A" + "Q".repeat(55);
    const { ports, calls } = makePorts({ exportPubKey: driftKey });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("pubkey drift");
    expect(res.reason).toContain(driftKey);
    // exported, then aborted — NO resolver append, NO restart, NO mint.
    expect(calls).toEqual([`export:ANDREAS_WORK_AGENTS`]);
  });

  // M2 — --force must not no-op-restart a shared nats-server ────────────────────
  test("M2: --force with the account already present re-mints but does NOT restart nats", async () => {
    // resolver already has the account ⇒ append no-ops (changed:false); --force
    // still re-mints creds + restarts the daemon, but the shared nats-server must
    // NOT be hard-restarted for a no-op resolver.
    const { ports, calls } = makePorts({ resolverHas: true, appendChanged: false });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: true, resolverHasAccount: true }, { force: true }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls).toContain(`export:ANDREAS_WORK_AGENTS`);
    expect(calls).toContain(`resolver-append:${AGENTS_PUB}`);
    expect(calls).not.toContain("restart-nats"); // ← the M2 guarantee
    expect(calls).toContain(`mint:cortex-work@ANDREAS_WORK_AGENTS->~/.config/nats/cortex-work.creds`);
    expect(calls).toContain("restart-daemon");
  });

  // BLOCK 2 — dry-run resolves + prints the restart targets ─────────────────────
  test("BLOCK 2: dry-run prints the resolved nats-server + daemon restart targets", async () => {
    const { ports } = makePorts({ natsDescriptor: "/LA/homebrew.nats.plist", daemonDescriptor: "/LA/cortex.work.plist" });
    const res = await makeLiveStack(makeInputs({ credsFileExists: false, resolverHasAccount: false }, { apply: false }), ports);
    expect(res.ok).toBe(true);
    const txt = res.steps.join("\n");
    expect(txt).toContain("nats-server restart target");
    expect(txt).toContain("/LA/homebrew.nats.plist");
    expect(txt).toContain("cortex daemon restart target");
    expect(txt).toContain("/LA/cortex.work.plist");
  });

  test("BLOCK 2: dry-run warns when a NEEDED restart has no discoverable service", async () => {
    const { ports } = makePorts({ natsDescriptor: undefined });
    const res = await makeLiveStack(makeInputs({ credsFileExists: false, resolverHasAccount: false }, { apply: false }), ports);
    expect(res.ok).toBe(true);
    const txt = res.steps.join("\n");
    expect(txt).toContain("WARNING");
    expect(txt).toContain("NOT FOUND");
  });
});

// ── resolver_preload insertion (multi-stack safety) ─────────────────────────────

describe("insertIntoResolverPreload", () => {
  const CONF = [
    "resolver: MEMORY",
    "",
    "resolver_preload: {",
    "  // Account \"ANDREAS_AGENTS\"",
    "  AOLD: eyJold",
    "  // Account \"SYS\"",
    "  ASYS: eyJsys",
    "}",
    "",
    "http: \"127.0.0.1:8222\"",
  ].join("\n");

  test("inserts before the closing brace, preserving existing accounts", () => {
    const out = insertIntoResolverPreload(CONF, "  // Account \"NEW\"\n  ANEW: eyJnew\n");
    expect(out).not.toBeNull();
    // existing accounts untouched
    expect(out).toContain("AOLD: eyJold");
    expect(out).toContain("ASYS: eyJsys");
    // new account landed INSIDE the block (before the closing brace, before http)
    const idxNew = out!.indexOf("ANEW: eyJnew");
    const idxClose = out!.indexOf("\n}");
    const idxHttp = out!.indexOf("http:");
    expect(idxNew).toBeGreaterThan(0);
    expect(idxNew).toBeLessThan(idxClose);
    expect(idxClose).toBeLessThan(idxHttp);
  });

  test("returns null when there is no resolver_preload block", () => {
    expect(insertIntoResolverPreload("listen: 127.0.0.1:4222\n", "x")).toBeNull();
  });
});

// ── cortex#1265 — bootstrapOperatorMode adapter (real renderOperatorModeBlocks) ─

describe("buildResolverPreloadAdapter — bootstrapOperatorMode (cortex#1265)", () => {
  const PKG = {
    operatorJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJPUCJ9.sig",
    account: "A" + "F".repeat(55),
    accountJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBRkVEIn0.sig",
  };
  // A plain bus config: server identity, NO operator-mode blocks.
  const BASE_CONF = ['server_name: "research"', 'listen: "127.0.0.1:4222"', 'http: "127.0.0.1:8222"'].join("\n") + "\n";

  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-bootstrap-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("renders operator + resolver_preload (federation account), KEEPING server identity", () => {
    const path = join(dir, "research.conf");
    writeFileSync(path, BASE_CONF, "utf-8");
    const adapter = buildResolverPreloadAdapter();

    const r = adapter.bootstrapOperatorMode({ natsConfigPath: path, package: PKG });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);

    const out = readFileSync(path, "utf-8");
    // operator-mode blocks rendered…
    expect(out).toContain("operator: " + PKG.operatorJwt);
    expect(out).toContain("resolver: MEMORY");
    expect(out).toContain(`${PKG.account}: ${PKG.accountJwt}`);
    // …and the bus's own identity preserved verbatim.
    expect(out).toContain('server_name: "research"');
    expect(out).toContain('listen: "127.0.0.1:4222"');
    // The probe now reports operator-mode (so the append step finds the block).
    expect(adapter.hasResolverPreload(path)).toBe(true);
  });

  test("idempotent: a second bootstrap on the converted bus is a no-op (changed:false)", () => {
    const path = join(dir, "research.conf");
    writeFileSync(path, BASE_CONF, "utf-8");
    const adapter = buildResolverPreloadAdapter();
    adapter.bootstrapOperatorMode({ natsConfigPath: path, package: PKG });
    const second = adapter.bootstrapOperatorMode({ natsConfigPath: path, package: PKG });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.changed).toBe(false);
  });

  test("refuses when the base config file is absent AND no baseIdentity (never fabricate server identity)", () => {
    const adapter = buildResolverPreloadAdapter();
    const r = adapter.bootstrapOperatorMode({ natsConfigPath: join(dir, "missing.conf"), package: PKG });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not found");
  });

  // cortex#1265 (PR8) — from-scratch path: absent file + derived baseIdentity ⇒
  // SYNTHESISE the hard-isolated base, then render the operator-mode blocks onto
  // it → a complete, nats-server-loadable operator-mode config, in one shot.
  test("absent file + baseIdentity → synthesises a COMPLETE loadable operator-mode config (zero raw nsc)", () => {
    const path = join(dir, "research.conf"); // does NOT exist yet
    const adapter = buildResolverPreloadAdapter();

    const r = adapter.bootstrapOperatorMode({
      natsConfigPath: path,
      package: PKG,
      baseIdentity: {
        serverName: "research-acme",
        listen: "127.0.0.1:4222",
        jetstreamStoreDir: "~/.config/nats/research-jetstream",
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);

    const out = readFileSync(path, "utf-8");
    // Base identity (derived, not fabricated) …
    expect(out).toContain('server_name: "research-acme"');
    expect(out).toContain('listen: "127.0.0.1:4222"');
    expect(out).toContain("jetstream {");
    expect(out).toContain('store_dir: "~/.config/nats/research-jetstream"');
    expect(out).toContain('domain: "research-acme"');
    // … plus the full operator-mode block set (the loadable MEMORY-resolver shape).
    expect(out).toContain("operator: " + PKG.operatorJwt);
    expect(out).toContain("resolver: MEMORY");
    expect(out).toContain("resolver_preload: {");
    expect(out).toContain(`${PKG.account}: ${PKG.accountJwt}`);
    // The isolation wall: no leafnodes/cluster/gateway accept block (join adds the
    // per-network leaf REMOTE later).
    expect(out).not.toMatch(/^\s*leafnodes\s*\{/m);
    // The probe now reports operator-mode (so the subsequent append finds the block).
    expect(adapter.hasResolverPreload(path)).toBe(true);
  });
});

// ── nats-server descriptor discovery (restart the RIGHT server) ─────────────────

describe("findNatsServerDescriptor", () => {
  const plist = (program: string, configArg: string) =>
    `<plist><dict><key>ProgramArguments</key><array>` +
    `<string>${program}</string><string>-js</string><string>-c</string><string>${configArg}</string>` +
    `</array></dict></plist>`;

  function io(files: Record<string, string>): DaemonLocatorIO {
    return {
      listDir: (dir) => Object.keys(files).filter((f) => f.startsWith(dir)).map((f) => f.slice(dir.length + 1)),
      readFile: (p) => files[p] ?? (() => { throw new Error("ENOENT"); })(),
      exists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(p)),
    };
  }

  test("matches the plist running nats-server -c <natsConfig>", () => {
    const dir = "/la";
    const files = {
      [`${dir}/homebrew.mxcl.nats-server.plist`]: plist("/opt/homebrew/opt/nats-server/bin/nats-server", "/home/x/.config/nats/local.conf"),
      [`${dir}/ai.meta-factory.cortex.work.plist`]: plist("bun", "/home/x/.config/cortex/work/work.yaml"),
    };
    const found = findNatsServerDescriptor({
      platform: "darwin",
      natsConfigPath: "/home/x/.config/nats/local.conf",
      launchAgentsDir: dir,
      systemdUserDir: "/sd",
      io: io(files),
    });
    expect(found).toBe(`${dir}/homebrew.mxcl.nats-server.plist`);
  });

  test("returns undefined when no nats-server plist references the config", () => {
    const dir = "/la";
    const files = { [`${dir}/other.plist`]: plist("/usr/bin/redis", "/etc/redis.conf") };
    const found = findNatsServerDescriptor({
      platform: "darwin",
      natsConfigPath: "/home/x/.config/nats/local.conf",
      launchAgentsDir: dir,
      systemdUserDir: "/sd",
      io: io(files),
    });
    expect(found).toBeUndefined();
  });
});
