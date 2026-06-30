/**
 * C-1225 — end-to-end integration test for the `cortex network provision` chain
 * at the cortex→arc seam.
 *
 * Where `network-provision-lib.test.ts` injects a fully-fake FederationWiringPort,
 * this test drives the orchestrator through the REAL
 * {@link buildFederationWiringAdapter} — the live adapter that builds the
 * `arc nats add-federation-export …` argv and parses arc's
 * `arc.nats.federation.v1` envelope. The only seam swapped is the arc SUBPROCESS
 * runner, replaced by a faithful harness that enforces arc's REAL CLI contract:
 * it rejects any option arc does not define (e.g. the never-shipped `--dry-run`)
 * with a non-zero exit + `unknown option`, exactly like commander.
 *
 * This is the cortex-side anti-rot guard for the provision-chain hardening: it
 * pins the argv cortex emits to arc AND the schema cortex demands back, so the
 * #1225 class of bugs (wrong schema `arc.nats.v2`; passing `--dry-run`) cannot
 * silently return. It complements the arc-side `nats-federation-integration`
 * test that pins arc→nsc.
 */
import { describe, test, expect } from "bun:test";

import { buildFederationWiringAdapter, type ArcFederationRunner } from "../network-federation-wiring";
import {
  provisionStack,
  type ProvisionInputs,
  type ProvisionPorts,
  type SigningIdentityPort,
  type ProvisionConfigWritePort,
} from "../network-provision-lib";
import type { OperatorProvisioningPort } from "../operator-provisioning";

const FED_PUB = "A" + "F".repeat(55);
const AGENTS_PUB = "A" + "G".repeat(55);

/** The options arc's `nats add-federation-export` ACTUALLY defines (src/cli.ts). */
const ARC_KNOWN_OPTS = new Set([
  "--from-account",
  "--to-account",
  "--subject",
  "--service",
  "--apply",
  "--json",
]);

/**
 * Faithful arc-CLI contract harness. Asserts the argv prefix is
 * `nats add-federation-export`, rejects any unknown option like commander
 * (exit 1 + `unknown option`), and otherwise returns the
 * `arc.nats.federation.v1` envelope. `record` captures the argv for assertions.
 */
function arcContractRunner(record: string[][]): ArcFederationRunner {
  return async (argv) => {
    record.push([...argv]);
    if (argv[0] !== "nats" || argv[1] !== "add-federation-export") {
      return { stdout: "", stderr: `unknown command: ${argv.join(" ")}`, exitCode: 1 };
    }
    for (const a of argv.slice(2)) {
      if (a.startsWith("--") && !ARC_KNOWN_OPTS.has(a)) {
        return { stdout: "", stderr: `error: unknown option '${a}'`, exitCode: 1 };
      }
    }
    const apply = argv.includes("--apply");
    const envelope = {
      schema: "arc.nats.federation.v1",
      ok: true,
      fromAccount: argv[argv.indexOf("--from-account") + 1],
      toAccount: argv[argv.indexOf("--to-account") + 1],
      subject: "federated.>",
      exportAdded: apply,
      importAdded: apply,
      exportAlreadyPresent: false,
      importAlreadyPresent: false,
      pushResult: { fromAccount: "skipped", toAccount: "skipped" },
    };
    return { stdout: JSON.stringify(envelope) + "\n", stderr: "", exitCode: 0 };
  };
}

