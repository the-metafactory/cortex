/**
 * G1d / T1 (cortex#1139) — the LIVE adapters for `cortex network provision`.
 *
 * These touch the real world (nsc store via arc, the signing seed on disk, the
 * stack config YAML). The orchestration is pure over the injected ports
 * (`network-provision-lib.ts`); these adapters are only constructed on a real
 * `--apply` invocation. The arc account-tree seam reuses
 * `buildOperatorProvisioningAdapter` (operator-provisioning.ts) and the existing
 * `buildFederationWiringAdapter` (network-federation-wiring.ts) — cortex runs nsc
 * through arc (ADR-0013 sovereign model). The one exception is
 * {@link buildAgentsJetStreamAdapter}, which shells `nsc edit account` until arc
 * ships a verb to grant an account JetStream (arc#384).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";

import { parseDocument } from "yaml";

import { composeRawConfig, expandTilde } from "../../../common/config/loader";
import { discoverStacks, type DiscoveredStack } from "./stack-lib";
import { generateStackIdentity } from "../../../bus/stack-provisioning";
import { buildFederationWiringAdapter } from "./network-federation-wiring";
import { buildOperatorProvisioningAdapter } from "./operator-provisioning";
import { buildOperatorModeExportAdapter } from "./operator-mode-export";
import type {
  AgentsJetStreamPort,
  NatsConfigLocatorPort,
  ProvisionPorts,
  SiblingStackRead,
  SigningIdentityPort,
  ProvisionConfigWritePort,
} from "./network-provision-lib";

// =============================================================================
// Signing-identity adapter — composes provision-stack's generateStackIdentity
// =============================================================================

/**
 * Live {@link SigningIdentityPort}. `generate` writes the seed `chmod 600` and
 * REFUSES to clobber without `force` (the orchestrator only calls it when the
 * seed is absent OR `--force` is set, so the refusal is belt-and-braces).
 *
 * The orchestrator threads the raw (portable `~`) `stack.nkey_seed_path` through
 * the port so the config write-back persists the tilde form; the fs boundary
 * here expands it (`expandTilde`) in BOTH `exists` and `generate` so the
 * existence probe and the O_EXCL write target the same `$HOME`-rooted path
 * (a divergence here breaks no-clobber idempotency — cortex#1236).
 */
