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
import type { ProvisionPorts, SiblingStackRead } from "../network-provision-lib";
import type { FederationWiringPort } from "../network-ports";
import type { OperatorProvisioningPort } from "../operator-provisioning";
import { ACCOUNT_JWT_WITH_JETSTREAM } from "./account-jwt-test-helpers";

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

/**
 * Recording fake ports factory. `files` are the paths the fake fs reports as
 * existing; `siblings` are the other stacks the fake discovery returns.
 */
function fakeFactory(opts: { files?: string[]; siblings?: SiblingStackRead[] } = {}): {
  factory: ProvisionPortsFactory;
  calls: string[];
  writePath: string[];
  cortexPath: (string | undefined)[];
  written: Record<string, unknown>[];
} {
  const calls: string[] = [];
  const writePath: string[] = [];
  const cortexPath: (string | undefined)[] = [];
  const written: Record<string, unknown>[] = [];
  const files = new Set(opts.files ?? []);
  const factory: ProvisionPortsFactory = (stackConfigPath, cortexConfigPath) => {
    writePath.push(stackConfigPath);
    cortexPath.push(cortexConfigPath);
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
        exportAccount: async (name) => {
          calls.push(`export-account:${name}`);
          return name.endsWith("_AGENTS")
            ? { ok: true, pubKey: AGENTS_PUB, jwt: ACCOUNT_JWT_WITH_JETSTREAM }
            : { ok: true, pubKey: FED_PUB, jwt: "eyJ.fed.sig" };
        },
        exportSystem: async ({ name }) => { calls.push(`export-system:${name}`); return { ok: true, pubKey: "A" + "S".repeat(55), jwt: "eyJ.sys.sig" }; },
      },
      jetstream: { enable: async ({ name }) => { calls.push(`enable-jetstream:${name}`); return { ok: true }; } },
      natsConfig: {
        exists: (path) => files.has(path),
        resolvePath: (path) => path,
        siblingStacks: () => opts.siblings ?? [],
      },
    };
    return ports;
  };
  return { factory, calls, writePath, cortexPath, written };
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
      // cortex#2534 — JetStream granted on the agents account, verified by read-back.
      "enable-jetstream:ANDREAS_RESEARCH_AGENTS",
      "export-account:ANDREAS_RESEARCH_AGENTS",
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

  test("write-back records config_path as `~/.config/nats/<slug>.conf` when that file exists", async () => {
    // UNPROVISIONED carries no `nats_infra.config_path`; the conventional file
    // exists, so provision records it — the field make-live derives `--nats-config` from.
    const { factory, written, cortexPath } = fakeFactory({ files: ["~/.config/nats/research.conf"] });
    const res = await dispatchNetwork(
      ["provision", "andreas/research", "--config", "/x/research.yaml", "--apply"],
      reader(UNPROVISIONED),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.configPath).toBe("~/.config/nats/research.conf");
    // Sibling discovery runs beside the --config path.
    expect(cortexPath).toEqual(["/x/research.yaml"]);
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

describe("cortex network provision — nats-server config path (cortex#2535)", () => {
  /** A second stack on a principal's shared bus, with no nats_infra yet. */
  const SECOND_STACK = loaded({
    config: { nats: { url: "nats://localhost:4222" } } as AgentConfig,
    principal: { id: "alice" },
    stack: { id: "alice/lab", nkey_seed_path: "~/.config/nats/alice-lab.seed" },
  });
  const SHARED_CONF = "~/.config/nats/local.conf";
  const SHARED_PLIST = "~/Library/LaunchAgents/nats.plist";
  const WORK_SIBLING: SiblingStackRead = {
    ok: true,
    stack: { stackId: "alice/work", natsUrl: "nats://127.0.0.1:4222", configPath: SHARED_CONF, plistPath: SHARED_PLIST },
  };

  test("dry-run: <slug>.conf missing + a sibling on the same bus → shows the sibling's path", async () => {
    const { factory } = fakeFactory({ files: [SHARED_CONF], siblings: [WORK_SIBLING] });
    const res = await dispatchNetwork(["provision", "alice/lab", "--config", "/x/lab.yaml"], reader(SECOND_STACK), undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("nats-server config path");
    expect(res.stdout).toContain(`${SHARED_CONF} (from sibling stack alice/work on loopback:4222; plist_path ${SHARED_PLIST})`);
  });

  test("apply: the sibling's config_path + plist_path are written back", async () => {
    const { factory, written } = fakeFactory({ files: [SHARED_CONF], siblings: [WORK_SIBLING] });
    const res = await dispatchNetwork(
      ["provision", "alice/lab", "--config", "/x/lab.yaml", "--apply"],
      reader(SECOND_STACK),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(written[0]?.configPath).toBe(SHARED_CONF);
    expect(written[0]?.plistPath).toBe(SHARED_PLIST);
  });

  test("apply: nothing found → config_path not written, note printed", async () => {
    const { factory, written } = fakeFactory();
    const res = await dispatchNetwork(
      ["provision", "alice/lab", "--config", "/x/lab.yaml", "--apply"],
      reader(SECOND_STACK),
      undefined,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect("configPath" in (written[0] ?? {})).toBe(false);
    expect(res.stdout).toContain("will need --nats-config");
  });

  test("join's --nats-config reaches the auto-provision and wins over discovery", async () => {
    const { factory } = fakeFactory({ files: [SHARED_CONF], siblings: [WORK_SIBLING] });
    const res = await dispatchNetwork(
      ["join", "metafactory", "--config", "/x/lab.yaml", "--nats-config", "~/.config/nats/mine.conf"],
      reader(SECOND_STACK),
      undefined,
      factory,
    );
    const out = res.stdout + res.stderr;
    expect(out).toContain("auto-running `cortex network provision`");
    expect(out).toContain("~/.config/nats/mine.conf (from --nats-config or the stack config; untouched)");
    expect(out).not.toContain("from sibling stack");
  });

  test("--json dry-run reports the branch taken", async () => {
    const sib = fakeFactory({ files: [SHARED_CONF], siblings: [WORK_SIBLING] });
    const resSib = await dispatchNetwork(
      ["provision", "alice/lab", "--config", "/x/lab.yaml", "--json"],
      reader(SECOND_STACK),
      undefined,
      sib.factory,
    );
    const envSib = JSON.parse(resSib.stdout) as { data?: Record<string, string> };
    expect(envSib.data?.config_path_source).toBe("sibling");
    expect(envSib.data?.config_path).toBe(SHARED_CONF);
    expect(envSib.data?.plist_path).toBe(SHARED_PLIST);

    const none = fakeFactory();
    const resNone = await dispatchNetwork(
      ["provision", "alice/lab", "--config", "/x/lab.yaml", "--json"],
      reader(SECOND_STACK),
      undefined,
      none.factory,
    );
    const envNone = JSON.parse(resNone.stdout) as { data?: Record<string, string> };
    expect(envNone.data?.config_path_source).toBe("unset");
    expect(envNone.data?.config_path).toBeUndefined();
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