function buildPorts(runner: ArcFederationRunner): { ports: ProvisionPorts; written: unknown[] } {
  const written: unknown[] = [];
  const operator: OperatorProvisioningPort = {
    initOperator: async ({ name }) => ({
      ok: true, operator: name, pubKey: "OD4D", created: true, alreadyExisted: false, seedPath: null,
    }),
    addAccount: async ({ name }) => ({
      ok: true, account: name, pubKey: name.endsWith("_AGENTS") ? AGENTS_PUB : FED_PUB,
      created: true, alreadyExisted: false,
    }),
  };
  const signing: SigningIdentityPort = {
    exists: () => false,
    generate: () => ({ ok: true, nkeyPub: "U" + "Z".repeat(55), fingerprint: "fp" }),
  };
  const configWrite: ProvisionConfigWritePort = {
    write: (fields) => { written.push(fields); return { ok: true }; },
  };
  // cortex#1265 — a fake export port (the export-arc seam is unit-tested separately).
  const exportPort = {
    exportOperator: async () => ({ ok: true as const, operatorJwt: "eyJ.op.sig", pubKey: "OD4D" }),
    exportAccount: async () => ({ ok: true as const, pubKey: FED_PUB, jwt: "eyJ.fed.sig" }),
    exportSystem: async () => ({ ok: false as const, reason: "no SYS", notFound: true }),
  };
  // The REAL wiring adapter — only the arc subprocess runner is swapped.
  const federationWiring = buildFederationWiringAdapter(runner);
  return { ports: { operator, signing, federationWiring, configWrite, export: exportPort }, written };
}

function inputs(): ProvisionInputs {
  return {
    principal: "andreas",
    stackSlug: "work",
    stackId: "andreas/work",
    operatorName: "OP_ANDREAS",
    federationAccountName: "ANDREAS_WORK_FED",
    agentsAccountName: "ANDREAS_WORK_AGENTS",
    systemAccountName: "SYS",
    seedPath: "~/.config/nats/cortex-work.nk",
    credsPath: "~/.config/nats/work.creds",
    configPath: "~/.config/nats/work.conf",
    force: false,
    apply: true,
    state: { federationAccount: undefined, agentsAccount: undefined, systemAccount: undefined, signingSeedExists: false, operatorModeJwtsPresent: false },
  };
}

describe("C-1225 — provision → real arc wiring adapter (faithful arc CLI contract)", () => {
  test("full --apply chain completes and emits arc's REAL add-federation-export argv", async () => {
    const record: string[][] = [];
    const { ports, written } = buildPorts(arcContractRunner(record));

    const result = await provisionStack(inputs(), ports);

    // Every step completed — including the wiring through the real adapter.
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.resolved?.account).toBe(FED_PUB);
    expect(result.resolved?.agentsAccount).toBe(AGENTS_PUB);
    expect(written).toHaveLength(1);
    // cortex#1265 (PR8) — the write-back carries the per-stack nats-server config
    // path make-live reads (closes the provision→make-live loop).
    expect((written[0] as { configPath?: string }).configPath).toBe("~/.config/nats/work.conf");
    expect(result.resolved?.configPath).toBe("~/.config/nats/work.conf");

    // The adapter emitted arc's REAL contract: `nats add-federation-export`
    // with --from-account/--to-account/--apply/--json and NO `--dry-run`.
    const argv = record.find((a) => a[1] === "add-federation-export");
    expect(argv).toBeDefined();
    expect(argv).toContain("--from-account");
    expect(argv).toContain("--to-account");
    expect(argv).toContain("--apply");
    expect(argv).toContain("--json");
    expect(argv).not.toContain("--dry-run");
    // from-account is the minted FED pubkey; to-account the AGENTS pubkey.
    expect(argv![argv!.indexOf("--from-account") + 1]).toBe(FED_PUB);
    expect(argv![argv!.indexOf("--to-account") + 1]).toBe(AGENTS_PUB);
  });

  test("an unknown option to arc (the never-shipped --dry-run) fails the chain", async () => {
    // Direct proof the harness bites: a runner that injects --dry-run is rejected.
    const record: string[][] = [];
    const base = arcContractRunner(record);
    const injecting: ArcFederationRunner = (argv) => base([...argv, "--dry-run"]);
    const { ports } = buildPorts(injecting);

    const result = await provisionStack(inputs(), ports);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("federation wiring failed");
  });
});
