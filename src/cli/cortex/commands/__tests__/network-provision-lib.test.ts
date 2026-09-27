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
  type NatsConfigLocatorPort,
  type SiblingStackRead,
  accountJwtHasJetStream,
  busEndpoint,
  resolveNatsConfigPath,
} from "../network-provision-lib";
import { accountJwt, ACCOUNT_JWT_WITH_JETSTREAM, ACCOUNT_JWT_WITHOUT_JETSTREAM } from "./account-jwt-test-helpers";

const FED_PUB = "A" + "B".repeat(55);
const AGENTS_PUB = "A" + "C".repeat(55);
const SYS_PUB = "A" + "S".repeat(55);
const OP_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJPUCJ9.sig";
const FED_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBRkVEIn0.sig";
const SYS_JWT = "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBU1lTIn0.sig";

/** Spy ports recording every effectful call in order. */
function makePorts(overrides?: {
  operator?: Partial<OperatorProvisioningPort>;
  signing?: Partial<SigningIdentityPort>;
  federationWiring?: Partial<FederationWiringPort>;
  configWrite?: Partial<ProvisionConfigWritePort>;
  export?: Partial<OperatorModeExportPort>;
  jetstream?: Partial<AgentsJetStreamPort>;
  natsConfig?: Partial<NatsConfigLocatorPort>;
  /** cortex#1265 — make exportSystem report the SYS account absent (a clean skip). */
  systemAbsent?: boolean;
  /**
   * cortex#2534 — the JetStream state of an agents account that ALREADY exists
   * in the nsc store. A freshly minted one always starts disabled (arc's plain
   * `nsc add account`). Default: enabled (a converged stack).
   */
  agentsJetStream?: "enabled" | "disabled";
  /** add-account finds every account already in the nsc store (created:false). */
  accountsAlreadyExist?: boolean;
}): { ports: ProvisionPorts; calls: string[]; written: Record<string, unknown>[] } {
  const calls: string[] = [];
  const written: Record<string, unknown>[] = [];
  // The fake nsc store's view of the agents account's JWT.
  let agentsJwt = (overrides?.agentsJetStream ?? "enabled") === "enabled" ? ACCOUNT_JWT_WITH_JETSTREAM : ACCOUNT_JWT_WITHOUT_JETSTREAM;

  const operator: OperatorProvisioningPort = {
    initOperator: async ({ name, force }) => {
      calls.push(`init-operator:${name}${force ? ":force" : ""}`);
      return { ok: true, operator: name, pubKey: "OD4D", created: true, alreadyExisted: false, seedPath: null };
    },
    addAccount: async ({ name }) => {
      calls.push(`add-account:${name}`);
      let pubKey: string;
      if (name.endsWith("_AGENTS")) pubKey = AGENTS_PUB;
      else if (name === "SYS") pubKey = SYS_PUB;
      else pubKey = FED_PUB;
      if (overrides?.accountsAlreadyExist) return { ok: true, account: name, pubKey, created: false, alreadyExisted: true };
      if (name.endsWith("_AGENTS")) agentsJwt = ACCOUNT_JWT_WITHOUT_JETSTREAM;
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
      agentsJwt = ACCOUNT_JWT_WITH_JETSTREAM;
      return { ok: true };
    },
    ...overrides?.jetstream,
  };

  // cortex#2535 — no files on disk and no sibling stacks unless a test says so.
  const natsConfig: NatsConfigLocatorPort = {
    exists: () => false,
    resolvePath: (path) => path,
    siblingStacks: () => [],
    ...overrides?.natsConfig,
  };

  return { ports: { operator, signing, federationWiring, configWrite, export: exportPort, jetstream, natsConfig }, calls, written };
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
            ? { ok: true, pubKey: AGENTS_PUB, jwt: ACCOUNT_JWT_WITH_JETSTREAM }
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
          return { ok: true, pubKey: driftPub, jwt: ACCOUNT_JWT_WITHOUT_JETSTREAM };
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
      export: { exportAccount: async () => ({ ok: true, pubKey: driftPub, jwt: ACCOUNT_JWT_WITH_JETSTREAM }) },
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
      accountsAlreadyExist: true,
      export: {
        exportAccount: async (name) => {
          calls.push(`export-account:${name}`);
          if (!name.endsWith("_AGENTS")) return { ok: true, pubKey: FED_PUB, jwt: FED_JWT };
          probes += 1;
          // The first (pre-mutation) probe fails; the re-probe reads the account.
          return probes === 1
            ? { ok: false, reason: "transient" }
            : { ok: true, pubKey: AGENTS_PUB, jwt: ACCOUNT_JWT_WITH_JETSTREAM };
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
            ? { ok: true, pubKey: driftPub, jwt: ACCOUNT_JWT_WITH_JETSTREAM }
            : { ok: true, pubKey: AGENTS_PUB, jwt: ACCOUNT_JWT_WITHOUT_JETSTREAM };
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
      accountsAlreadyExist: true,
    });
    const res = await provisionStack(baseInputs({ apply: true }), ports);
    expect(res.ok).toBe(true);
    expect(calls).toContain("export-account:ANDREAS_RESEARCH_AGENTS");
    expect(calls.some((c) => c.startsWith("enable-jetstream:"))).toBe(false);
  });
});

