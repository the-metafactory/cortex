/**
 * G1d / T1 (cortex#1139) — tests for the pure provision orchestration behind
 * `cortex network provision <stack>`. All arc/fs/nsc effects are injected ports
 * recording their calls — no real nsc/arc/filesystem.
 */
import { describe, test, expect } from "bun:test";

import type { FederationWiringPort } from "../network-ports";
import type { OperatorProvisioningPort } from "../operator-provisioning";
import {
  buildProvisionPlan,
  deriveProvisionNames,
  provisionStack,
  type ProvisionInputs,
  type ProvisionPorts,
  type ProvisionState,
  type SigningIdentityPort,
  type ProvisionConfigWritePort,
  type OperatorModeExportPort,
  type AgentsJetStreamPort,
} from "../network-provision-lib";
import { accountJwt, ACCOUNT_JWT_WITH_JETSTREAM, ACCOUNT_JWT_WITHOUT_JETSTREAM } from "./account-jwt-test-helpers";

const FED_PUB = "A" + "B".repeat(55);
const AGENTS_PUB = "A" + "C".repeat(55);
const SYS_PUB = "A" + "S".repeat(55);
const OP_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJPUCJ9.sig";
const FED_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBRkVEIn0.sig";
const SYS_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBU1lTIn0.sig";

const AGENTS_JWT_NO_JS = ACCOUNT_JWT_WITHOUT_JETSTREAM;
const AGENTS_JWT_JS = ACCOUNT_JWT_WITH_JETSTREAM;

/** Spy ports recording every effectful call in order. */
function makePorts(overrides?: {
  operator?: Partial<OperatorProvisioningPort>;
  signing?: Partial<SigningIdentityPort>;
  federationWiring?: Partial<FederationWiringPort>;
  configWrite?: Partial<ProvisionConfigWritePort>;
  export?: Partial<OperatorModeExportPort>;
  jetstream?: Partial<AgentsJetStreamPort>;
  /** cortex#1265 — make exportSystem report the SYS account absent (a clean skip). */
  systemAbsent?: boolean;
  /**
   * cortex#2534 — the JetStream state of an agents account that ALREADY exists
   * in the nsc store. A freshly minted one always starts disabled (arc's plain
   * `nsc add account`). Default: enabled (a converged stack).
   */
  agentsJetStream?: "enabled" | "disabled";
}): { ports: ProvisionPorts; calls: string[]; written: Record<string, unknown>[] } {
  const calls: string[] = [];
  const written: Record<string, unknown>[] = [];
  // The fake nsc store's view of the agents account's JWT.
  let agentsJwt = (overrides?.agentsJetStream ?? "enabled") === "enabled" ? AGENTS_JWT_JS : AGENTS_JWT_NO_JS;

  const operator: OperatorProvisioningPort = {
    initOperator: async ({ name, force }) => {
      calls.push(`init-operator:${name}${force ? ":force" : ""}`);
      return { ok: true, operator: name, pubKey: "OD4D", created: true, alreadyExisted: false, seedPath: null };
    },
    addAccount: async ({ name }) => {
      calls.push(`add-account:${name}`);
      let pubKey: string;
      if (name.endsWith("_AGENTS")) {
        pubKey = AGENTS_PUB;
        agentsJwt = AGENTS_JWT_NO_JS;
      } else if (name === "SYS") pubKey = SYS_PUB;
      else pubKey = FED_PUB;
      return { ok: true, account: name, pubKey, created: true, alreadyExisted: false };
    },
    ...overrides?.operator,
  };

  const signing: SigningIdentityPort = {
    exists: () => false,
    generate: ({ seedPath, force }) => {
      calls.push(`signing-generate:${seedPath}${force ? ":force" : ""}`);
      return { ok: true, nkeyPub: "U" + "Z".repeat(55), fingerprint: "fp" };
    },
    ...overrides?.signing,
  };

  const federationWiring: FederationWiringPort = {
    wireLocalFederation: async ({ federationAccount, agentsAccount, apply }) => {
      calls.push(`wire:${federationAccount}->${agentsAccount}:${apply ? "apply" : "dry"}`);
      return { ok: true, note: "export+import wired" };
    },
    ...overrides?.federationWiring,
  };

  const configWrite: ProvisionConfigWritePort = {
    write: (fields) => {
      calls.push("config-write");
      written.push(fields);
      return { ok: true };
    },
    ...overrides?.configWrite,
  };

  const exportPort: OperatorModeExportPort = {
    exportOperator: async ({ name }) => {
      calls.push(`export-operator:${name}`);
      return { ok: true, operatorJwt: OP_JWT, pubKey: "OD4D" };
    },
    exportAccount: async (name) => {
      calls.push(`export-account:${name}`);
      if (name.endsWith("_AGENTS")) return { ok: true, pubKey: AGENTS_PUB, jwt: agentsJwt };
      return { ok: true, pubKey: FED_PUB, jwt: FED_JWT };
    },
    exportSystem: async ({ name }) => {
      calls.push(`export-system:${name}`);
      if (overrides?.systemAbsent) return { ok: false, reason: "no SYS", notFound: true };
      return { ok: true, pubKey: SYS_PUB, jwt: SYS_JWT };
    },
    ...overrides?.export,
  };

  const jetstream: AgentsJetStreamPort = {
    enable: async ({ name }) => {
      calls.push(`enable-jetstream:${name}`);
      agentsJwt = AGENTS_JWT_JS;
      return { ok: true };
    },
    ...overrides?.jetstream,
  };

  return { ports: { operator, signing, federationWiring, configWrite, export: exportPort, jetstream }, calls, written };
}

