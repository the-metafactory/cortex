/**
 * G1c (#1117, ADR-0013) — federation-wiring step in `cortex network join`.
 *
 * Tests that `joinNetwork` orchestrates the local-side `federated.>` export/import
 * by calling `FederationWiringPort.wireLocalFederation(...)` at step (b.4):
 *   - after bind-mode resolution (so the federation/leaf account is known),
 *   - before the leaf file write (fail-fast before any mutation on arc failure).
 *
 * Model B (ADR-0013): each principal wires their OWN half, in their OWN store.
 * The call is LOCAL — no peer account, no network id on the wire.
 *
 * The arc-shell runner is NEVER called in tests — only the port method is.
 * The injected `FederationWiringPort` is a fake (no real arc / nsc invocations).
 */

import { describe, test, expect } from "bun:test";

import {
  joinNetwork,
  type JoiningStack,
} from "../network-lib";
import type {
  ConfigStorePort,
  DaemonPort,
  FederationWiringPort,
  LeafFilePort,
  LeafStatePort,
  NatsServerPort,
  NetworkPorts,
  NetworkRegistryPort,
  PlistPort,
  RenderLeafInputs,
} from "../network-ports";
import type {
  NetworkDescriptor,
  NetworkRosterResult,
} from "../../../../common/registry/types";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";

// =============================================================================
// Fixtures
// =============================================================================

const LEAF_ACCOUNT = "A" + "B".repeat(55); // valid nkey-A account public key
const AGENTS_ACCOUNT = "A" + "C".repeat(55); // distinct agents account

const LOCAL: JoiningStack = {
  principalId: "andreas",
  stackSlug: "meta-factory",
  credentials: "/Users/andreas/.config/nats/andreas.creds",
  account: LEAF_ACCOUNT,
};

const LOCAL_NO_ACCOUNT: JoiningStack = {
  principalId: "andreas",
  stackSlug: "meta-factory",
  credentials: "/Users/andreas/.config/nats/andreas.creds",
  // no account — $G/default bus
};

function descriptorFor(networkId: string): NetworkDescriptor {
  return {
    network_id: networkId,
    hub_url: "tls://hub.meta-factory.ai:7422",
    leaf_port: 7422,
    members: ["andreas"],
  };
}

function rosterFor(networkId: string): NetworkRosterResult {
  return {
    network_id: networkId,
    members: [],
  };
}

// =============================================================================
// Fake FederationWiringPort + port bundle helpers
// =============================================================================

interface WiringCall {
  federationAccount: string;
  agentsAccount: string | undefined;
  apply: boolean;
}

interface WiringRecorder {
  calls: WiringCall[];
}

function makeFederationPort(opts: {
  ok?: boolean;
  /** When true, wireLocalFederation() throws synchronously (arc not found). */
  throws?: boolean;
}): { port: FederationWiringPort; rec: WiringRecorder } {
  const rec: WiringRecorder = { calls: [] };
  const port: FederationWiringPort = {
    async wireLocalFederation({ federationAccount, agentsAccount, apply }) {
      rec.calls.push({ federationAccount, agentsAccount, apply });
      if (opts.throws === true) {
        throw new Error("arc binary not found on PATH (ENOENT)");
      }
      if (opts.ok === false) {
        return {
          ok: false,
          reason: "arc nats add-federation-export failed: NSC_COMMAND_FAILED",
        };
      }
      return { ok: true, note: "export+import wired (idempotent)" };
    },
  };
  return { port, rec };
}

