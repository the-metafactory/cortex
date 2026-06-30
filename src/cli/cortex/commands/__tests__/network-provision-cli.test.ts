/**
 * G1d / T1 (cortex#1139) — CLI tests for `cortex network provision <stack>` and
 * the `cortex network join` auto-provision. The config reader + provision ports
 * are both injected, so no disk / arc / nsc is touched.
 */
import { describe, test, expect } from "bun:test";

import { dispatchNetwork, type ProvisionPortsFactory } from "../network";
import type { ConfigReader } from "../network-derive";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import type { ProvisionPorts } from "../network-provision-lib";
import type { FederationWiringPort } from "../network-ports";
import type { OperatorProvisioningPort } from "../operator-provisioning";

const FED_PUB = "A" + "B".repeat(55);
const AGENTS_PUB = "A" + "C".repeat(55);

function loaded(partial: Partial<LoadedConfig>): LoadedConfig {
  return { config: {} as AgentConfig, inlineAgents: [], ...partial };
}
function reader(cfg: LoadedConfig): ConfigReader {
  return () => cfg;
}

/** A config for an UN-provisioned stack (no nats_infra account tree yet). */
const UNPROVISIONED = loaded({
  principal: { id: "andreas" },
  stack: { id: "andreas/research", nkey_seed_path: "~/.config/nats/andreas-research.seed" },
});

/** A config for a fully-provisioned stack. */
const PROVISIONED = loaded({
  principal: { id: "andreas" },
  stack: {
    id: "andreas/research",
    nkey_seed_path: "~/.config/nats/andreas-research.seed",
    nats_infra: {
      config_path: "~/.config/nats/local.conf",
      plist_path: "~/Library/LaunchAgents/nats.plist",
      account: FED_PUB,
      agents_account: AGENTS_PUB,
      creds_path: "~/.config/nats/research.creds",
    },
  },
});

/** Recording fake ports factory. */
function fakeFactory(): { factory: ProvisionPortsFactory; calls: string[]; writePath: string[]; written: Record<string, unknown>[] } {
  const calls: string[] = [];
  const writePath: string[] = [];
  const written: Record<string, unknown>[] = [];
  const factory: ProvisionPortsFactory = (stackConfigPath) => {
    writePath.push(stackConfigPath);
    const operator: OperatorProvisioningPort = {
      initOperator: async ({ name }) => {
        calls.push(`init-operator:${name}`);
        return { ok: true, operator: name, pubKey: "OD4D", created: true, alreadyExisted: false, seedPath: null };
      },
      addAccount: async ({ name }) => {
        calls.push(`add-account:${name}`);
        return { ok: true, account: name, pubKey: name.endsWith("_AGENTS") ? AGENTS_PUB : FED_PUB, created: true, alreadyExisted: false };
      },
    };
    const federationWiring: FederationWiringPort = {
      wireLocalFederation: async () => {
        calls.push("wire");
        return { ok: true, note: "wired" };
      },
    };
    const ports: ProvisionPorts = {
      operator,
      federationWiring,
      signing: { exists: () => false, generate: () => { calls.push("signing"); return { ok: true, nkeyPub: "U" + "Z".repeat(55), fingerprint: "fp" }; } },
      configWrite: { write: (fields) => { calls.push("config-write"); written.push(fields); return { ok: true }; } },
      export: {
        exportOperator: async ({ name }) => { calls.push(`export-operator:${name}`); return { ok: true, operatorJwt: "eyJ.op.sig", pubKey: "OD4D" }; },
        exportAccount: async (name) => { calls.push(`export-account:${name}`); return { ok: true, pubKey: FED_PUB, jwt: "eyJ.fed.sig" }; },
        exportSystem: async ({ name }) => { calls.push(`export-system:${name}`); return { ok: false, reason: "no SYS", notFound: true }; },
      },
    };
    return ports;
  };
  return { factory, calls, writePath, written };
}