describe("accountJwtHasJetStream (cortex#2534)", () => {
  test("no limits object, or limits without storage → disabled", () => {
    expect(accountJwtHasJetStream(accountJwt(undefined))).toBe(false);
    expect(accountJwtHasJetStream(ACCOUNT_JWT_WITHOUT_JETSTREAM)).toBe(false);
  });

  test("unlimited or capped storage → enabled", () => {
    expect(accountJwtHasJetStream(ACCOUNT_JWT_WITH_JETSTREAM)).toBe(true);
    expect(accountJwtHasJetStream(accountJwt({ mem_storage: 0, disk_storage: 1073741824 }))).toBe(true);
  });

  test("a tier counts only with non-zero storage", () => {
    expect(accountJwtHasJetStream(accountJwt({ tiered_limits: { R1: { disk_storage: -1 } } }))).toBe(true);
    expect(accountJwtHasJetStream(accountJwt({ tiered_limits: { R1: { mem_storage: 0, disk_storage: 0 } } }))).toBe(false);
  });

  test("not a JWT → undefined (cannot tell)", () => {
    expect(accountJwtHasJetStream("not-a-jwt")).toBeUndefined();
  });
});

// =============================================================================
// cortex#2535 — how provision picks stack.nats_infra.config_path when the
// stack config has none. Pure over a fake NatsConfigLocatorPort.
// =============================================================================

const SHARED_CONF = "~/.config/nats/local.conf";
const SHARED_PLIST = "~/Library/LaunchAgents/nats.plist";
const OWN_CONF = "~/.config/nats/lab.conf";

function locator(opts: { files?: string[]; siblings?: SiblingStackRead[]; home?: string } = {}): NatsConfigLocatorPort {
  const home = opts.home ?? "/home/alice";
  const resolvePath = (p: string): string => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);
  const files = new Set((opts.files ?? []).map(resolvePath));
  return {
    exists: (p) => files.has(resolvePath(p)),
    resolvePath,
    siblingStacks: () => opts.siblings ?? [],
  };
}

/** A locator that fails the test if it is consulted at all. */
const UNTOUCHED: NatsConfigLocatorPort = {
  exists: () => {
    throw new Error("locator consulted");
  },
  resolvePath: () => {
    throw new Error("locator consulted");
  },
  siblingStacks: () => {
    throw new Error("locator consulted");
  },
};

function sibling(stackId: string, natsUrl: string | undefined, configPath?: string, plistPath?: string): SiblingStackRead {
  return {
    ok: true,
    stack: {
      stackId,
      ...(natsUrl !== undefined && { natsUrl }),
      ...(configPath !== undefined && { configPath }),
      ...(plistPath !== undefined && { plistPath }),
    },
  };
}