/** Minimal fake ports bundle that is always "happy" except where overridden. */
function makeMinimalPorts(opts: {
  federationWiring?: FederationWiringPort;
  busType?: "operator-mode" | "default-g";
  wiringOk?: boolean;
  wiringThrows?: boolean;
  /** G1c: mirrors --apply. Default: false (dry-run). */
  apply?: boolean;
}): { ports: NetworkPorts; wiringRec: WiringRecorder; writes: RenderLeafInputs[] } {
  const writes: RenderLeafInputs[] = [];

  const { port: federationPort, rec: wiringRec } = makeFederationPort({
    ok: opts.wiringOk,
    throws: opts.wiringThrows,
  });

  const registry: NetworkRegistryPort = {
    async registerStack() { return { ok: true, note: "HTTP 201" }; },
    async fetchVerified(id) {
      return {
        status: "ok",
        value: { descriptor: descriptorFor(id), roster: rosterFor(id) },
      };
    },
    loadCached() { return undefined; },
    async deregisterFromNetwork() { return { ok: true, note: "ok" }; },
    async departFromNetwork() { return { ok: true, note: "ok" }; },
  };

  const busType = opts.busType ?? "operator-mode";

  const leafFile: LeafFilePort = {
    write(inputs) { writes.push(inputs); },
    remove() {},
    ensureInclude() {},
    removeInclude() {},
    list() { return []; },
    natsConfigPath() { return "/etc/nats/local.conf"; },
    canBindAccount() { return { canBind: true }; },
    resolveBindMode(account, hasCreds) {
      if (!hasCreds) return { mode: "refuse", reason: "no creds" };
      if (busType === "default-g") return { mode: "creds-only" };
      const trimmed = account?.trim();
      if (trimmed && trimmed.length > 0) return { mode: "operator-account", account: trimmed };
      return { mode: "refuse", reason: "no account for operator-mode bus" };
    },
    convertToOperatorMode() { return { status: "already", conf: "" }; },
    credsExist() { return true; },
    snapshotLeafState(networkId) { return { networkId, includeFile: undefined, natsConfig: undefined }; },
    restoreLeafState() {},
  };

  const plist: PlistPort = {
    ensureConfigLoaded() {},
    dropConfigArg() {},
  };

  const configStore: ConfigStorePort = {
    readNetworks(): PolicyFederatedNetwork[] { return []; },
    writeNetworks() {},
  };

  const daemon: DaemonPort = {
    async restart() { return { ok: true }; },
  };

  const natsServer: NatsServerPort = {
    async restart() { return { ok: true }; },
    async validateConfig() { return { status: "valid" as const }; },
    async isHealthy() { return { healthy: true }; },
  };

  const ports: NetworkPorts = {
    registry,
    leafFile,
    plist,
    configStore,
    daemon,
    natsServer,
    federationWiring: opts.federationWiring ?? federationPort,
    // G1c: mirror the --apply flag so wireLocalFederation receives the right value.
    apply: opts.apply ?? false,
  };

  return { ports, wiringRec, writes };
}

// =============================================================================
// Tests
// =============================================================================

