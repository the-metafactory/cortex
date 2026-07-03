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
 * touches the STACK config / `nats_infra` (so encryption / federated config
 * survives). NOTE (v5.30.2, cortex#1265): make-live MAY now write a single
 * SYSTEM-layer key — `config.nats.credsPath` — but ONLY when it had to default it
 * (`credsPathDefaulted` + an injected `configWrite` port). These unit tests pass an
 * explicit credsPath and no `configWrite`, so that path never fires here.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import {
  makeLiveStack,
  planMakeLive,
  type MakeLiveInputs,
  type MakeLivePorts,
  type MakeLiveState,
} from "../network-make-live-lib";
import { insertIntoResolverPreload, findNatsServerDescriptor, buildResolverPreloadAdapter, buildNatsCanaryAdapter } from "../network-make-live-adapters";
import type { DaemonLocatorIO } from "../daemon-locator";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SettleWindowOptions } from "../../../../common/nats/restart-with-settle";
import { instantClock } from "./settle-test-helpers";

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
  /**
   * cortex#1480 (join-1, epic #1479) — a per-pubkey override for
   * `hasAccount`, so a test can distinguish "AGENTS already preloaded" from
   * "FED already preloaded" (the fake otherwise answers the SAME `resolverHas`
   * boolean regardless of which pubkey was queried). Undefined ⇒ falls back
   * to the legacy `resolverHas`-for-everything behaviour every existing test
   * above depends on.
   */
  hasAccountFor?: (accountPubkey: string) => boolean;
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
  /**
   * cortex#1483 (join-4) — wire a fake `natsCanary` port. Absent (default) ⇒
   * `ports.natsCanary` stays `undefined` (the pre-#1483 behaviour every
   * existing test above depends on).
   */
  withNatsCanary?: boolean;
  /** cortex#1483 — make the canary's `nats-server -t` gate report INVALID. */
  canaryValidateFails?: boolean;
  /**
   * cortex#1495 BLOCKER — make the canary's `-t` gate report SKIPPED (binary
   * missing): make-live must WARN loudly + PROCEED (not refuse, not silent pass).
   */
  canaryValidateSkips?: boolean;
  /** cortex#1483 — model the INITIAL restart's post-restart health. Default: healthy. */
  canaryNatsHealthy?: boolean;
  /** cortex#1483 — model the RECOVERY restart's post-restart health. Default: healthy. */
  canaryRecoveryHealthy?: boolean;
  /** cortex#1483 — healthy starting from the Nth poll WITHIN the initial phase. */
  canaryNatsHealthyAfterAttempt?: number;
  /** cortex#1483 — settle-window tuning threaded onto `ports.settle`. */
  settle?: SettleWindowOptions;
}): { ports: MakeLivePorts; calls: string[] } {
  const calls: string[] = [];
  // cortex#1483 — the canary's snapshot is whatever `snapshot()` was called
  // with; `restore()` records the restore + lets tests assert it ran.
  let canaryConfigContents = "ORIGINAL-CONFIG-BYTES";
  let canaryRestartCount = 0;
  const canaryPhaseAttempts: Record<number, number> = {};
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
      hasAccount: (_natsConfigPath, accountPubkey) =>
        over?.hasAccountFor !== undefined
          ? over.hasAccountFor(accountPubkey)
          : (over?.resolverHas ?? false),
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
        canaryRestartCount++; // cortex#1483 — phase counter for the canary's isHealthy fake
        return { ok: true };
      },
      restartDaemon: async () => {
        calls.push("restart-daemon");
        return { ok: true };
      },
    },
    ...(over?.withNatsCanary === true
      ? {
          natsCanary: {
            async validateConfig() {
              calls.push("canary-validate");
              if (over.canaryValidateFails === true) {
                return { status: "invalid", reason: "nats-server -t: parse error" };
              }
              if (over.canaryValidateSkips === true) {
                return { status: "skipped", reason: "could not run nats-server -t: spawn nats-server ENOENT" };
              }
              return { status: "valid" };
            },
            snapshot(natsConfigPath) {
              calls.push("canary-snapshot");
              return { natsConfigPath, contents: canaryConfigContents };
            },
            restore(snapshot) {
              calls.push("canary-restore");
              canaryConfigContents = snapshot.contents ?? "";
            },
            async isHealthy() {
              calls.push("canary-isHealthy");
              // cortex#1483 — phase (initial vs recovery) keyed off how many
              // restartNats() calls have happened so far, mirroring network-lib
              // test's `rec.natsRestarts` phase discriminator.
              const phase = canaryRestartCount;
              const isRecoveryProbe = phase > 1;
              canaryPhaseAttempts[phase] = (canaryPhaseAttempts[phase] ?? 0) + 1;
              const attemptInPhase = canaryPhaseAttempts[phase];
              const healthy =
                !isRecoveryProbe && over.canaryNatsHealthyAfterAttempt !== undefined
                  ? attemptInPhase >= over.canaryNatsHealthyAfterAttempt
                  : isRecoveryProbe
                    ? over.canaryRecoveryHealthy ?? true
                    : over.canaryNatsHealthy ?? true;
              return healthy ? { healthy: true } : { healthy: false, reason: "monitor port 8222 not listening" };
            },
          },
        }
      : {}),
    ...(over?.settle !== undefined ? { settle: over.settle } : {}),
    clock: instantClock(),
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

  // cortex#1480 (join-1, epic #1479) — bootstrap must ALSO fire when
  // resolver_preload already EXISTS but is missing the FED (or SYS) account
  // the package carries, not only when the block is wholly absent. This is
  // the real "does not define account <FED>" gap: a bus bootstrapped before
  // FED existed (or hand-converted carrying only AGENTS) kept
  // `hasResolverPreload` true forever, so the OLD `!hasResolverPreload`-only
  // gate never revisited it and FED was never preloaded. ─────────────────────
  test("cortex#1480: resolver_preload EXISTS (AGENTS only) but package's FED account is missing → bootstrap STILL fires", async () => {
    const { ports, calls } = makePorts({
      hasResolverPreload: true, // the block already exists (e.g. AGENTS-only, from a prior make-live)
      hasAccountFor: (pubkey) => pubkey === AGENTS_PUB, // FED (FAKE_PKG.account) is NOT yet present
    });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: true, resolverHasAccount: true }, { operatorModePackage: FAKE_PKG }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    // The bootstrap/ensure step fires DESPITE hasResolverPreload:true, because
    // the package's FED account was not yet present.
    expect(calls[0]).toBe("bootstrap:~/.config/nats/local.conf");
    expect(res.steps.join("\n")).toContain("operator-mode bootstrap");
  });

  test("cortex#1480: resolver_preload EXISTS and already carries FED + AGENTS (+ no SYS in package) → bootstrap is a no-op", async () => {
    const { ports, calls } = makePorts({
      hasResolverPreload: true,
      hasAccountFor: () => true, // both FED and AGENTS already present
    });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: true, resolverHasAccount: true }, { operatorModePackage: FAKE_PKG }),
      ports,
    );
    expect(res.ok).toBe(true);
    // Fully converged: no bootstrap call, no append, no restart, nothing minted.
    expect(calls).toEqual([]);
    expect(res.steps.join("\n")).not.toContain("operator-mode bootstrap");
  });

  test("cortex#1480: resolver_preload EXISTS with FED present but the package's SYS account is missing → bootstrap STILL fires", async () => {
    const PKG_WITH_SYS = { ...FAKE_PKG, systemAccount: "A" + "Y".repeat(55), systemAccountJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJTWVMifQ.sig" };
    const { ports, calls } = makePorts({
      hasResolverPreload: true,
      hasAccountFor: (pubkey) => pubkey === FAKE_PKG.account || pubkey === AGENTS_PUB, // SYS absent
    });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: true, resolverHasAccount: true }, { operatorModePackage: PKG_WITH_SYS }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls[0]).toBe("bootstrap:~/.config/nats/local.conf");
  });

  test("cortex#1480: no operatorModePackage + resolver_preload already exists → unaffected (no bootstrap, matches pre-#1480 behaviour)", async () => {
    const { ports, calls } = makePorts({ hasResolverPreload: true, resolverHas: true });
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: true, resolverHasAccount: true }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(res.steps.join("\n")).not.toContain("operator-mode bootstrap");
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

// ── cortex#1483 (join-4, epic #1479) — canary safety: validate-before-reload,
// snapshot-before-mutate, settle-window health-verify, auto-rollback ───────────
describe("makeLiveStack — cortex#1483 canary safety (natsCanary port)", () => {
  test("no natsCanary wired → pre-#1483 behaviour: exit code trusted, no validate/health/rollback", async () => {
    const { ports, calls } = makePorts(); // withNatsCanary omitted
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(true);
    expect(calls).not.toContain("canary-validate");
    expect(calls).not.toContain("canary-isHealthy");
  });

  test("valid config + healthy restart → validate THEN restart THEN health-verify, in order", async () => {
    const { ports, calls } = makePorts({ withNatsCanary: true });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(true);
    const order = calls.filter((c) => c.startsWith("canary-") || c === "restart-nats");
    expect(order).toEqual(["canary-snapshot", "canary-validate", "restart-nats", "canary-isHealthy"]);
    expect(res.steps.join("\n")).toContain("verified healthy");
  });

  test("invalid config → caught by -t BEFORE restart; restart never attempted; resolver write reverted", async () => {
    const { ports, calls } = makePorts({ withNatsCanary: true, canaryValidateFails: true });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("config validation (-t) failed");
    expect(calls).not.toContain("restart-nats");
    expect(calls).toContain("canary-restore");
    // Never proceeded to mint/daemon-restart after the refused reload.
    expect(calls).not.toContain("restart-daemon");
  });

  test("slow-but-healthy bus (healthy on the 3rd poll) → NO false 'bus DOWN', no rollback", async () => {
    const { ports, calls } = makePorts({ withNatsCanary: true, canaryNatsHealthyAfterAttempt: 3 });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c === "restart-nats").length).toBe(1);
    expect(calls).not.toContain("canary-restore");
    expect(calls.filter((c) => c === "canary-isHealthy").length).toBe(3);
  });

  test("genuinely unhealthy across the whole settle window → auto-rollback restores the snapshot + reloads", async () => {
    const { ports, calls } = makePorts({
      withNatsCanary: true,
      canaryNatsHealthy: false,
      settle: { maxAttempts: 2, initialDelayMs: 1 },
    });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("2 health check(s)");
    expect(calls).toContain("canary-restore");
    // Rollback re-restarts + re-probes (recovery healthy by default → 1 more probe).
    expect(calls.filter((c) => c === "restart-nats").length).toBe(2);
    expect(calls.filter((c) => c === "canary-isHealthy").length).toBe(2 + 1);
    expect(res.reason).toContain("restored to prior state");
  });

  test("worst case: recovery also stays unhealthy → clear manual-intervention warning, never claims 'restored'", async () => {
    const { ports, calls } = makePorts({
      withNatsCanary: true,
      canaryNatsHealthy: false,
      canaryRecoveryHealthy: false,
      settle: { maxAttempts: 2, initialDelayMs: 1 },
    });
    const res = await makeLiveStack(makeInputs({ credsFileExists: true, resolverHasAccount: false }), ports);
    expect(res.ok).toBe(false);
    expect(calls).toContain("canary-restore");
    expect(res.reason).not.toContain("restored to prior state");
    expect(res.reason).toContain("intervene manually");
  });

  // ── cortex#1495 v2 (important 2): the no-monitor bus (the #1476 class) is now
  // liveness-probed by a real TCP connect, so auto-rollback is NO LONGER inert.
  // End-to-end with the REAL canary adapter (injected TCP probe) + fake services.
  test("v2 end-to-end: no-monitor bus + client port DOWN → real canary reports unhealthy → auto-rollback fires", async () => {
    const cdir = mkdtempSync(join(tmpdir(), "cortex-canary-e2e-"));
    try {
      const conf = join(cdir, "local.conf");
      writeFileSync(conf, "listen: 127.0.0.1:4222\n", "utf-8"); // valid HOCON, NO http monitor
      const { ports, calls } = makePorts({ settle: { maxAttempts: 2, initialDelayMs: 1 } });
      ports.natsCanary = buildNatsCanaryAdapter(true, undefined, async () => false); // client port DOWN
      const res = await makeLiveStack(
        makeInputs({ credsFileExists: true, resolverHasAccount: false }, { natsConfigPath: conf }),
        ports,
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("not accepting connections");
      // Rollback restored the config; the daemon was never restarted into a down bus.
      expect(readFileSync(conf, "utf-8")).toBe("listen: 127.0.0.1:4222\n");
      expect(calls).not.toContain("restart-daemon");
    } finally {
      rmSync(cdir, { recursive: true, force: true });
    }
  });

  test("v2 end-to-end: no-monitor bus + client port UP → real canary reports healthy → no rollback, proceeds", async () => {
    const cdir = mkdtempSync(join(tmpdir(), "cortex-canary-e2e-"));
    try {
      const conf = join(cdir, "local.conf");
      writeFileSync(conf, "listen: 127.0.0.1:4222\n", "utf-8");
      const { ports, calls } = makePorts({ settle: { maxAttempts: 2, initialDelayMs: 1 } });
      ports.natsCanary = buildNatsCanaryAdapter(true, undefined, async () => true); // client port UP
      const res = await makeLiveStack(
        makeInputs({ credsFileExists: true, resolverHasAccount: false }, { natsConfigPath: conf }),
        ports,
      );
      expect(res.ok).toBe(true);
      // No rollback; the flow proceeded to the daemon restart.
      expect(calls).toContain("restart-daemon");
    } finally {
      rmSync(cdir, { recursive: true, force: true });
    }
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

// ── credsPath write-back on a DEFAULTED path (v5.30.2, cortex#1265) ──────────────

describe("makeLiveStack — defaulted credsPath write-back", () => {
  /** makePorts() + a recording configWrite spy (optionally forced to fail). */
  function portsWithConfigWrite(fail?: boolean): {
    ports: MakeLivePorts;
    calls: string[];
    writes: { systemConfigPath: string; credsPath: string }[];
  } {
    const { ports, calls } = makePorts();
    const writes: { systemConfigPath: string; credsPath: string }[] = [];
    return {
      ports: {
        ...ports,
        configWrite: {
          writeBusCredsPath: ({ systemConfigPath, credsPath }) => {
            writes.push({ systemConfigPath, credsPath });
            calls.push("config-write");
            return fail === true
              ? { ok: false, reason: "EACCES" }
              : { ok: true, path: systemConfigPath, changed: true };
          },
        },
      },
      calls,
      writes,
    };
  }

  test("writes the defaulted path back BEFORE the daemon restart, in order", async () => {
    const { ports, calls, writes } = portsWithConfigWrite();
    const res = await makeLiveStack(
      makeInputs(
        { credsFileExists: false, resolverHasAccount: false },
        {
          credsPath: "~/.config/nats/work-bot.creds",
          credsPathDefaulted: true,
          systemConfigWritePath: "/Users/x/.config/cortex/work/system/system.yaml",
        },
      ),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(writes).toEqual([
      { systemConfigPath: "/Users/x/.config/cortex/work/system/system.yaml", credsPath: "~/.config/nats/work-bot.creds" },
    ]);
    // config-write lands AFTER the mint and BEFORE the daemon restart.
    expect(calls.indexOf("config-write")).toBeGreaterThan(calls.findIndex((c) => c.startsWith("mint:")));
    expect(calls.indexOf("config-write")).toBeLessThan(calls.indexOf("restart-daemon"));
  });

  test("write-back failure fail-fasts and the daemon is NOT restarted", async () => {
    const { ports, calls } = portsWithConfigWrite(true);
    const res = await makeLiveStack(
      makeInputs(
        { credsFileExists: false, resolverHasAccount: false },
        {
          credsPath: "~/.config/nats/work-bot.creds",
          credsPathDefaulted: true,
          systemConfigWritePath: "/Users/x/.config/cortex/work/system/system.yaml",
        },
      ),
      ports,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("nats.credsPath write-back failed");
      expect(res.reason).toContain("by hand"); // actionable manual-fix instruction
    }
    expect(calls).not.toContain("restart-daemon"); // never restart into broken-auth
  });

  test("an EXPLICIT credsPath (credsPathDefaulted unset) never triggers a write-back", async () => {
    const { ports, calls, writes } = portsWithConfigWrite();
    const res = await makeLiveStack(
      makeInputs({ credsFileExists: false, resolverHasAccount: false }),
      ports,
    );
    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(0);
    expect(calls).not.toContain("config-write");
  });
});

// ── cortex#1483 (join-4) — buildNatsCanaryAdapter (real fs + real HTTP probe) ───

describe("buildNatsCanaryAdapter (live)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-canary-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("snapshot → mutate → restore reverts the config to exactly the prior bytes", () => {
    const conf = join(dir, "local.conf");
    const original = "server_name: work\nlisten: 127.0.0.1:4222\n";
    writeFileSync(conf, original, "utf-8");
    const adapter = buildNatsCanaryAdapter(true);

    const snap = adapter.snapshot(conf);
    expect(snap.contents).toBe(original);

    writeFileSync(conf, "server_name: work\nresolver_preload: { A: eyJ }\n", "utf-8");
    adapter.restore(snap);
    expect(readFileSync(conf, "utf-8")).toBe(original);
  });

  test("cortex#1495 v2 (important 1): the restored (secret-bearing) config lands mode 0600 even under a permissive umask", () => {
    const conf = join(dir, "local.conf");
    const original = "server_name: work\nresolver_preload: { SECRET: eyJcreds }\n";
    writeFileSync(conf, original, "utf-8");
    const adapter = buildNatsCanaryAdapter(true);
    const snap = adapter.snapshot(conf);

    // Corrupt the live config (simulate a crashing restart's bad render)...
    writeFileSync(conf, "broken\n", "utf-8");
    // ...then roll back under a permissive umask so a mode-less write would land
    // 0644. The restore must still land 0600 (the config carries leaf creds etc.).
    const prevUmask = process.umask(0o022);
    try {
      adapter.restore(snap);
    } finally {
      process.umask(prevUmask);
    }
    expect(readFileSync(conf, "utf-8")).toBe(original);
    expect(statSync(conf).mode & 0o777).toBe(0o600);
  });

  test("restore removes a config that did NOT exist pre-mutation (the from-scratch bootstrap path)", () => {
    const conf = join(dir, "local.conf");
    const adapter = buildNatsCanaryAdapter(true);

    const snap = adapter.snapshot(conf); // file absent → contents: undefined
    expect(snap.contents).toBeUndefined();

    writeFileSync(conf, "bootstrapped-from-scratch\n", "utf-8");
    adapter.restore(snap);
    expect(existsSync(conf)).toBe(false);
  });

  test("dry-run restore is inert (writes nothing)", () => {
    const conf = join(dir, "local.conf");
    const original = "server_name: work\n";
    writeFileSync(conf, original, "utf-8");
    const adapter = buildNatsCanaryAdapter(false);

    const snap = adapter.snapshot(conf);
    writeFileSync(conf, "mutated\n", "utf-8");
    adapter.restore(snap);
    expect(readFileSync(conf, "utf-8")).toBe("mutated\n");
  });

  test("isHealthy probes the config's own monitor and reports healthy on a 200", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === "/healthz"
          ? new Response("ok", { status: 200 })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const conf = join(dir, "local.conf");
      writeFileSync(conf, `http_port: ${(server.port ?? 0).toString()}\n`, "utf-8");
      const adapter = buildNatsCanaryAdapter(true);
      const res = await adapter.isHealthy(conf);
      expect(res.healthy).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("isHealthy reports unhealthy when the config's monitor is unreachable", async () => {
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "http_port: 1\n", "utf-8"); // nothing listens on :1
    const adapter = buildNatsCanaryAdapter(true);
    const res = await adapter.isHealthy(conf);
    expect(res.healthy).toBe(false);
  });

  test("cortex#1495 v2: no monitor + client port UP (TCP connect ok) → genuinely healthy, NOT inconclusive", async () => {
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "listen: 127.0.0.1:4222\n", "utf-8"); // no http_port monitor
    const probed: { host: string; port: number }[] = [];
    const adapter = buildNatsCanaryAdapter(true, undefined, async (host, port) => {
      probed.push({ host, port });
      return true; // client port accepting → bus is up
    });
    const res = await adapter.isHealthy(conf);
    expect(res.healthy).toBe(true);
    // A REAL signal — no longer flagged inconclusive.
    expect("inconclusive" in res && res.inconclusive).not.toBe(true);
    // Probed the parsed client listen host:port.
    expect(probed).toEqual([{ host: "127.0.0.1", port: 4222 }]);
  });

  test("cortex#1495 v3: no monitor + a NON-loopback listen host → probes THAT host (no false 127.0.0.1)", async () => {
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "listen: 10.0.0.5:4222\n", "utf-8"); // bound to a specific address
    const probed: { host: string; port: number }[] = [];
    const adapter = buildNatsCanaryAdapter(true, undefined, async (host, port) => {
      probed.push({ host, port });
      return true;
    });
    const res = await adapter.isHealthy(conf);
    expect(res.healthy).toBe(true);
    // v3 important — the parsed host is dialled, NOT a hardcoded 127.0.0.1.
    expect(probed).toEqual([{ host: "10.0.0.5", port: 4222 }]);
  });

  test("cortex#1495 v3: no monitor + a WILDCARD listen host maps to loopback for the connect", async () => {
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "listen: 0.0.0.0:4222\n", "utf-8"); // wildcard bind
    const probed: { host: string; port: number }[] = [];
    const adapter = buildNatsCanaryAdapter(true, undefined, async (host, port) => {
      probed.push({ host, port });
      return true;
    });
    await adapter.isHealthy(conf);
    // 0.0.0.0 is reachable via loopback → probe 127.0.0.1.
    expect(probed).toEqual([{ host: "127.0.0.1", port: 4222 }]);
  });

  test("cortex#1495 v2: no monitor + client port DOWN (TCP connect fails) → UNHEALTHY (rollback will fire)", async () => {
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "port: 4299\n", "utf-8"); // client port via `port:`, no monitor
    const probed: { host: string; port: number }[] = [];
    const adapter = buildNatsCanaryAdapter(true, undefined, async (host, port) => {
      probed.push({ host, port });
      return false; // nothing accepting → the restart left the bus down
    });
    const res = await adapter.isHealthy(conf);
    expect(res.healthy).toBe(false);
    if (!res.healthy) expect(res.reason).toContain("not accepting connections");
    // Bare `port:` → empty host defaulted to loopback; port parsed as 4299.
    expect(probed).toEqual([{ host: "127.0.0.1", port: 4299 }]);
  });

  test("cortex#1495 v2: no monitor + client listen unresolvable (config absent) → discloses inconclusive-healthy", async () => {
    let tcpCalled = false;
    const adapter = buildNatsCanaryAdapter(true, undefined, async () => {
      tcpCalled = true;
      return true;
    });
    const res = await adapter.isHealthy(join(dir, "does-not-exist.conf"));
    expect(res.healthy).toBe(true);
    expect("inconclusive" in res && res.inconclusive).toBe(true);
    // Nothing to connect to — the TCP probe is not even attempted.
    expect(tcpCalled).toBe(false);
  });

  test("dry-run isHealthy is trivially healthy (never probes)", async () => {
    const adapter = buildNatsCanaryAdapter(false);
    const res = await adapter.isHealthy("/x/local.conf");
    expect(res.healthy).toBe(true);
  });

  test("dry-run validateConfig is inert (valid, never spawns)", async () => {
    const adapter = buildNatsCanaryAdapter(false);
    const res = await adapter.validateConfig("/x/local.conf");
    expect(res.status).toBe("valid");
  });

  test("cortex#1495 BLOCKER: validateConfig is three-state (valid | invalid | skipped), never a silent fail-open", async () => {
    // Mirrors network-adapters.test.ts's MAJOR-1 pattern: we can't guarantee
    // nats-server is installed on CI, so assert a well-formed three-state result.
    // A missing binary MUST be `skipped` (with a reason), NEVER a silent `valid`
    // — that fail-open is the exact BLOCKER this slice closes.
    const conf = join(dir, "local.conf");
    writeFileSync(conf, "server_name: work\nlisten: 127.0.0.1:4222\n", "utf-8");
    const adapter = buildNatsCanaryAdapter(true);
    const res = await adapter.validateConfig(conf);
    if (res.status === "invalid") {
      expect(res.reason).toContain("nats-server");
    } else if (res.status === "skipped") {
      expect(res.reason).toContain("nats-server");
    } else {
      expect(res.status).toBe("valid");
    }
  });
});