function labInputs(over: Partial<ProvisionInputs> = {}): ProvisionInputs {
  return {
    principal: "alice",
    stackSlug: "lab",
    stackId: "alice/lab",
    operatorName: "OP_ALICE",
    federationAccountName: "ALICE_LAB_FED",
    agentsAccountName: "ALICE_LAB_AGENTS",
    systemAccountName: "SYS",
    seedPath: "~/.config/nats/alice-lab.seed",
    credsPath: "~/.config/nats/lab.creds",
    natsUrl: "nats://localhost:4222",
    plistPathSet: false,
    force: false,
    apply: false,
    state: {
      federationAccount: undefined,
      agentsAccount: undefined,
      systemAccount: undefined,
      signingSeedExists: false,
      operatorModeJwtsPresent: false,
    },
    ...over,
  };
}

describe("busEndpoint", () => {
  test("folds loopback aliases, defaults the port, ignores the scheme", () => {
    expect(busEndpoint("nats://localhost:4222")).toBe("loopback:4222");
    expect(busEndpoint("nats://127.0.0.1")).toBe("loopback:4222");
    expect(busEndpoint("tls://[::1]:4222")).toBe("loopback:4222");
    expect(busEndpoint("nats://user:pw@Bus.Example:4300")).toBe("bus.example:4300");
  });

  test("a scheme-less url is read as nats://", () => {
    expect(busEndpoint("localhost:4222")).toBe("loopback:4222");
    expect(busEndpoint("127.0.0.1:4222")).toBe("loopback:4222");
  });

  test("uses the first server of a comma list; unusable input is undefined", () => {
    expect(busEndpoint("nats://localhost:4223, nats://localhost:4224")).toBe("loopback:4223");
    expect(busEndpoint(undefined)).toBeUndefined();
    expect(busEndpoint("")).toBeUndefined();
    expect(busEndpoint("not a url")).toBeUndefined();
  });

  test("different ports are different buses", () => {
    expect(busEndpoint("nats://localhost:4222")).not.toBe(busEndpoint("nats://localhost:4223"));
  });
});