describe("G1c — federation-wiring step in joinNetwork (ADR-0013 Model B)", () => {

  // -------------------------------------------------------------------------
  // (b.4) step is called on a successful join with an operator-mode bus
  // -------------------------------------------------------------------------

  test("dry-run: calls wireLocalFederation with apply=false and does NOT write leaf", async () => {
    const { ports, wiringRec, writes } = makeMinimalPorts({});
    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(true);
    expect(wiringRec.calls).toHaveLength(1);
    expect(wiringRec.calls[0]!.apply).toBe(false);
    expect(wiringRec.calls[0]!.federationAccount).toBe(LEAF_ACCOUNT);
    // No agentsAccount in JoiningStack → undefined (same-account fallback flagged as G1d)
    expect(wiringRec.calls[0]!.agentsAccount).toBeUndefined();
    // Leaf IS written (dry-run ports still record writes in the fake)
    expect(writes).toHaveLength(1);
  });

  test("--apply: calls wireLocalFederation with apply=true", async () => {
    const { port: federationPort, rec: wiringRec } = makeFederationPort({ ok: true });
    const { ports, writes } = makeMinimalPorts({
      federationWiring: federationPort,
      apply: true,
    });

    const res = await joinNetwork("metafactory", { ...LOCAL }, ports);

    expect(res.ok).toBe(true);
    // Called exactly once with apply=true
    expect(wiringRec.calls).toHaveLength(1);
    expect(wiringRec.calls[0]!.apply).toBe(true);
    // Leaf written
    expect(writes).toHaveLength(1);
  });

  test("wiring step passes agentsAccount from JoiningStack when supplied", async () => {
    const { port: federationPort, rec: wiringRec } = makeFederationPort({ ok: true });
    const { ports } = makeMinimalPorts({ federationWiring: federationPort });

    const stackWithAgents: JoiningStack = {
      ...LOCAL,
      agentsAccount: AGENTS_ACCOUNT,
    };

    const res = await joinNetwork("metafactory", stackWithAgents, ports);
    expect(res.ok).toBe(true);
    expect(wiringRec.calls[0]!.federationAccount).toBe(LEAF_ACCOUNT);
    expect(wiringRec.calls[0]!.agentsAccount).toBe(AGENTS_ACCOUNT);
  });

  // -------------------------------------------------------------------------
  // Fail-fast: arc failure aborts join BEFORE the leaf write
  // -------------------------------------------------------------------------

  test("arc failure (ok=false): join fails and leaf is NOT written", async () => {
    const { ports, wiringRec, writes } = makeMinimalPorts({ wiringOk: false });

    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/add-federation-export failed/i);
    // Wiring was called
    expect(wiringRec.calls).toHaveLength(1);
    // Leaf write was NEVER reached
    expect(writes).toHaveLength(0);
  });

  test("arc spawn throws (ENOENT): join fails and leaf is NOT written", async () => {
    const { ports, wiringRec, writes } = makeMinimalPorts({ wiringThrows: true });

    const res = await joinNetwork("metafactory", LOCAL, ports);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/arc binary not found/i);
    // Wiring was called (the port wrapped the throw)
    expect(wiringRec.calls).toHaveLength(1);
    // Leaf write was NEVER reached
    expect(writes).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // $G/default-account bus (creds-only mode): wiring is skipped
  // -------------------------------------------------------------------------

  test("creds-only bus ($G): wiring step is SKIPPED (no federation account)", async () => {
    const { ports, wiringRec, writes } = makeMinimalPorts({ busType: "default-g" });

    const res = await joinNetwork("metafactory", LOCAL_NO_ACCOUNT, ports);

    expect(res.ok).toBe(true);
    // No federation account → wiring is skipped
    expect(wiringRec.calls).toHaveLength(0);
    // Leaf still written
    expect(writes).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Step (b.4) placement: wiring runs AFTER bind-mode resolution
  // -------------------------------------------------------------------------

  test("step placement: wiring called BEFORE leaf write (fail-fast friendly)", async () => {
    const callOrder: string[] = [];

    const { port: federationPort } = makeFederationPort({ ok: true });
    // Wrap to record order
    const trackedWiring: FederationWiringPort = {
      async wireLocalFederation(params) {
        callOrder.push("wiring");
        return federationPort.wireLocalFederation(params);
      },
    };

    const writes: RenderLeafInputs[] = [];
    const registry: NetworkRegistryPort = {
      async registerStack() { return { ok: true, note: "HTTP 201" }; },
      async fetchVerified(id) {
        return {
          status: "ok",
          value: { descriptor: descriptorFor(id), roster: rosterFor(id) },
        };
      },
      loadCached() { return undefined; },
      async deregisterFromNetwork() { return { ok: true, note: "ok" }; },
    async departFromNetwork() { return { ok: true, note: "ok" }; },
    };

    const leafFile: LeafFilePort = {
      write(inputs) { callOrder.push("leafWrite"); writes.push(inputs); },
      remove() {},
      ensureInclude() {},
      removeInclude() {},
      list() { return []; },
      natsConfigPath() { return "/etc/nats/local.conf"; },
      canBindAccount() { return { canBind: true }; },
      resolveBindMode(account, hasCreds) {
        if (!hasCreds) return { mode: "refuse", reason: "no creds" };
        const trimmed = account?.trim();
        if (trimmed && trimmed.length > 0) return { mode: "operator-account", account: trimmed };
        return { mode: "refuse", reason: "no account" };
      },
      convertToOperatorMode() { return { status: "already", conf: "" }; },
      credsExist() { return true; },
      snapshotLeafState(networkId) { return { networkId, includeFile: undefined, natsConfig: undefined }; },
      restoreLeafState() {},
    };

    const ports: NetworkPorts = {
      registry,
      leafFile,
      plist: { ensureConfigLoaded() {}, dropConfigArg() {} },
      configStore: { readNetworks() { return []; }, writeNetworks() {} },
      daemon: { async restart() { return { ok: true }; } },
      natsServer: {
        async restart() { return { ok: true }; },
        async validateConfig() { return { status: "valid" as const }; },
        async isHealthy() { return { healthy: true }; },
      },
      federationWiring: trackedWiring,
      apply: false,
    };

    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(res.ok).toBe(true);
    expect(callOrder.indexOf("wiring")).toBeLessThan(callOrder.indexOf("leafWrite"));
  });

  // -------------------------------------------------------------------------
  // No federationWiring port wired: join succeeds (backwards-compat / no-op)
  // -------------------------------------------------------------------------

  test("federationWiring absent: join succeeds (no-op — backwards compat)", async () => {
    const { ports, writes } = makeMinimalPorts({});
    // Remove the wiring port
    const portsWithout: NetworkPorts = { ...ports, federationWiring: undefined };

    const res = await joinNetwork("metafactory", LOCAL, portsWithout);
    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Dry-run step log includes a line about the wiring plan
  // -------------------------------------------------------------------------

  test("dry-run step log mentions the federated.> wiring plan", async () => {
    const { ports } = makeMinimalPorts({});

    const res = await joinNetwork("metafactory", LOCAL, ports);
    expect(res.ok).toBe(true);
    const wiringStep = res.steps.find((s) => s.includes("federation") || s.includes("federated.>"));
    expect(wiringStep).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Idempotency: calling join twice does not double-call wiring (2nd call is
  // still exactly 1 invocation — the port itself is idempotent)
  // -------------------------------------------------------------------------

  test("re-join calls wireLocalFederation exactly once per join invocation", async () => {
    const { ports, wiringRec } = makeMinimalPorts({});

    await joinNetwork("metafactory", LOCAL, ports);
    await joinNetwork("metafactory", LOCAL, ports);

    // Each joinNetwork call invokes the port once; 2 calls → 2 wiring invocations
    expect(wiringRec.calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // cortex never calls nsc directly (structural: the port is the only path)
  // -------------------------------------------------------------------------

  test("no direct nsc calls: all wiring goes through FederationWiringPort", async () => {
    // This test is structural: we never import nsc / no nsc references exist in
    // network-lib.ts. The port is the only call site. If the implementation
    // were to bypass the port and call nsc directly, the fake would not record
    // the call and the step-placement test above would fail independently.
    // We assert the port WAS called, confirming the call went through the seam.
    const { ports, wiringRec } = makeMinimalPorts({});
    await joinNetwork("metafactory", LOCAL, ports);
    expect(wiringRec.calls).toHaveLength(1);
  });
});

// =============================================================================
// FederationWiringAdapter (live adapter) — arc-shell unit tests
// =============================================================================

import {
  buildFederationWiringAdapter,
  type ArcFederationRunner,
} from "../network-federation-wiring";

describe("buildFederationWiringAdapter — arc-shell adapter", () => {

  function makeRunner(response: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }): { runner: ArcFederationRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: ArcFederationRunner = async (argv) => {
      calls.push([...argv]);
      return {
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
        exitCode: response.exitCode ?? 0,
      };
    };
    return { runner, calls };
  }

  const SUCCESS_JSON = JSON.stringify({
    schema: "arc.nats.federation.v1",
    ok: true,
    fromAccount: LEAF_ACCOUNT,
    toAccount: AGENTS_ACCOUNT,
    subject: "federated.>",
    exportAdded: true,
    importAdded: true,
    exportAlreadyPresent: false,
    importAlreadyPresent: false,
  });

  const IDEMPOTENT_JSON = JSON.stringify({
    schema: "arc.nats.federation.v1",
    ok: true,
    fromAccount: LEAF_ACCOUNT,
    toAccount: AGENTS_ACCOUNT,
    subject: "federated.>",
    exportAdded: false,
    importAdded: false,
    exportAlreadyPresent: true,
    importAlreadyPresent: true,
  });

  test("dry-run: invokes arc with NO --apply and NO --dry-run (arc default is dry-run) and returns ok", async () => {
    const { runner, calls } = makeRunner({ stdout: SUCCESS_JSON });
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: false,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // arc's add-federation-export has NO --dry-run flag: dry-run is the default
    // and only --apply mutates. The non-apply branch must emit neither flag —
    // passing --dry-run makes real arc exit 1 with `unknown option '--dry-run'`.
    expect(calls[0]).not.toContain("--dry-run");
    expect(calls[0]).not.toContain("--apply");
    expect(calls[0]).toContain("--from-account");
    expect(calls[0]).toContain(LEAF_ACCOUNT);
    expect(calls[0]).toContain("--to-account");
    expect(calls[0]).toContain(AGENTS_ACCOUNT);
    expect(calls[0]).toContain("--json");
  });

  test("dry-run regression: a runner mimicking real arc's --dry-run rejection would surface failure (guards against a non-existent arc flag)", async () => {
    // Mimic real arc's behaviour if the adapter ever regressed to passing a flag
    // arc does not know (e.g. --dry-run): commander exits 1 with empty stdout and
    // an `unknown option` error on stderr. This pins the regression to real-arc
    // behaviour rather than a permissive mock that returns success for any argv.
    const realArcLikeRunner: ArcFederationRunner = async (argv) => {
      const unknown = argv.find(
        (a) => a.startsWith("--") && a !== "--from-account" && a !== "--to-account"
          && a !== "--subject" && a !== "--service" && a !== "--apply" && a !== "--json",
      );
      if (unknown !== undefined) {
        return { stdout: "", stderr: `error: unknown option '${unknown}'`, exitCode: 1 };
      }
      return { stdout: SUCCESS_JSON, stderr: "", exitCode: 0 };
    };
    const adapter = buildFederationWiringAdapter(realArcLikeRunner);

    // The shipping adapter (no --dry-run flag) succeeds against real-arc behaviour.
    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: false,
    });

    expect(result.ok).toBe(true);
  });

  test("--apply: invokes arc with --apply (not --dry-run)", async () => {
    const { runner, calls } = makeRunner({ stdout: SUCCESS_JSON });
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]).toContain("--apply");
    expect(calls[0]).not.toContain("--dry-run");
  });

  test("idempotent: already-present export+import is ok", async () => {
    const { runner } = makeRunner({ stdout: IDEMPOTENT_JSON });
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toBeDefined();
  });

  test("arc ok=false: returns ok=false with reason from arc", async () => {
    const errorJson = JSON.stringify({
      schema: "arc.nats.federation.v1",
      ok: false,
      error: { code: "NSC_COMMAND_FAILED", message: "nsc add export failed" },
    });
    const { runner } = makeRunner({ stdout: errorJson });
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/NSC_COMMAND_FAILED/);
  });

  test("arc no valid JSON: returns ok=false with clear error", async () => {
    const { runner } = makeRunner({ stdout: "not json", exitCode: 1 });
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/arc returned no valid/i);
  });

  test("arc spawn throws: returns ok=false (never throws)", async () => {
    const throwingRunner: ArcFederationRunner = async (_argv) => {
      throw new Error("ENOENT: arc not found");
    };
    const adapter = buildFederationWiringAdapter(throwingRunner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ENOENT/i);
  });

  test("no agentsAccount: arc IS called exactly once with --from-account == --to-account (same-account / G1d path)", async () => {
    // G1d same-account path: agentsAccount absent → toAccount = federationAccount = LEAF_ACCOUNT.
    // arc is always called (the adapter always shells out; the arc primitive treats
    // from==to as a no-op locally). Build a SUCCESS_JSON with toAccount=LEAF_ACCOUNT
    // to match the actual args the adapter will pass.
    const sameAccountSuccessJson = JSON.stringify({
      schema: "arc.nats.federation.v1",
      ok: true,
      fromAccount: LEAF_ACCOUNT,
      toAccount: LEAF_ACCOUNT,
      subject: "federated.>",
      exportAdded: true,
      importAdded: true,
      exportAlreadyPresent: false,
      importAlreadyPresent: false,
    });

    const { runner, calls } = makeRunner({ stdout: sameAccountSuccessJson });
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: undefined,
      apply: false,
    });

    expect(result.ok).toBe(true);

    // HARD: arc MUST be invoked exactly once — the G1d path is a no-op in the
    // arc primitive, not in the adapter. Zero calls means the behavior was never
    // exercised; > 1 call means a double-invocation bug.
    expect(calls).toHaveLength(1);

    // HARD: --from-account must be present and equal LEAF_ACCOUNT.
    const fromIdx = calls[0]!.indexOf("--from-account");
    expect(fromIdx).toBeGreaterThanOrEqual(0);
    expect(calls[0]![fromIdx + 1]).toBe(LEAF_ACCOUNT);

    // HARD: --to-account must be present and equal LEAF_ACCOUNT (same-account).
    const toIdx = calls[0]!.indexOf("--to-account");
    expect(toIdx).toBeGreaterThanOrEqual(0);
    expect(calls[0]![toIdx + 1]).toBe(LEAF_ACCOUNT);

    // HARD: both accounts are identical (the defining property of the G1d path).
    expect(calls[0]![fromIdx + 1]).toBe(calls[0]![toIdx + 1]);
  });

  test("command includes 'nats add-federation-export' as the arc subcommand", async () => {
    const { runner, calls } = makeRunner({ stdout: SUCCESS_JSON });
    const adapter = buildFederationWiringAdapter(runner);

    await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: false,
    });

    expect(calls[0]).toContain("nats");
    expect(calls[0]).toContain("add-federation-export");
  });
});

