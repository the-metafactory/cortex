#!/usr/bin/env bun
/**
 * MIG-7.1 — Cortex entrypoint. Wires runtime → surface-router → adapters
 * (Discord + Mattermost) → dispatch-handler → dispatch-listener →
 * worklog-manager → taps. Equivalent of grove-v2's `src/bot/grove-bot.ts`
 * against the cortex layout; per plan §1.3, startup behaviour is parity.
 *
 * Out of scope (deferred): arc-manifest (MIG-7.7), launchd plist (MIG-7.8),
 * config schema flip — `agents:` + `renderers:` (MIG-7.2*), relay daemon
 * wiring (MIG-5b). Public surface: `startCortex(config) → { stop }` —
 * tests construct pieces directly; the CLI bottom wires SIGINT/SIGTERM.
 */

import { Command } from "commander";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { basename, join, dirname } from "path";
import { parse as parseYaml } from "yaml";
import type { TextChannel } from "discord.js";

import { loadConfigWithAgents, loadAgentsDirectory, expandTilde, FragmentLoadError } from "./common/config/loader";
import { ConfigWatcher } from "./common/config/watcher";
import { type BotConfig, getAllRepos } from "./common/types/config";
import { fetchWithTimeout } from "./common/timeout";
import { UsageMonitor } from "./common/usage/monitor";
import { AgentRegistry } from "./common/agents/registry";
import { TrustResolver } from "./common/agents/trust-resolver";
// cortex#79 — creds minting moved to `arc nats … --json` (shelled out from
// `src/cli/cortex/commands/creds.ts`). No daemon-side RPC handler in
// cortex; the operator-signature verifier in TrustResolver keeps using
// `loadAccountSigningKey` independently.
import type { UsageStats } from "./runner/stream-parser";

import { buildSecurityPreamble } from "./runner/security-preamble";
import { DispatchHandler } from "./bus/dispatch-handler";
import {
  makeSubjectPlaceholderSubstituter,
  startMyelinRuntime,
  type BusEnvelopeSigner,
  type MyelinRuntime,
} from "./bus/myelin/runtime";
import { loadStackSigningKey } from "./common/config/stack-signing-key";
import { BusDispatchListener } from "./bus/bus-dispatch-listener";
import { DID_RE } from "@the-metafactory/myelin/identity";
import { createSurfaceRouter, type SurfaceRouter } from "./bus/surface-router";
import { createNetworkResolver } from "./bus/network-resolver";
import type { SystemEventSource } from "./bus/system-events";
import {
  publishCapabilityRegistry,
  type CapabilityRegistryEntry,
} from "./bus";
import {
  ReviewConsumer,
  type ReviewConsumerAgent,
  type SignatureVerifier,
} from "./bus/review-consumer";
import {
  provisionReviewStream,
  provisionReviewConsumer,
} from "./bus/jetstream/provision";
import { verifySignedByChain } from "./bus/verify-signed-by-chain";
import { CCSession } from "./runner/cc-session";
import { makePiDevPipelineRunner } from "./runner/substrate/pi-dev-runner";

import { DiscordAdapter } from "./adapters/discord";
import { createRenderer, type Renderer } from "./renderers";
import { RendererSchema, deriveStackId } from "./common/types/cortex-config";
import type {
  Agent,
  BusConfig,
  DiscordPresence,
  MattermostPresence,
  Policy,
  SlackPresence,
  StackConfig,
} from "./common/types/cortex-config";
import { policyEngineFromConfig } from "./common/policy/factory";
import {
  buildPlatformPrincipalIndex,
  buildPrincipalRegistry,
} from "./common/policy";
import { MattermostAdapter } from "./adapters/mattermost";
import { SlackAdapter } from "./adapters/slack";
import type { PlatformAdapter } from "./adapters/types";

import { createDispatchListener, type DispatchListener } from "./runner/dispatch-listener";
import { WorklogManager } from "./runner/worklog-manager";

import { CloudPublisher } from "./taps/cc-events/cloud-publisher";
import { RegistryClient } from "./common/registry";
import type { RegistryClientReader } from "./common/registry";
import { JsonlReader } from "./taps/cc-events/lib/jsonl-reader";
import { PublishedEventSchema } from "./taps/cc-events/hooks/lib/event-types";
import { formatEventForDiscord } from "./adapters/discord/event-formatter";
import {
  startGithubWebhookReceiver,
  type GithubWebhookReceiverHandle,
} from "./taps/gh-webhook-receiver/server";

// MIG-7.9 (deferred) flips these to `~/.config/cortex/`. Keeping grove-shaped
// paths for now so the operator's existing `bot.yaml` continues to work.
const STATE_DIR = join(process.env.HOME ?? "~", ".config", "grove", "state");
const PID_FILE = join(STATE_DIR, "cortex.pid");
const DEFAULT_CONFIG = join(process.env.HOME ?? "~", ".config", "grove", "bot.yaml");

/**
 * Resolve the PID file path for a given `--config` value.
 *
 * Operators running multiple cortex instances on a single machine (per
 * Phase A.5's stack-aware namespace — e.g. `andreas/research` and
 * `andreas/work` side-by-side) need distinct PID files so the
 * singleton check in {@link checkSingleton} only blocks duplicates of
 * the same stack, not unrelated stacks.
 *
 * Resolution:
 *   - Default config (or unspecified) → legacy `cortex.pid` (preserves
 *     single-instance backward compat — operators on the default path
 *     see no behaviour change).
 *   - Custom config → `cortex-<config-basename>.pid` (derived from the
 *     config filename without the `.yaml`/`.yml` extension). Two stacks
 *     with different `--config` paths get different PID files.
 *
 * The basename derivation deliberately omits the directory portion so
 * `~/.config/cortex/cortex.work.yaml` and `./cortex.work.yaml` resolve
 * to the same PID file — moving a config doesn't accidentally orphan
 * the prior PID file.
 */
export function pidFileFor(configPath: string | undefined): string {
  if (configPath === undefined || configPath === DEFAULT_CONFIG) {
    return PID_FILE;
  }
  const base = basename(configPath).replace(/\.ya?ml$/i, "");
  if (base.length === 0) return PID_FILE;
  return join(STATE_DIR, `cortex-${base}.pid`);
}

/** Lifecycle handle returned by `startCortex`. Capped at 15s — components
 *  that don't drain are abandoned (logged). */
export interface CortexHandle {
  stop(): Promise<void>;
  /**
   * Subsystems that did not finish their `stop()` within
   * `SHUTDOWN_TIMEOUT_MS` on the most recent `stop()` invocation. Empty
   * after a clean shutdown; non-empty signals operators (or launchd) that
   * the process exited dirty — typically wiring this to a non-zero exit
   * code.
   *
   * Echo round-1 N2: previously the timeout warned but didn't surface
   * which components were left in flight. The CLI handler at the bottom
   * of this file checks this list after stop() and exits 1 if non-empty
   * so launchd knows to log a dirty shutdown.
   */
  readonly lastShutdownAbandoned: readonly string[];
  /**
   * cortex#67 prereq C — agent registry assembled at startup from inline
   * cortex.yaml `agents[]` + fragments under `agents.d/` (inline wins on id
   * conflict per design §6.1). Read-only; downstream consumers (dashboard,
   * trust resolver, future capability surfaces) look up agents here rather
   * than synthesising local `Agent` shapes.
   *
   * Today this coexists with the transitional inline `Agent` synthesis at
   * cortex.ts:246 and :321 (Discord + Mattermost adapter wiring). Those
   * paths land in MIG-7.2c-presence-adapter-flip; this PR does not refactor
   * them.
   */
  readonly agentRegistry: AgentRegistry;
  /**
   * IAW Phase D.4.3 — registry-resolved peer pubkey reader. Exposed
   * read-only so D.6 integration tests + future consumers can verify
   * that the federation roster gets populated from the registry.
   * `null` when no registry was configured on this cortex instance.
   */
  readonly registryClient: RegistryClientReader | null;
}