describe("resolveNatsConfigPath (cortex#2535)", () => {
  test("an already-set config_path is kept and nothing on disk is consulted", () => {
    const res = resolveNatsConfigPath(labInputs({ configPath: "~/.config/nats/hand-set.conf" }), UNTOUCHED);
    expect(res).toEqual({ source: "explicit", configPath: "~/.config/nats/hand-set.conf" });
  });

  test("<slug>.conf exists → the convention path", () => {
    const res = resolveNatsConfigPath(
      labInputs(),
      locator({ files: [OWN_CONF, SHARED_CONF], siblings: [sibling("alice/work", "nats://localhost:4222", SHARED_CONF)] }),
    );
    expect(res).toEqual({ source: "convention", configPath: OWN_CONF, exists: true, why: "exists on disk" });
  });

  test("<slug>.conf missing + one sibling on the same bus → the sibling's config_path + plist_path", () => {
    const res = resolveNatsConfigPath(
      labInputs(),
      locator({
        files: [SHARED_CONF],
        siblings: [sibling("alice/work", "nats://127.0.0.1:4222", SHARED_CONF, SHARED_PLIST)],
      }),
    );
    expect(res).toEqual({
      source: "sibling",
      configPath: SHARED_CONF,
      plistPath: SHARED_PLIST,
      siblingStackId: "alice/work",
      endpoint: "loopback:4222",
    });
  });

  test("a sibling's plist_path is not adopted when the stack already sets one", () => {
    const res = resolveNatsConfigPath(
      labInputs({ plistPathSet: true }),
      locator({ files: [SHARED_CONF], siblings: [sibling("alice/work", "nats://localhost:4222", SHARED_CONF, SHARED_PLIST)] }),
    );
    expect(res.source).toBe("sibling");
    if (res.source === "sibling") expect(res.plistPath).toBeUndefined();
  });

  test("siblings naming the same file (tilde vs absolute) agree", () => {
    const res = resolveNatsConfigPath(
      labInputs(),
      locator({
        files: [SHARED_CONF],
        siblings: [
          sibling("alice/work", "nats://localhost:4222", SHARED_CONF),
          sibling("alice/ops", "nats://localhost:4222", "/home/alice/.config/nats/local.conf"),
        ],
      }),
    );
    expect(res.source).toBe("sibling");
  });

  test("<slug>.conf missing + conflicting siblings → unset, naming both", () => {
    const res = resolveNatsConfigPath(
      labInputs(),
      locator({
        files: [SHARED_CONF, "~/.config/nats/other.conf"],
        siblings: [
          sibling("alice/work", "nats://localhost:4222", SHARED_CONF),
          sibling("alice/ops", "nats://localhost:4222", "~/.config/nats/other.conf"),
        ],
      }),
    );
    expect(res.source).toBe("unset");
    if (res.source === "unset") {
      expect(res.why).toContain("disagree");
      expect(res.why).toContain("alice/work");
      expect(res.why).toContain("alice/ops");
    }
  });

  test("<slug>.conf missing + no sibling → the convention path (the stack's own bus, cortex#1265 PR8)", () => {
    const res = resolveNatsConfigPath(labInputs(), locator());
    expect(res.source).toBe("convention");
    if (res.source === "convention") {
      expect(res.configPath).toBe(OWN_CONF);
      expect(res.exists).toBe(false);
      expect(res.why).toContain("no other stack of alice is on loopback:4222");
    }
  });

  test("siblings on another port do not count as sharing the bus → the convention path", () => {
    const res = resolveNatsConfigPath(
      labInputs(),
      locator({
        files: ["~/.config/nats/elsewhere.conf"],
        siblings: [sibling("alice/far", "nats://localhost:4300", "~/.config/nats/elsewhere.conf")],
      }),
    );
    expect(res).toMatchObject({ source: "convention", configPath: OWN_CONF, exists: false });
  });

  test("siblings on the same bus without an existing config_path → unset", () => {
    const res = resolveNatsConfigPath(
      labInputs(),
      locator({
        siblings: [
          sibling("alice/bare", "nats://localhost:4222"),
          sibling("alice/stale", "nats://localhost:4222", "~/.config/nats/gone.conf"),
        ],
      }),
    );
    expect(res.source).toBe("unset");
    if (res.source === "unset") expect(res.why).toContain("the stacks sharing loopback:4222 (alice/bare, alice/stale)");
  });

  test("an unreadable sibling config → unset (it could be the conflicting one)", () => {
    const res = resolveNatsConfigPath(
      labInputs(),
      locator({
        files: [SHARED_CONF],
        siblings: [
          sibling("alice/work", "nats://localhost:4222", SHARED_CONF),
          { ok: false, stackId: "alice/broken", reason: "parse error" },
        ],
      }),
    );
    expect(res.source).toBe("unset");
    if (res.source === "unset") expect(res.why).toContain("alice/broken (parse error)");
  });

  test("a stack with no nats.url cannot be matched to a sibling → the convention path", () => {
    const res = resolveNatsConfigPath(
      labInputs({ natsUrl: undefined }),
      locator({ files: [SHARED_CONF], siblings: [sibling("alice/work", "nats://localhost:4222", SHARED_CONF)] }),
    );
    expect(res.source).toBe("convention");
    if (res.source === "convention") expect(res.why).toContain("no usable nats.url");
  });
});

// -----------------------------------------------------------------------------
// Through provisionStack: the plan row, the note, and the write-back.
// -----------------------------------------------------------------------------

function labPorts(natsConfig: NatsConfigLocatorPort): { ports: ProvisionPorts; written: Record<string, unknown>[] } {
  const { ports, written } = makePorts({ natsConfig });
  return { ports, written };
}

const natsRow = (plan: { step: string; status: string; detail: string }[]) =>
  plan.find((p) => p.step === "nats-server config path");