function baseInputs(over?: Partial<ProvisionInputs>, state?: Partial<ProvisionState>): ProvisionInputs {
  return {
    principal: "andreas",
    stackSlug: "research",
    stackId: "andreas/research",
    operatorName: "OP_ANDREAS",
    federationAccountName: "ANDREAS_RESEARCH_FED",
    agentsAccountName: "ANDREAS_RESEARCH_AGENTS",
    systemAccountName: "SYS",
    seedPath: "~/.config/nats/andreas-research.seed",
    credsPath: "~/.config/nats/research.creds",
    configPath: "~/.config/nats/research.conf",
    force: false,
    apply: false,
    state: {
      federationAccount: undefined,
      agentsAccount: undefined,
      systemAccount: undefined,
      signingSeedExists: false,
      operatorModeJwtsPresent: false,
      ...state,
    },
    ...over,
  };
}

describe("deriveProvisionNames", () => {
  test("per-stack agents account is distinct from the federation account", () => {
    const r = deriveProvisionNames("andreas", "research");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operatorName).toBe("OP_ANDREAS");
      expect(r.federationAccountName).toBe("ANDREAS_RESEARCH_FED");
      expect(r.agentsAccountName).toBe("ANDREAS_RESEARCH_AGENTS");
      // ADR-0012 isolation — the two accounts are NOT the same.
      expect(r.federationAccountName).not.toBe(r.agentsAccountName);
    }
  });

  test("a second stack of the same principal mints DIFFERENT accounts", () => {
    const a = deriveProvisionNames("andreas", "research");
    const b = deriveProvisionNames("andreas", "production");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.agentsAccountName).not.toBe(b.agentsAccountName);
    }
  });

  test("hyphens in segments become underscores (UPPER_SNAKE)", () => {
    const r = deriveProvisionNames("andreas-x", "code-review");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operatorName).toBe("OP_ANDREAS_X");
      expect(r.federationAccountName).toBe("ANDREAS_X_CODE_REVIEW_FED");
    }
  });
});

describe("buildProvisionPlan", () => {
  test("empty stack → 5 ensure actions (operator + 3 accounts + signing) + 2 wire steps", () => {
    const plan = buildProvisionPlan(baseInputs());
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike.map((p) => p.step)).toEqual([
      "nsc operator",
      "federation account",
      "agents account",
      "system account",
      "signing seed",
    ]);
  });

  test("fully-provisioned stack → every account/seed step is [ok]", () => {
    const plan = buildProvisionPlan(
      baseInputs({}, { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, systemAccount: SYS_PUB, signingSeedExists: true }),
    );
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike).toEqual([]);
  });

  test("partial state: operator+fed present, agents absent → only agents mints", () => {
    const plan = buildProvisionPlan(
      baseInputs({}, { federationAccount: FED_PUB, agentsAccount: undefined, systemAccount: SYS_PUB, signingSeedExists: true }),
    );
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike.map((p) => p.step)).toEqual(["agents account"]);
  });

  test("--force re-mints everything even when present", () => {
    const plan = buildProvisionPlan(
      baseInputs({ force: true }, { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, signingSeedExists: true }),
    );
    const mintLike = plan.filter((p) => p.status === "mint" || p.status === "generate");
    expect(mintLike.length).toBe(5);
  });
});