describe("cortex network provision — dry-run (default)", () => {
  test("prints the plan, mutates nothing", async () => {
    const { factory, calls } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "andreas/research", "--config", "/x/research.yaml"],
      reader(UNPROVISIONED),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("nsc operator");
    expect(res.stdout).toContain("ANDREAS_RESEARCH_FED");
    expect(res.stdout).toContain("ANDREAS_RESEARCH_AGENTS");
    expect(calls).toEqual([]); // no effectful calls in dry-run
  });

  test("--json emits an envelope with the derived account-tree names", async () => {
    const { factory } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "andreas/research", "--config", "/x/research.yaml", "--json"],
      reader(UNPROVISIONED),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { status: string; data?: Record<string, string> };
    expect(env.status).toBe("ok");
    expect(env.data?.applied).toBe("false");
    expect(env.data?.federation_account).toBe("ANDREAS_RESEARCH_FED");
    expect(env.data?.agents_account).toBe("ANDREAS_RESEARCH_AGENTS");
  });
});

describe("cortex network provision — apply", () => {
  test("mints operator + both accounts, wires, writes config — in order", async () => {
    const { factory, calls } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "andreas/research", "--config", "/x/research.yaml", "--apply"],
      reader(UNPROVISIONED),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(calls).toEqual([
      "init-operator:OP_ANDREAS",
      "add-account:ANDREAS_RESEARCH_FED",
      "add-account:ANDREAS_RESEARCH_AGENTS",
      "add-account:SYS",
      "signing",
      "wire",
      // cortex#1265 — the operator-mode JWT export bridges wiring → config write.
      "export-operator:OP_ANDREAS",
      "export-account:ANDREAS_RESEARCH_FED",
      "export-system:SYS",
      "config-write",
    ]);
  });

  test("write-back records config_path at the convention default `~/.config/nats/<slug>.conf`", async () => {
    // UNPROVISIONED carries no `nats_infra.config_path`, so provision must fall
    // back to the convention — the field make-live derives `--nats-config` from.
    const { factory, written } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "andreas/research", "--config", "/x/research.yaml", "--apply"],
      reader(UNPROVISIONED),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.configPath).toBe("~/.config/nats/research.conf");
  });

  test("an existing nats_infra.config_path is PRESERVED (never clobbered)", async () => {
    // PROVISIONED already pins `config_path: ~/.config/nats/local.conf` (a shared
    // bus). provision must keep it, not overwrite it with the convention.
    const { factory, written } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "andreas/research", "--config", "/x/research.yaml", "--apply"],
      reader(PROVISIONED),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.configPath).toBe("~/.config/nats/local.conf");
  });

  test("--apply + --dry-run is a usage error (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "andreas/research", "--config", "/x/research.yaml", "--apply", "--dry-run"],
      reader(UNPROVISIONED),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });

  test("a missing principal is a usage error", async () => {
    const { factory } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "research", "--config", "/x/research.yaml"],
      reader(loaded({ stack: { id: "x/research" } })),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("principal");
  });
});

describe("cortex network join — auto-provision (cortex#1139)", () => {
  test("an UN-provisioned stack auto-runs provision first (dry-run)", async () => {
    const { factory, calls } = fakeFactory();
    const res = await dispatchNetwork(
      ["join", "metafactory", "--config", "/x/research.yaml"],
      reader(UNPROVISIONED),
      undefined,
      factory,
    );
    // The auto-provision plan is prepended to the join output.
    expect(res.stdout + res.stderr).toContain("auto-running `cortex network provision`");
    expect(res.stdout + res.stderr).toContain("nsc operator");
    expect(calls).toEqual([]); // dry-run: no mutations
  });

  test("a PROVISIONED stack does NOT auto-run provision", async () => {
    const { factory, calls } = fakeFactory();
    const res = await dispatchNetwork(
      ["join", "metafactory", "--config", "/x/research.yaml"],
      reader(PROVISIONED),
      undefined,
      factory,
    );
    expect(res.stdout + res.stderr).not.toContain("auto-running");
    expect(calls).toEqual([]);
  });
});