export function buildSigningIdentityAdapter(): SigningIdentityPort {
  return {
    exists: (seedPath) => existsSync(expandTilde(seedPath)),
    generate: ({ seedPath, force }) => {
      try {
        const material = generateStackIdentity({ seedPath: expandTilde(seedPath), force });
        return { ok: true, nkeyPub: material.nkeyPub, fingerprint: material.fingerprint };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// =============================================================================
// Config write-back adapter — persist stack.nats_infra + nkey_seed_path
// =============================================================================

/**
 * Live {@link ProvisionConfigWritePort}. Writes the resolved account-tree
 * fields into the stack config YAML in place, preserving comments
 * (parseDocument + setIn — same discipline as `ConfigStorePort.writeNetworks`).
 *
 * @param stackConfigPath - the already-resolved, tilde-expanded path to the
 *   stack file the daemon loads (config-split `stacks/<slug>.yaml`, or the
 *   legacy monolith). The CLI resolves this layout-aware before constructing.
 */
export function buildProvisionConfigWriteAdapter(stackConfigPath: string): ProvisionConfigWritePort {
  return {
    write: (fields) => {
      try {
        const doc = existsSync(stackConfigPath)
          ? parseDocument(readFileSync(stackConfigPath, "utf-8"))
          : parseDocument("");
        doc.setIn(["stack", "nats_infra", "account"], fields.account);
        doc.setIn(["stack", "nats_infra", "agents_account"], fields.agentsAccount);
        doc.setIn(["stack", "nats_infra", "creds_path"], fields.credsPath);
        // cortex#1265 (PR8) — the per-stack nats-server config path make-live
        // derives its `--nats-config` target from. Closes the provision→make-live
        // loop: without it make-live has no bus to bootstrap. cortex#2535 — absent
        // when provision found no existing file; then nothing is written.
        if (fields.configPath !== undefined) {
          doc.setIn(["stack", "nats_infra", "config_path"], fields.configPath);
        }
        if (fields.plistPath !== undefined) {
          doc.setIn(["stack", "nats_infra", "plist_path"], fields.plistPath);
        }
        doc.setIn(["stack", "nkey_seed_path"], fields.seedPath);
        if (fields.nkeyPub !== undefined) {
          doc.setIn(["stack", "nkey_pub"], fields.nkeyPub);
        }
        // cortex#1265 — the operator-mode JWTs the O-3 join / make-live-bootstrap
        // renderer reads (network-derive). Set only when exported this run (omitted
        // fields leave any hand-tuned value untouched — never clobbered).
        if (fields.operatorJwt !== undefined) {
          doc.setIn(["stack", "nats_infra", "operator_jwt"], fields.operatorJwt);
        }
        if (fields.accountJwt !== undefined) {
          doc.setIn(["stack", "nats_infra", "account_jwt"], fields.accountJwt);
        }
        if (fields.systemAccount !== undefined) {
          doc.setIn(["stack", "nats_infra", "system_account"], fields.systemAccount);
        }
        if (fields.systemAccountJwt !== undefined) {
          doc.setIn(["stack", "nats_infra", "system_account_jwt"], fields.systemAccountJwt);
        }
        mkdirSync(dirname(stackConfigPath), { recursive: true });
        writeFileSync(stackConfigPath, doc.toString(), "utf-8");
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// =============================================================================
// Agents-account JetStream adapter (cortex#2534) — nsc edit account
// =============================================================================

/** Result of one nsc subprocess invocation. */
export interface NscRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Pluggable nsc subprocess driver. Tests inject a fake; production uses Bun.spawn. */
export type NscRunner = (argv: readonly string[]) => Promise<NscRunResult>;

async function defaultNscRunner(argv: readonly string[]): Promise<NscRunResult> {
  const proc = Bun.spawn(["nsc", ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Same strict UPPER_SNAKE guard arc applies before any nsc call (no flag injection). */
const NSC_ACCOUNT_NAME_RE = /^[A-Z][A-Z0-9_]+$/;

/**
 * Live {@link AgentsJetStreamPort}: `nsc edit account -n <name> --js-mem-storage -1
 * --js-disk-storage -1` (unlimited). Like arc's add-account it acts on the CURRENT
 * nsc operator; the orchestrator cross-checks the account pubkey before and after.
 *
 * This is the one place cortex runs nsc directly: arc has no verb to grant an
 * account JetStream (arc#384). Replace this adapter with the arc verb once it ships.
 */
export function buildAgentsJetStreamAdapter(runner: NscRunner = defaultNscRunner): AgentsJetStreamPort {
  return {
    enable: async ({ name }) => {
      if (!NSC_ACCOUNT_NAME_RE.test(name)) {
        return { ok: false, reason: `refusing to edit account "${name}": not an UPPER_SNAKE account name` };
      }
      const argv = ["edit", "account", "-n", name, "--js-mem-storage", "-1", "--js-disk-storage", "-1"];
      let res: NscRunResult;
      try {
        res = await runner(argv);
      } catch (err) {
        return {
          ok: false,
          reason: `failed to invoke 'nsc edit account' — ${err instanceof Error ? err.message : String(err)}. Is nsc on PATH?`,
        };
      }
      if (res.exitCode !== 0) {
        return {
          ok: false,
          reason: `nsc edit account ${name} exited ${res.exitCode}: ${res.stderr.trim() || res.stdout.trim() || "(no output)"}`,
        };
      }
      return { ok: true };
    },
  };
}

// =============================================================================
// nats-server config locator (cortex#2535) — file checks + sibling stack reads
// =============================================================================

/**
 * The config dir that holds every stack, from the `--config` path: a
 * config-split pointer `<base>/<slug>/<slug>.yaml` → `<base>`; a legacy
 * monolith `<base>/cortex*.yaml` → `<base>`.
 */
function stacksBaseDir(cortexConfigPath: string): string {
  const dir = dirname(expandTilde(cortexConfigPath));
  return existsSync(join(dir, "system", "system.yaml")) ? dirname(dir) : dir;
}

/** A string at `obj[key]`, else undefined. */
function stringAt(obj: unknown, key: string): string | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Read a discovered sibling's `nats.url` + `stack.nats_infra.{config_path,
 * plist_path}` from its composed raw config. A split stack is composed from its
 * pointer path (`<base>/<slug>/<slug>.yaml`, the file need not exist) so the
 * `system/` layer that carries `nats.url` is merged in.
 */
function readSiblingStack(base: string, s: DiscoveredStack & { stackId: string }): SiblingStackRead {
  const loadPath = s.layout === "split" ? join(base, s.slugLocator, `${s.slugLocator}.yaml`) : s.configPath;
  let raw: Record<string, unknown>;
  try {
    raw = composeRawConfig(loadPath);
  } catch (err) {
    return { ok: false, stackId: s.stackId, reason: err instanceof Error ? err.message : String(err) };
  }
  const natsInfra = (raw.stack as Record<string, unknown> | undefined)?.nats_infra;
  const natsUrl = stringAt(raw.nats, "url");
  const configPath = stringAt(natsInfra, "config_path");
  const plistPath = stringAt(natsInfra, "plist_path");
  return {
    ok: true,
    stack: {
      stackId: s.stackId,
      ...(natsUrl !== undefined && { natsUrl }),
      ...(configPath !== undefined && { configPath }),
      ...(plistPath !== undefined && { plistPath }),
    },
  };
}

/**
 * Live {@link NatsConfigLocatorPort}. Siblings come from the existing stack
 * discovery (`discoverStacks`) over the config dir `cortexConfigPath` lives in,
 * filtered to the same principal. Reads files only; never touches a process.
 */
export function buildNatsConfigLocatorAdapter(cortexConfigPath: string): NatsConfigLocatorPort {
  return {
    exists: (path) => existsSync(expandTilde(path)),
    resolvePath: (path) => resolve(expandTilde(path)),
    siblingStacks: (principal, selfStackId) => {
      const base = stacksBaseDir(cortexConfigPath);
      return discoverStacks(base)
        .filter(
          (s): s is DiscoveredStack & { stackId: string } =>
            s.stackId !== undefined && s.stackId !== selfStackId && s.stackId.startsWith(`${principal}/`),
        )
        .map((s) => readSiblingStack(base, s));
    },
  };
}

// =============================================================================
// Full live port bundle
// =============================================================================

/**
 * Build the full live {@link ProvisionPorts} bundle for a real `--apply` run.
 * `cortexConfigPath` is the `--config` path; sibling stacks are discovered
 * beside it (defaults to `stackConfigPath` for a legacy monolith).
 */
export function buildLiveProvisionPorts(stackConfigPath: string, cortexConfigPath: string = stackConfigPath): ProvisionPorts {
  return {
    operator: buildOperatorProvisioningAdapter(),
    signing: buildSigningIdentityAdapter(),
    federationWiring: buildFederationWiringAdapter(),
    configWrite: buildProvisionConfigWriteAdapter(stackConfigPath),
    export: buildOperatorModeExportAdapter(),
    jetstream: buildAgentsJetStreamAdapter(),
    natsConfig: buildNatsConfigLocatorAdapter(cortexConfigPath),
  };
}