/** Optional test-only injection points. Production callers omit. */
export interface StartCortexOptions {
  /** Override config-file path. Defaults to no watching. */
  configPath?: string;
  /** Skip the config-watcher (tests). */
  disableConfigWatcher?: boolean;
  /** Skip the dashboard API even if config.api.enabled is set (tests). */
  disableDashboard?: boolean;
  /** Skip the JSONL outbound poller (tests). */
  disableOutboundPoller?: boolean;
  /** Skip the GitHub webhook receiver even if config.github.receiver.enabled is true (tests). */
  disableGithubReceiver?: boolean;
  /**
   * Inject a runtime instead of constructing one via `startMyelinRuntime`.
   * Tests pass a recording fake to assert observable side-effects (e.g. that
   * the surface-router actually called `runtime.onEnvelope`). Production
   * callers omit this and the runtime is built from `config.nats?` as usual.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  injectRuntime?: MyelinRuntime;
  /**
   * Override the 15s shutdown timeout. Tests use a small value (50–200ms)
   * to exercise the abandoned-set tracking path without holding the test
   * runner hostage for 15 real seconds.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  shutdownTimeoutMs?: number;
  /**
   * Override the agents.d/ fragment directory the AgentRegistry assembly
   * step reads. Production code derives this from the config file's
   * directory (`{configDir}/agents.d`) matching `cortex agents` CLI
   * behaviour, falling back to `~/.config/cortex/agents.d/` when no
   * `configPath` was supplied. Tests pass a tmp dir so the registry
   * assembly path runs without touching the operator's real `agents.d/`.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  agentsDir?: string;
  /**
   * Inline `Agent[]` to merge with the fragment-loaded list when building
   * the registry. Mirrors the cortex.yaml `agents[]` block (design §6.1):
   * inline entries win on id conflict with fragments.
   *
   * BotConfig (today's legacy shape) carries no inline `agents[]` field, so
   * production callers pass nothing and the registry is built purely from
   * fragments. The seam exists today so tests can assemble a registry
   * without writing fragment files, and so the cortex.yaml migration
   * (MIG-7.2e) can plumb the real inline list through without changing
   * this signature.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  inlineAgents?: readonly Agent[];
  /**
   * IAW Phase A.5 (refs cortex#113) — optional `stack:` block from
   * `CortexConfig`, threaded through from the loader so the boot path can
   * call `deriveStackId` without re-parsing the file. Undefined for legacy
   * `bot.yaml` input (the block lives on `CortexConfigSchema` only) AND for
   * cortex-shape input where the operator hasn't declared `stack:` —
   * `deriveStackId` default-derives `${operator.id}/default` for both.
   *
   * The seam exists today so the boot path can log the derived stack id and
   * downstream emit code (A.5.5, blocked on myelin#113) can consume the
   * resolved value without re-loading config. No emit-subject behaviour
   * change ships here — that's the follow-up PR.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  stack?: StackConfig;
  /**
   * IAW Phase C.3.1 (refs cortex#115) — optional `policy:` block from
   * `CortexConfig`, threaded through from the loader so the boot path
   * can build the PolicyEngine once and pass it to the dispatch-
   * listener. Undefined for legacy `bot.yaml` input (the block lives
   * on `CortexConfigSchema` only) AND for cortex-shape input where
   * the operator hasn't declared a `policy:` block — the engine
   * factory returns `undefined` for both, and the dispatch-listener
   * falls back to the legacy unauthenticated path.
   *
   * C.2b removes the legacy path; until then, this seam keeps the
   * existing dev-mode bots booting unchanged.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  policy?: Policy;
  /**
   * cortex-shape `bus:` block. Currently consumed by ReviewConsumer
   * JetStream provisioning (`bus.review.*`). Legacy bot.yaml deployments
   * leave this undefined and receive the same defaults as before.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  bus?: BusConfig;
  /**
   * v2.0.0 cutover (cortex#297) — operator's platform-side ids surfaced
   * from `OperatorSchema` via `LoadedConfig.operator`. Replaces the
   * `BotConfig.agent.operatorDiscordId/Mattermost/Slack` fields retired
   * in cortex#297. `undefined` for legacy `bot.yaml` input — adapters
   * then have no operator-DM target and `notifyOperator` is a no-op.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  operator?: {
    id: string;
    discordId?: string;
    mattermostId?: string;
    slackId?: string;
  };
}

/**
 * Construct the full cortex stack and start it. Returns a stop handle.
 *
 * Order: runtime → router → dispatch-handler → adapters → dispatch-listener
 * → router.start(). Optional taps (cloud publisher, dashboard, JSONL
 * poller) run alongside. Errors during startup of OPTIONAL components are
 * logged and swallowed; REQUIRED components (runtime, router, listener)
 * propagate so the operator sees them at the CLI exit.
 */
export async function startCortex(
  config: BotConfig,
  options: StartCortexOptions = {},
): Promise<CortexHandle> {
  const expandedConfigPath = options.configPath
    ? options.configPath.replace(/^~/, process.env.HOME ?? "~")
    : DEFAULT_CONFIG;

  const securityPreamble = buildSecurityPreamble(config, expandedConfigPath);
  console.log("cortex: starting...");
  console.log(`  Agent: ${config.agent.displayName}`);
  console.log(`  Config: ${options.configPath ?? "(in-memory)"}`);
  console.log(`  PID: ${process.pid}`);

  // IAW Phase A.5 (refs cortex#113, closes cortex#262) — resolve the
  // deployment's stack identity at boot. `deriveStackId` returns
  // `{operator, stack, id}`; the `stack` segment flows into
  // `MyelinRuntime.publish()` below so emitted envelopes land in the
  // 6-segment `local.{org}.{stack}.{type}` grammar that sage's bridge
  // and pilot's review-request subscriber both expect.
  //
  // The helper accepts a narrow `DeriveStackIdInput` shape (operator?.id +
  // optional stack.id) — we synthesise it from the loader-passed
  // `options.stack` (the top-level cortex.yaml `stack:` block, when present)
  // plus an `operator.id` derived from the BotConfig projection. The
  // fallback path (no `options.stack`, no `agent.operatorId`) returns
  // `default/default` and the helper never throws — that default matches
  // sage's bridge default (`SAGE_STACK=default`).
  const derivedStack = deriveStackId({
    operator: { id: config.agent.operatorId ?? "default" },
    ...(options.stack !== undefined && { stack: options.stack }),
  });
  console.log(
    `  Stack: ${derivedStack.id}${options.stack === undefined ? " (default-derived)" : ""}`,
  );

  // IAW Phase B.3 (refs cortex#114) — load the stack signing keypair
  // if the operator has declared `stack.nkey_seed_path`. The signer is
  // optional; when absent, MyelinRuntime publishes envelopes unsigned
  // (same shape as today). When present, MyelinRuntime.publish signs
  // every outbound envelope via myelin's chain-aware signEnvelope.
  //
  // Principal derivation: `did:mf:${stack.id.replace("/", "-")}`. The
  // `stack.id` shape is `{operator_id}/{stack_id}` (Phase A.5 lock-in);
  // myelin's DID_RE rejects slashes but accepts hyphens, so we
  // canonicalize the slash. Operators see `did:mf:andreas-research`
  // on the wire for `stack.id = "andreas/research"`.
  //
  // Load failures are non-fatal — the daemon keeps starting and the
  // runtime publishes unsigned. The error surfaces to operator logs
  // so they can fix the seed file and restart.
  let signer: BusEnvelopeSigner | undefined;
  if (options.stack?.nkey_seed_path) {
    try {
      // `expandTilde` matches `NatsLink.connect`'s treatment of
      // `credsPath` + the agents.d/ fallback below — operators writing
      // `~/.config/cortex/stack.nk` should not silently ENOENT into
      // the unsigned-publish fallback (Echo cortex#211 round 1).
      const seedPath = expandTilde(options.stack.nkey_seed_path);
      const kp = await loadStackSigningKey(seedPath);

      // Consistency check: if `stack.nkey_pub` is also declared, the
      // loaded keypair's public key MUST match. A mismatch is the
      // operator-rotation split-brain hazard — peers' `trust:`
      // lookups would reject every signature without explaining why.
      // Throw and let the existing catch surface the failure (Echo
      // cortex#211 round 1).
      if (
        options.stack.nkey_pub !== undefined &&
        kp.getPublicKey() !== options.stack.nkey_pub
      ) {
        throw new Error(
          `seed file pubkey ${kp.getPublicKey()} does not match declared ` +
            `stack.nkey_pub ${options.stack.nkey_pub} — rotation split-brain hazard`,
        );
      }

      // KP class exposes getRawSeed() returning the 32-byte ed25519
      // seed; that's the shape myelin's signEnvelope consumes (after
      // base64-encoding, done inside MyelinRuntime). See B.3 PR #209.
      const rawSeedBytes = (
        kp as unknown as { getRawSeed(): Uint8Array }
      ).getRawSeed();

      // Derive the principal DID. `stack.id` shape is `{op}/{stack}`
      // (Phase A.5 lock-in); myelin's DID_RE rejects slashes but
      // accepts hyphens, so we canonicalize. The schema regex allows
      // trailing hyphens in each segment (`my-op-/foo`) which after
      // replacement becomes `my-op--foo`, breaking DID_RE's
      // consecutive-hyphen guard. Collapse `--` runs to avoid the
      // silent per-publish sign failure that would otherwise downgrade
      // every outbound envelope to unsigned (Echo cortex#211 round 1).
      const principal = `did:mf:${derivedStack.id
        .replace("/", "-")
        .replace(/-+/g, "-")}`;
      if (!DID_RE.test(principal)) {
        throw new Error(
          `derived DID "${principal}" does not match myelin DID_RE — ` +
            `check stack.id segments for trailing-hyphen edge cases`,
        );
      }

      signer = { rawSeedBytes, principal };
      // Soften wording: the runtime may still fail to start; the
      // signer is only "active" once `startMyelinRuntime` returns an
      // enabled runtime. Boot-log clarity matters more than terseness
      // here (Echo cortex#211 round 1).
      console.log(
        `cortex: stack signing key staged — principal=${principal} (active once myelin runtime starts)`,
      );
    } catch (err) {
      console.error(
        "cortex: stack signing key load failed (non-fatal — publish will be unsigned):",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    // cortex#324 (v2.0.3) — walk the talk: stack signing should be ON by
    // default. When the operator hasn't declared `stack.nkey_seed_path`,
    // every outbound envelope is published UNSIGNED, which means peers
    // on the bus that run `verifySignedByChain` (cortex#320 / v2.0.2)
    // will reject the messages — silently for plain `dispatch.*`, loudly
    // once federation is on. The opt-in default is a footgun: operators
    // upgrade from a working unsigned deployment, don't notice the
    // missing field, and traffic looks fine until a peer enforces.
    //
    // For v2.0.3 we emit a LOUD stderr WARNING so operators tailing logs
    // OR running interactively see the actionable fix-path. Boot stays
    // non-fatal — existing deployments degrade gracefully (same shape as
    // today's unsigned publish), and v2.0.4 promotes this to a refuse-to-
    // boot once arc upgrade auto-provisions the field on every install.
    //
    // Same wording pattern as the cortex#314 capability-registry and
    // review-consumer skip warnings (`src/cortex.ts:~640, ~774`): info
    // log + stderr WARNING with the `arc upgrade Cortex` fix-path AND
    // the manual cortex.yaml fix-path, plus a docs/sop-stack-identity.md
    // cross-link for the rotation / threat-model background.
    console.log(
      "cortex: stack signing key not configured — outbound envelopes will be unsigned",
    );
    process.stderr.write(
      "WARNING: stack identity not configured — cortex will publish unsigned envelopes.\n" +
        "  Peers that verify signed_by[] will reject these messages.\n" +
        "  Run `arc upgrade Cortex --force` to auto-provision, or add\n" +
        "  `stack.nkey_seed_path` (+ optionally `stack.nkey_pub`) to cortex.yaml.\n" +
        "  See docs/sop-stack-identity.md for the full SOP.\n",
    );
  }

  // Bus runtime (M2-M6) — no-op when `config.nats?` is absent. Tests inject
  // a recording fake via `options.injectRuntime` to assert observable
  // wire-up side-effects without standing up a real NATS server.
  /* eslint-disable @typescript-eslint/no-empty-function */
  // Null-runtime stub: intentionally empty methods. NATS-less cortex flows
  // through this path, so onEnvelope's unregister, publish, and stop are
  // all no-ops by design — the @-disables document intent at the source.
  let runtime: MyelinRuntime = {
    enabled: false,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
  };
  /* eslint-enable @typescript-eslint/no-empty-function */
  if (options.injectRuntime) {
    runtime = options.injectRuntime;
  } else {
    try {
      // IAW Phase A.5 (cortex#262) — surface the resolved stack identity
      // into the runtime so `publish()` emits 6-segment subjects matching
      // sage's `local.{org}.{stack}.>` subscription. `derivedStack.stack`
      // is the second segment of the canonical `{operator}/{stack}` id;
      // when the operator omitted the `stack:` block, `deriveStackId`
      // default-derived it to `'default'` (cortex.ts:278-281). That value
      // is what sage's bridge listens for by default (`SAGE_STACK=default`).
      runtime = await startMyelinRuntime(config, {
        ...(signer !== undefined && { signer }),
        stack: derivedStack.stack,
      });
    } catch (err) {
      console.error("cortex: myelin runtime startup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // cortex#67 prereq C — assemble the AgentRegistry from inline agents +
  // fragments dropped under `agents.d/`. Per design §6.1, inline entries win
  // on id conflict with fragments.
  //
  // The fragment directory defaults to `{configDir}/agents.d` (matching the
  // `cortex agents` CLI's resolver) so an operator who already manages
  // fragments via that command sees them honoured at daemon startup too.
  // When `options.configPath` is absent (e.g. tests with in-memory config),
  // we fall back to `~/.config/cortex/agents.d/`.
  //
  // Fragment-load errors are non-fatal at this stage of the migration: the
  // agent must keep starting in BotConfig mode even when an operator's
  // experimental fragment is malformed. Once the cortex.yaml migration is
  // complete (MIG-7.2e), the rule flips to strict per spec §FR-4.
  const agentsDir = options.agentsDir
    ?? (options.configPath ? join(dirname(expandedConfigPath), "agents.d") : expandTilde("~/.config/cortex/agents.d/"));
  let fragmentAgents: Agent[] = [];
  try {
    fragmentAgents = loadAgentsDirectory(agentsDir);
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      console.error(`cortex: agents.d fragment load failed (non-fatal during BotConfig migration): ${err.message}`);
    } else {
      throw err;
    }
  }

  // Merge: inline wins on id conflict (design §6.1). BotConfig today carries
  // no inline `agents[]`, so production callers pass `inlineAgents: undefined`
  // and the merged list is just the fragments. The seam exists so tests can
  // exercise the merge rule without writing fragment files, and so MIG-7.2e
  // can plumb the real inline list through without changing the signature.
  const inlineAgents = options.inlineAgents ?? [];
  const inlineIds = new Set(inlineAgents.map((a) => a.id));
  const shadowedFragmentCount = fragmentAgents.filter((a) => inlineIds.has(a.id)).length;
  const mergedAgents: Agent[] = [
    ...inlineAgents,
    ...fragmentAgents.filter((a) => !inlineIds.has(a.id)),
  ];
  const agentRegistry = AgentRegistry.fromAgents(mergedAgents);
  if (mergedAgents.length > 0) {
    console.log(
      `cortex: agent registry assembled — ${mergedAgents.length} agent(s) `
        + `(${inlineAgents.length} inline + ${fragmentAgents.length} fragment, `
        + `${shadowedFragmentCount} fragment override(s) shadowed by inline)`,
    );
  } else {
    console.log("cortex: agent registry assembled — 0 agents (no inline agents, no fragments)");
  }

  // cortex#98 (part B) — in-process trust map. Each Discord adapter
  // registers its own `client.user.id` after login (Pass 1 of the adapter
  // loop below), and the merge step (Pass 2) walks each agent's `trust:[]`
  // list and asks the resolver for each peer's bot user id. Co-hosted
  // peers land in the merged set; cross-process peers (never registered
  // here) silently fall through and stay covered by the operator-explicit
  // `presence.discord.trustedBotIds` field (cortex#98 part A).
  //
  // The resolver is constructed unconditionally — even legacy bot.yaml
  // configs with `trust: []` (no peers) get a no-op resolver rather than
  // a branching code path, keeping the adapter loop uniform.
  const trustResolver = new TrustResolver(agentRegistry);

  // cortex#79 — creds minting is no longer a cortex daemon responsibility.
  // `cortex creds issue / revoke / rotate` now shell out to
  // `arc nats … --json`; arc owns nsc and the operator account.
  // `config.nats.accountSigningKeyPath` survives for the operator-signature
  // verifier on TrustResolver (cortex#76); see
  // `src/common/agents/trust-resolver.ts`.

  // SystemEventSource for `system.*` envelopes (spec §3.6:
  // `{operatorId}.cortex.{instance}`). `local` until federation lands.
  // `dataResidency` flows from `config.agent.dataResidency` so a non-NZ
  // operator gets envelopes stamped with their actual residency without
  // touching the per-event constructors. Defaults to "NZ" when absent
  // (the original cortex deployment's residency).
  //
  // Declared BEFORE the surface-router (cortex#134 Echo round-1 fix):
  // the router needs the source to publish `system.access.filtered`
  // envelopes when a visibility-config renderer drops an envelope.
  // Without this, the audit-trail emit silently degrades to console.info
  // in production — only unit tests passed the explicit source.
  const systemEventSource: SystemEventSource = {
    org: config.agent.operatorId ?? "default",
    agent: "cortex",
    instance: "local",
    ...(config.agent.dataResidency !== undefined && {
      dataResidency: config.agent.dataResidency,
    }),
  };

  // cortex#237 PR-7 — capability-registry boot wiring.
  //
  // Per `docs/design-capability-dispatch-review-consumer.md` §3.4: for each
  // agent in `mergedAgents` with at least one `runtime.capabilities[]` entry,
  // publish one `agents.capabilities.registered` envelope so the rest of the
  // network (today: pilot's deferred bucket reader per §13.1; tomorrow: the
  // operator-side dashboard) can discover what each agent claims to do.
  //
  // **Ordering rationale.** This block runs AFTER:
  //   - the runtime is constructed (line ~395) so `runtime.publish` is wired
  //     (no-op stub when NATS is absent; production runtime when present),
  //   - `mergedAgents` is built (line ~439) so we know who claims what,
  //   - `systemEventSource` is built (immediately above) so we share the same
  //     `{org}.cortex.{instance}` envelope source with `system.*` emissions.
  //
  // It runs BEFORE the bus-dispatch-listener + surface-router start so the
  // registry envelope is on the wire before any dispatch envelope can arrive
  // — peers that gate on "is the registration there yet?" (pilot Phase B.4,
  // deferred per §13.1) see it before the first `tasks.code-review.*` is
  // accepted. Even though pilot's reader doesn't exist yet, putting the
  // emission first keeps the future ordering contract obvious.
  //
  // **Error handling (per task spec + CLAUDE.md "no empty catch blocks").**
  // `publishCapabilityRegistry` itself does NOT catch publish errors — its
  // doc explicitly says they propagate to the caller. So we wrap the
  // injected `publish` here and trap per-envelope failures with a
  // `process.stderr.write` log + a non-throw resolve. Net effect: one bad
  // publish doesn't abort the rest of the loop OR abort boot.
  //
  // **Idempotency.** Re-invoking `publishCapabilityRegistry` with the same
  // entries re-emits envelopes with fresh ids/timestamps; the bucket
  // consumer keys on the payload `agent_id` and overwrites — see the
  // publisher's idempotency doc. So this boot-time call is safe under
  // restart-and-replay; we do NOT wire a re-publish into the BotConfig
  // hot-reload path because (a) capabilities live on `Agent`, not
  // `BotConfig`, and (b) cortex.ts does not currently run an agents.d/
  // fragment watcher at the daemon level — when one is wired, the
  // re-publish belongs in its callback, not the BotConfig one.
  //
  // **Scope (per §10.1 PR-7).** Publish-only. No subscriber wiring here —
  // the consumer is operator-dashboard side and lands in a future PR.
  const capabilityEntries: CapabilityRegistryEntry[] = mergedAgents
    .filter((a): a is Agent & { runtime: { capabilities: readonly string[] } } =>
      (a.runtime?.capabilities.length ?? 0) > 0,
    )
    .map((a) => ({
      agentId: a.id,
      capabilities: a.runtime.capabilities,
    }));
  if (capabilityEntries.length > 0) {
    // cortex#288 follow-up — closure-scoped success/failure counters.
    //
    // `publishCapabilityRegistry`'s contract is "I called publish() for each
    // envelope" — it pushes to its returned `published[]` *after* awaiting
    // publish(), regardless of whether the boot site swallows the rejection.
    // Our `wrappedPublish` below DOES swallow per-envelope failures (so one
    // bad publish doesn't abort the loop), which means `published.length` is
    // really "publishes that returned without throwing into the publisher",
    // not "publishes that actually landed on the wire". The boot log should
    // report wire-side reality. We count outcomes locally here; the publisher
    // contract stays correct and unchanged.
    let successfulPublishes = 0;
    let failedPublishes = 0;
    const wrappedPublish = async (env: Parameters<typeof runtime.publish>[0]): Promise<void> => {
      try {
        await runtime.publish(env);
        successfulPublishes++;
      } catch (err) {
        // Per CLAUDE.md "no empty catch blocks": log every error. We use
        // stderr (not the system-events pipeline) because the system-events
        // emitter shares the same runtime we just failed to publish on —
        // routing the error through it would be a credible re-failure loop.
        // Continue without rethrowing so sibling envelopes still emit.
        failedPublishes++;
        process.stderr.write(
          `cortex: capability-registry publish failed for ${env.type} ` +
            `(agent_id=${(env.payload as { agent_id?: string }).agent_id ?? "?"}): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    };
    try {
      await publishCapabilityRegistry({
        source: systemEventSource,
        entries: capabilityEntries,
        publish: wrappedPublish,
      });
      const failureSuffix = failedPublishes > 0 ? ` (${failedPublishes} failure(s))` : "";
      console.log(
        `cortex: published ${successfulPublishes} capability registration(s)${failureSuffix} ` +
          `for ${capabilityEntries.length} agent(s)`,
      );
    } catch (err) {
      // Defensive — `publishCapabilityRegistry` is pure orchestration and
      // shouldn't throw once `wrappedPublish` traps per-envelope failures,
      // but a `clock()` or `buildBaseEnvelope` throw would still surface
      // here. Boot continues; the bucket simply stays unpopulated until
      // the next restart.
      console.error(
        "cortex: capability-registry boot wiring failed (non-fatal — boot continues):",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    // cortex#314 — promote skipped notice to stderr WARNING with
    // operator-actionable text. The capability-dispatch consumer rejects
    // every inbound request with `cant_do` until at least one agent
    // declares runtime.capabilities[], so the boot-time silence was a
    // first-install footgun (fresh `pilot request-review --wait` exits 0
    // with no review having happened). Keep the original info-level
    // `console.log` for normal observability AND emit a stderr WARNING
    // so operators tailing logs OR running interactively see the
    // actionable fix-path.
    console.log(
      "cortex: capability-registry skipped — 0 agents declare runtime.capabilities[]",
    );
    process.stderr.write(
      "WARNING: capability-registry skipped — 0 agents declare runtime.capabilities[].\n" +
        "  The capability-dispatch consumer will reject every request with cant_do.\n" +
        "  Add runtime.capabilities[] to at least one agent in cortex.yaml.\n" +
        "  See cortex.yaml.example for a working configuration.\n",
    );
  }

  // cortex#237 PR-6 — review-consumer boot wiring.
  //
  // Per `docs/design-capability-dispatch-review-consumer.md` §3 + §10.1
  // PR-6: for each agent in `mergedAgents` that declares at least one
  // `code-review` / `code-review.<flavor>` capability, instantiate a
  // dedicated `ReviewConsumer` AND drive it through `start()` so it
  // actually subscribes to the JetStream `local.{org}.tasks.code-review.>`
  // pull consumer. One consumer per agent — the spec's routing is
  // single-agent (the consumer's capability filter checks the owning
  // agent's claims only; multi-agent fan-out is the runtime's namespace
  // job, not the consumer's).
  //
  // **Ordering.** Runs AFTER the capability-registry block above so an
  // operator scanning boot logs sees registrations before consumers.
  // Runs BEFORE the bus-dispatch-listener so the review path is in place
  // before the first `dispatch.task.received` envelope can arrive
  // (defensive — pilot publishes review requests on a different subject
  // namespace, but the ordering keeps the cognitive model "all
  // capability-side bring-up first, then dispatch").
  //
  // **Subscription wiring (cortex#290).** `MyelinRuntime.subscribePull`
  // captures the runtime's private `NatsLink` and threads it into a
  // `MyelinSubscriber` on the consumer's behalf. `consumer.start(...)`
  // calls that helper internally — the runtime stays the single owner of
  // the raw NATS connection lifecycle while consumers declare what they
  // want subscribed. When the runtime is disabled (no NATS configured),
  // `subscribePull` returns `null` and the consumer stays dormant; the
  // instantiation + shutdown-drain wiring still runs so the boot path
  // behaves identically whether or not the bus is up.
  //
  // **Error handling.** Each instantiate-and-start cycle is wrapped in
  // try/catch per CLAUDE.md "no empty catch blocks": a throw on one
  // agent logs to stderr and the boot continues with the rest of the
  // roster. Sibling consumers are not abandoned because one agent's
  // config (or one agent's subscriber bind) tripped.
  //
  // **Shutdown drain.** Every consumer the boot wiring creates lands in
  // the `reviewConsumers` array; the shutdown drain below calls `.stop()`
  // on each, allowing in-flight pipelines to finish per the consumer's
  // own drain contract.
  const reviewConsumers: ReviewConsumer[] = [];
  const reviewCapableAgents = mergedAgents.filter((a) => {
    const caps = a.runtime?.capabilities ?? [];
    return caps.some(
      (c) => c === "code-review" || c.startsWith("code-review."),
    );
  });
  // Stable identity inputs for the per-agent durable consumer name. Org
  // is taken from the canonical operatorId resolution (same fallback as
  // the surface-router and capability-registry boot paths). Durable name
  // convention per `docs/design-capability-dispatch-review-consumer.md`
  // §2.3: `cortex-review-consumer-{operator}-{agent}` — unique per
  // (operator, agent) pair so dev + prod instances on the same operator
  // share competing-consumer semantics and a daemon restart resumes from
  // the same JetStream offset.
  const reviewOperatorId = config.agent.operatorId ?? "default";
  // cortex#318 — include the stack segment to match the 6-segment grammar
  // `deriveSubject` produces for stack-scoped publishes (cortex#262 / IAW
  // Phase A.5 + canonical helper at `@the-metafactory/myelin/subjects`).
  // Pilot publishes to `local.{org}.{stack}.tasks.code-review.<flavor>`;
  // the consumer must subscribe to the same grammar or the wildcard
  // `>` never matches (NATS requires literal segments before the `>`).
  // Reuses `derivedStack.stack` resolved at boot (line 308) — same source
  // sage's bridge subscription already uses for `local.{org}.{stack}.>`.
  const reviewSubjectPattern = `local.${reviewOperatorId}.${derivedStack.stack}.tasks.code-review.>`;
  const reviewConfig = options.bus?.review;
  const reviewStream = reviewConfig?.stream.name ?? "CODE_REVIEW";
  const reviewStreamMaxAgeNs =
    (reviewConfig?.stream.maxAgeSeconds ?? 86_400) * 1_000_000_000;
  const reviewStreamMaxBytes =
    reviewConfig?.stream.maxBytes ?? 512 * 1024 * 1024;
  const reviewConsumerMaxDeliver = reviewConfig?.consumer.maxDeliver ?? 5;

  // cortex#338 — resolve the provisioning JSM and provision the
  // CODE_REVIEW stream up-front so the per-agent `ReviewConsumer.start`
  // calls below can bind without hitting "stream not found" against a
  // virgin broker. `reviewJsm = null` means the runtime is dormant
  // (no NATS / connect failed / `runtime.jetstreamManager()` itself
  // threw / runtime stub omits the helper) — provisioning is skipped
  // and the consumer loop stays dormant in lockstep.
  //
  // Extracted into `resolveReviewProvisioningJsm` so the JSM-
  // resolution failure path is covered by the same boot-survives-
  // provisioning-failure contract as the stream-add path. Pre-fix
  // an `await runtime.jetstreamManager()` throw bypassed the inner
  // try/catch and aborted boot (sage review on #338, round 2).
  const reviewJsm = await resolveReviewProvisioningJsm(runtime, reviewCapableAgents);

  if (reviewJsm !== null) {
    try {
      const outcome = await provisionReviewStream({
        jsm: reviewJsm,
        name: reviewStream,
        subjects: [reviewSubjectPattern],
        maxAgeNs: reviewStreamMaxAgeNs,
        maxBytes: reviewStreamMaxBytes,
      });
      if (outcome === "created") {
        console.log(
          `cortex: provisioned JetStream stream "${reviewStream}" (subjects=[${reviewSubjectPattern}])`,
        );
      } else if (outcome === "exists") {
        console.log(
          `cortex: JetStream stream "${reviewStream}" already present — binding existing config`,
        );
      }
      // config-drift-warning is already logged by the helper.
    } catch (err) {
      // A provisioning failure does NOT abort boot — siblings still
      // wire, and the per-agent `consumer.start()` below will surface
      // the binding failure via its existing try/catch + stderr line.
      // We log here so operators see provisioning was even attempted.
      process.stderr.write(
        `cortex: provisionReviewStream failed for "${reviewStream}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  for (const agent of reviewCapableAgents) {
    try {
      const caps = agent.runtime?.capabilities ?? [];
      const consumerAgent: ReviewConsumerAgent = {
        id: agent.id,
        capabilities: caps,
        ...(agent.runtime?.maxConcurrent !== undefined && {
          maxConcurrent: agent.runtime.maxConcurrent,
        }),
      };
      // cortex#327 follow-up (D1) — build the per-agent signature verifier
      // closure when this agent declares a non-empty `trust:[]` list.
      //
      // **Default-ON, fail-open posture.** Agents with `trust: []` (the
      // shape that says "I accept anything from anyone the runtime
      // delivered") get NO verifier — the gate in `ReviewConsumer.processEnvelope`
      // is a no-op, matching the pre-#329 behaviour. Agents with at least
      // one trusted peer get the verifier wired and the gate enforces.
      // This is the one-way ratchet: as operators add `trust:` entries
      // to their cortex.yaml, signature enforcement strengthens
      // automatically without any flag toggling.
      //
      // The closure captures `trustResolver`, `agent.id`, and the
      // configured operatorId — same triple the bus-peer harness
      // (`src/substrates/bus-peer/harness.ts`) supplies to
      // verifySignedByChain on its inbound path. `cryptoVerify: true`
      // engages B.1c canonical-bytes verification on top of B.1a
      // structural-trust resolution.
      //
      // Reason mapping: discriminated `ChainRejectionReason` → short
      // grep-friendly string ("empty_chain", "signer_not_trusted",
      // "crypto_verify_failed", etc.) so the structured stderr line
      // landed in #329 carries the rejection class verbatim. The full
      // myelin-side detail is logged separately by the trust resolver.
      const agentTrustList = agent.trust;
      const verifyOperatorId = reviewOperatorId;
      const signatureVerifier: SignatureVerifier | undefined =
        agentTrustList.length === 0
          ? undefined
          : async (envelope) => {
              const r = await verifySignedByChain(envelope, {
                resolver: trustResolver,
                receivingAgentId: agent.id,
                cryptoVerify: true,
                operatorId: verifyOperatorId,
              });
              if (r.valid) return { valid: true } as const;
              return { valid: false, reason: r.reason.kind } as const;
            };

      // cortex#331 Phase 1 — substrate-aware pipelineRunner selection.
      //
      // **Why this lives in cortex (not sage).** Sage went in-process at
      // sage#41 — its standalone launchd daemon and standalone NATS
      // subscribe path are retired. Cortex's review-consumer is now the
      // sole receiver for sage-owned review flavors. The cross-repo scope
      // split (sage#40 / sage#41 / cortex#331) deliberately puts
      // cortex-side wiring HERE in cortex#331, NOT in sage's Phase 1 —
      // sage stepped DOWN from owning its own bus subscription, cortex
      // stepped UP to own substrate dispatch for in-process agents. The
      // selection below is the substrate-dispatch fork that closes the
      // round-trip; the adapter itself lives in
      // `src/runner/substrate/pi-dev-runner.ts`.
      //
      // Agents that declare `runtime.substrate: "pi-dev"` get the sage
      // adapter wired in via `makePiDevPipelineRunner`. Every other agent
      // (including those with the substrate field unset, which defaults
      // to claude-code semantics) gets no `pipelineRunner` opt so the
      // ReviewConsumer falls through to the existing `runReviewPipeline`
      // → CC path (`ccSessionFactory` stays wired for that path; we do
      // NOT remove it — see the issue's "out of scope" list).
      //
      // The pi-dev runner resolves its sage binary lazily at first use
      // (see `pi-dev-runner.ts`'s lifetime note), so a missing sage on
      // boot does not crash this loop — review requests surface the
      // failure as `dispatch.task.failed` envelopes instead.
      const substrate = agent.runtime?.substrate ?? "claude-code";
      const pipelineRunner =
        substrate === "pi-dev" ? makePiDevPipelineRunner({}) : undefined;

      const consumer = new ReviewConsumer({
        agent: consumerAgent,
        source: systemEventSource,
        runtime,
        // CC session factory — spawns a real `claude` process. Mirrors the
        // default factory inside `ClaudeCodeHarness` (the harness keeps its
        // own copy private; we don't re-export to avoid the symbol leaking
        // into the public bus surface). Tests don't reach the factory
        // unless `processEnvelope` is invoked; the boot test in
        // `src/__tests__/cortex.review-consumer-boot.test.ts` only
        // exercises instantiation + subscribe. Stays wired even when a
        // non-CC pipelineRunner is selected — the consumer's type still
        // requires the factory, and the CC path remains the default
        // fallthrough for non-pi-dev substrates.
        ccSessionFactory: (opts) => new CCSession(opts),
        // PR-6 has no policy hook — that's a future PR (sovereignty /
        // compliance gate). Until then the pipeline goes straight to CC.
        promptBuilder: ({ payload }) =>
          // Minimal prompt — the real skill-aware builder lands in PR-8.
          // Echo's skill consumes `/review <owner/repo>#<pr>` style today.
          `/review ${payload.repo}#${payload.pr}`,
        ...(pipelineRunner !== undefined && { pipelineRunner }),
        ...(signatureVerifier !== undefined && { signatureVerifier }),
      });
      reviewConsumers.push(consumer);
      // Subscribe via the runtime's subscribePull helper. When the
      // runtime is disabled the helper returns null inside start() and
      // the consumer stays dormant — `started.subscribed` distinguishes
      // the two cases so the boot log can be honest (cortex#334)
      // instead of unconditionally claiming "ready".
      const durable = `cortex-review-consumer-${reviewOperatorId}-${agent.id}`;

      // cortex#338 — provision the per-agent durable consumer up-front
      // so `consumer.start()` below binds successfully against a virgin
      // broker. Reuses `reviewJsm` resolved once before this loop.
      // Idempotent — safe across restarts. Skipped when JSM isn't
      // available (runtime dormant); the subsequent `consumer.start()`
      // will then stay dormant too.
      if (reviewJsm !== null) {
        try {
          const outcome = await provisionReviewConsumer({
            jsm: reviewJsm,
            stream: reviewStream,
            durable,
            maxDeliver: reviewConsumerMaxDeliver,
          });
          if (outcome === "created") {
            console.log(
              `cortex: provisioned JetStream durable "${durable}" on stream "${reviewStream}"`,
            );
          }
        } catch (provisionErr) {
          // Don't abort — let consumer.start surface the bind failure
          // through its own error path so the operator sees the same
          // stderr shape they'd see if the consumer existed but bind
          // failed for another reason.
          process.stderr.write(
            `cortex: provisionReviewConsumer failed for "${durable}": ` +
              `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
          );
        }
      }

      const started = await consumer.start({
        pattern: reviewSubjectPattern,
        stream: reviewStream,
        durable,
      });
      const flavorSummary =
        consumer.flavors.length > 0 ? consumer.flavors.join(",") : "(none)";
      // D1 visibility: surface whether signature verification is enforced
      // on this consumer so operators can grep `signed=on/off` to confirm
      // their trust:[] config landed where they expected.
      const signedTag = signatureVerifier !== undefined ? "on" : "off";
      // cortex#331 Phase 1 — surface the dispatching substrate so
      // operators can grep `substrate=pi-dev` / `substrate=claude-code`
      // to confirm sage agents (or any future substrate) actually
      // received the substrate-aware factory. Unset substrate defaults
      // to `claude-code` in the log (matches the runtime fallthrough).
      //
      // cortex#334 — distinguish "ready" (subscription open) from
      // "DORMANT" (subscribePull returned null; G-1111 pending or
      // nats.subjects empty). The previous unconditional "ready" line
      // misled operators into chasing phantom misconfigs.
      if (started.subscribed) {
        console.log(
          `cortex: review consumer ready for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} substrate=${substrate}`,
        );
      } else {
        console.log(
          `cortex: review consumer DORMANT for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} substrate=${substrate} — cortex MyelinRuntime subscriptions disabled (G-1111 pending; tasks.code-review.* envelopes will not be claimed by this consumer)`,
        );
      }
    } catch (err) {
      // Per CLAUDE.md: log every error. A single agent's consumer crash
      // does NOT abort boot — siblings still get wired. Boot keeps the
      // consumer in `reviewConsumers[]` so shutdown drain still calls
      // `.stop()` (idempotent — handles the "never subscribed" case).
      process.stderr.write(
        `cortex: review consumer init failed for agent=${agent.id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  if (reviewConsumers.length === 0) {
    // cortex#314 — same first-install-safety promotion as the
    // capability-registry skip above. Zero code-review-capable agents
    // means inbound `tasks.code-review.>` envelopes have no consumer
    // listening; pilot's `request-review --wait` will eventually
    // time out (or, worse, silently exit 0 pre-pilot#129). Keep the
    // info-level log AND emit a stderr WARNING with the actionable
    // fix-path.
    console.log(
      "cortex: review-consumer skipped — 0 agents declare code-review capabilities",
    );
    process.stderr.write(
      "WARNING: review-consumer skipped — 0 agents declare code-review capabilities.\n" +
        "  Inbound code-review tasks have no consumer; pilot request-review will not be serviced.\n" +
        "  Add code-review.* entries to an agent's runtime.capabilities[] in cortex.yaml.\n" +
        "  See cortex.yaml.example for a working configuration.\n",
    );
  }

  // IAW Phase B.2a (refs cortex#114) — inbound peer-dispatch listener.
  // Subscribes via the runtime's onEnvelope fan-out, filters for
  // `dispatch.task.dispatched` envelopes from non-self sources, runs
  // verifySignedByChain, emits `system.bus.peer_dispatch_received`
  // visibility envelopes on valid arrivals. Listener is bound to the
  // FIRST registered agent today — multi-agent stacks may eventually
  // want one listener per agent (each receiver's `trust:` list is
  // distinct), but at this slice a single binding is sufficient for
  // the inbound visibility surface. When the registry is empty (no
  // inline agents AND no fragments — e.g. legacy bot.yaml with
  // `trust: []`), the listener is skipped entirely.
  //
  // `cryptoVerify` is hard-coded off at this slice — the structural
  // check alone is the B.1a contract and operators flip to crypto
  // verify once every trusted peer has an `nkey_pub` declared. The
  // flag is a small follow-up plumbing (cortex.yaml flag → option) once
  // the rollout window closes.
  let busDispatchListener: BusDispatchListener | undefined;
  const firstAgent = mergedAgents[0];
  if (firstAgent !== undefined) {
    busDispatchListener = new BusDispatchListener({
      runtime,
      resolver: trustResolver,
      receivingAgentId: firstAgent.id,
      operatorId: config.agent.operatorId ?? "default",
      source: systemEventSource,
    });
    busDispatchListener.start();
    console.log(
      `cortex: bus-dispatch-listener started — receivingAgentId=${firstAgent.id}`,
    );
  } else {
    console.log(
      "cortex: bus-dispatch-listener skipped — no agents in registry",
    );
  }

  // Surface router (in-process fan-out).
  // Receives `systemEventSource` so visibility-config drops produce
  // `system.access.filtered` envelopes operators can subscribe to — see
  // `evaluateVisibility()` in surface-router.ts.
  //
  // IAW Phase D.2 (refs cortex#116) — also receives `policy.federated`
  // so inbound `federated.*` envelopes get gated against the operator's
  // declared accept/deny/max_hop config before adapter fan-out. When
  // `policy.federated` is absent or `networks[]` is empty, the gate is
  // fully inert — `federated.*` envelopes pass through unchanged
  // (mirrors the C.3.1 policy-engine contract: no policy → no gating).
  // Federation enforcement is opt-in.
  const router: SurfaceRouter = createSurfaceRouter(runtime, {
    systemEventSource,
    ...(options.policy?.federated !== undefined && { federated: options.policy.federated }),
    onAdapterError: (adapterId, err) => {
      console.error(`cortex: surface adapter "${adapterId}" render error:`, err.message);
    },
  });

  // IAW Phase D.4.3 (refs cortex#116) — registry client. Opt-in:
  // instantiated only when `policy.federated.registry.url` is set
  // AND `policy.federated.networks[].peers[]` declares at least one
  // peer. When dormant, callers asking for an operator simply get
  // `undefined` — the rest of cortex never has to special-case
  // "no registry configured".
  //
  // The client populates an in-memory cache of registry-verified peer
  // pubkeys (base64 Ed25519) on a 5-minute refresh schedule. Each
  // fetched assertion is verified against the pinned registry pubkey
  // before mutating the cache; verification failures log to stderr
  // and leave the cache untouched (fail-safe).
  //
  // Phase-B caveat: the registry trust anchor is operator-supplied
  // via `policy.federated.registry.pubkey` (pinned at config time) OR
  // TOFU at boot via `GET /registry/pubkey`. The TOFU window is
  // exactly the first call against an unknown registry; operators
  // wanting zero-TOFU populate the pubkey field out-of-band. See
  // `src/common/registry/client.ts` JSDoc for the full failure-mode
  // table.
  let registryClient: RegistryClient | null = null;
  const registryConfig = options.policy?.federated?.registry;
  if (registryConfig !== undefined) {
    const peerOperatorIds = Array.from(
      new Set(
        (options.policy?.federated?.networks ?? []).flatMap((n) =>
          n.peers.map((p) => p.operator_id),
        ),
      ),
    );
    if (peerOperatorIds.length === 0) {
      console.log(
        `cortex: policy.federated.registry configured (${registryConfig.url}) but no peers declared — registry client dormant`,
      );
    } else {
      registryClient = new RegistryClient({
        url: registryConfig.url,
        ...(registryConfig.pubkey !== undefined && { pubkey: registryConfig.pubkey }),
        operatorIds: peerOperatorIds,
      });
      // Boot the client asynchronously — TOFU + initial refresh must
      // not block the rest of cortex boot. Errors inside `start()`
      // are already logged via the client's own `logError` seam.
      void registryClient.start();
      console.log(
        `cortex: registry client started (${registryConfig.url}, tracking ${peerOperatorIds.length} peer(s))`,
      );
    }
  }

  // Dispatch-handler — synchronous platform-message → CC pipeline.
  //
  // MIG-3.8 / C-104: hand the runtime + systemEventSource down so the handler
  // can publish `system.inbound.aborted` envelopes when an adapter outbound
  // (today: Discord attachment fetch) trips `TimeoutSourceError`. Both
  // fields are passed unconditionally — when the runtime is the no-op stub
  // (NATS absent), `MyelinRuntime.publish` is a no-op and emission falls
  // through silently. See `DispatchHandler.canPublishSystemEvent`.
  const dispatchHandler = new DispatchHandler({
    config,
    securityPreamble,
    configPath: expandedConfigPath,
    runtime,
    systemEventSource,
  });

  // Cloud publisher (G-401 + G-500) — opt-in via cloud-capable network.
  let cloudPublisher: CloudPublisher | null = null;
  const hasCloudNetworks = config.networks.some((n) => !!n.cloud);
  if (hasCloudNetworks) {
    const networkResolver = createNetworkResolver(config);
    cloudPublisher = new CloudPublisher({ networkResolver });
    const networkIds = config.networks.filter((n) => n.cloud).map((n) => n.id);
    console.log(`cortex: cloud publisher active (networks: ${networkIds.join(", ")})`);
    CloudPublisher.checkEndpoints(networkResolver, networkIds).catch((err: unknown) => {
      console.error("cortex: endpoint health check error:", err instanceof Error ? err.message : String(err));
    });
  } else if (config.api.mode === "cloud") {
    console.warn("cortex: api.mode is 'cloud' but no network has cloud config. Events will not be published.");
  }

  // Adapters (Discord + Mattermost).
  const adapters: PlatformAdapter[] = [];
  const adapterCleanup: (() => void)[] = [];

  // MIG-7.2e: per-instance agent lookup. When cortex.yaml supplies
  // `inlineAgents` (reused from the registry-merge block above), each
  // Discord/Mattermost adapter binds to the declared Agent (real id,
  // displayName, persona, roles, trust) instead of the
  // synthesized-from-singular fallback. Keyed by the unique platform
  // credential — `presence.discord.token` for Discord,
  // `presence.mattermost.apiToken` for Mattermost.
  const agentByDiscordToken = new Map<string, Agent>();
  const agentByMattermostApiToken = new Map<string, Agent>();
  const agentBySlackBotToken = new Map<string, Agent>();
  for (const a of mergedAgents) {
    if (a.presence.discord?.token) agentByDiscordToken.set(a.presence.discord.token, a);
    if (a.presence.mattermost?.apiToken) {
      agentByMattermostApiToken.set(a.presence.mattermost.apiToken, a);
    }
    if (a.presence.slack?.botToken) {
      agentBySlackBotToken.set(a.presence.slack.botToken, a);
    }
  }

  // cortex#98 (part B) — two-pass adapter start so peer-bot ids can be
  // resolved across adapters. Pass 1 starts each adapter with its operator-
  // explicit `trustedBotIds` set (the cross-process bridge list from
  // cortex.yaml) and registers each agent's freshly-learned bot user id in
  // the TrustResolver. Pass 2 walks each adapter's `agent.trust[]` list,
  // asks the resolver for each peer's bot id, and merges the result into
  // the adapter's allowlist via `setTrustedBotIds`. The split is required
  // because adapter A's `trust` list may reference adapter B, and B's
  // platform id is only known after B's `client.login()` resolves.
  //
  // Started Discord state carried between passes. We capture the adapter,
  // its declaring agent, and the operator-explicit set as a baseline so
  // Pass 2 can produce the merged set in one place (explicit ∪ resolved
  // peers) without re-parsing the instance.
  interface StartedDiscord {
    adapter: DiscordAdapter;
    agent: Agent;
    instance: BotConfig["discord"][number];
    instanceId: string;
    explicitTrustedBotIds: ReadonlySet<string>;
  }
  const startedDiscord: StartedDiscord[] = [];

  // v2.0.0 (cortex#297) — build engine + lookup index + principal registry
  // ONCE so the three adapter loops below share the same instances. The
  // policy block is parsed at config-load time; the factory + index
  // builders are idempotent over the same input.
  //
  // v2.0.1 (cortex#311): retired the `CORTEX_POLICY_REQUIRE_UNVERIFIED_ACK`
  // env-var gate. PolicyEngine activates whenever a `policy:` block is
  // declared (which v2.0.0's schema already enforces for boot). The
  // pre-Phase-B unverified-principal-claim trade-off is now an
  // informational boot-log notice from the dispatch-listener builder
  // below — gating it behind an env var created an M-3 split-brain where
  // adapters denied every inbound while bus dispatches bypassed auth
  // entirely (Echo PR #310 r1 finding, cortex#311).
  const adapterPolicyEngine = policyEngineFromConfig(options.policy);
  const adapterPolicyLookup = buildPlatformPrincipalIndex(options.policy);
  const adapterPolicyRegistry = buildPrincipalRegistry(options.policy);

  for (const instance of config.discord) {
    if (!instance.enabled) {
      console.log(`cortex: discord instance ${instance.instanceId ?? instance.guildId} disabled — skipping`);
      continue;
    }
    // MIG-7.2c-discord-flip: derive the instance id from the agent name plus
    // the discord guild so multi-instance bot.yaml configs (same `agent.name`,
    // multiple `discord[]` entries) still produce a unique key. Once
    // migrate-config (MIG-7.2e) emits a proper `agents[]` array the suffix
    // collapses to plain `${agent.id}-discord`.
    const instanceId = instance.instanceId ?? `${config.agent.name}-discord-${instance.guildId}`;
    // Build the `DiscordPresence` from the bot.yaml discord[i] entry.
    // Schema defaults already applied by `BotConfigSchema` at load time —
    // this is a structural mapping, not a parse.
    //
    // cortex#98 (part A): `trustedBotIds` carries the operator-explicit
    // cross-process bridge list (architecture §9.3). It MUST be threaded
    // through verbatim — the auto-population step below merges in-process
    // peers from `agent.trust[]` on top via the TrustResolver (part B).
    const presence: DiscordPresence = {
      enabled: instance.enabled,
      token: instance.token,
      guildId: instance.guildId,
      agentChannelId: instance.agentChannelId,
      logChannelId: instance.logChannelId,
      ...(instance.worklogChannelId !== undefined && { worklogChannelId: instance.worklogChannelId }),
      contextDepth: instance.contextDepth,
      enableAgentLog: instance.enableAgentLog,
      // v2.0.0 (cortex#297) — roles/defaultRole/dm retired.
      ...(instance.operatorRoleId !== undefined && { operatorRoleId: instance.operatorRoleId }),
      trustedBotIds: instance.trustedBotIds,
      surfaceSubjects: instance.surfaceSubjects,
      ...(instance.surfaceFallbackChannelId !== undefined && {
        surfaceFallbackChannelId: instance.surfaceFallbackChannelId,
      }),
    };
    // MIG-7.2e: prefer the cortex-shape `inlineAgents` lookup when present —
    // per-instance identity (real id, persona, roles, trust) flows from
    // cortex.yaml. Falls back to the transitional synthesis-from-singular
    // for legacy bot.yaml input (no inlineAgents).
    const matchedAgent = agentByDiscordToken.get(instance.token);
    const agent: Agent = matchedAgent ?? {
      id: config.agent.name,
      displayName: config.agent.displayName,
      persona: "(deferred-mig-7.2e)",
      trust: [],
      presence: { discord: presence },
    };
    try {
      // cortex#84: build the trusted-peer-bot allowlist once per adapter
      // start so the messageCreate hot path doesn't re-allocate per event.
      // Empty list → adapter falls back to "drop every bot author"
      // (pre-cortex#84 behaviour). Pass 2 below merges resolver-derived
      // in-process peer ids on top via `adapter.setTrustedBotIds`.
      const explicitTrustedBotIds = new Set<string>(instance.trustedBotIds);
      const adapter = new DiscordAdapter(
        agent,
        presence,
        {
          instanceId,
          operator: {
            ...(options.operator?.discordId !== undefined && { discordId: options.operator.discordId }),
          },
          runtime,
          systemEventSource,
          trustedBotIds: explicitTrustedBotIds,
          ...(adapterPolicyEngine !== undefined && { policyEngine: adapterPolicyEngine }),
          ...(adapterPolicyLookup !== undefined && { policyLookup: adapterPolicyLookup }),
          ...(adapterPolicyRegistry !== undefined && { policyRegistry: adapterPolicyRegistry }),
          // cortex#205: plumb the operator's configured subject patterns
          // through to the surface-router. Pass the array verbatim — `[]`
          // included — so the adapter's one-shot empty-array warning at
          // `discord/index.ts:178` actually fires for the "operator
          // forgot / typoed surfaceSubjects" case the schema docstrings
          // promise. A conditional short-circuit here would convert
          // `[]` → `undefined` on the infra side and silently disable
          // the diagnostic. Setting e.g.
          // `["local.metafactory.tasks.code-review.>"]` wires pilot's
          // IoAW review-requests into the Discord render path.
          surfaceSubjects: presence.surfaceSubjects,
          // cortex#207: fallback channel for envelopes that don't carry
          // their own routing. Spread-conditionally because the field
          // is optional and `renderEnvelope` discriminates on its
          // presence (undefined → drop-with-warning, configured → post).
          ...(presence.surfaceFallbackChannelId !== undefined && {
            surfaceFallbackChannelId: presence.surfaceFallbackChannelId,
          }),
        },
      );
      // Register the adapter's surface-router face. Empty `surfaceSubjects`
      // makes this a no-op match; harmless to register either way.
      router.register(adapter.surfaceConfig);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg));
      adapters.push(adapter);

      // cortex#98 (part B) — Pass 1 step c: register this adapter's bot
      // user id in the trust resolver so OTHER adapters' Pass 2 lookups
      // can resolve `agent.trust = [<this-agent>]` to this bot id. The
      // matched-agent lookup above already gave us this agent's
      // declarative id; pair it with `client.user.id` (available
      // post-login via `getPlatformUserId`).
      //
      // The register call is best-effort: if the agent id isn't in the
      // registry (legacy bot.yaml with synthesized-from-singular agent
      // — `mergedAgents` is empty, so the registry has no entries),
      // skip silently. Pass 2 will still produce a correctly-sized
      // empty resolved-peer set for those configs.
      if (agentRegistry.tryGetById(agent.id)) {
        try {
          const botUserId = await adapter.getPlatformUserId();
          trustResolver.register("discord", botUserId, agent.id);
        } catch (err) {
          // Register failures (PlatformIdAlreadyRegisteredError on a
          // misconfigured token, or getPlatformUserId throwing if the
          // adapter's client.user is unexpectedly null) should not abort
          // startup — log and continue so other adapters can come up.
          console.error(
            `cortex: trust-resolver register for "${agent.id}" failed (non-fatal):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      startedDiscord.push({
        adapter,
        agent,
        instance,
        instanceId,
        explicitTrustedBotIds,
      });
    } catch (err) {
      console.error(`cortex: discord adapter ${instanceId} failed to start:`, err instanceof Error ? err.message : err);
    }
  }

  // cortex#98 (part B) — Pass 2: merge resolver-derived in-process peer
  // bot ids on top of each adapter's operator-explicit set, and log the
  // final allowlist size per adapter. Peers absent from the resolver
  // (cross-process — they live in a different cortex deployment) are
  // silently skipped; the operator-explicit field in
  // `presence.discord.trustedBotIds` covers those.
  //
  // cortex#108 item 1 — closing the Pass-1→Pass-2 TOCTOU window: after
  // `setTrustedBotIds(merged)` populates the allowlist, we IMMEDIATELY
  // call `attachInboundDispatch()` so the `messageCreate` listener is
  // registered against the post-merge allowlist. Order is load-bearing:
  // setTrustedBotIds MUST complete before attachInboundDispatch, so the
  // first delivered message sees the correct allowlist. Echo's round-1
  // review of cortex#105 flagged the start()-attaches-listener-pre-merge
  // shape as a [major/security] silent-drop bug for bot-to-bot traffic
  // landing in the startup window.
  for (const { adapter, agent, instance, instanceId, explicitTrustedBotIds } of startedDiscord) {
    const merged = new Set<string>(explicitTrustedBotIds);
    const resolvedPeers: string[] = [];
    const skippedPeers: string[] = [];
    for (const peerAgentId of agent.trust) {
      if (peerAgentId === agent.id) continue; // self-trust handled by adapter's self-loop guard
      const peerBotId = trustResolver.lookupPlatformIdByAgent("discord", peerAgentId);
      if (peerBotId !== undefined) {
        merged.add(peerBotId);
        resolvedPeers.push(peerAgentId);
      } else {
        skippedPeers.push(peerAgentId);
      }
    }
    adapter.setTrustedBotIds(merged);
    // cortex#108 item 1: attach the messageCreate listener now — AFTER the
    // merged allowlist is in place. discord.js holds inbound events at the
    // WebSocket layer until a JS listener is attached, so no startup-window
    // bot-to-bot traffic is dropped.
    adapter.attachInboundDispatch();
    console.log(
      `cortex: discord adapter started (instance: ${instanceId}, guild: ${instance.guildId}, ` +
        `trustedBotIds: ${adapter.trustedBotIdCount}` +
        (resolvedPeers.length > 0 ? ` [resolver: ${resolvedPeers.join(", ")}]` : "") +
        (skippedPeers.length > 0 ? ` [cross-process: ${skippedPeers.join(", ")}]` : "") +
        `)`,
    );

    // Outbound JSONL → #agent-log + worklog (opt-in). Dashboard + cloud
    // delivery handled by the HTTP path (H-004). Moved into Pass 2 so the
    // log-line ordering stays "adapter started → outbound poller wired";
    // poller setup is decoupled from the trust-resolver merge.
    if (!options.disableOutboundPoller && (instance.enableAgentLog || instance.worklogChannelId)) {
      const cleanup = setupOutboundLog(adapter, instance, config, router, systemEventSource);
      if (cleanup) adapterCleanup.push(cleanup);
    }
  }

  if (config.discord.length === 0) {
    console.log("cortex: no discord instances configured");
  }

  for (const instance of config.mattermost) {
    if (!instance.enabled) continue;
    if (!instance.apiUrl || !instance.apiToken) {
      console.error(`cortex: mattermost instance ${instance.instanceId ?? "unnamed"} missing apiUrl/apiToken — skipping`);
      continue;
    }
    // MIG-7.2c-mattermost: same instanceId-derivation strategy as Discord —
    // suffix the legacy fallback with `mattermost-${index}` when
    // botConfig.mattermost[] has multiple entries per agent.name. Collapses
    // to plain `${agent.id}-mattermost` at MIG-7.2e.
    const mmIndex = config.mattermost.indexOf(instance);
    const instanceId = instance.instanceId ?? (config.mattermost.length > 1
      ? `${config.agent.name}-mattermost-${mmIndex}`
      : `${config.agent.name}-mattermost`);
    // Build the `MattermostPresence` from the bot.yaml mattermost[i] entry.
    const presence: MattermostPresence = {
      enabled: instance.enabled,
      callbackPort: instance.callbackPort,
      apiUrl: instance.apiUrl,
      apiToken: instance.apiToken,
      ...(instance.triggerWord !== undefined && { triggerWord: instance.triggerWord }),
      ...(instance.webhookUrl !== undefined && { webhookUrl: instance.webhookUrl }),
      ...(instance.webhookToken !== undefined && { webhookToken: instance.webhookToken }),
      channels: instance.channels,
      pollIntervalMs: instance.pollIntervalMs,
      allowedUsers: instance.allowedUsers,
      // v2.0.0 (cortex#297) — roles/defaultRole retired.
    };
    // MIG-7.2e: prefer the cortex-shape `inlineAgents` lookup when present —
    // same pattern as the Discord block above. apiToken is the cleanest
    // unique key on Mattermost presence.
    const matchedAgent = instance.apiToken
      ? agentByMattermostApiToken.get(instance.apiToken)
      : undefined;
    const agent: Agent = matchedAgent ?? {
      id: config.agent.name,
      displayName: config.agent.displayName,
      persona: "(deferred-mig-7.2e)",
      trust: [],
      presence: { mattermost: presence },
    };
    try {
      const adapter = new MattermostAdapter(
        agent,
        presence,
        {
          instanceId,
          operator: {
            ...(options.operator?.mattermostId !== undefined && { mattermostId: options.operator.mattermostId }),
          },
          ...(adapterPolicyEngine !== undefined && { policyEngine: adapterPolicyEngine }),
          ...(adapterPolicyLookup !== undefined && { policyLookup: adapterPolicyLookup }),
          ...(adapterPolicyRegistry !== undefined && { policyRegistry: adapterPolicyRegistry }),
        },
      );
      router.register(adapter.surfaceConfig);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg));
      adapters.push(adapter);
      console.log(`cortex: mattermost adapter started (instance: ${instanceId}, ${instance.channels.length} channel(s))`);
    } catch (err) {
      console.error(`cortex: mattermost adapter ${instanceId} failed to start:`, err instanceof Error ? err.message : err);
    }
  }

  // F-slack: Slack adapter boot — sibling to Discord + Mattermost above.
  // Same shape: iterate `config.slack` (synthesized from `agents[].presence.slack`
  // by `flattenSlackPresences` in the loader), build a `SlackPresence`, look up
  // the declaring agent by bot token, instantiate the adapter, register its
  // surface-router face, and start it. Errors during start are logged
  // per-instance so one bad workspace doesn't block the rest of the boot.
  //
  // cortex#235 r1#7 — two-pass boot, mirror of the Discord pattern above.
  // Pass 1 starts each adapter with its operator-explicit trustedBotIds
  // set + registers the adapter's bot user id in the TrustResolver.
  // Pass 2 walks each adapter's `agent.trust[]` list, resolves peer
  // agent ids to in-process Slack user ids via the resolver, merges
  // those into the adapter's allowlist via `setTrustedBotIds`, and
  // calls `attachInboundDispatch` to drain any pre-merge queued events
  // (Slack's analogue to discord.js's gateway-buffered events).
  interface StartedSlack {
    adapter: SlackAdapter;
    agent: Agent;
    instance: BotConfig["slack"][number];
    instanceId: string;
    explicitTrustedBotIds: ReadonlySet<string>;
  }
  const startedSlack: StartedSlack[] = [];

  for (const instance of config.slack) {
    if (!instance.enabled) {
      console.log(`cortex: slack instance ${instance.instanceId ?? instance.workspaceId} disabled — skipping`);
      continue;
    }
    const slackIndex = config.slack.indexOf(instance);
    const instanceId = instance.instanceId ?? (config.slack.length > 1
      ? `${config.agent.name}-slack-${slackIndex}`
      : `${config.agent.name}-slack`);
    // Build the `SlackPresence` from the legacy `SlackInstance` shape.
    // Schema defaults have already been applied by `BotConfigSchema` —
    // this is a structural map, not a parse.
    const presence: SlackPresence = {
      enabled: instance.enabled,
      botToken: instance.botToken,
      appToken: instance.appToken,
      workspaceId: instance.workspaceId,
      channels: instance.channels,
      allowedUserIds: instance.allowedUserIds,
      trustedBotIds: instance.trustedBotIds,
      // v2.0.0 (cortex#297) — roles/defaultRole retired.
      surfaceSubjects: instance.surfaceSubjects,
      ...(instance.surfaceFallbackChannelId !== undefined && {
        surfaceFallbackChannelId: instance.surfaceFallbackChannelId,
      }),
    };
    const matchedAgent = agentBySlackBotToken.get(instance.botToken);
    const agent: Agent = matchedAgent ?? {
      id: config.agent.name,
      displayName: config.agent.displayName,
      persona: "(deferred-mig-7.2e)",
      trust: [],
      presence: { slack: presence },
    };
    try {
      const adapter = new SlackAdapter(
        agent,
        presence,
        {
          instanceId,
          operator: {
            ...(options.operator?.slackId !== undefined && { slackId: options.operator.slackId }),
          },
          ...(adapterPolicyEngine !== undefined && { policyEngine: adapterPolicyEngine }),
          ...(adapterPolicyLookup !== undefined && { policyLookup: adapterPolicyLookup }),
          ...(adapterPolicyRegistry !== undefined && { policyRegistry: adapterPolicyRegistry }),
          // cortex#235 r1#4 — wire runtime + source so the adapter
          // can emit `system.adapter.{disconnected,recovered}` on
          // Socket Mode lifecycle transitions. Same pattern as the
          // Discord adapter above.
          runtime,
          systemEventSource,
          surfaceSubjects: presence.surfaceSubjects,
          ...(presence.surfaceFallbackChannelId !== undefined && {
            surfaceFallbackChannelId: presence.surfaceFallbackChannelId,
          }),
          trustedBotIds: new Set(instance.trustedBotIds),
        },
      );
      router.register(adapter.surfaceConfig);
      // Pass 1: open Socket Mode but do NOT dispatch inbound events
      // yet. Events arriving here queue in the adapter's
      // `pendingMessages` until Pass 2 calls
      // `attachInboundDispatch()`. This is the Slack equivalent of
      // discord.js's buffered-events-before-listener pattern.
      const explicitTrustedBotIds: ReadonlySet<string> = new Set(instance.trustedBotIds);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg));
      adapters.push(adapter);
      // Best-effort trust-resolver registration matches the Discord pattern.
      if (agentRegistry.tryGetById(agent.id)) {
        try {
          const botUserId = await adapter.getPlatformUserId();
          trustResolver.register("slack", botUserId, agent.id);
        } catch (err) {
          console.error(
            `cortex: trust-resolver register for "${agent.id}" (slack) failed (non-fatal):`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      startedSlack.push({
        adapter,
        agent,
        instance,
        instanceId,
        explicitTrustedBotIds,
      });
    } catch (err) {
      console.error(`cortex: slack adapter ${instanceId} failed to start:`, err instanceof Error ? err.message : err);
    }
  }

  // cortex#235 r1#7 — Pass 2: merge resolver-derived in-process peer
  // bot ids on top of each adapter's operator-explicit set, log the
  // final allowlist size, then attachInboundDispatch() to drain
  // queued events through the merged allowlist. Order is
  // load-bearing: setTrustedBotIds MUST complete before
  // attachInboundDispatch, so queued events see the post-merge set.
  for (const { adapter, agent, instance, instanceId, explicitTrustedBotIds } of startedSlack) {
    const merged = new Set<string>(explicitTrustedBotIds);
    const resolvedPeers: string[] = [];
    const skippedPeers: string[] = [];
    for (const peerAgentId of agent.trust) {
      if (peerAgentId === agent.id) continue; // self-loop guard owns this case
      const peerBotId = trustResolver.lookupPlatformIdByAgent("slack", peerAgentId);
      if (peerBotId !== undefined) {
        merged.add(peerBotId);
        resolvedPeers.push(peerAgentId);
      } else {
        skippedPeers.push(peerAgentId);
      }
    }
    adapter.setTrustedBotIds(merged);
    adapter.attachInboundDispatch();
    console.log(
      `cortex: slack adapter started (instance: ${instanceId}, workspace: ${instance.workspaceId}, ${instance.channels.length} channel(s), ` +
        `trustedBotIds: ${adapter.trustedBotIdCount}` +
        (resolvedPeers.length > 0 ? ` [resolver: ${resolvedPeers.join(", ")}]` : "") +
        (skippedPeers.length > 0 ? ` [cross-process: ${skippedPeers.join(", ")}]` : "") +
        `)`,
    );
  }

  if (config.slack.length === 0) {
    console.log("cortex: no slack instances configured");
  }

  // MIG-7.2d: non-agent-bound renderers (dashboard, pagerduty, …).
  // Per architecture §9.2 these are activity-centric sinks that subscribe
  // to a slice of the bus and project envelopes into a UI / pager / log
  // stream. The G-1111 §4.6 fail-safe rule requires ≥2 distinct platform
  // classes covering `local.{org}.system.>` so an operational alert
  // reliably reaches the operator even if one sink is the thing that
  // broke. Renderers never publish on the bus (architecture §9.3).
  // cortex#269 — substitute `{org}` AND `{stack}` in renderer subscribe
  // patterns so they resolve against the same canonical shape that
  // `MyelinRuntime` already substitutes for `nats.subjects`. Without
  // this, an operator-written `local.{org}.{stack}.system.>` pattern
  // never matches an actual envelope's wire subject. The `{stack}.`
  // placeholder includes the trailing dot so stack-less deployments
  // collapse cleanly to `local.{org}.system.>`.
  //
  // cortex#279 cycle 2 — extracted to a shared helper so renderer- and
  // runtime-side substitution can't drift. The stack-less branch
  // (`{stack}.` → empty) mirrors `MyelinRuntime.publish`'s same-named
  // helper, satisfying Sage's "renderer stack-less collapse missing"
  // finding even though `derivedStack.stack` is currently always
  // defined in production. Symmetric logic keeps future refactors
  // honest if the boot ever passes `undefined`.
  const subjectPlaceholderSubstituter = makeSubjectPlaceholderSubstituter({
    org: config.agent.operatorId ?? "default",
    stack: options.stack !== undefined ? derivedStack.stack : undefined,
  });

  const renderers: Renderer[] = [];
  for (const raw of config.renderers ?? []) {
    // BotConfig types renderers as z.unknown() so legacy bot.yaml loads
    // without breakage (the canonical shape lives on cortex-config's
    // RendererSchema). Parse each entry strictly here — a typo fails fast
    // with a Zod error rather than surfacing as a runtime cast failure
    // inside the factory.
    const parseResult = RendererSchema.safeParse(raw);
    if (!parseResult.success) {
      console.error(
        `cortex: renderer config rejected by schema:`,
        parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
      continue;
    }
    const rendererConfig = {
      ...parseResult.data,
      subscribe: subjectPlaceholderSubstituter(parseResult.data.subscribe),
    };
    try {
      const renderer = createRenderer(rendererConfig);
      await renderer.start();
      router.register(renderer.surfaceConfig);
      renderers.push(renderer);
      console.log(`cortex: ${rendererConfig.kind} renderer started (id: ${renderer.id})`);
    } catch (err) {
      // Renderer construction can throw (UnimplementedRendererKindError)
      // or `start()` can fail. Per the G-1111 fail-safe rule, ONE broken
      // renderer must not prevent the others from coming up — log + skip.
      console.error(
        `cortex: ${rendererConfig.kind} renderer failed to start:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // IAW Phase C.3.1 — build the PolicyEngine from the optional
  // `policy:` block on cortex.yaml. `policyEngineFromConfig` returns
  // `undefined` when no block was declared or it has no principals;
  // the dispatch-listener falls back to the legacy unauthenticated
  // path in that case (C.2b removes the legacy path).
  //
  // v2.0.0 (cortex#297): the schema requires a `policy:` block at boot.
  // PolicyEngine activates unconditionally when at least one principal
  // is declared (`policyEngineFromConfig` returns undefined for an empty
  // `policy.principals[]` — the M-1 silent-degradation case captured in
  // the warning below).
  //
  // v2.0.1 (cortex#311): retired the `CORTEX_POLICY_REQUIRE_UNVERIFIED_ACK`
  // env-var gate that had been Echo's cortex#220 round-1 safeguard against
  // pre-Phase-B (cortex#114) unverified `signed_by[0].principal` claims.
  //
  // v2.0.2 (cortex#320): wired `verifySignedByChain` into the runner
  // dispatch-listener so inbound envelopes are now chain-verified
  // before principal resolution — structural trust against the
  // receiving agent's `trust:` list AND ed25519 signature verification
  // over the JCS-canonical envelope bytes (`cryptoVerify: true` by
  // default). Empty chains (adapter-originated dispatches) are
  // accepted and fall through to the policy gate; signed chains must
  // verify against the operator's NKey roster. The pre-Phase-B
  // authorization-without-authentication gap is closed.
  if (options.policy?.principals.length === 0) {
    console.warn(
      `cortex: policy: block declared with empty principals[] — no authorisation gate engages; the dispatch-listener stays on the legacy path.`,
    );
  }
  const policyEngine = policyEngineFromConfig(options.policy);
  if (policyEngine !== undefined) {
    console.log(
      `cortex: policy-engine active — principals=${policyEngine.principalCount} roles=${policyEngine.roleCount} (signed_by chain verified; empty chains accepted for adapter-originated dispatches)`,
    );
  }

  // Dispatch-listener — bus envelope → CC spawn.
  //
  // v2.0.2 (cortex#320): also receives `trustResolver` + `receivingAgentId`
  // + `operatorId` so the listener can chain-verify every inbound
  // envelope. Mirrors the `BusDispatchListener` wiring above
  // (`firstAgent.id` + `config.agent.operatorId`). `cryptoVerify`
  // defaults to `true` in `createDispatchListener`; explicit here for
  // operator clarity.
  const dispatchListener: DispatchListener = createDispatchListener({
    runtime,
    router,
    source: systemEventSource,
    ...(policyEngine !== undefined && { policyEngine }),
    trustResolver,
    cryptoVerify: true,
    operatorId: config.agent.operatorId ?? "default",
    ...(firstAgent !== undefined && { receivingAgentId: firstAgent.id }),
  });
  await dispatchListener.start();

  // Start router AFTER all surfaces register so the first envelope
  // (which may arrive synchronously after `runtime.onEnvelope`) fans
  // out to every registered adapter.
  await router.start();

  // Config watcher (hot-reload for safe fields).
  let configWatcher: ConfigWatcher | null = null;
  if (
    !options.disableConfigWatcher
    && options.configPath
    && existsSync(expandedConfigPath)
  ) {
    configWatcher = new ConfigWatcher(expandedConfigPath, config, (event) => {
      // cortex#237: capability-registry re-publish lands here once
      // AgentsDirectoryWatcher is wired — see boot block ~line 540 for
      // rationale (BotConfig hot-reload's SAFE_FIELDS doesn't include
      // capabilities; mergedAgents isn't re-built).
      dispatchHandler.updateConfig(event.config, expandedConfigPath);
      for (const adapter of adapters) adapter.updateConfig?.(event.config);
      if (cloudPublisher) {
        cloudPublisher.updateResolver(createNetworkResolver(event.config));
      }
      if (event.applied.length > 0) {
        console.log(`cortex: config reloaded — applied ${event.applied.length} change(s)`);
      }
      if (event.requiresRestart.length > 0) {
        console.warn(`cortex: ${event.requiresRestart.length} field(s) require restart:`, event.requiresRestart.join(", "));
      }
    });
    configWatcher.start();
  }

  // Dashboard API + usage monitor (G-201 / G-206) — opt-in.
  let dashboardApi: { stop?: () => void } | null = null;
  let usageMonitor: UsageMonitor | null = null;
  if (config.api.enabled && !options.disableDashboard) {
    try {
      ({ api: dashboardApi, usageMonitor } = await setupDashboard(config, dispatchHandler, cloudPublisher));
    } catch (err) {
      console.error("cortex: dashboard API startup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // MIG-5.6 (C-106): GitHub webhook receiver — opt-in via `github.receiver.enabled`
  // AND a non-empty `github.webhookSecret`. Publishes `local.{org}.github.{event}.{action}`
  // envelopes via `runtime.publish`; that path is a no-op when NATS isn't configured
  // (see `myelin/runtime.ts`), so this block stays safe to run even without NATS.
  let githubReceiver: GithubWebhookReceiverHandle | null = null;
  if (
    !options.disableGithubReceiver
    && config.github.receiver.enabled
    && config.github.webhookSecret.length > 0
  ) {
    try {
      githubReceiver = startGithubWebhookReceiver({
        secret: config.github.webhookSecret,
        port: config.github.receiver.port,
        hostname: config.github.receiver.hostname,
        source: systemEventSource,
        publish: (env) => runtime.publish(env),
      });
    } catch (err) {
      console.error(
        "cortex: github webhook receiver startup error (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  } else if (config.github.receiver.enabled && !config.github.webhookSecret) {
    console.warn(
      "cortex: github.receiver.enabled is true but github.webhookSecret is empty — receiver not started",
    );
  }

  // Shutdown — reverse-order; capped at SHUTDOWN_TIMEOUT_MS.
  //
  // Echo round-1 N2 — abandoned-set tracking: each drain step is named
  // and pre-registered in `pending` BEFORE the loop runs. Steps remove
  // themselves on completion. If the timeout fires first, whatever
  // remains in `pending` is the abandoned set:
  //   - the slow/hanging step itself (if any), and
  //   - every subsequent step that never got its turn (drain is sequential
  //     by design — a hung step also blocks its siblings).
  // The handle exposes `lastShutdownAbandoned` so the CLI can exit 1
  // (visible to launchd / operators) when shutdown was unclean.
  let shuttingDown = false;
  let lastShutdownAbandoned: string[] = [];
  const SHUTDOWN_TIMEOUT_MS = options.shutdownTimeoutMs ?? 15_000;

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\ncortex: shutting down...");

    // Named slots in shutdown order. Pre-register everything; each step
    // removes its name on completion so the leftover after the race is
    // the abandoned set.
    const pending = new Set<string>();
    const adapterStopNames = adapters.map((a) => `adapter ${a.instanceId} stop`);
    const rendererStopNames = renderers.map((r) => `renderer ${r.id} stop`);
    const allSlots: string[] = [
      "config-watcher stop",
      "usage-monitor stop",
      "dashboard stop",
      "github webhook receiver stop",
      ...adapterCleanup.map((_, i) => `outbound poller stop[${i}]`),
      ...reviewConsumers.map((c, i) => `review-consumer stop[${i}] (agent=${c.agent.id})`),
      "dispatch-listener stop",
      "surface-router stop",
      "dispatch-handler shutdown",
      ...adapterStopNames,
      ...rendererStopNames,
      "cloud publisher close",
      "registry client stop",
      "runtime stop",
    ];
    for (const slot of allSlots) pending.add(slot);

    const completeSync = (slot: string, fn: () => void): void => {
      try { fn(); } catch (err) {
        console.error(`cortex: ${slot} error:`, err instanceof Error ? err.message : err);
      } finally {
        pending.delete(slot);
      }
    };
    const completeAsync = async (slot: string, p: Promise<unknown> | undefined): Promise<void> => {
      try { if (p) await p; } catch (err) {
        console.error(`cortex: ${slot} error:`, err instanceof Error ? err.message : err);
      } finally {
        pending.delete(slot);
      }
    };

    const drain = async (): Promise<void> => {
      completeSync("config-watcher stop", () => configWatcher?.stop());
      completeSync("usage-monitor stop", () => usageMonitor?.stop());
      completeSync("dashboard stop", () => dashboardApi?.stop?.());
      completeSync("github webhook receiver stop", () => githubReceiver?.stop());
      for (let i = 0; i < adapterCleanup.length; i++) {
        const cleanup = adapterCleanup[i];
        if (cleanup) completeSync(`outbound poller stop[${i}]`, cleanup);
      }
      // cortex#237 PR-6 — drain review consumers before the dispatch
      // listener so any in-flight CC review pipelines get a chance to
      // publish their terminal envelope (verdict / failed) before the
      // runtime closes. `ReviewConsumer.stop()` is idempotent and awaits
      // the in-flight set per its own drain contract.
      for (let i = 0; i < reviewConsumers.length; i++) {
        const consumer = reviewConsumers[i];
        if (consumer) {
          await completeAsync(
            `review-consumer stop[${i}] (agent=${consumer.agent.id})`,
            consumer.stop(),
          );
        }
      }
      await completeAsync("dispatch-listener stop", dispatchListener.stop());
      // IAW B.2a — bus-dispatch-listener drain runs after the dispatch
      // listener (which feeds dispatch-handler) but before the
      // surface-router stop. The listener's `stop()` awaits its
      // in-flight verify chain so late stderr / publish side-effects
      // don't land after the runtime closes.
      if (busDispatchListener !== undefined) {
        await completeAsync(
          "bus-dispatch-listener stop",
          busDispatchListener.stop(),
        );
      }
      await completeAsync("surface-router stop", router.stop());
      await completeAsync("dispatch-handler shutdown", dispatchHandler.shutdown());
      for (let i = 0; i < adapters.length; i++) {
        const adapter = adapters[i];
        const name = adapterStopNames[i];
        if (adapter && name) await completeAsync(name, adapter.stop());
      }
      for (let i = 0; i < renderers.length; i++) {
        const renderer = renderers[i];
        const name = rendererStopNames[i];
        if (renderer && name) await completeAsync(name, renderer.stop());
      }
      await completeAsync("cloud publisher close", cloudPublisher?.close());
      completeSync("registry client stop", () => registryClient?.stop());
      await completeAsync("runtime stop", runtime.stop());
    };

    let timeoutFired = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timeoutFired = true;
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });
    await Promise.race([drain(), timeout]);

    // TS narrows `timeoutFired` and `timeoutHandle` to their initial values
    // because the only assignments happen inside Promise constructor
    // callbacks. The runtime updates are real; suppress the rule.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (timeoutFired) {
      lastShutdownAbandoned = Array.from(pending);
      console.warn(
        `cortex: shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — abandoned: ${lastShutdownAbandoned.join(", ")}`,
      );
    } else {
      lastShutdownAbandoned = [];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  return {
    stop,
    get lastShutdownAbandoned() {
      return lastShutdownAbandoned;
    },
    get agentRegistry() {
      return agentRegistry;
    },
    get registryClient() {
      return registryClient;
    },
  };
}

/**
 * G-201 / G-206 dashboard wiring. Dynamic import: surface/mc uses bun-only
 * globals tsc can't see, so we keep this off the type-check path. Tests
 * pass `disableDashboard` and never enter here.
 *
 * The `await import("./surface/mc/api/index" as string)` deliberately
 * sidesteps TS module resolution to keep the bun-only surface out of
 * `tsc --noEmit`. Every downstream interaction with `DashboardApi` is
 * therefore `any`-typed at lint time, even though the runtime contract is
 * well-defined. Suppressing the unsafe-* family inside this function is
 * the boundary; production callers see the typed return signature.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */
/**
 * cortex#338 — resolve the JetStreamManager-shaped provisioning
 * capability needed by the review-stream + per-agent durable boot
 * wiring. Returns `null` when the runtime is dormant (no NATS / connect
 * failed / runtime stub omits the helper / the JSM resolution itself
 * throws). Logging the resolution failure here keeps the boot path
 * survives-provisioning-failure contract intact — the inner
 * `provisionReviewStream` + `provisionReviewConsumer` try/catches alone
 * can't catch a throw from `runtime.jetstreamManager()` itself.
 *
 * Extracted from `startCortex` so the resolution surface stays a single
 * place to read on review and a single place to test going forward
 * (per sage review on #338 round 2 — Maintainability).
 */
async function resolveReviewProvisioningJsm(
  runtime: MyelinRuntime,
  reviewCapableAgents: readonly Agent[],
): Promise<import("./bus/jetstream/types").ProvisionJsm | null> {
  if (reviewCapableAgents.length === 0 || !runtime.jetstreamManager) {
    return null;
  }
  try {
    return await runtime.jetstreamManager();
  } catch (err) {
    process.stderr.write(
      `cortex: jetstreamManager() resolution failed — review provisioning skipped: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

async function setupDashboard(
  config: BotConfig,
  dispatchHandler: DispatchHandler,
  cloudPublisher: CloudPublisher | null,
): Promise<{ api: { stop?: () => void }; usageMonitor: UsageMonitor }> {
  const { DashboardApi } = await import("./surface/mc/api/index" as string);
  const dbPath = join(STATE_DIR, "dashboard.db");
  const cortexRoot = join(dirname(import.meta.dir), ".");
  const dashboardDir = join(cortexRoot, "dist", "dashboard");
  const api = new DashboardApi({
    port: config.api.port,
    corsOrigin: config.api.corsOrigin,
    dbPath,
    github: { ...config.github, repos: getAllRepos(config) },
    apiMode: config.api.mode,
    operatorId: config.agent.operatorId ?? config.agent.name,
    operatorName: config.agent.operatorName ?? config.agent.operatorId ?? config.agent.displayName,
    dashboardDir,
  });
  console.log(`cortex: dashboard DB at ${dbPath}`);

  const publishedDir = config.paths.publishedEventsDir.replace(/^~/, process.env.HOME ?? "~");
  const replayed = api.getState().rehydrate(publishedDir);
  if (replayed > 0) console.log(`cortex: rehydrated dashboard with ${replayed} events from disk`);
  api.start();

  const cloudNetworks = config.networks.filter((n) => n.cloud);
  if (cloudNetworks.length > 0) {
    runStartupCloudSync(cloudNetworks, api).catch((err: unknown) => {
      console.error("cortex: cloud sync error:", err instanceof Error ? err.message : String(err));
    });
  } else {
    api.runStartupSync();
  }
  if (cloudPublisher) {
    api.setCloudPublisher((event: unknown) => {
      cloudPublisher.publish(event as never);
    });
  }

  const usageMonitor = new UsageMonitor((usage, snapshot) => {
    api.getState().setAccountUsage(usage);
    api.getDb()?.insertUsageSnapshot(snapshot);
    api.notifyStateChanged();
  });
  api.setUsageMonitor(usageMonitor);
  usageMonitor.start();

  dispatchHandler.on("session-usage", (sessionId: string, usage: UsageStats) => {
    const changed = api.getState().updateSessionUsage(sessionId, usage);
    if (changed) api.notifyStateChanged();
  });
  return { api, usageMonitor };
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion */

/** Subscribe a Discord adapter to the published-events JSONL stream so legacy
 *  `#agent-log` and per-task worklog threads keep working. Mirrors grove-bot's
 *  `setupOutboundLog`. The dispatch.task.* projection has migrated to
 *  `worklog-manager.surfaceConfig` (router-driven); this function runs the
 *  legacy direct-call path while MIG-7.2d Renderer cutover is pending. */
function setupOutboundLog(
  discordAdapter: DiscordAdapter,
  instance: import("./common/types/config").DiscordInstance,
  config: BotConfig,
  router: SurfaceRouter,
  systemEventSource: SystemEventSource,
): (() => void) | null {
  const eventsDir = config.paths.publishedEventsDir.replace(/^~/, process.env.HOME ?? "~");
  const client = discordAdapter.getClient();
  if (!client) {
    console.log("cortex: discord client not available for outbound log");
    return null;
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // discord.js v15 prep — see comment in adapters/discord/client.ts.
  client.on("clientReady", () => {
    if (!existsSync(eventsDir)) {
      console.log(`cortex: published events dir not found (${eventsDir}), skipping outbound`);
      return;
    }

    const reader = new JsonlReader();
    reader.skipAllToEnd(eventsDir);
    const logChannelId = instance.logChannelId;
    const guildId = instance.guildId;
    const postedEventIds = new Set<string>();

    let worklog: WorklogManager | null = null;
    if (instance.worklogChannelId) {
      worklog = new WorklogManager(client, instance.worklogChannelId);
      console.log(`cortex: worklog enabled → channel ${instance.worklogChannelId}`);
      // Register the worklog manager's `dispatch.task.*` surface so the
      // bus-driven path projects into the same threads as the JSONL path.
      router.register(
        worklog.surfaceConfig({
          org: systemEventSource.org,
          adapterId: `worklog-${discordAdapter.instanceId}`,
        }),
      );
    }

    const processFile = async (path: string) => {
      const events = reader.readNew(path);
      if (events.length > 0) {
        console.log(`cortex: processing ${events.length} event(s) from ${path.split("/").pop()}`);
      }
      for (const raw of events) {
        try {
          const event = PublishedEventSchema.parse(raw);
          if (postedEventIds.has(event.event_id)) continue;
          postedEventIds.add(event.event_id);
          if (worklog) await worklog.handleEvent(event);
          if (instance.enableAgentLog) {
            const formatted = formatEventForDiscord(event);
            if (!formatted) continue;
            const guild = client.guilds.cache.get(guildId);
            const channel =
              (guild?.channels.cache.get(logChannelId) as TextChannel | null)
              ?? ((await client.channels.fetch(logChannelId).catch(() => null)) as TextChannel | null);
            if (channel && "send" in channel) {
              await channel.send(formatted);
            } else {
              console.error(`cortex: could not resolve log channel ${logChannelId} — check bot permissions and channel ID`);
            }
          }
        } catch (err) {
          console.error("cortex: outbound error:", err instanceof Error ? err.message : err);
        }
      }
    };

    pollInterval = setInterval(() => {
      try {
        const files = readdirSync(eventsDir).filter((f: string) => f.endsWith(".jsonl"));
        for (const file of files) void processFile(join(eventsDir, file));
      } catch (err) {
        console.error("cortex: poll error:", err instanceof Error ? err.message : String(err));
      }
    }, 2000);

    console.log(`cortex: polling ${eventsDir} for outbound events (every 2s)`);
  });

  return () => {
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };
}

/** G-204a + G-500: Issue startup `/api/sync` POST against each cloud-capable
 *  network; fall back to a local sync for any network that errors. */
async function runStartupCloudSync(
  cloudNetworks: BotConfig["networks"],
  api: { runStartupSync: () => unknown },
): Promise<void> {
  let anyFailed = false;
  for (const network of cloudNetworks) {
    if (!network.cloud) continue;
    const { endpoint, apiKey, cfAccessClientId, cfAccessClientSecret } = network.cloud;
    try {
      const syncUrl = `${endpoint.replace(/\/+$/, "")}/api/sync`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (cfAccessClientId && cfAccessClientSecret) {
        headers["CF-Access-Client-Id"] = cfAccessClientId;
        headers["CF-Access-Client-Secret"] = cfAccessClientSecret;
      }
      const res = await fetchWithTimeout("startup_sync", 15_000, syncUrl, {
        method: "POST",
        headers,
      });
      if (res.ok) {
        const result = (await res.json()) as { repos?: number; issues?: number; prs?: number };
        console.log(`cortex: cloud sync [${network.id}] — ${result.repos ?? 0} repo(s), ${result.issues ?? 0} issues, ${result.prs ?? 0} PRs`);
      } else {
        console.error(`cortex: cloud sync [${network.id}] failed: HTTP ${res.status}`);
        anyFailed = true;
      }
    } catch (err) {
      console.error(`cortex: cloud sync [${network.id}] error:`, err instanceof Error ? err.message : err);
      anyFailed = true;
    }
  }
  if (anyFailed) await api.runStartupSync();
}

// CLI

function getVersion(): string {
  try {
    const manifestPath = join(dirname(import.meta.dir), "arc-manifest.yaml");
    const manifest = parseYaml(readFileSync(manifestPath, "utf-8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function checkSingleton(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const raw = readFileSync(pidFile, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) {
    console.error(`cortex: removing invalid PID file (${pidFile} contents: "${raw}")`);
    unlinkSync(pidFile);
    return;
  }
  try {
    process.kill(pid, 0);
    console.error(`cortex: already running (PID ${pid}, ${pidFile}). Stop it first with: cortex stop`);
    process.exit(1);
  } catch {
    console.error(`cortex: removing stale PID file ${pidFile} (PID ${pid} not running)`);
    unlinkSync(pidFile);
  }
}

// cortex#88 item 2 — `cortex start --dry-run` config validator.
//
// `scripts/postinstall.sh` already advertises `cortex start --config <path>
// --dry-run` to operators as a post-migration sanity check. This helper
// implements that contract: parse the file through the normal load path
// (`loadConfigWithAgents`, which validates against both `BotConfigSchema`
// and `CortexConfigSchema` depending on shape), print a one-line OK
// summary, exit 0. Schema parse failures surface verbatim with exit 2 so
// the postinstall path stays distinguishable from "file unreadable" (1).
//
// Exported so the unit tests can invoke it in-process with captured stdout
// /stderr — the production CLI block below delegates to it as well. No
// adapter startup, no NATS connect, no plist render, no daemon — purely
// schema validation.
export interface DryRunResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

export function runDryRun(configPath: string): DryRunResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const { config, inlineAgents } = loadConfigWithAgents(configPath);
    // cortex#106 item 4: clamp to the actual length — don't mask a degenerate
    // "no agents" config behind a fallback of 1. For cortex-shape input
    // `CortexConfigSchema.agents.min(1)` enforces ≥1 at parse time, so a
    // zero here means a legacy bot.yaml shape that the loader returned with
    // empty `inlineAgents` AND no synthesized singular agent — surface that
    // as a hard failure rather than reporting "1 agent" misleadingly.
    const agentCount = inlineAgents.length;
    if (agentCount === 0) {
      stderr.push(
        `cortex config validation FAILED: ${configPath} has no agents — config invalid`,
      );
      return { exitCode: 2, stdout: stdout.join("\n"), stderr: stderr.join("\n") + "\n" };
    }
    const rendererCount = config.renderers?.length ?? 0;
    const natsUrl = config.nats?.url ?? "(disabled)";
    stdout.push(
      `cortex config validation OK — ${agentCount} agents, ${rendererCount} renderers, NATS=${natsUrl}`,
    );
    return { exitCode: 0, stdout: stdout.join("\n") + "\n", stderr: stderr.join("\n") };
  } catch (err) {
    // Operator-readable: surface the Zod-shaped message verbatim. The
    // schema's own error formatter is already field-pathed (`agent.name:
    // Required`, etc.) so we don't try to re-pretty-print here.
    stderr.push(
      `cortex config validation FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: 2, stdout: stdout.join("\n"), stderr: stderr.join("\n") + "\n" };
  }
}

// `import.meta.main` is true only when this file is the CLI entrypoint.
// Skipping the CLI wiring at module load is what lets tests
// `import { startCortex }` here without parsing argv or registering signal
// handlers.
if (import.meta.main) {
  const program = new Command()
    .name("cortex")
    .description("Cortex — the M7 conscious processing surface agent")
    .version(getVersion());

  program
    .command("start")
    .description("Start the agent")
    .option("--config <path>", "Path to agent config YAML", DEFAULT_CONFIG)
    .option("--dry-run", "Validate config file and exit (no adapter / NATS / daemon startup)")
    .action(async (options: { config: string; dryRun?: boolean }) => {
      // cortex#88 item 2 — short-circuit: skip PID file, signal handlers,
      // and the full startCortex pipeline. Just parse + validate the config.
      if (options.dryRun) {
        const result = runDryRun(options.config);
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      }

      mkdirSync(STATE_DIR, { recursive: true });
      const pidFile = pidFileFor(options.config);
      checkSingleton(pidFile);
      writeFileSync(pidFile, String(process.pid));

      process.on("uncaughtException", (err) => {
        console.error("cortex: uncaught exception (non-fatal):", err.message);
      });
      process.on("unhandledRejection", (reason) => {
        console.error("cortex: unhandled rejection (non-fatal):", reason);
      });

      // MIG-7.2e: detect cortex shape vs legacy bot.yaml. `loadConfigWithAgents`
      // returns both the BotConfig projection (for downstream legacy consumers)
      // and the rich cortex `agents[]` so `startCortex` can route per-instance
      // identity correctly.
      //
      // IAW A.5.3 (cortex#113): also pass through the cortex-shape `stack:`
      // block when the operator declared one — `startCortex` calls
      // `deriveStackId` and logs the resolved stack id. Today this is
      // observational only; emit subjects are unchanged.
      const { config, inlineAgents, stack, policy, operator, bus } = loadConfigWithAgents(options.config);
      const handle = await startCortex(config, {
        configPath: options.config,
        ...(inlineAgents.length > 0 && { inlineAgents }),
        ...(stack !== undefined && { stack }),
        ...(policy !== undefined && { policy }),
        ...(operator !== undefined && { operator }),
        ...(bus !== undefined && { bus }),
      });

      const shutdown = async () => {
        await handle.stop();
        if (existsSync(pidFile)) unlinkSync(pidFile);
        // Echo round-1 N2: surface dirty shutdown to launchd / operators
        // via a non-zero exit code. `lastShutdownAbandoned` is non-empty
        // only when the 15s drain timeout fired with subsystems still in
        // flight (logged by `stop()` already).
        const abandoned = handle.lastShutdownAbandoned;
        process.exit(abandoned.length > 0 ? 1 : 0);
      };
      process.on("SIGINT", () => { void shutdown(); });
      process.on("SIGTERM", () => { void shutdown(); });
    });

  program
    .command("stop")
    .description("Stop the agent")
    .option("--config <path>", "Path to agent config YAML (selects which stack to stop)", DEFAULT_CONFIG)
    .action((options: { config: string }) => {
      const pidFile = pidFileFor(options.config);
      if (!existsSync(pidFile)) {
        console.log(`cortex: not running (${pidFile})`);
        return;
      }
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
      try {
        process.kill(pid, "SIGTERM");
        unlinkSync(pidFile);
        console.log(`cortex: stopped (PID ${pid}, ${pidFile})`);
      } catch {
        console.log(`cortex: process ${pid} not found, cleaning up ${pidFile}`);
        unlinkSync(pidFile);
      }
    });

  program
    .command("status")
    .description("Check agent status")
    .option("--config <path>", "Path to agent config YAML (selects which stack to query)", DEFAULT_CONFIG)
    .action((options: { config: string }) => {
      const pidFile = pidFileFor(options.config);
      if (!existsSync(pidFile)) {
        console.log(`cortex: not running (${pidFile})`);
        return;
      }
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim());
      try {
        process.kill(pid, 0);
        console.log(`cortex: running (PID ${pid}, ${pidFile})`);
      } catch {
        console.log(`cortex: stale PID file ${pidFile}`);
        unlinkSync(pidFile);
      }
    });

  program.parse();
}