describe("provisionStack — dry-run (default)", () => {
  test("records ZERO effectful port calls and does not write config", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(baseInputs({ apply: false }), ports);
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(calls).toEqual([]);
    expect(res.steps.some((s) => s.includes("--apply"))).toBe(true);
  });
});

describe("provisionStack — apply on an empty stack", () => {
  test("records the mint/wire/write calls in order", async () => {
    const { ports, calls, written } = makePorts();
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(calls).toEqual([
      "init-operator:OP_ANDREAS",
      "add-account:ANDREAS_RESEARCH_FED",
      "add-account:ANDREAS_RESEARCH_AGENTS",
      // cortex#2534 — a fresh agents account gets JetStream, verified by read-back.
      "enable-jetstream:ANDREAS_RESEARCH_AGENTS",
      "export-account:ANDREAS_RESEARCH_AGENTS",
      "add-account:SYS",
      "signing-generate:~/.config/nats/andreas-research.seed",
      `wire:${FED_PUB}->${AGENTS_PUB}:apply`,
      // cortex#1265 — the JWT export bridges wiring → config write-back.
      "export-operator:OP_ANDREAS",
      "export-account:ANDREAS_RESEARCH_FED",
      "export-system:SYS",
      "config-write",
    ]);
    // Config write-back carries the minted (distinct) account pubkeys + the
    // operator-mode JWTs the O-3 join renderer reads (cortex#1265).
    expect(written[0]).toMatchObject({
      account: FED_PUB,
      agentsAccount: AGENTS_PUB,
      operatorJwt: OP_JWT,
      accountJwt: FED_JWT,
      systemAccount: SYS_PUB,
      systemAccountJwt: SYS_JWT,
    });
    // cortex#1265 (PR8) — the per-stack nats-server config path make-live reads.
    // Closes the provision→make-live loop (no manual `nsc generate config`).
    expect(written[0]?.configPath).toBe("~/.config/nats/research.conf");
    expect(res.resolved?.account).toBe(FED_PUB);
    expect(res.resolved?.agentsAccount).toBe(AGENTS_PUB);
    expect(res.resolved?.configPath).toBe("~/.config/nats/research.conf");
  });

  test("the federated.> wire is CROSS-account (distinct from/to)", async () => {
    const { ports, calls } = makePorts();
    await provisionStack(baseInputs({ apply: true }), ports);
    const wire = calls.find((c) => c.startsWith("wire:"));
    expect(wire).toBe(`wire:${FED_PUB}->${AGENTS_PUB}:apply`);
    expect(FED_PUB).not.toBe(AGENTS_PUB);
  });
});