describe("provisionStack — nats-server config path (cortex#2535)", () => {
  test("dry-run shows the sibling branch in the plan", async () => {
    const { ports: p } = labPorts(
      locator({ files: [SHARED_CONF], siblings: [sibling("alice/work", "nats://localhost:4222", SHARED_CONF, SHARED_PLIST)] }),
    );
    const res = await provisionStack(labInputs(), p);
    expect(res.ok).toBe(true);
    expect(res.natsConfig?.source).toBe("sibling");
    expect(natsRow(res.plan)?.status).toBe("wire");
    expect(natsRow(res.plan)?.detail).toContain("from sibling stack alice/work on loopback:4222");
    expect(res.steps.join("\n")).toContain(`plist_path ${SHARED_PLIST}`);
  });

  test("dry-run with a same-bus sibling that has no config_path shows [skip] and the --nats-config note", async () => {
    const { ports: p } = labPorts(locator({ siblings: [sibling("alice/work", "nats://localhost:4222")] }));
    const res = await provisionStack(labInputs(), p);
    expect(res.ok).toBe(true);
    expect(natsRow(res.plan)?.status).toBe("skip");
    const out = res.steps.join("\n");
    expect(out).toContain("left unset");
    expect(out).toContain("will need --nats-config");
  });

  test("dry-run with conflicting siblings shows [skip], names both, and prints the note", async () => {
    const { ports: p } = labPorts(
      locator({
        files: [SHARED_CONF, "~/.config/nats/other.conf"],
        siblings: [
          sibling("alice/work", "nats://localhost:4222", SHARED_CONF),
          sibling("alice/ops", "nats://localhost:4222", "~/.config/nats/other.conf"),
        ],
      }),
    );
    const res = await provisionStack(labInputs(), p);
    expect(res.ok).toBe(true);
    expect(natsRow(res.plan)?.status).toBe("skip");
    const out = res.steps.join("\n");
    expect(out).toContain("left unset");
    expect(out).toContain("disagree (alice/work");
    expect(out).toContain("will need --nats-config");
  });

  test("dry-run with the conventional file present shows it", async () => {
    const { ports: p } = labPorts(locator({ files: [OWN_CONF] }));
    const res = await provisionStack(labInputs(), p);
    expect(natsRow(res.plan)?.detail).toBe(`${OWN_CONF} (exists on disk)`);
  });

  test("dry-run with no sibling on the bus keeps the convention and says make-live creates it", async () => {
    const { ports: p } = labPorts(locator());
    const res = await provisionStack(labInputs(), p);
    expect(natsRow(res.plan)?.status).toBe("wire");
    expect(natsRow(res.plan)?.detail).toContain(`${OWN_CONF} (not created yet; no other stack of alice is on loopback:4222`);
    expect(res.steps.join("\n")).not.toContain("will need --nats-config");
  });

  test("apply adopts the sibling's config_path + plist_path in the write-back", async () => {
    const { ports: p, written } = labPorts(
      locator({ files: [SHARED_CONF], siblings: [sibling("alice/work", "nats://localhost:4222", SHARED_CONF, SHARED_PLIST)] }),
    );
    const res = await provisionStack(labInputs({ apply: true }), p);
    expect(res.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]?.configPath).toBe(SHARED_CONF);
    expect(written[0]?.plistPath).toBe(SHARED_PLIST);
    expect(res.resolved?.configPath).toBe(SHARED_CONF);
    expect(res.steps.join("\n")).toContain("config_path, plist_path, nkey_seed_path");
  });

  test("apply with a same-bus sibling that has no config_path writes none and prints the note", async () => {
    const { ports: p, written } = labPorts(locator({ siblings: [sibling("alice/work", "nats://localhost:4222")] }));
    const res = await provisionStack(labInputs({ apply: true }), p);
    expect(res.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect("configPath" in (written[0] ?? {})).toBe(false);
    expect("plistPath" in (written[0] ?? {})).toBe(false);
    expect(res.resolved?.configPath).toBeUndefined();
    const out = res.steps.join("\n");
    expect(out).not.toContain("config_path, nkey_seed_path");
    expect(out).toContain("will need --nats-config");
  });

  test("apply with no sibling on the bus writes the convention path", async () => {
    const { ports: p, written } = labPorts(locator());
    const res = await provisionStack(labInputs({ apply: true }), p);
    expect(res.ok).toBe(true);
    expect(written[0]?.configPath).toBe(OWN_CONF);
    expect("plistPath" in (written[0] ?? {})).toBe(false);
  });

  test("apply with an already-set config_path writes it back unchanged and adopts no plist", async () => {
    const { ports: p, written } = labPorts(UNTOUCHED);
    const res = await provisionStack(labInputs({ apply: true, configPath: SHARED_CONF }), p);
    expect(res.ok).toBe(true);
    expect(written[0]?.configPath).toBe(SHARED_CONF);
    expect("plistPath" in (written[0] ?? {})).toBe(false);
    expect(natsRow(res.plan)?.status).toBe("ok");
  });
});