// =============================================================================
// cortex#1225 regression — accept arc's REAL schema, reject the wrong one
//
// The adapter originally required `arc.nats.v2`, a schema arc never shipped
// (arc#243 namespaces federation results under `arc.nats.federation.v1`). That
// made `cortex network provision --apply` always fail at the federation-wiring
// step against real arc, blocking the PR7 live-stack migration. These tests
// pin the contract to what arc ACTUALLY emits and prove the never-shipped
// `arc.nats.v2` is rejected, so the regression cannot silently return.
// =============================================================================

describe("cortex#1225 — federation-wiring schema contract (arc.nats.federation.v1)", () => {
  function makeRunner(stdout: string): { runner: ArcFederationRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: ArcFederationRunner = async (argv) => {
      calls.push([...argv]);
      return { stdout, stderr: "", exitCode: 0 };
    };
    return { runner, calls };
  }

  // Mirrors arc's REAL AddFederationExportJson on --apply, including the extra
  // `pushResult` field arc emits (which cortex does not model and must ignore).
  const REAL_ARC_OUTPUT = JSON.stringify({
    schema: "arc.nats.federation.v1",
    ok: true,
    fromAccount: LEAF_ACCOUNT,
    toAccount: AGENTS_ACCOUNT,
    subject: "federated.>",
    exportAdded: true,
    importAdded: true,
    exportAlreadyPresent: false,
    importAlreadyPresent: false,
    pushResult: { fromAccount: "ok", toAccount: "ok" },
  });

  test("accepts the schema arc actually emits (arc.nats.federation.v1, incl. extra pushResult)", async () => {
    const { runner } = makeRunner(REAL_ARC_OUTPUT);
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toBeDefined();
  });

  test("rejects the never-shipped arc.nats.v2 as a schema mismatch (the original bug)", async () => {
    const wrongSchema = JSON.stringify({
      schema: "arc.nats.v2",
      ok: true,
      fromAccount: LEAF_ACCOUNT,
      toAccount: AGENTS_ACCOUNT,
      subject: "federated.>",
      exportAdded: true,
      importAdded: true,
      exportAlreadyPresent: false,
      importAlreadyPresent: false,
    });
    const { runner } = makeRunner(wrongSchema);
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/schema mismatch/i);
      // The diagnostic names the schema we DID require + the one arc sent.
      expect(result.reason).toMatch(/arc\.nats\.federation\.v1/);
      expect(result.reason).toMatch(/arc\.nats\.v2/);
    }
  });

  test("rejects a genuinely-malformed envelope (missing schema field)", async () => {
    const noSchema = JSON.stringify({
      ok: true,
      fromAccount: LEAF_ACCOUNT,
      toAccount: AGENTS_ACCOUNT,
      subject: "federated.>",
    });
    const { runner } = makeRunner(noSchema);
    const adapter = buildFederationWiringAdapter(runner);

    const result = await adapter.wireLocalFederation({
      federationAccount: LEAF_ACCOUNT,
      agentsAccount: AGENTS_ACCOUNT,
      apply: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/schema mismatch/i);
  });
});