describe("provisionStack — idempotent apply re-run", () => {
  test("fully-provisioned stack → no operator/account/signing mint calls", async () => {
    const { ports, calls } = makePorts({ signing: { exists: () => true } });
    const res = await provisionStack(
      baseInputs(
        { apply: true },
        { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, systemAccount: SYS_PUB, signingSeedExists: true },
      ),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls).not.toContain("init-operator:OP_ANDREAS");
    expect(calls.some((c) => c.startsWith("add-account:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("signing-generate:"))).toBe(false);
    // Wiring (idempotent) + config write still run to converge.
    expect(calls).toContain(`wire:${FED_PUB}->${AGENTS_PUB}:apply`);
    expect(calls).toContain("config-write");
  });
});

describe("provisionStack — no-clobber & force", () => {
  test("existing signing seed without --force is left untouched (no-clobber)", async () => {
    const { ports, calls } = makePorts({ signing: { exists: () => true } });
    await provisionStack(
      baseInputs({ apply: true }, { federationAccount: undefined, agentsAccount: undefined, signingSeedExists: true }),
      ports,
    );
    // generate is NEVER called when the seed exists and --force is off.
    expect(calls.some((c) => c.startsWith("signing-generate:"))).toBe(false);
  });

  test("--force re-mints the signing seed (clobber) loudly", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(
      baseInputs({ apply: true, force: true }, { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, signingSeedExists: true }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls).toContain("init-operator:OP_ANDREAS:force");
    expect(calls.some((c) => c.startsWith("signing-generate:") && c.endsWith(":force"))).toBe(true);
  });
});

describe("provisionStack — cortex#1265 operator-mode JWT export", () => {
  test("exports operator + federation + system JWTs and writes them to config", async () => {
    const { ports, calls, written } = makePorts();
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(true);
    expect(calls).toContain("export-operator:OP_ANDREAS");
    expect(calls).toContain("export-account:ANDREAS_RESEARCH_FED");
    expect(calls).toContain("export-system:SYS");
    expect(written[0]).toMatchObject({
      operatorJwt: OP_JWT,
      accountJwt: FED_JWT,
      systemAccount: SYS_PUB,
      systemAccountJwt: SYS_JWT,
    });
  });

  test("SYS missing at export despite ensure → provision FAILS before the config write", async () => {
    // SYS is ensured at step 3.5 (cortex#1333), so exportSystem reporting it absent
    // is an arc store inconsistency. Returning ok while the advertised
    // system_account wiring silently did not happen would mislead the caller —
    // fail fast, BEFORE the config write (the module's arc-failure invariant).
    const { ports, calls, written } = makePorts({ systemAbsent: true });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not found at export despite the step-3.5 ensure");
    expect(calls).toContain("export-system:SYS");
    // fail-fast: NO config write happened at all.
    expect(calls).not.toContain("config-write");
    expect(written).toHaveLength(0);
  });

  test("a generic SYS export failure also FAILS provision before the config write", async () => {
    const { ports, calls, written } = makePorts({
      export: { exportSystem: async () => ({ ok: false, reason: "arc dependency unmet", notFound: false }) },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("system export failed: arc dependency unmet");
    expect(calls).not.toContain("config-write");
    expect(written).toHaveLength(0);
  });

  test("idempotent: JWTs already in config → NO export calls (ensure-shaped)", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(
      baseInputs(
        { apply: true },
        // a TRULY fully-provisioned stack — system_account present too, else SYS
        // export must still fire (see the cortex#1335 blocker test below).
        { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, systemAccount: SYS_PUB, signingSeedExists: true, operatorModeJwtsPresent: true },
      ),
      ports,
    );
    expect(res.ok).toBe(true);
    // The only export is cortex#2534's read-only agents-account JetStream probe.
    expect(calls.filter((c) => c.startsWith("export-"))).toEqual(["export-account:ANDREAS_RESEARCH_AGENTS"]);
    expect(res.steps.join("\n")).toContain("operator-mode JWTs present in config (untouched)");
  });

  test("cortex#1335 blocker: JWTs present but NO system_account → SYS still exported + written", async () => {
    // An older provisioned stack: operator/account JWTs already in config, but
    // system_account was never minted. SYS provisioning must NOT be coupled to the
    // JWT export gate — otherwise apply finishes without writing system_account and
    // the JetStream boot-fatal survives the "fix".
    const { ports, calls, written } = makePorts();
    const res = await provisionStack(
      baseInputs(
        { apply: true },
        { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, systemAccount: undefined, signingSeedExists: true, operatorModeJwtsPresent: true },
      ),
      ports,
    );
    expect(res.ok).toBe(true);
    // operator/account JWT export stays skipped (present, untouched)...
    expect(calls).not.toContain("export-operator:OP_ANDREAS");
    expect(res.steps.join("\n")).toContain("operator-mode JWTs present in config (untouched)");
    // ...but SYS is minted AND exported AND written — the decoupled gate.
    expect(calls).toContain("add-account:SYS");
    expect(calls).toContain("export-system:SYS");
    expect(written[0]?.systemAccount).toBe(SYS_PUB);
    expect(written[0]?.systemAccountJwt).toBe(SYS_JWT);
  });

  test("--force re-exports the JWTs even when already present", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(
      baseInputs(
        { apply: true, force: true },
        { federationAccount: FED_PUB, agentsAccount: AGENTS_PUB, signingSeedExists: true, operatorModeJwtsPresent: true },
      ),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls).toContain("export-operator:OP_ANDREAS");
  });

  test("an export-operator failure aborts BEFORE the config write", async () => {
    const { ports, calls } = makePorts({
      export: {
        exportOperator: async () => ({ ok: false, reason: "arc dependency unmet" }),
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("export-operator");
    expect(calls).not.toContain("config-write");
  });

  test("account pubkey drift (export ≠ minted) aborts before config write", async () => {
    const driftPub = "A" + "Q".repeat(55);
    const { ports, calls } = makePorts({
      export: {
        exportAccount: async (name) =>
          name.endsWith("_AGENTS")
            ? { ok: true, pubKey: AGENTS_PUB, jwt: AGENTS_JWT_JS }
            : { ok: true, pubKey: driftPub, jwt: FED_JWT },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("pubkey drift");
    expect(calls).not.toContain("config-write");
  });

  test("dry-run shows the operator-mode JWT export step in the plan", async () => {
    const { ports } = makePorts();
    const res = await provisionStack(baseInputs({ apply: false }), ports);
    expect(res.ok).toBe(true);
    expect(res.steps.join("\n")).toContain("operator-mode JWTs export");
  });
});

describe("provisionStack — fail-fast", () => {
  test("an arc add-account failure aborts BEFORE the config write", async () => {
    const { ports, calls } = makePorts({
      operator: {
        initOperator: async ({ name }) => {
          calls.push(`init-operator:${name}`);
          return { ok: true, operator: name, pubKey: "OD4D", created: true, alreadyExisted: false, seedPath: null };
        },
        addAccount: async ({ name }) => {
          calls.push(`add-account:${name}`);
          return { ok: false, reason: "NSC_COMMAND_FAILED: boom" };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("add-account");
    // No config write-back on a mid-pipeline failure.
    expect(calls).not.toContain("config-write");
  });

  test("a federation-wiring failure aborts before config write", async () => {
    const { ports, calls } = makePorts({
      federationWiring: {
        wireLocalFederation: async () => ({ ok: false, reason: "arc add-federation-export failed" }),
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("wiring");
    expect(calls).not.toContain("config-write");
  });
});

describe("provisionStack — cortex#2534 agents account JetStream", () => {
  const PROVISIONED = {
    federationAccount: FED_PUB,
    agentsAccount: AGENTS_PUB,
    systemAccount: SYS_PUB,
    signingSeedExists: true,
    operatorModeJwtsPresent: true,
  };
  const jsRow = (plan: { step: string; status: string; detail: string }[]) =>
    plan.find((p) => p.step === "agents account JetStream");

  test("fresh stack: plan shows the JetStream grant as [wire]; apply enables it and verifies by read-back", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(true);
    expect(jsRow(res.plan)?.status).toBe("wire");
    const enable = calls.indexOf("enable-jetstream:ANDREAS_RESEARCH_AGENTS");
    expect(enable).toBeGreaterThan(calls.indexOf("add-account:ANDREAS_RESEARCH_AGENTS"));
    expect(calls[enable + 1]).toBe("export-account:ANDREAS_RESEARCH_AGENTS");
    expect(res.steps.join("\n")).toContain("agents account JetStream enabled");
  });

  test("existing agents account WITHOUT JetStream: dry-run reports [wire] via one read-only probe", async () => {
    const { ports, calls, written } = makePorts({ agentsJetStream: "disabled" });
    const res = await provisionStack(baseInputs({ apply: false }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(jsRow(res.plan)?.status).toBe("wire");
    expect(jsRow(res.plan)?.detail).toContain("JetStream disabled");
    expect(calls).toEqual(["export-account:ANDREAS_RESEARCH_AGENTS"]);
    expect(written).toHaveLength(0);
  });

  test("existing agents account WITHOUT JetStream: apply repairs it (enable + verify), no re-mint", async () => {
    const { ports, calls } = makePorts({ agentsJetStream: "disabled" });
    const res = await provisionStack(baseInputs({ apply: true }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("add-account:"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("enable-jetstream:"))).toEqual(["enable-jetstream:ANDREAS_RESEARCH_AGENTS"]);
    // probe, enable, verify
    expect(calls.slice(0, 3)).toEqual([
      "export-account:ANDREAS_RESEARCH_AGENTS",
      "enable-jetstream:ANDREAS_RESEARCH_AGENTS",
      "export-account:ANDREAS_RESEARCH_AGENTS",
    ]);
    // A repair of an existing account names the resolver_preload caveat for a live bus.
    expect(res.steps.join("\n")).toContain("resolver_preload");
  });

  test("existing agents account WITH JetStream: [ok] and no enable call", async () => {
    const { ports, calls } = makePorts({ agentsJetStream: "enabled" });
    const res = await provisionStack(baseInputs({ apply: true }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(jsRow(res.plan)?.status).toBe("ok");
    expect(calls.some((c) => c.startsWith("enable-jetstream:"))).toBe(false);
  });

  test("hand-tuned positive limits count as enabled (never overwritten)", async () => {
    const { ports, calls } = makePorts({
      export: {
        exportAccount: async (name) => {
          calls.push(`export-account:${name}`);
          return { ok: true, pubKey: AGENTS_PUB, jwt: accountJwt({ mem_storage: 0, disk_storage: 1073741824 }) };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(jsRow(res.plan)?.status).toBe("ok");
    expect(calls.some((c) => c.startsWith("enable-jetstream:"))).toBe(false);
  });

  test("tiered limits count as enabled", async () => {
    const { ports, calls } = makePorts({
      export: {
        exportAccount: async () => ({
          ok: true,
          pubKey: AGENTS_PUB,
          jwt: accountJwt({ tiered_limits: { R1: { mem_storage: -1, disk_storage: -1 } } }),
        }),
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("enable-jetstream:"))).toBe(false);
  });

  test("the FED and SYS accounts are never given JetStream", async () => {
    const { ports, calls } = makePorts();
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(true);
    const enabled = calls.filter((c) => c.startsWith("enable-jetstream:"));
    expect(enabled).toEqual(["enable-jetstream:ANDREAS_RESEARCH_AGENTS"]);
    // No probe of the FED account for JetStream either — its only export is the
    // cortex#1265 operator-mode JWT export.
    expect(calls.filter((c) => c === "export-account:ANDREAS_RESEARCH_FED")).toHaveLength(1);
  });

  test("verification fails after the edit → provision FAILS before the config write", async () => {
    const { ports, calls, written } = makePorts({
      jetstream: {
        enable: async ({ name }) => {
          calls.push(`enable-jetstream:${name}`);
          return { ok: true }; // reports success but the JWT never changes
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("still has JetStream disabled");
    expect(calls).not.toContain("config-write");
    expect(written).toHaveLength(0);
  });

  test("an enable failure aborts before the config write", async () => {
    const { ports, calls } = makePorts({
      jetstream: { enable: async () => ({ ok: false, reason: "nsc: boom" }) },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("nsc: boom");
    expect(calls).not.toContain("config-write");
  });

  test("probe pubkey drift (wrong nsc operator context) refuses apply before ANY mutation", async () => {
    const driftPub = "A" + "Q".repeat(55);
    const { ports, calls } = makePorts({
      export: {
        exportAccount: async (name) => {
          calls.push(`export-account:${name}`);
          return { ok: true, pubKey: driftPub, jwt: AGENTS_JWT_NO_JS };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }, PROVISIONED), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("pubkey drift");
    expect(calls).toEqual(["export-account:ANDREAS_RESEARCH_AGENTS"]);
  });

  test("probe pubkey drift in dry-run → [wire] naming the drift, still no mutation", async () => {
    const driftPub = "A" + "Q".repeat(55);
    const { ports, written } = makePorts({
      export: { exportAccount: async () => ({ ok: true, pubKey: driftPub, jwt: AGENTS_JWT_JS }) },
    });
    const res = await provisionStack(baseInputs({ apply: false }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(jsRow(res.plan)?.status).toBe("wire");
    expect(jsRow(res.plan)?.detail).toContain("pubkey drift");
    expect(written).toHaveLength(0);
  });

  test("probe failure: dry-run reports [wire] (unknown), never [ok]", async () => {
    const { ports } = makePorts({
      export: { exportAccount: async () => ({ ok: false, reason: "arc not on PATH" }) },
    });
    const res = await provisionStack(baseInputs({ apply: false }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(jsRow(res.plan)?.status).toBe("wire");
    expect(jsRow(res.plan)?.detail).toContain("unknown");
  });

  test("probe failure: apply refuses before ANY mutation (cannot verify)", async () => {
    const { ports, calls } = makePorts({
      export: {
        exportAccount: async (name) => {
          calls.push(`export-account:${name}`);
          return { ok: false, reason: "arc not on PATH" };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }, PROVISIONED), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("arc not on PATH");
    expect(calls).toEqual(["export-account:ANDREAS_RESEARCH_AGENTS"]);
  });

  test("--force with a drifted pre-probe is NOT refused: add-account's pubkey is re-probed", async () => {
    // Recovery case: config records a stale pubkey; --force re-provisions and
    // adopts whatever add-account resolves, so the guard must not block it.
    const stalePub = "A" + "Q".repeat(55);
    const { ports, calls, written } = makePorts({ agentsJetStream: "disabled" });
    const res = await provisionStack(
      baseInputs({ apply: true, force: true }, { ...PROVISIONED, agentsAccount: stalePub }),
      ports,
    );
    expect(res.ok).toBe(true);
    // The fake add-account reports created:true, so the grant follows directly.
    expect(calls).toContain("enable-jetstream:ANDREAS_RESEARCH_AGENTS");
    expect(written[0]?.agentsAccount).toBe(AGENTS_PUB);
  });

  test("--force with an unreadable pre-probe re-probes the existing account after add-account", async () => {
    let probes = 0;
    const { ports, calls } = makePorts({
      operator: {
        addAccount: async ({ name }) => {
          calls.push(`add-account:${name}`);
          const pubKey = name.endsWith("_AGENTS") ? AGENTS_PUB : name === "SYS" ? SYS_PUB : FED_PUB;
          return { ok: true, account: name, pubKey, created: false, alreadyExisted: true };
        },
      },
      export: {
        exportAccount: async (name) => {
          calls.push(`export-account:${name}`);
          if (!name.endsWith("_AGENTS")) return { ok: true, pubKey: FED_PUB, jwt: FED_JWT };
          probes += 1;
          // The first (pre-mutation) probe fails; the re-probe reads the account.
          return probes === 1
            ? { ok: false, reason: "transient" }
            : { ok: true, pubKey: AGENTS_PUB, jwt: AGENTS_JWT_JS };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true, force: true }, PROVISIONED), ports);
    expect(res.ok).toBe(true);
    expect(probes).toBe(2);
    expect(calls.some((c) => c.startsWith("enable-jetstream:"))).toBe(false);
  });

  test("post-grant read-back drift is reported as drift, not as a failed grant", async () => {
    const driftPub = "A" + "Q".repeat(55);
    let granted = false;
    const { ports, calls } = makePorts({
      jetstream: {
        enable: async () => {
          granted = true;
          return { ok: true };
        },
      },
      export: {
        exportAccount: async (name) => {
          calls.push(`export-account:${name}`);
          if (!name.endsWith("_AGENTS")) return { ok: true, pubKey: FED_PUB, jwt: FED_JWT };
          return granted
            ? { ok: true, pubKey: driftPub, jwt: AGENTS_JWT_JS }
            : { ok: true, pubKey: AGENTS_PUB, jwt: AGENTS_JWT_NO_JS };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }, PROVISIONED), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("pubkey drift");
    expect(res.reason).not.toContain("still has JetStream disabled");
    expect(calls).not.toContain("config-write");
  });

  test("an agents account already in nsc but not in config is probed after add-account (no blind edit)", async () => {
    // add-account is idempotent: an account present in the nsc store but missing
    // from config comes back created:false. Its JetStream state is read, not assumed.
    const { ports, calls } = makePorts({
      agentsJetStream: "enabled",
      operator: {
        addAccount: async ({ name }) => {
          calls.push(`add-account:${name}`);
          const pubKey = name.endsWith("_AGENTS") ? AGENTS_PUB : name === "SYS" ? SYS_PUB : FED_PUB;
          return { ok: true, account: name, pubKey, created: false, alreadyExisted: true };
        },
      },
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(true);
    expect(calls).toContain("export-account:ANDREAS_RESEARCH_AGENTS");
    expect(calls.some((c) => c.startsWith("enable-jetstream:"))).toBe(false);
  });
});
