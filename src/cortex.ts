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

// MUST be first: forces @discordjs/ws onto the `ws` package on Bun (overrides
// globalThis.WebSocket) BEFORE any transitive discord.js import evaluates its
// module-level WebSocket constructor. Fixes the recurring gateway flapping
// (cortex#546/#581/#590/#591/#593). See src/bootstrap/ws-transport.ts.
import "./bootstrap/ws-transport";

import { Command } from "commander";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { basename, join, dirname, isAbsolute } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import type { TextChannel } from "discord.js";

import { loadConfigWithAgents, loadAgentsDirectory, expandTilde, FragmentLoadError } from "./common/config/loader";
import { ConfigWatcher } from "./common/config/watcher";
import { type AgentConfig } from "./common/types/config";
import { resolveSigningKnobs } from "./common/security-posture";
import { buildHttpsMtlsMaterial } from "./common/config/transport-mtls";
import { AgentRegistry } from "./common/agents/registry";
import { TrustResolver } from "./common/agents/trust-resolver";
// cortex#79 — creds minting moved to `arc nats … --json` (shelled out from
// `src/cli/cortex/commands/creds.ts`). No daemon-side RPC handler in
// cortex; the account-signature verifier in TrustResolver keeps using
// `loadAccountSigningKey` independently.

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
import { wireDevConsumers } from "./runner/dev-consumer-boot";
import {
  ReleaseConsumer,
  type ReleaseConsumerAgent,
} from "./runner/release-consumer";
import {
  provisionReviewStream,
  provisionReviewConsumer,
} from "./bus/jetstream/provision";
import {
  verifySignedByChain,
  nkeyToBase64Pubkey,
} from "./bus/verify-signed-by-chain";
import { bootVerifierSelfCheck } from "./bus/verifier-self-check";
import { CCSession, type CCSessionOpts } from "./runner/cc-session";
import { makeSageReviewRunner } from "./runner/sage-runner";
import { resolveReviewEngine } from "./runner/review-engine";
import { runReviewPipeline } from "./runner/review-pipeline";
import {
  resolveOffering,
  offeringSubjectPatterns,
  type OfferScope,
} from "./common/types/offering";
import { admitOfferedDispatch } from "./bus/admit-offered-dispatch";
import type { GateFloorContext, GateFloorDecision } from "./bus/gate-floor";
// CO-7 (epic cortex#939) — untrusted-content & prompt-injection hardening
// (M1/M2/M4/M6). Composed per offer-scope by `co7-review-hardening`; every
// helper short-circuits to the pre-CO-7 behaviour on `local` scope, so a stack
// with no `policy.offerings` wires byte-identically to today.
import {
  reviewPromptForScope,
  reviewSessionOptsForScope,
  resolveComplianceOk,
} from "./runner/co7-review-hardening";
import { withCo7EgressGuard } from "./runner/co7-egress-pipeline";
import {
  getSignedByChain,
  type Envelope,
} from "./bus/myelin/envelope-validator";

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
import { createDispatchSink, type DispatchSink } from "./adapters/dispatch-sink";
import { createReviewSink, type ReviewSink } from "./adapters/review-sink";
import { startGatewayIfEnabled } from "./gateway/start-gateway";
// G-1113 ML.5 — cockpit live-refresh loop (opt-in via config.cockpit).
import { refreshCockpit, defaultWorkItemSourceFor } from "./surface/mc/refresh";
import { startCockpitRefreshLoop, type CockpitRefreshLoop } from "./surface/mc/refresh-loop";
// MC-I1.S1 (ADR-0005) — in-process Mission Control embed (supersedes api.*).
import { startMissionControl, type MissionControlHandle } from "./surface/mc/embed";
import type { AgentPresenceView } from "./surface/mc/api/agents";
// MC-I1.S4 (ADR-0005 §4) — bus→MC dispatch-lifecycle projection renderer.
import { createDispatchProjectionRenderer } from "./surface/mc/projection/dispatch-lifecycle-renderer";
// P-14 U2.1 (#934) — bus→MC observability projection renderer (signal's four
// system.* families). Own renderer, own subjects; registered beside the dispatch
// renderer, no edit to surface-router.ts.
// P-14 U3.3 (#937) — projectForeignObservability: the foreign-origin projection
// entry the federated observability fold's callback writes through.
import {
  createObservabilityProjectionRenderer,
  projectForeignObservability,
} from "./surface/mc/projection/observability-renderer";
// MC-I1.S7 (#849) — funnel the event-driven failed_dispatch attention delta
// onto the same system.attention.* bus path the cockpit loop publishes on.
import { publishReconcileDelta } from "./surface/mc/attention-notify";
import type { Database as BunDatabase } from "bun:sqlite";
import { isGatewayEnabled } from "./gateway/gateway-bootstrap";
import {
  gatewayAdapterInstanceCollisions,
  planSurfaceOwnership,
} from "./gateway/surface-ownership-plan";
import type { Surfaces } from "./common/types/surfaces";
import type { SurfaceGateway } from "./gateway/surface-gateway";

import { createDispatchListener, type DispatchListener } from "./runner/dispatch-listener";
// G-1114.B.2 — live agent-presence producer (online/heartbeat/offline) wired
// into boot. G-1114.B.3 — the runtime registry subscriber it feeds.
import {
  AgentPresenceProducer,
  presenceAgentFromAgent,
  DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS,
  type PresenceAgent,
} from "./runner/agent-presence-producer";
import {
  startAgentPresenceRegistry,
  type AgentPresenceRegistryHandle,
} from "./bus/agent-network/registry";
// G-1114.E.2 + E.5 — trust-verified federated agent-presence subscriber.
import {
  startFederatedAgentPresenceSubscriber,
  type FederatedAgentPresenceSubscriberHandle,
} from "./bus/agent-network/federated-subscriber";
// P-14 U3.3 (#937) — trust-verified federated OBSERVABILITY fold (the
// observability sibling of the presence subscriber; same Option-D trust path +
// the curation gate, origin-badged).
import {
  startFederatedObservabilityFold,
  type FederatedObservabilityFoldHandle,
} from "./bus/agent-network/federated-observability-fold";
// #989 part-1 — LOCAL same-principal multi-bus presence aggregation.
import { discoverSiblingStacks } from "./surface/mc/local-aggregation/sibling-discovery";
import {
  startSiblingPresenceAggregator,
  type SiblingPresenceAggregatorHandle,
} from "./surface/mc/local-aggregation/sibling-presence-subscriber";
import { natsSiblingBusConnector } from "./surface/mc/local-aggregation/nats-sibling-connector";
// #1008 — direct sibling MC-DB read aggregation (the pane-of-glass mechanism).
import type {
  LocalAggregationContext,
  SiblingDbResolveOptions,
} from "./surface/mc/local-aggregation/sibling-db-reader";
import type { SiblingStackDescriptor } from "./surface/mc/local-aggregation/sibling-discovery";
import { createProbeResponder, type ProbeResponder } from "./bus/probe-responder";
import { WorklogManager } from "./runner/worklog-manager";

// #752 — the `network` + `provision-stack` subcommand dispatchers. Registered
// as passthrough commander subcommands below so `cortex network join …` and
// `cortex provision-stack register …` work directly (no `bun src/...` prefix).
// These do NOT boot the daemon — only `start` does.
import { dispatchNetwork } from "./cli/cortex/commands/network";
import { dispatchOffer } from "./cli/cortex/commands/offer";
import { dispatchProvisionStack } from "./cli/cortex/commands/provision-stack";
import { dispatchStack } from "./cli/cortex/commands/stack";

import { CloudPublisher } from "./taps/cc-events/cloud-publisher";
import {
  RegistryClient,
  PrincipalPubkeyResolver,
  MultiPrincipalIdentityRegistry,
} from "./common/registry";
import type {
  RegistryClientReader,
  FederatedPeerResolution,
} from "./common/registry";
import { resolveBootFederatedPeers } from "./common/registry/resolve-federated-peers-boot";
import type { NetworkRosterProvider } from "./common/registry/resolve-federated-peers";
import { JsonlReader } from "./taps/cc-events/lib/jsonl-reader";
import { PublishedEventSchema } from "./taps/cc-events/hooks/lib/event-types";
import { formatEventForDiscord } from "./adapters/discord/event-formatter";
import {
  startGithubWebhookReceiver,
  type GithubWebhookReceiverHandle,
} from "./taps/gh-webhook-receiver/server";

// MIG-7.9 (deferred) flips these to `~/.config/cortex/`. Keeping grove-shaped
// paths for now so the principal's existing `bot.yaml` continues to work.
const STATE_DIR = join(process.env.HOME ?? "~", ".config", "grove", "state");
const PID_FILE = join(STATE_DIR, "cortex.pid");
const DEFAULT_CONFIG = join(process.env.HOME ?? "~", ".config", "grove", "bot.yaml");

/**
 * Resolve the PID file path for a given `--config` value.
 *
 * Principals running multiple cortex instances on a single machine (per
 * Phase A.5's stack-aware namespace — e.g. `andreas/research` and
 * `andreas/work` side-by-side) need distinct PID files so the
 * singleton check in {@link checkSingleton} only blocks duplicates of
 * the same stack, not unrelated stacks.
 *
 * Resolution:
 *   - Default config (or unspecified) → legacy `cortex.pid` (preserves
 *     single-instance backward compat — principals on the default path
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

/**
 * cortex#400 — derive the per-agent CC session opts handed to the
 * bus-side review-consumer. Mirrors the Discord path's wiring at
 * `src/bus/dispatch-handler.ts:1014` so a `/review owner/repo#N`
 * dispatch over the bus spawns CC with the same toolset (Bash/Read/gh
 * + `bypassPermissions`) the Discord path uses. Without this, the
 * spawned CC sees only globally-configured MCP tools and politely
 * refuses with "I don't have access to GitHub CLI tools".
 *
 * `asyncTimeoutMs` matches the Discord path's choice (review work
 * is async). `bashAllowlist` is propagated when present; the runtime
 * gate at `src/runner/hooks/bash-guard.hook.ts:218` currently
 * short-circuits to `allow()` whenever `GROVE_AGENT_ID` is set (a
 * pre-existing scope of the agent-trust model that affects the
 * Discord path too — tracked as a follow-up issue).
 *
 * Exported so `src/__tests__/cortex.review-session-opts.test.ts` can
 * assert the projection without standing up the full `startCortex`
 * integration harness.
 */
export function buildReviewSessionOpts(
  config: AgentConfig,
  agent: Pick<Agent, "id" | "displayName">,
): Partial<Omit<CCSessionOpts, "prompt">> {
  return {
    agentName: agent.displayName,
    agentId: agent.id,
    additionalArgs: config.claude.additionalArgs,
    allowedTools: config.claude.allowedTools,
    disallowedTools: config.claude.disallowedTools,
    allowedDirs: config.claude.allowedDirs,
    timeoutMs: config.claude.asyncTimeoutMs,
    cwd: process.cwd(),
    ...(config.claude.bashAllowlist !== undefined && {
      bashAllowlist: config.claude.bashAllowlist,
    }),
  };
}

/** Lifecycle handle returned by `startCortex`. Capped at 15s — components
 *  that don't drain are abandoned (logged). */
export interface CortexHandle {
  stop(): Promise<void>;
  /**
   * Subsystems that did not finish their `stop()` within
   * `SHUTDOWN_TIMEOUT_MS` on the most recent `stop()` invocation. Empty
   * after a clean shutdown; non-empty signals principals (or launchd) that
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
  /** Skip the Mission Control embed even if config.mc.enabled is set (tests). */
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
   * S4 (Network Join Control Plane, epic #733) — inject a roster provider for
   * the boot-path federated-peer resolution instead of building a live
   * `NetworkRegistryClient` from `policy.federated.registry`. Tests pass a
   * fixture/stub provider so the DD-5/DD-10/DD-11 boot wiring runs with NO
   * network I/O and NO `~/.config` cache touch. Production omits this.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  bootFederatedRosterProvider?: NetworkRosterProvider;
  /**
   * S4 (Network Join Control Plane, epic #733) — test-only observation hook,
   * invoked synchronously with the resolved policy view right after the
   * boot-path federated-peer resolution (DD-5/DD-10/DD-11). Tests use it to
   * assert what the membership gate will see WITHOUT mutating the caller's
   * `options` (PR #818 review NIT-6) and without growing the public
   * `CortexHandle`. Production omits it.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  onBootResolvedPolicy?: (policy: Policy | undefined) => void;
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
   * assembly path runs without touching the principal's real `agents.d/`.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  agentsDir?: string;
  /**
   * Inline `Agent[]` to merge with the fragment-loaded list when building
   * the registry. Mirrors the cortex.yaml `agents[]` block (design §6.1):
   * inline entries win on id conflict with fragments.
   *
   * AgentConfig (today's legacy shape) carries no inline `agents[]` field, so
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
   * cortex-shape input where the principal hasn't declared `stack:` —
   * `deriveStackId` default-derives `${principal.id}/default` for both.
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
   * the principal hasn't declared a `policy:` block — the engine
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
   * IAW GW (cortex#524) — validated surface binding map from
   * `LoadedConfig.surfaces`. Consumed ONLY by the flag-gated
   * `startGatewayIfEnabled` block below; when `CORTEX_GATEWAY` is unset (the
   * default on every live stack) this field is read but the gateway is never
   * constructed. Undefined for legacy `bot.yaml` input and for cortex-shape
   * input with no `surfaces:` block.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  surfaces?: Surfaces;
  /**
   * v2.0.0 cutover (cortex#297) — principal's platform-side ids surfaced
   * from `PrincipalConfigSchema` via `LoadedConfig.principal`. Replaces the
   * `AgentConfig.agent.operatorDiscordId/Mattermost/Slack` fields retired
   * in cortex#297. `undefined` for legacy `bot.yaml` input — adapters
   * then have no principal-DM target and `notifyPrincipal` is a no-op.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  principal?: {
    id: string;
    /**
     * cortex#429 PR-C — replaces the removed `AgentConfig.agent.operatorName`.
     * Surfaced on the dashboard's `principal` column when present; defaults
     * to `id` otherwise.
     */
    displayName?: string;
    discordId?: string;
    mattermostId?: string;
    slackId?: string;
  };
}

/**
 * cortex#427 — resolve the canonical `{principal}` segment for every
 * NATS subject, dashboard column, and `signed_by` chain inside the
 * cortex process. v3 vocabulary (cortex#388) made `principal.id` the
 * single source of truth on cortex.yaml; the loader surfaces it as
 * `LoadedConfig.principal.id`, which the entrypoint hands in here via
 * `options.principal.id`.
 *
 * cortex#429 PR-C — the legacy `config.agent.operatorId` fallback has
 * been retired together with the schema field. Principals on un-migrated
 * configs see a fail-fast startup error pointing at `principal.id`; this
 * IS the upgrade prompt.
 *
 * **No silent `"default"` fallback.** v3 PrincipalConfigSchema makes
 * `principal.id` REQUIRED (`z.string().min(1)`); a missing identity
 * means the config didn't load through the v3 path. That's a startup
 * error — not a silent collapse to `local.default.>` that hides
 * misconfiguration until the first cross-principal envelope leaks.
 *
 * @throws if `options.principal.id` is unset or empty — fail-fast at
 *   boot rather than masking the gap.
 */
function resolvePrincipalId(
  principal: StartCortexOptions["principal"],
): string {
  const fromLoadedPrincipal = principal?.id;
  if (fromLoadedPrincipal !== undefined && fromLoadedPrincipal !== "") {
    return fromLoadedPrincipal;
  }
  throw new Error(
    "cortex: cannot resolve principal id — cortex.yaml must declare `principal.id` " +
      "(v3 canonical). The `{principal}` segment of every NATS subject and " +
      "`signed_by` chain is required; refusing to silently collapse to `default`. " +
      "If upgrading from v2, run `cortex migrate-config` to rewrite your config.",
  );
}

function targetAgentForDispatch(
  agent: Pick<Agent, "id" | "displayName" | "persona">,
  configDir: string,
): { id: string; displayName: string; persona: string } {
  const expandedPersona = expandTilde(agent.persona);
  return {
    id: agent.id,
    displayName: agent.displayName,
    persona: isAbsolute(expandedPersona)
      ? expandedPersona
      : join(configDir, expandedPersona),
  };
}

/**
 * Construct the full cortex stack and start it. Returns a stop handle.
 *
 * Order: runtime → router → dispatch-handler → adapters → dispatch-listener
 * → router.start(). Optional taps (cloud publisher, dashboard, JSONL
 * poller) run alongside. Errors during startup of OPTIONAL components are
 * logged and swallowed; REQUIRED components (runtime, router, listener)
 * propagate so the principal sees them at the CLI exit.
 */
export async function startCortex(
  config: AgentConfig,
  options: StartCortexOptions = {},
): Promise<CortexHandle> {
  const expandedConfigPath = options.configPath
    ? options.configPath.replace(/^~/, process.env.HOME ?? "~")
    : DEFAULT_CONFIG;

  const configDir = dirname(expandedConfigPath);
  const securityPreamble = buildSecurityPreamble(config, expandedConfigPath);
  console.log("cortex: starting...");
  console.log(`  Agent: ${config.agent.displayName}`);
  console.log(`  Config: ${options.configPath ?? "(in-memory)"}`);
  console.log(`  PID: ${process.pid}`);

  // cortex#427 — resolve the canonical principal id ONCE at boot. Every
  // subsequent `{principal}` segment (NATS subjects, `signed_by` chains,
  // dashboard columns) reads from this variable. cortex#429 PR-C retired
  // the legacy `config.agent.operatorId` fallback together with the
  // schema field — `options.principal.id` (sourced from `principal.id` by
  // the loader) is the single resolution path.
  const principalId = resolvePrincipalId(options.principal);
  console.log(`  Principal: ${principalId}`);

  // IAW Phase A.5 (refs cortex#113, closes cortex#262) — resolve the
  // deployment's stack identity at boot. `deriveStackId` returns
  // `{principal, stack, id}`; the `stack` segment flows into
  // `MyelinRuntime.publish()` below so emitted envelopes land in the
  // 6-segment `local.{principal}.{stack}.{type}` grammar that sage's bridge
  // and pilot's review-request subscriber both expect.
  //
  // The helper accepts a narrow `DeriveStackIdInput` shape (principal.id +
  // optional stack.id) — we synthesise it from the loader-passed
  // `options.stack` (the top-level cortex.yaml `stack:` block, when present)
  // plus `principalId` resolved above. cortex#427 retired the
  // `?? "default"` fallback — a missing principal is a boot-time error.
  const derivedStack = deriveStackId({
    principal: { id: principalId },
    ...(options.stack !== undefined && { stack: options.stack }),
  });
  console.log(
    `  Stack: ${derivedStack.id}${options.stack === undefined ? " (default-derived)" : ""}`,
  );

  // IAW Phase B.3 (refs cortex#114) — load the stack signing keypair
  // if the principal has declared `stack.nkey_seed_path`. The signer is
  // optional; when absent, MyelinRuntime publishes envelopes unsigned
  // (same shape as today). When present, MyelinRuntime.publish signs
  // every outbound envelope via myelin's chain-aware signEnvelope.
  //
  // Principal derivation: `did:mf:${stack.id.replace("/", "-")}`. The
  // `stack.id` shape is `{principal_id}/{stack_id}` (Phase A.5 lock-in);
  // myelin's DID_RE rejects slashes but accepts hyphens, so we
  // canonicalize the slash. Principals see `did:mf:andreas-research`
  // on the wire for `stack.id = "andreas/research"`.
  //
  // Load failures are non-fatal — the daemon keeps starting and the
  // runtime publishes unsigned. The error surfaces to principal logs
  // so they can fix the seed file and restart.
  // TC-0 (#628) — resolve the security posture's `signing` toggle to its
  // concrete boot knobs ONCE here, then apply at each verifier/signer site
  // below (signer attach, runtime signFailureMode, review-consumer verifier,
  // runner dispatch-listener, bus-dispatch-listener). DRY: one resolver,
  // applied at every site. `config.security` is always populated (schema
  // default `off` + transform), so this is safe for legacy bot.yaml input too.
  //
  // Backward-compat invariant (load-bearing): with `security` absent (default
  // `signing: "off"`) AND no `stack.nkey_seed_path`, these knobs are
  // non-rejecting (`rejectEmpty: false`, `signFailureMode: "fallback"`) — byte-
  // identical to today's unsigned dev-stack boot. See
  // `src/common/__tests__/security-posture.test.ts`.
  const signingKnobs = resolveSigningKnobs(config.security.signing);
  console.log(
    `cortex: security posture — signing=${config.security.signing} ` +
      `(attachSigner=${signingKnobs.attachSigner} rejectEmpty=${signingKnobs.rejectEmpty} ` +
      `signFailureMode=${signingKnobs.signFailureMode})`,
  );

  let signer: BusEnvelopeSigner | undefined;
  // cortex#480 — receiving stack's NKey public key for the chain
  // verifier's own-stack short-circuit (structural) + crypto-registry
  // entry (bytes-check). Captured from the loaded keypair below so the
  // signer-side and verifier-side use the SAME key — eliminates a
  // split-brain hazard where signer.publish stamps with key A but the
  // verifier short-circuits on declared-but-stale key B.
  let stackNKeyPubForVerifier: string | undefined;
  if (options.stack?.nkey_seed_path && !signingKnobs.attachSigner) {
    // TC-0 (#628) — a stack seed is configured, but `security.signing` is
    // `off`. Posture wins: do NOT attach the signer; publish unsigned.
    // Since cortex#1000 a seed-configured stack only reaches this branch via
    // an EXPLICIT `signing: off` — the loader's seed-aware default
    // (`applySeedAwareSigningDefault`) bumps an UNSET toggle to `permissive`
    // before the schema parse. Keep the warning for the explicit-off case.
    console.log(
      "cortex: stack signing key present but security.signing=off — " +
        "NOT attaching signer; outbound envelopes will be unsigned " +
        "(set security.signing: permissive to retain signing)",
    );
  } else if (options.stack?.nkey_seed_path) {
    try {
      // `expandTilde` matches `NatsLink.connect`'s treatment of
      // `credsPath` + the agents.d/ fallback below — principals writing
      // `~/.config/cortex/stack.nk` should not silently ENOENT into
      // the unsigned-publish fallback (Echo cortex#211 round 1).
      const seedPath = expandTilde(options.stack.nkey_seed_path);
      const kp = await loadStackSigningKey(seedPath);

      // Consistency check: if `stack.nkey_pub` is also declared, the
      // loaded keypair's public key MUST match. A mismatch is the
      // principal-rotation split-brain hazard — peers' `trust:`
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
      // cortex#480 — capture the stack's NKey public key so the chain
      // verifier can short-circuit + bytes-check self-signed envelopes.
      // `kp.getPublicKey()` is the U-prefixed base32 NATS NKey, the
      // same shape the verifier's `nkeyToBase64Pubkey` consumes.
      stackNKeyPubForVerifier = kp.getPublicKey();
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
    // default. When the principal hasn't declared `stack.nkey_seed_path`,
    // every outbound envelope is published UNSIGNED, which means peers
    // on the bus that run `verifySignedByChain` (cortex#320 / v2.0.2)
    // will reject the messages — silently for plain `dispatch.*`, loudly
    // once federation is on. The opt-in default is a footgun: principals
    // upgrade from a working unsigned deployment, don't notice the
    // missing field, and traffic looks fine until a peer enforces.
    //
    // For v2.0.3 we emit a LOUD stderr WARNING so principals tailing logs
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

  // #1006 — presence-scoped stack pubkey, resolved INDEPENDENT of the signing
  // posture.
  //
  // `stackNKeyPubForVerifier` (above) is only populated inside the
  // signing-ENABLED boot branch — it is the key the chain-verifier loads from
  // the seed when `attachSigner` is true. With `security.signing: off` (the
  // schema default that the live work/halden config-split stacks run) that
  // branch is skipped, so the verifier key stays `undefined` even though the
  // stack pubkey IS declared in config (`stack.nkey_pub`).
  //
  // Presence is a BUS identity concern, NOT a signing concern (ADR-0007): the
  // agent-presence producer stamps the stack's NKey pubkey as the fallback
  // identity for any hosted agent that hasn't declared its own `nkey_pub`
  // (the work/halden shape — per-agent keys live on `policy.principals[]`,
  // not on the canonical `agents[]` entry). A stack whose pubkey is declared
  // MUST announce its agents whether or not it signs outbound envelopes.
  //
  // Resolution order: prefer the seed-loaded verifier key (already validated
  // against `stack.nkey_pub` for the rotation split-brain check above when
  // signing is on), else the declared `stack.nkey_pub`. Both pass the same
  // NKEY_PUBKEY_REGEX at the schema layer, so they are interchangeable as the
  // presence identity. Stays `undefined` only when the stack declares neither
  // — the genuine no-key case, where skipping is still correct.
  const stackNKeyPubForPresence: string | undefined =
    stackNKeyPubForVerifier ?? options.stack?.nkey_pub;

  // S4 (Network Join Control Plane, epic #733; DD-5 wiring) — resolve the
  // federated `peers[]` from the registry roster BEFORE any consumer reads
  // them. Joining a network names the NETWORK, not each principal: a peer may
  // declare just `principal_id` + `stack_id` and have its `principal_pubkey`
  // filled here from the verified registry roster (DD-5). Hand-pins are kept as
  // the offline fallback; a hand-pin that DISAGREES with the registry-resolved
  // key fails that peer closed (DD-11); a registry outage falls back to the
  // cached roster + a loud warn (DD-10). The resolved networks become the local
  // `resolvedPolicy` that EVERY downstream consumer (the runtime LinkPool below,
  // the surface-router + dispatch-listener membership gates, the review-consumer
  // subjects, the public index) reads — DD-5: no separate registry-resolved code
  // path. NEVER throws; closes the `cortex-config.ts` "WIRING STATUS (S2)" gap.
  //
  // PR #818 review NIT-6 — we do NOT mutate the caller's `options.policy`. The
  // resolved view is a fresh local binding; the caller's object is untouched
  // (the resolver returns new objects and never mutates its input). All boot
  // reads below go through `resolvedPolicy`, never `options.policy`.
  const bootResolve = await resolveBootFederatedPeers(options.policy, {
    warn: (message) => {
      // Loud — drops + DD-10 fallback must be visible in the daemon logs.
      process.stderr.write(`cortex: federated-peer boot resolve — ${message}\n`);
    },
    // Test-only seam: inject a fixture roster provider so the boot wiring runs
    // with NO network I/O and NO `~/.config` cache touch. Production omits this
    // and a live `NetworkRegistryClient` is built from the registry block.
    ...(options.bootFederatedRosterProvider !== undefined && {
      rosterProvider: options.bootFederatedRosterProvider,
    }),
  });
  // The resolved policy view used by every consumer below. When
  // federation/registry is absent this is the input policy returned unchanged.
  const resolvedPolicy = bootResolve.policy;
  // Test-only observation seam (NIT-6): surface the resolved view without
  // mutating `options`. No-op in production.
  options.onBootResolvedPolicy?.(resolvedPolicy);
  if (bootResolve.errors.length > 0) {
    console.error(
      `cortex: ${bootResolve.errors.length.toString()} federated peer(s) ` +
        `failed closed at boot and were dropped from the membership gate ` +
        `(see stderr warnings above for per-peer detail).`,
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
      // sage's `local.{principal}.{stack}.>` subscription. `derivedStack.stack`
      // is the second segment of the canonical `{principal}/{stack}` id;
      // when the principal omitted the `stack:` block, `deriveStackId`
      // default-derived it to `'default'` (cortex.ts:278-281). That value
      // is what sage's bridge listens for by default (`SAGE_STACK=default`).
      runtime = await startMyelinRuntime(config, {
        ...(signer !== undefined && { signer }),
        stack: derivedStack.stack,
        // cortex#429 PR-C — runtime no longer reads
        // `config.agent.operatorId`; the boot-resolved principal flows
        // in explicitly so subscribe-side `{principal}` substitution
        // stays symmetric with publish-side `envelope.source`.
        principal: principalId,
        // TC-0 (#628) — `signFailureMode` from the security posture:
        // `enforce` → "drop" (a sign failure becomes a silent-downgrade
        // attack surface once peers reject unsigned), else "fallback"
        // (publish unsigned on transient sign failure). Ignored by the
        // runtime when no signer is attached.
        signFailureMode: signingKnobs.signFailureMode,
        // IAW Phase F-3b (cortex#659) — the federation networks the runtime
        // builds its LinkPool from. Each network declaring an inline `nats:`
        // block (F-3a) contributes one leaf NatsLink; networks without it
        // ride the primary link. Zero per-network `nats:` ⇒ primary-only
        // pool ⇒ today's single-link behaviour byte-for-byte. Sourced from
        // the SAME `policy.federated.networks[]` the surface-router gate
        // keys off — NEVER `config.networks[]` (the legacy grove
        // cloud-publish table; design §3.2 NAME-COLLISION).
        ...(resolvedPolicy?.federated?.networks !== undefined && {
          federatedNetworks: resolvedPolicy.federated.networks,
        }),
        // TC-4d/4e (#627 Phase 4) — transport-mTLS posture for the LinkPool
        // (primary + every federated leaf). Default `off` ⇒ no tls block on
        // any link, byte-identical to today; `require` fails closed at connect.
        // The federated-leaf-cleartext warning fires from the runtime
        // regardless of mode. `config.security` is always populated (TC-0
        // schema default), so this is safe for legacy bot.yaml input too.
        transportMtls: {
          mode: config.security.transport.mtls,
          ...(config.security.transport.tls !== undefined && {
            paths: config.security.transport.tls,
          }),
        },
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
  // `cortex agents` CLI's resolver) so a principal who already manages
  // fragments via that command sees them honoured at daemon startup too.
  // When `options.configPath` is absent (e.g. tests with in-memory config),
  // we fall back to `~/.config/cortex/agents.d/`.
  //
  // Fragment-load errors are non-fatal at this stage of the migration: the
  // agent must keep starting in AgentConfig mode even when a principal's
  // experimental fragment is malformed. Once the cortex.yaml migration is
  // complete (MIG-7.2e), the rule flips to strict per spec §FR-4.
  const agentsDir = options.agentsDir
    ?? (options.configPath ? join(dirname(expandedConfigPath), "agents.d") : expandTilde("~/.config/cortex/agents.d/"));
  let fragmentAgents: Agent[] = [];
  try {
    fragmentAgents = loadAgentsDirectory(agentsDir);
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      console.error(`cortex: agents.d fragment load failed (non-fatal during AgentConfig migration): ${err.message}`);
    } else {
      throw err;
    }
  }

  // Merge: inline wins on id conflict (design §6.1). AgentConfig today carries
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
  // here) silently fall through and stay covered by the principal-explicit
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
  // `{principalId}.cortex.{instance}`). `local` until federation lands.
  // `dataResidency` flows from `config.agent.dataResidency` so a non-NZ
  // principal gets envelopes stamped with their actual residency without
  // touching the per-event constructors. Defaults to "NZ" when absent
  // (the original cortex deployment's residency).
  //
  // Declared BEFORE the surface-router (cortex#134 Echo round-1 fix):
  // the router needs the source to publish `system.access.filtered`
  // envelopes when a visibility-config renderer drops an envelope.
  // Without this, the audit-trail emit silently degrades to console.info
  // in production — only unit tests passed the explicit source.
  const systemEventSource: SystemEventSource = {
    // cortex#427 — the `principal` segment is the `{principal}` subject
    // segment; same resolution path as the dispatch-listener below so
    // publisher and consumer can't disagree on which principal a
    // `system.*` envelope belongs to.
    principal: principalId,
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
  // principal-side dashboard) can discover what each agent claims to do.
  //
  // **Ordering rationale.** This block runs AFTER:
  //   - the runtime is constructed (line ~395) so `runtime.publish` is wired
  //     (no-op stub when NATS is absent; production runtime when present),
  //   - `mergedAgents` is built (line ~439) so we know who claims what,
  //   - `systemEventSource` is built (immediately above) so we share the same
  //     `{principal}.cortex.{instance}` envelope source with `system.*` emissions.
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
  // restart-and-replay; we do NOT wire a re-publish into the AgentConfig
  // hot-reload path because (a) capabilities live on `Agent`, not
  // `AgentConfig`, and (b) cortex.ts does not currently run an agents.d/
  // fragment watcher at the daemon level — when one is wired, the
  // re-publish belongs in its callback, not the AgentConfig one.
  //
  // **Scope (per §10.1 PR-7).** Publish-only. No subscriber wiring here —
  // the consumer is principal-dashboard side and lands in a future PR.
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
    // principal-actionable text. The capability-dispatch consumer rejects
    // every inbound request with `cant_do` until at least one agent
    // declares runtime.capabilities[], so the boot-time silence was a
    // first-install footgun (fresh `pilot request-review --wait` exits 0
    // with no review having happened). Keep the original info-level
    // `console.log` for normal observability AND emit a stderr WARNING
    // so principals tailing logs OR running interactively see the
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
  // actually subscribes to the JetStream `local.{principal}.tasks.code-review.>`
  // pull consumer. One consumer per agent — the spec's routing is
  // single-agent (the consumer's capability filter checks the owning
  // agent's claims only; multi-agent fan-out is the runtime's namespace
  // job, not the consumer's).
  //
  // **Ordering.** Runs AFTER the capability-registry block above so a
  // principal scanning boot logs sees registrations before consumers.
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
  // Stable identity inputs for the per-agent durable consumer name.
  // cortex#427 — `reviewPrincipalId` is the same `{principal}` segment the
  // surface-router and capability-registry boot paths use; reading the
  // shared `principalId` keeps publisher and consumer aligned across the
  // ladder. Durable name convention per
  // `docs/design-capability-dispatch-review-consumer.md` §2.3:
  // `cortex-review-consumer-{principal}-{agent}` — unique per
  // (principal, agent) pair so dev + prod instances on the same principal
  // share competing-consumer semantics and a daemon restart resumes from
  // the same JetStream offset. PR-R2a (cortex#439) renamed the downstream
  // API parameter to `principalId`; this local alias keeps the review-
  // consumer wiring readable alongside the dashboard's `operatorId`
  // column name (still on the MC surface — PR-R2b).
  const reviewPrincipalId = principalId;

  // CO-2/CO-4 (epic cortex#939) — the per-capability OFFER-SCOPE ADMISSION GATE
  // factory. Returns the closure each consumer calls (after signature
  // verification, before the capability gate) to evaluate whether an
  // offered-wider dispatch clears its scope's floor. The closure:
  //
  //   1. derives `arrivedScope` from the subject prefix (`local.`/`federated.`/
  //      `public.`); a malformed/unknown prefix is treated as `local` (the
  //      narrowest, fail-safe scope — never silently a wider tier);
  //   2. calls `admitOfferedDispatch` (CO-4), which resolves the capability's
  //      offering and evaluates `gateFloorForScope` for the arrived scope.
  //
  // BYTE-IDENTICAL: with no `policy.offerings` every capability resolves
  // `local`-only and `gateFloorForScope('local', …)` admits UNCONDITIONALLY
  // (reading none of the context), so the closure is a provingly-inert
  // `{admit:true}` on the `local.` subjects that are the ONLY scope bound today.
  // It bites only on the `federated.`/`public.` subjects CO-2 newly binds once a
  // capability is offered wider (CO-3).
  //
  // CONTEXT WIRING (what is live now vs. the CO-5/CO-7 seams):
  //   - `signed`           — LIVE: read from the envelope's `signed_by[]` chain.
  //   - `peerPrincipal`    — LIVE: first signed stamp's principal (federated
  //                          {kind:'principals'} roster check).
  //   - `peerInNetwork`    — defense-in-depth ONLY here: the federated `peers[]`
  //                          roster is ALSO (and authoritatively) enforced by the
  //                          existing cortex#686 federated consumer gate. Passed
  //                          `false` so the FLOOR never *widens* admission beyond
  //                          what that gate already allows (the floor can only
  //                          refuse; a federated {kind:'network'} request still
  //                          has to clear the existing peers gate regardless).
  //   - `surfaceVerified` / `surfacePredicatePassed` — CO-5 seam (gh-webhook
  //                          Stage-1 tap). NOT yet computed ⇒ passed `false` ⇒
  //                          the public floor REFUSES (`policy_denied`). This is
  //                          the SECURE default: a public offering cannot admit
  //                          until CO-5 wires the surface trust anchor — which is
  //                          correct, since the public marketplace (CO-5) is
  //                          itself gated on CO-7 hardening.
  //   - `complianceOk`     — CO-7 seam. Passed `false` ⇒ public refuses
  //                          `compliance_block` until CO-7 wires the hook.
  //   - `rateOk`           — passed `true` (no limiter wired yet; the §5
  //                          rate/cost cap is a CO-4-follow / CO-7 knob). The
  //                          structural floors above gate public long before
  //                          rate matters.
  //
  // Net: federated admits a signed peer at `signing ≥ permissive` (then the
  // existing peers gate enforces the roster); public is refused until CO-5/CO-7
  // land. Both are correct-and-secure given what is built today. A follow-up
  // (filed as part of CO-5/CO-7) threads the live surface/compliance/rate
  // signals into this context.
  const makeOfferAdmission = (
    capability: string,
  ): ((envelope: Envelope, subject: string) => GateFloorDecision) => {
    return (envelope, subject) => {
      const arrivedScope: OfferScope = subject.startsWith("federated.")
        ? "federated"
        : subject.startsWith("public.")
          ? "public"
          : "local";
      const chain = getSignedByChain(envelope);
      const signed = chain.length > 0;
      // CO-7 M6 — resolve the capability's offering so the budget/cost gate can
      // read its `public` accept-policy `limits`. `complianceOk` is now the M6
      // BudgetCheck verdict (fail-closed for public: a public offering with no
      // declared cost authority refuses `compliance_block`), composed with the
      // prior secure default. For `local`/`federated` the budget gate does not
      // apply, so `complianceOk` stays the secure prior default and the floor's
      // structural gates do the work.
      const resolvedOfferingForCap = resolveOffering(
        capability,
        resolvedPolicy?.offerings,
      );
      const compliance = resolveComplianceOk({
        scope: arrivedScope,
        accept: resolvedOfferingForCap.accept,
        // Prior default stays secure: until the CO-5 Stage-1 tap wires a real
        // compliance hook, public's prior compliance is `false` (refuse), so the
        // floor refuses public regardless of budget — the public marketplace
        // (CO-5) is itself gated on this CO-7 hardening landing first. M6
        // composes (ANDs) with this; it can only tighten.
        priorComplianceOk: arrivedScope === "public" ? false : true,
      });
      const ctx: GateFloorContext = {
        signed,
        // `peerPrincipal` is intentionally left undefined here: the signed
        // stamp carries a `did:mf:` identity, not a bare principal, and the
        // AUTHORITATIVE federated roster check (both `{kind:'network'}` and
        // `{kind:'principals'}`) is the existing cortex#686 `peers[]` gate that
        // decodes the requester from `originator.identity`. The CO-4 floor here
        // contributes the signing-posture + signed-peer + scope-admission gates;
        // it does not re-derive the roster (see block comment).
        // Defense-in-depth only — the authoritative federated roster check is
        // the existing cortex#686 peers gate (see block comment). `false` keeps
        // the floor refuse-only; it never widens admission.
        peerInNetwork: false,
        // CO-5 seam — not yet computed ⇒ secure default (public refuses).
        surfaceVerified: false,
        surfacePredicatePassed: false,
        // CO-7 M6 — the BudgetCheck-composed compliance verdict (fail-closed
        // public). Public still also refuses on `surfaceVerified` until CO-5.
        complianceOk: compliance.complianceOk,
        // No limiter wired yet; structural floors gate public before rate.
        rateOk: true,
      };
      return admitOfferedDispatch({
        capability,
        offerings: resolvedPolicy?.offerings,
        arrivedScope,
        signing: config.security.signing,
        ctx,
      });
    };
  };

  // cortex#318 — include the stack segment to match the 6-segment grammar
  // `deriveSubject` produces for stack-scoped publishes (cortex#262 / IAW
  // Phase A.5 + canonical helper at `@the-metafactory/myelin/subjects`).
  // Pilot publishes to `local.{principal}.{stack}.tasks.code-review.<flavor>`;
  // the consumer must subscribe to the same grammar or the wildcard
  // `>` never matches (NATS requires literal segments before the `>`).
  // Reuses `derivedStack.stack` resolved at boot (line 308) — same source
  // sage's bridge subscription already uses for `local.{principal}.{stack}.>`.
  const reviewSubjectPattern = `local.${reviewPrincipalId}.${derivedStack.stack}.tasks.code-review.>`;
  // CO-2 (cortex#941) — the offering-derived consumer binding for the
  // `code-review` capability. `resolveOffering` reads the per-stack offering
  // policy (default-deny ⇒ `local`-only when `policy.offerings` is absent);
  // `offeringSubjectPatterns` projects the admitted offer-scopes onto the
  // scope-prefixed subject patterns the Offer consumer binds on. The
  // `tasks.code-review.>` task-suffix is the SAME wildcard family the local
  // pattern uses, so a `local`-only resolution returns EXACTLY
  // `[reviewSubjectPattern]` — byte-identical to today's single binding. When
  // (CO-3) `code-review` is offered `federated`/`public`, this also yields the
  // `federated.…`/`public.….tasks.code-review.>` patterns and the consumer
  // binds them too. This is ORTHOGONAL to the cortex#686/#725 `federated:`
  // policy-block federation wiring below (which routes verdicts back to a
  // cross-principal requester and stays gated on `federationConfigured`); the
  // offering layer decides reachability, the existing federation block decides
  // verdict-routing. They compose; CO-2 touches only the Offer binding.
  const reviewOfferingPatterns = offeringSubjectPatterns(
    "tasks.code-review.>",
    reviewPrincipalId,
    derivedStack.stack,
    resolveOffering("code-review", resolvedPolicy?.offerings),
  );
  // cortex#686 (ADR 0001) — the FEDERATED review pattern: this RECEIVING stack's
  // OWN identity (`federated.{my-principal}.{my-stack}.tasks.code-review.>`),
  // the same `{principal}.{stack}` segments as the local pattern, only the
  // scope prefix differs (the network is NEVER on the wire — resolved from
  // topology). Cross-principal review-requests from a configured peer land
  // here; the federated consumer routes the verdict back to the REQUESTER's
  // identity (see ReviewConsumer `federated` mode). Gated on a `federated:`
  // policy block: a deployment with no federation declared adds no federated
  // filter/consumer (back-compat — local path byte-for-byte unchanged).
  const federationConfigured =
    (resolvedPolicy?.federated?.networks ?? []).length > 0;
  const reviewFederatedSubjectPattern = `federated.${reviewPrincipalId}.${derivedStack.stack}.tasks.code-review.>`;
  // cortex#725 (ADR 0001/0002 §2) — the FEDERATED **Direct** review pattern.
  // pilot#149's `--reviewer {name}@{principal}/{stack}` Direct dispatch lands
  // on `federated.{me}.{my-stack}.tasks.@{did-encoded-reviewer}.code-review.{flavor}`:
  // the named reviewer's DID is spliced in as an `@{did}` segment AFTER `tasks.`
  // (pilot's `deriveReviewRequestSubject`). The Offer filter above expects
  // `code-review` in that position, so it never matches a Direct request —
  // `pilot --reviewer name@p/s --wait` hangs (the cortex#725 gap).
  //
  // NATS whole-token `*` matches the entire `@{did-encoded-reviewer}` segment
  // (same convention the LOCAL Direct dispatch uses: `local.{p}.{s}.tasks.*.>`
  // in `dispatch-listener.ts`); the trailing literal `code-review` + `>`
  // narrows to code-review flavors only (not every capability). The
  // `envelope.type` of a Direct request is STILL `tasks.code-review.{flavor}`
  // (the `@{did}` lives ONLY on the subject — myelin's `type` grammar forbids
  // `@`), so `extractFlavor` + the whole federated consumer path work
  // unchanged: only this extra subscription differs from the Offer path.
  const reviewFederatedDirectSubjectPattern = `federated.${reviewPrincipalId}.${derivedStack.stack}.tasks.*.code-review.>`;
  const reviewConfig = options.bus?.review;
  const reviewStream = reviewConfig?.stream.name ?? "CODE_REVIEW";
  const reviewStreamMaxAgeNs =
    (reviewConfig?.stream.maxAgeSeconds ?? 86_400) * 1_000_000_000;
  const reviewStreamMaxBytes =
    reviewConfig?.stream.maxBytes ?? 512 * 1024 * 1024;
  const reviewConsumerMaxDeliver = reviewConfig?.consumer.maxDeliver ?? 5;

  // cortex#835 / pilot#154 — the REVIEW_LIFECYCLE stream. A SECOND JetStream
  // stream that carries the verdict + dispatch-lifecycle envelopes so a
  // downstream reactor (pilot's verdict watch) can later bind a DURABLE
  // consumer and REPLAY history instead of racing a transient core-NATS
  // subscription. cortex provisions the stream only — the durable consumers
  // that read it are the downstream reactor's concern (the cortex#835
  // follow-up). Config posture mirrors CODE_REVIEW exactly. NOTE (#851
  // review): retention is INTEREST — with zero registered consumers the
  // stream retains NOTHING, so until pilot's durable consumer exists this
  // is a structural enabler, not history. Replay-from-history begins only
  // once the first durable consumer is bound.
  const lifecycleConfig = options.bus?.lifecycle;
  const lifecycleStream = lifecycleConfig?.stream.name ?? "REVIEW_LIFECYCLE";
  const lifecycleStreamMaxAgeNs =
    (lifecycleConfig?.stream.maxAgeSeconds ?? 86_400) * 1_000_000_000;
  const lifecycleStreamMaxBytes =
    lifecycleConfig?.stream.maxBytes ?? 512 * 1024 * 1024;

  // ── F-2.2 (cortex#835 → cortex#865) DEV_IMPLEMENT config ──────────────────
  // Resolve the DEV_IMPLEMENT stream knobs alongside the review knobs. Sibling
  // of the REVIEW_LIFECYCLE block (cortex#851). The actual provisioning rides
  // the SAME `reviewJsm !== null` gate below so it inherits byte-identical
  // dormant behaviour when the bus/JetStream is unconfigured. (Boundary comment
  // kept loud so the expected #851/#874 boot-section merge conflict is trivial.)
  const devImplementConfig = options.bus?.devImplement;
  const devImplementStream = devImplementConfig?.stream.name ?? "DEV_IMPLEMENT";
  const devImplementStreamMaxAgeNs =
    (devImplementConfig?.stream.maxAgeSeconds ?? 86_400) * 1_000_000_000;
  const devImplementStreamMaxBytes =
    devImplementConfig?.stream.maxBytes ?? 512 * 1024 * 1024;
  // ── /F-2.2 DEV_IMPLEMENT config ───────────────────────────────────────────

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

  // cortex#686 — the CODE_REVIEW stream's subject filter carries BOTH the
  // local and (when federation is configured) the federated code-review
  // patterns, so an inbound `federated.{me}.{stack}.tasks.code-review.…`
  // request from a peer is captured by the same JetStream stream the local
  // consumer binds. A parallel federated DURABLE (per agent) binds below.
  // cortex#725 — the Direct federated pattern joins the stream filter too, so
  // an inbound `federated.{me}.{stack}.tasks.@{did}.code-review.…` Direct
  // request is captured by the same CODE_REVIEW stream the Offer + local
  // consumers bind. A parallel Direct DURABLE (per agent) binds below.
  // CO-2 (cortex#941) — the CODE_REVIEW stream filter must also CAPTURE the
  // wider scope prefixes the `code-review` offering admits, or the Offer
  // consumer's `federated.…`/`public.….tasks.code-review.>` binding would hit
  // "subject not in stream". The offering's non-local patterns are unioned in
  // with DEDUP so a `federated` offering and the pre-existing cortex#686
  // `reviewFederatedSubjectPattern` (byte-identical string) coalesce to ONE
  // subject — JetStream rejects overlapping/duplicate subjects, so the set is
  // dedup'd. For the CO-1 default (`local`-only) `reviewOfferingPatterns` is
  // `[reviewSubjectPattern]`, which is already in the base set, so this adds
  // NOTHING — the stream filter is byte-identical to today.
  const reviewStreamSubjects = Array.from(
    new Set([
      ...(federationConfigured
        ? [
            reviewSubjectPattern,
            reviewFederatedSubjectPattern,
            reviewFederatedDirectSubjectPattern,
          ]
        : [reviewSubjectPattern]),
      ...reviewOfferingPatterns,
    ]),
  );

  // cortex#835 / pilot#154 — REVIEW_LIFECYCLE subject set. Covers the THREE
  // local lifecycle families a downstream verdict-reactor races for (the
  // exact set pilot's `subscribe-verdict.ts` listens on, plus the dispatch
  // lifecycle the task brief names):
  //   - `…review.verdict.>`   — the verdict envelopes (approved / changes /
  //                             commented) the review consumer publishes
  //   - `…code.pr.review.>`   — sage's `code` domain verdict family (pilot
  //                             subscribes both verdict families explicitly)
  //   - `…dispatch.task.>`    — dispatch lifecycle (received / dispatched /
  //                             completed / failed / aborted)
  //
  // OVERLAP ANALYSIS (JetStream rejects overlapping subjects across streams):
  // CODE_REVIEW owns `…tasks.code-review.>` (+ federated `tasks.*.code-review`).
  // Those live under the `tasks.` token at segment 4; the three families here
  // live under disjoint tokens (`review.`, `code.`, `dispatch.`) at segment 4.
  // No prefix of any subject here is a prefix of (or prefixed by) any
  // CODE_REVIEW subject — the two streams partition the subject space cleanly.
  // Federated verdict/lifecycle traffic is intentionally NOT mirrored here:
  // the durable-history need is local-reactor-scoped (pilot watches its OWN
  // `local.{principal}.{stack}.…` scope); a federated-history follow-up can
  // extend this set the same way `reviewStreamSubjects` extends under
  // `federationConfigured` if/when a cross-principal reactor needs replay.
  const lifecycleStreamSubjects = [
    `local.${reviewPrincipalId}.${derivedStack.stack}.review.verdict.>`,
    `local.${reviewPrincipalId}.${derivedStack.stack}.code.pr.review.>`,
    `local.${reviewPrincipalId}.${derivedStack.stack}.dispatch.task.>`,
  ];

  // ── F-2.2 (cortex#835 → cortex#865) DEV_IMPLEMENT subject set ─────────────
  // The dev-loop's dev-agent consumer (F-2.1, cortex#853) subscribes on
  // `local.{principal}.{stack}.tasks.dev.implement` and binds the durable on
  // stream `DEV_IMPLEMENT`. The stream filter covers the whole `tasks.dev.>`
  // family (the exact subject the consumer subscribes, plus room for future
  // `tasks.dev.*` capabilities) so the consumer's `consumers.get(stream, …)`
  // never hits "stream not found" against a virgin broker.
  //
  // OVERLAP ANALYSIS (JetStream rejects overlapping subjects across streams):
  //   CODE_REVIEW       owns `…tasks.code-review.>`
  //   REVIEW_LIFECYCLE  owns `…review.verdict.>` / `…code.pr.review.>` /
  //                          `…dispatch.task.>`   (cortex#851, sibling stream)
  //   DEV_IMPLEMENT     owns `…tasks.dev.>`        (THIS stream)
  // `tasks.dev.` and `tasks.code-review.` diverge at segment 5 (the token after
  // `tasks.`): neither is a prefix of the other, so no subject of DEV_IMPLEMENT
  // is a prefix of (or prefixed by) any CODE_REVIEW / REVIEW_LIFECYCLE subject.
  // The three streams partition the subject space cleanly. The overlap-invariant
  // test (cortex.dev-stream-boot.test.ts) is the codified guard at boot.
  //
  // Federated dev traffic is intentionally NOT mirrored here — the dev-loop is
  // principal-local (F-5 federation is a later slice); a federated-history
  // follow-up can extend this set under `federationConfigured` the same way
  // `reviewStreamSubjects` does, when a cross-principal dev consumer needs it.
  // CO-2 (cortex#941) — the DEV_IMPLEMENT stream filter carries the scope
  // prefixes the `dev.implement` offering admits, using the `tasks.dev.>`
  // wildcard family (so the stream still covers any future `tasks.dev.*`
  // capability under each admitted scope). `local`-only (the CO-1 default) ⇒
  // `devStreamOfferingPatterns` is exactly `[local.…tasks.dev.>]` — byte-
  // identical to today's single-subject filter. The per-consumer binding uses
  // the narrower exact `tasks.dev.implement` suffix (see the dev boot loop).
  const devStreamOfferingPatterns = offeringSubjectPatterns(
    "tasks.dev.>",
    reviewPrincipalId,
    derivedStack.stack,
    resolveOffering("dev.implement", resolvedPolicy?.offerings),
  );
  const devImplementStreamSubjects = devStreamOfferingPatterns;
  // ── /F-2.2 DEV_IMPLEMENT subject set ──────────────────────────────────────

  if (reviewJsm !== null) {
    try {
      const outcome = await provisionReviewStream({
        jsm: reviewJsm,
        name: reviewStream,
        subjects: reviewStreamSubjects,
        maxAgeNs: reviewStreamMaxAgeNs,
        maxBytes: reviewStreamMaxBytes,
      });
      if (outcome === "created") {
        console.log(
          `cortex: provisioned JetStream stream "${reviewStream}" (subjects=[${reviewStreamSubjects.join(", ")}])`,
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
      // We log here so principals see provisioning was even attempted.
      process.stderr.write(
        `cortex: provisionReviewStream failed for "${reviewStream}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // cortex#835 / pilot#154 — provision the REVIEW_LIFECYCLE stream in the
    // SAME `reviewJsm !== null` gate so it inherits the identical config
    // posture as CODE_REVIEW: created iff a JSM resolved (review-capable
    // agents present AND `runtime.jetstreamManager` available), skipped
    // entirely when the runtime is dormant. Reuses the generic
    // `provisionReviewStream` helper (idempotent ensure, Interest retention,
    // File storage, drift-warning) — only the name / subjects / limits
    // differ. A failure here does NOT abort boot, identical to CODE_REVIEW.
    try {
      const lifecycleOutcome = await provisionReviewStream({
        jsm: reviewJsm,
        name: lifecycleStream,
        subjects: lifecycleStreamSubjects,
        maxAgeNs: lifecycleStreamMaxAgeNs,
        maxBytes: lifecycleStreamMaxBytes,
      });
      if (lifecycleOutcome === "created") {
        console.log(
          `cortex: provisioned JetStream stream "${lifecycleStream}" (subjects=[${lifecycleStreamSubjects.join(", ")}])`,
        );
      } else if (lifecycleOutcome === "exists") {
        console.log(
          `cortex: JetStream stream "${lifecycleStream}" already present — binding existing config`,
        );
      }
      // config-drift-warning is already logged by the helper.
    } catch (err) {
      process.stderr.write(
        `cortex: provisionReviewStream failed for "${lifecycleStream}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // ── F-2.2 (cortex#835 → cortex#865) provision DEV_IMPLEMENT ─────────────
    // Provision the DEV_IMPLEMENT stream in the SAME `reviewJsm !== null` gate
    // so it inherits the identical config posture as CODE_REVIEW: created iff a
    // JSM resolved (review-capable agents present AND `runtime.jetstreamManager`
    // available), skipped entirely when the runtime is dormant — byte-identical
    // boot when the bus/JetStream is unconfigured. Reuses the generic
    // `provisionReviewStream` helper (idempotent ensure, Interest retention,
    // File storage, drift-warning) — only name / subjects / limits differ.
    // A failure here does NOT abort boot, identical to CODE_REVIEW. The
    // dev-agent consumer (F-2.1, cortex#853) binds its durable against this
    // stream; until a dev-capable agent exists that consumer never wires, so
    // this stream is a structural enabler. NOTE: retention is INTEREST — with
    // zero registered consumers the stream retains NOTHING, so replay-from-
    // history begins only once the first durable dev consumer is bound.
    // KNOWN COUPLING (#875 review nit 2): the gate is `resolveReviewProvisioningJsm`,
    // which returns null when there are zero REVIEW-capable agents. So a
    // hypothetical dev-ONLY stack (a dev-capable agent but no code-review agent)
    // would silently skip provisioning DEV_IMPLEMENT even though its dev consumer
    // needs it. Not reachable today (every production stack runs a reviewer),
    // but the proper fix is to gate DEV_IMPLEMENT on dev-capable-agent presence
    // independently of review agents — tracked as a follow-up (see cortex#835
    // phase #865). Documented here so a future dev-only principal isn't surprised.
    // (Boundary comment kept loud so the expected #851/#874 merge is trivial.)
    try {
      const devOutcome = await provisionReviewStream({
        jsm: reviewJsm,
        name: devImplementStream,
        subjects: devImplementStreamSubjects,
        maxAgeNs: devImplementStreamMaxAgeNs,
        maxBytes: devImplementStreamMaxBytes,
      });
      if (devOutcome === "created") {
        console.log(
          `cortex: provisioned JetStream stream "${devImplementStream}" (subjects=[${devImplementStreamSubjects.join(", ")}])`,
        );
      } else if (devOutcome === "exists") {
        console.log(
          `cortex: JetStream stream "${devImplementStream}" already present — binding existing config`,
        );
      }
      // config-drift-warning is already logged by the helper.
    } catch (err) {
      process.stderr.write(
        `cortex: provisionReviewStream failed for "${devImplementStream}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // ── /F-2.2 provision DEV_IMPLEMENT ──────────────────────────────────────
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
        // Governance Stage 1b — the agent's declared model class feeds the
        // consumer-side sovereignty gate. Absent → the gate fails closed for
        // local-only tasks.
        ...(agent.runtime?.modelClass !== undefined && {
          modelClass: agent.runtime.modelClass,
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
      // This is the one-way ratchet: as principals add `trust:` entries
      // to their cortex.yaml, signature enforcement strengthens
      // automatically without any flag toggling.
      //
      // The closure captures `trustResolver`, `agent.id`, and the
      // configured principalId — same triple the bus-peer harness
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
      const verifyPrincipalId = reviewPrincipalId;
      const signatureVerifier: SignatureVerifier | undefined =
        agentTrustList.length === 0
          ? undefined
          : async (envelope) => {
              const r = await verifySignedByChain(envelope, {
                resolver: trustResolver,
                receivingAgentId: agent.id,
                cryptoVerify: signingKnobs.cryptoVerify,
                // TC-0 (#628) — posture-gated empty-chain rejection. `off`/
                // `permissive` → `false` (verify but never reject empty
                // adapter-originated chains); `enforce` → `true`. Pre-TC-0
                // this relied on the `verifySignedByChain` default
                // (`rejectEmpty: true`); the posture now sets it explicitly
                // so seed-less / off stacks stay non-rejecting.
                rejectEmpty: signingKnobs.rejectEmpty,
                principalId: verifyPrincipalId,
                // cortex#535 (TC-1a) — implicit own-stack trust, mirroring
                // the bus-dispatch-listener wiring below. Pilot review-
                // requests are signed with the STACK identity
                // (`did:mf:<principal>-<stack>`), NOT an agent identity, so
                // without `stackIdentity` the stack DID misses the cortex#480
                // own-stack short-circuit and gets rejected as
                // `principal_has_no_nkey_pub`. Thread the SAME conditional-
                // spread options the dispatch-listener passes so self-signed
                // review-requests verify cleanly instead of being dropped.
                ...(signer !== undefined && { stackIdentity: signer.principal }),
                ...(stackNKeyPubForVerifier !== undefined && {
                  stackNKeyPub: stackNKeyPubForVerifier,
                }),
              });
              if (r.valid) return { valid: true } as const;
              return { valid: false, reason: r.reason.kind } as const;
            };

      // cortex#331 Phase 1 — substrate-aware pipelineRunner selection.
      //
      // **Why this lives in cortex (not sage).** Sage went in-process at
      // sage#41 — its standalone launchd daemon and standalone NATS
      // subscribe path are retired. Cortex's review-consumer is now the
      // sole receiver for sage-owned review flavors.
      //
      // cortex#917 — the engine/model split. `resolveReviewEngine` reads
      // `runtime.engine` (`sage` | `assistant`); the sage lens LLM is the
      // orthogonal `runtime.model` (claude|codex|pi), NOT `substrate` (which is
      // the M6 harness). `engine: sage` wires the sage lens-CLI runner,
      // forwarding `model` to `sage review --substrate <model>`; `assistant`
      // (and the legacy default) leaves `pipelineRunner` undefined so the
      // ReviewConsumer falls through to `runReviewPipeline` → the Claude-Code
      // SKILL.md path (`ccSessionFactory` stays wired for it). The resolver's
      // legacy shim keeps pre-split `substrate: pi-dev` configs routing to sage
      // (no forced model — SAGE_SUBSTRATE env still honoured).
      //
      // The sage runner resolves its binary lazily at first use (see
      // `sage-runner.ts`'s lifetime note), so a missing sage on boot does not
      // crash this loop — review requests surface the failure as
      // `dispatch.task.failed` envelopes instead.
      const { engine, model } = resolveReviewEngine(agent.runtime);
      const pipelineRunner =
        engine === "sage"
          ? makeSageReviewRunner(model !== undefined ? { model } : {})
          : undefined;

      const reviewSessionOpts = buildReviewSessionOpts(config, agent);

      // cortex#686 — shared construction options for the local + federated
      // consumers. Both serve the SAME reviewer agent (same capabilities,
      // verifier, substrate, prompt); they differ only in the `federated` flag
      // (which flips verdict routing to the requester) and the subscription
      // pattern/durable. Factored into a closure so the two consumers can't
      // drift on the heavy CC-session / verifier / prompt wiring.
      //
      // CO-7 (epic cortex#939) — the closure is now SCOPE-AWARE. The `scope`
      // argument (`local`/`federated`/`public`, derived from the bound subject
      // prefix) selects the hardened M1 prompt + M2 least-privilege session +
      // M4 egress-guarded pipeline for wider scopes. On `local` every helper
      // short-circuits to the pre-CO-7 path (plain prompt, baseline opts, no
      // egress wrap), so the local consumer is byte-identical to today.
      const makeConsumer = (scope: OfferScope): ReviewConsumer => {
        const federated = scope === "federated" || scope === "public";
        // M1 — untrusted-content boundary prompt for wider scope; plain for local.
        const scopedPromptBuilder = reviewPromptForScope(scope);
        // M2 — least-privilege session lockdown for wider scope; baseline for local.
        // `scratchDir` is left undefined here: the lockdown then fails CLOSED to
        // "no dirs granted" (empty allowedDirs) for a wider-scope review rather
        // than ever granting the principal's cwd to untrusted work. A per-review
        // scratch dir is the F-5b follow-up's concern (the non-local backend
        // owns the sandbox filesystem). For local, baseline opts (with their cwd)
        // pass through unchanged.
        const scopedSessionOpts = reviewSessionOptsForScope({
          baseline: reviewSessionOpts,
          scope,
          agentId: agent.id,
        });
        // M4 — wrap the pipeline runner so a wider-scope review's free-text
        // egress is leakage-scanned and a leak becomes `compliance_block`
        // (the review is never posted). `local` returns the inner runner
        // unchanged. The inner runner is the sage runner (if selected) or the
        // default `runReviewPipeline` (passed `undefined` ⇒ the consumer's own
        // default); we only override `pipelineRunner` when there is something to
        // wrap (a non-local scope OR an explicit sage runner).
        const baseRunner = pipelineRunner ?? runReviewPipeline;
        const scopedPipelineRunner =
          scope === "local"
            ? pipelineRunner // undefined ⇒ consumer default; or the sage runner
            : withCo7EgressGuard(scope, baseRunner);
        return new ReviewConsumer({
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
          // cortex#911 — the prompt now carries the verdict-block contract +
          // post intent explicitly (`buildReviewPrompt`), not just bare intent.
          // A thin persona used to review in prose and ask "Shall I post?",
          // leaving the pipeline with no parseable block and nothing on the
          // forge. Stating the contract in the prompt raises the floor on
          // persona quality. Failure is asymmetric: a missing/malformed block
          // drops only the verdict envelope (retryable), but a forge review,
          // once posted, persists — see `buildReviewPrompt`'s docstring.
          // Capability routing still happened on the subject
          // (`tasks.code-review.*`).
          // CO-7 M1 — scope-aware prompt builder (untrusted-content boundary for
          // federated/public; plain trusted prompt for local — byte-identical).
          promptBuilder: ({ payload }) => scopedPromptBuilder(payload),
          // CO-7 M2 — scope-aware session opts (least-privilege lockdown for
          // wider scope; baseline for local — byte-identical).
          sessionOpts: scopedSessionOpts,
          // CO-7 M4 — scope-aware pipeline runner (egress-guarded for wider
          // scope; the sage runner or consumer default for local).
          ...(scopedPipelineRunner !== undefined && {
            pipelineRunner: scopedPipelineRunner,
          }),
          ...(signatureVerifier !== undefined && { signatureVerifier }),
          // CO-2/CO-4 — the per-offer-scope admission gate. Inert on `local.`
          // (byte-identical); gates the `federated.`/`public.` subjects this
          // PR newly binds at their scope's floor before reviewer work.
          offerAdmission: makeOfferAdmission("code-review"),
          // cortex#686 — federated consumers route the verdict back to the
          // requester's identity on the conformant `federated.{requester}.…`
          // grammar (the cortex receiver that closes the cross-principal loop).
          // The peer topology is passed so the consumer-path `peers[]` gate
          // (ADR 0002 §5) can deny a non-peer requester BEFORE spawning the
          // reviewer — defense-in-depth that, under `signing: off`, is the
          // application-layer trust boundary on the consumer path.
          ...(federated && {
            federated: true,
            federatedNetworks: resolvedPolicy?.federated?.networks ?? [],
          }),
        });
      };

      const consumer = makeConsumer("local");
      reviewConsumers.push(consumer);
      // Subscribe via the runtime's subscribePull helper. When the
      // runtime is disabled the helper returns null inside start() and
      // the consumer stays dormant — `started.subscribed` distinguishes
      // the two cases so the boot log can be honest (cortex#334)
      // instead of unconditionally claiming "ready".
      const durable = `cortex-review-consumer-${reviewPrincipalId}-${agent.id}`;

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
          } else if (outcome === "updated") {
            console.log(
              `cortex: reconciled JetStream durable "${durable}" ack_wait (cortex#422) on stream "${reviewStream}"`,
            );
          }
        } catch (provisionErr) {
          // Don't abort — let consumer.start surface the bind failure
          // through its own error path so the principal sees the same
          // stderr shape they'd see if the consumer existed but bind
          // failed for another reason.
          process.stderr.write(
            `cortex: provisionReviewConsumer failed for "${durable}": ` +
              `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
          );
        }
      }

      // CO-2 (cortex#941) — bind the Offer consumer on the scope prefixes the
      // `code-review` offering admits. `reviewOfferingPatterns[0]` is the
      // first admitted scope in canonical order (local → federated → public);
      // for a `local`-only resolution (the CO-1 default) it is byte-identical
      // to `reviewSubjectPattern`, so the primary `start()` below is unchanged.
      // Any FURTHER patterns (federated/public, once CO-3 offers them wider)
      // bind on a per-scope durable so each scope's traffic acks independently,
      // mirroring the cortex#686/#725 federated-consumer idiom. With no
      // offerings, `reviewOfferingPatterns` is exactly `[reviewSubjectPattern]`
      // and this slice-loop is empty — zero added boot behaviour.
      const primaryReviewPattern = reviewOfferingPatterns[0] ?? reviewSubjectPattern;
      const started = await consumer.start({
        pattern: primaryReviewPattern,
        stream: reviewStream,
        durable,
      });
      const flavorSummary =
        consumer.flavors.length > 0 ? consumer.flavors.join(",") : "(none)";
      // D1 visibility: surface whether signature verification is enforced
      // on this consumer so principals can grep `signed=on/off` to confirm
      // their trust:[] config landed where they expected.
      const signedTag = signatureVerifier !== undefined ? "on" : "off";
      // cortex#331 Phase 1 — surface the dispatching substrate so
      // principals can grep `substrate=pi-dev` / `substrate=claude-code`
      // to confirm sage agents (or any future substrate) actually
      // received the substrate-aware factory. Unset substrate defaults
      // to `claude-code` in the log (matches the runtime fallthrough).
      //
      // cortex#334 — distinguish "ready" (subscription open) from
      // "DORMANT" (subscribePull returned null; G-1111 pending or
      // nats.subjects empty). The previous unconditional "ready" line
      // misled principals into chasing phantom misconfigs.
      if (started.subscribed) {
        console.log(
          `cortex: review consumer ready for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"}`,
        );
      } else {
        console.log(
          `cortex: review consumer DORMANT for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} — cortex MyelinRuntime subscriptions disabled (G-1111 pending; tasks.code-review.* envelopes will not be claimed by this consumer)`,
        );
      }

      // CO-2 (cortex#941) — bind the FURTHER offering scopes (federated/public)
      // beyond the primary local one. Empty for the CO-1 default (`local`-only
      // ⇒ `reviewOfferingPatterns` has length 1, so `.slice(1)` is empty ⇒ this
      // loop never runs ⇒ byte-identical boot). Each extra scope binds on its
      // OWN durable (scope token in the durable name) so the scopes ack
      // independently, the same idiom as the cortex#686/#725 federated durables.
      for (const extraPattern of reviewOfferingPatterns.slice(1)) {
        const scopeToken = extraPattern.split(".", 1)[0] ?? "scope";
        // MAJOR-1 fix (cortex#715 re-introduction): a `federated.`/`public.`
        // offer-scope consumer MUST be constructed with `federated: true` so
        // `ReviewConsumer.processEnvelope` decodes the REQUESTER from
        // `originator.identity` and routes the verdict back cross-principal —
        // `makeConsumer(false)` left `this.federated` unset, routing every
        // verdict to SELF (the exact cortex#715 BLOCKER). `makeConsumer(true)`
        // also wires `federatedNetworks` so the defense-in-depth `peers[]` gate
        // runs. (`public` shares the federated verdict-routing path: a public
        // requester reaches us through a surface but the verdict still routes to
        // the relaying identity in `originator`, not self.)
        // CO-7 — pass the actual offer-scope (not just a federated bool) so the
        // consumer wires the scope-appropriate M1/M2/M4 hardening. A non-scope
        // token (defensive) falls back to `public` — the STRICTEST hardening —
        // never silently to local.
        const offerScope: OfferScope =
          scopeToken === "federated"
            ? "federated"
            : scopeToken === "public"
              ? "public"
              : "public";
        const offerConsumer = makeConsumer(offerScope);
        reviewConsumers.push(offerConsumer);
        const offerDurable = `cortex-review-consumer-offer-${scopeToken}-${reviewPrincipalId}-${agent.id}`;
        if (reviewJsm !== null) {
          try {
            const outcome = await provisionReviewConsumer({
              jsm: reviewJsm,
              stream: reviewStream,
              durable: offerDurable,
              maxDeliver: reviewConsumerMaxDeliver,
            });
            if (outcome === "created") {
              console.log(
                `cortex: provisioned JetStream durable "${offerDurable}" on stream "${reviewStream}"`,
              );
            } else if (outcome === "updated") {
              console.log(
                `cortex: reconciled JetStream durable "${offerDurable}" ack_wait (cortex#422) on stream "${reviewStream}"`,
              );
            }
          } catch (provisionErr) {
            process.stderr.write(
              `cortex: provisionReviewConsumer failed for "${offerDurable}": ` +
                `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
            );
          }
        }
        const offerStarted = await offerConsumer.start({
          pattern: extraPattern,
          stream: reviewStream,
          durable: offerDurable,
        });
        if (offerStarted.subscribed) {
          console.log(
            `cortex: review consumer (offer:${scopeToken}) ready for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} pattern=${extraPattern}`,
          );
        } else {
          console.log(
            `cortex: review consumer (offer:${scopeToken}) DORMANT for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} — cortex MyelinRuntime subscriptions disabled (${extraPattern} envelopes will not be claimed by this consumer)`,
          );
        }
      }

      // cortex#686 (ADR 0001) — the FEDERATED review consumer. Subscribes this
      // stack's OWN federated identity (`federated.{my-principal}.{my-stack}.
      // tasks.code-review.>`) on the SAME CODE_REVIEW stream (its subject
      // filter was extended above when federation is configured), via a
      // SEPARATE durable so local + federated traffic ack independently. Routes
      // the verdict back to the REQUESTER's identity (the `federated: true`
      // flag). Only wired when a `federated:` policy block is declared — a
      // non-federating deployment skips this entirely (back-compat).
      if (federationConfigured) {
        // cortex#686 + cortex#725 — wire BOTH federated consumers (Offer +
        // Direct) for this agent. They share the `makeConsumer(true)`
        // construction (same reviewer, verifier, peers gate, verdict-back) and
        // the SAME CODE_REVIEW stream; they differ ONLY in the subscription
        // pattern + the durable (so Offer and Direct traffic ack independently).
        // Factored into a closure so the two can't drift on provisioning /
        // start / log wiring.
        const startFederatedConsumer = async (
          mode: "offer" | "direct",
          pattern: string,
          durable: string,
        ): Promise<void> => {
          // CO-7 — the cortex#686/#725 federated-policy consumers bind on
          // `federated.` subjects, so they wire the `federated`-scope M1/M2/M4
          // hardening (untrusted-content boundary + least-privilege + egress
          // guard) for cross-principal review requests.
          const federatedConsumer = makeConsumer("federated");
          reviewConsumers.push(federatedConsumer);
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
              } else if (outcome === "updated") {
                console.log(
                  `cortex: reconciled JetStream durable "${durable}" ack_wait (cortex#422) on stream "${reviewStream}"`,
                );
              }
            } catch (provisionErr) {
              process.stderr.write(
                `cortex: provisionReviewConsumer failed for "${durable}": ` +
                  `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
              );
            }
          }
          const federatedStarted = await federatedConsumer.start({
            pattern,
            stream: reviewStream,
            durable,
          });
          if (federatedStarted.subscribed) {
            console.log(
              `cortex: federated review consumer (${mode}) ready for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} pattern=${pattern}`,
            );
          } else {
            console.log(
              `cortex: federated review consumer (${mode}) DORMANT for agent=${agent.id} flavors=[${flavorSummary}] signed=${signedTag} engine=${engine} model=${model ?? "default"} — cortex MyelinRuntime subscriptions disabled (federated.* code-review envelopes will not be claimed by this consumer)`,
            );
          }
        };

        // cortex#686 (ADR 0001) — Offer: `federated.{me}.{stack}.tasks.code-review.>`.
        await startFederatedConsumer(
          "offer",
          reviewFederatedSubjectPattern,
          `cortex-review-consumer-federated-${reviewPrincipalId}-${agent.id}`,
        );
        // cortex#725 (ADR 0001/0002 §2) — Direct: this stack's OWN
        // `federated.{me}.{stack}.tasks.@{did}.code-review.>` (the `@{did}` is
        // the named reviewer/target-assistant). Routes the verdict back to the
        // REQUESTER (from `originator.identity`) identically to the Offer path.
        await startFederatedConsumer(
          "direct",
          reviewFederatedDirectSubjectPattern,
          `cortex-review-consumer-federated-direct-${reviewPrincipalId}-${agent.id}`,
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

  // cortex#835 F-4.1 — release-consumer boot wiring (the `release.cut` gated
  // capability). Mirrors the review-consumer block above: for each agent that
  // declares `release.cut` (or the generic `release`) capability, instantiate a
  // dedicated `ReleaseConsumer` and drive it through `start()` so it subscribes
  // to the JetStream `local.{principal}.{stack}.tasks.release.cut` pull
  // consumer.
  //
  // **HARD CONTRACT — byte-identical boot when no agent declares the capability.**
  // The ENTIRE block (filter, array, stream/consumer provisioning, log lines) is
  // gated behind `releaseCapableAgents.length > 0`. A roster with no
  // release-capable agent adds ZERO new boot behaviour — no stream provisioned,
  // no log line, no JSM round-trip — so the release lane is DORMANT-by-default
  // and a stack that never opts into `release.cut` boots exactly as before this
  // PR landed. (This differs from review-consumer's always-run "skipped" warning
  // because release is an opt-in authority, not a default expectation.)
  //
  // **Executor seam — F-4.1 ships the consumer WITHOUT a production executor.**
  // The consumer is constructed with no `executor`, so it operates
  // dormant-but-present: it claims the capability on the bus + runs the full
  // grant/precondition gate ladder, but every granted-and-gated claim terminates
  // `cant_do: no release executor configured` until the real git/gh executor is
  // wired (a follow-up slice — see the PR's Flags section). This keeps F-4.1 the
  // gate + lifecycle + capability-declaration slice, with the side-effecting
  // forge/command seam deferred behind the SAME `ReleaseExecutor` interface the
  // tests already drive.
  const releaseConsumers: ReleaseConsumer[] = [];
  const releaseCapableAgents = mergedAgents.filter((a) => {
    const caps = a.runtime?.capabilities ?? [];
    return caps.some((c) => c === "release" || c === "release.cut");
  });
  if (releaseCapableAgents.length > 0) {
    // Durable name convention mirrors the review lane:
    // `cortex-release-consumer-{principal}-{agent}` — unique per (principal,
    // agent) so dev + prod instances on the same principal share competing-
    // consumer semantics and a restart resumes from the same offset.
    const releaseSubjectPattern = `local.${principalId}.${derivedStack.stack}.tasks.release.cut`;
    // CO-2 (cortex#941) — the offering-derived binding for the `release.cut`
    // capability. The task-suffix `tasks.release.cut` is an EXACT subject (no
    // wildcard); `offeringSubjectPatterns` only varies the scope prefix, so a
    // `local`-only resolution (the CO-1 default) returns EXACTLY
    // `[releaseSubjectPattern]` — byte-identical to today's single binding.
    // Resolved against `release.cut` (the canonical capability the subject
    // routes on, regardless of whether the agent declared `release` or
    // `release.cut`).
    const releaseOfferingPatterns = offeringSubjectPatterns(
      "tasks.release.cut",
      principalId,
      derivedStack.stack,
      resolveOffering("release.cut", resolvedPolicy?.offerings),
    );
    const releaseStream = "RELEASE";
    // Reuse the review-lane stream defaults: a release-cut request is small +
    // infrequent; 24h retention + 512MiB is ample and matches the operational
    // posture principals already understand from CODE_REVIEW.
    const releaseStreamMaxAgeNs = 86_400 * 1_000_000_000;
    const releaseStreamMaxBytes = 512 * 1024 * 1024;
    const releaseConsumerMaxDeliver = 5;

    // Resolve the provisioning JSM once (same contained-failure contract as the
    // review lane's `resolveReviewProvisioningJsm`): a dormant runtime → null →
    // provisioning skipped + the consumer stays dormant in lockstep.
    const releaseJsm = await resolveReviewProvisioningJsm(
      runtime,
      releaseCapableAgents,
    );

    if (releaseJsm !== null) {
      try {
        // CO-2 (cortex#941) — the RELEASE stream filter carries the scope
        // prefixes the `release.cut` offering admits. `local`-only (the CO-1
        // default) ⇒ `releaseOfferingPatterns` is `[releaseSubjectPattern]`, so
        // this is byte-identical to today's single-subject filter.
        const outcome = await provisionReviewStream({
          jsm: releaseJsm,
          name: releaseStream,
          subjects: releaseOfferingPatterns,
          maxAgeNs: releaseStreamMaxAgeNs,
          maxBytes: releaseStreamMaxBytes,
        });
        if (outcome === "created") {
          console.log(
            `cortex: provisioned JetStream stream "${releaseStream}" (subjects=[${releaseOfferingPatterns.join(", ")}])`,
          );
        } else if (outcome === "exists") {
          console.log(
            `cortex: JetStream stream "${releaseStream}" already present — binding existing config`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `cortex: provisionReviewStream failed for "${releaseStream}": ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    for (const agent of releaseCapableAgents) {
      try {
        const caps = agent.runtime?.capabilities ?? [];
        const consumerAgent: ReleaseConsumerAgent = {
          id: agent.id,
          capabilities: caps,
          ...(agent.runtime?.maxConcurrent !== undefined && {
            maxConcurrent: agent.runtime.maxConcurrent,
          }),
        };
        // F-4.1 — no executor wired yet (see block header). The consumer is
        // dormant-but-present: capability declared + gate ladder live.
        const consumer = new ReleaseConsumer({
          agent: consumerAgent,
          source: systemEventSource,
          runtime,
          // CO-2/CO-4 — per-offer-scope admission gate (inert on `local.`).
          offerAdmission: makeOfferAdmission("release.cut"),
        });
        releaseConsumers.push(consumer);

        const durable = `cortex-release-consumer-${principalId}-${agent.id}`;
        if (releaseJsm !== null) {
          try {
            const outcome = await provisionReviewConsumer({
              jsm: releaseJsm,
              stream: releaseStream,
              durable,
              maxDeliver: releaseConsumerMaxDeliver,
            });
            if (outcome === "created") {
              console.log(
                `cortex: provisioned JetStream durable "${durable}" on stream "${releaseStream}"`,
              );
            } else if (outcome === "updated") {
              console.log(
                `cortex: reconciled JetStream durable "${durable}" on stream "${releaseStream}"`,
              );
            }
          } catch (provisionErr) {
            process.stderr.write(
              `cortex: provisionReviewConsumer failed for "${durable}": ` +
                `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
            );
          }
        }

        // CO-2 (cortex#941) — bind on the offering-admitted scope prefixes.
        // `releaseOfferingPatterns[0]` is byte-identical to
        // `releaseSubjectPattern` for the CO-1 default (`local`-only); the
        // `.slice(1)` loop is empty unless `release.cut` is offered wider.
        const primaryReleasePattern =
          releaseOfferingPatterns[0] ?? releaseSubjectPattern;
        const started = await consumer.start({
          pattern: primaryReleasePattern,
          stream: releaseStream,
          durable,
        });
        // F-4.1 — log line flags `executor=none` so a principal grepping boot
        // can see the lane is declared but the forge seam is not yet wired.
        if (started.subscribed) {
          console.log(
            `cortex: release consumer ready for agent=${agent.id} capability=release.cut executor=none (gated; principal-grant required) — PRINCIPAL-GATED, ALWAYS-HUMAN`,
          );
        } else {
          console.log(
            `cortex: release consumer DORMANT for agent=${agent.id} capability=release.cut executor=none — cortex MyelinRuntime subscriptions disabled (G-1111 pending; tasks.release.cut envelopes will not be claimed by this consumer)`,
          );
        }
        // CO-2 — extra offering scopes (federated/public) beyond the primary
        // local one, each on its own scope-named durable. Empty for the CO-1
        // default ⇒ byte-identical boot.
        for (const extraPattern of releaseOfferingPatterns.slice(1)) {
          const scopeToken = extraPattern.split(".", 1)[0] ?? "scope";
          // A NEW consumer instance per extra scope (one filter per JetStream
          // pull consumer) — same idiom as the review lane + the NIT-fix on the
          // dev lane. The CO-2/CO-4 admission gate is wired here too so the
          // wider-scope release dispatch clears its floor.
          const extraConsumer = new ReleaseConsumer({
            agent: consumerAgent,
            source: systemEventSource,
            runtime,
            offerAdmission: makeOfferAdmission("release.cut"),
          });
          releaseConsumers.push(extraConsumer);
          const extraDurable = `cortex-release-consumer-offer-${scopeToken}-${principalId}-${agent.id}`;
          if (releaseJsm !== null) {
            try {
              const outcome = await provisionReviewConsumer({
                jsm: releaseJsm,
                stream: releaseStream,
                durable: extraDurable,
                maxDeliver: releaseConsumerMaxDeliver,
              });
              if (outcome === "created") {
                console.log(
                  `cortex: provisioned JetStream durable "${extraDurable}" on stream "${releaseStream}"`,
                );
              } else if (outcome === "updated") {
                console.log(
                  `cortex: reconciled JetStream durable "${extraDurable}" on stream "${releaseStream}"`,
                );
              }
            } catch (provisionErr) {
              process.stderr.write(
                `cortex: provisionReviewConsumer failed for "${extraDurable}": ` +
                  `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
              );
            }
          }
          const extraStarted = await extraConsumer.start({
            pattern: extraPattern,
            stream: releaseStream,
            durable: extraDurable,
          });
          if (extraStarted.subscribed) {
            console.log(
              `cortex: release consumer (offer:${scopeToken}) ready for agent=${agent.id} capability=release.cut executor=none pattern=${extraPattern}`,
            );
          } else {
            console.log(
              `cortex: release consumer (offer:${scopeToken}) DORMANT for agent=${agent.id} capability=release.cut executor=none — cortex MyelinRuntime subscriptions disabled (${extraPattern} envelopes will not be claimed by this consumer)`,
            );
          }
        }
      } catch (err) {
        // Per CLAUDE.md "no empty catch blocks": a single agent's release
        // consumer crash does NOT abort boot — siblings still wire. The
        // consumer stays in `releaseConsumers[]` so the shutdown drain still
        // calls `.stop()` (idempotent — handles the "never subscribed" case).
        process.stderr.write(
          `cortex: release consumer init failed for agent=${agent.id}: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  // F-2.1 (cortex#835) — dev.implement consumer boot wiring.
  //
  // DORMANT BY DEFAULT: `wireDevConsumers` returns an EMPTY array — touching
  // no filesystem, spawning nothing, reading no token — unless an agent
  // declares a `dev.implement` (or bare `dev`) capability in
  // `runtime.capabilities[]`. Every live stack today declares none, so this
  // block is inert: byte-identical boot. Mirrors the review-consumer
  // dormancy contract above; runs AFTER it so a principal scanning boot logs
  // sees the review path first.
  // CO-2 (cortex#941) — the dev consumer binds on the scope prefixes the
  // `dev.implement` offering admits, using the EXACT `tasks.dev.implement`
  // subject (narrower than the `tasks.dev.>` stream filter). `local`-only (the
  // CO-1 default) ⇒ `devOfferingPatterns` is exactly
  // `[local.…tasks.dev.implement]` — byte-identical to today's single binding.
  const devOfferingPatterns = offeringSubjectPatterns(
    "tasks.dev.implement",
    principalId,
    derivedStack.stack,
    resolveOffering("dev.implement", resolvedPolicy?.offerings),
  );
  // CO-2 NIT-fix: `wireDevConsumers` now returns one {consumer, pattern} per
  // (agent × admitted scope) — a SEPARATE DevConsumer instance per scope, never
  // one `.start()`-ed twice (the second `.start()` would silently drop the
  // extra filter). With no offerings, `devOfferingPatterns` is the single local
  // pattern ⇒ one entry per agent ⇒ byte-identical boot.
  const wiredDevConsumers = wireDevConsumers({
    agents: mergedAgents,
    runtime,
    source: systemEventSource,
    principalId,
    stack: derivedStack.stack,
    // §3.5b — thread the same guardrail config the review path uses
    // (`config.claude`: bashAllowlist + allowedTools/Dirs + async timeout) so
    // the higher-authority dev push session is never LESS-guarded than the
    // review session. `buildDevSessionOpts` also sets the bash-guard Gate-1
    // channel + a conservative allowlist default when the config declares none.
    guardrails: config.claude,
    offeringPatterns: devOfferingPatterns,
    // CO-2/CO-4 — per-offer-scope admission gate (inert on `local.`).
    offerAdmission: makeOfferAdmission("dev.implement"),
  });
  // Flat consumer list for the shutdown drain (one entry per wired scope).
  const devConsumers = wiredDevConsumers.map((w) => w.consumer);
  for (const { consumer, pattern } of wiredDevConsumers) {
    try {
      // Stream provisioning for `tasks.dev.implement` is deliberately a
      // sibling slice (see dev-consumer-boot.ts header FLAG) — until a
      // dev-capable agent exists this loop never runs, so the deferral
      // changes no live behaviour. `start()` stays dormant-safe: a disabled
      // runtime returns `subscribed: false` and the consumer never binds.
      // The durable carries the scope token so a multi-scope offering's
      // consumers don't collide; for `local.` it is byte-identical to today's
      // `cortex-dev-consumer-{principal}-{agent}`.
      const scopeToken = pattern.split(".", 1)[0] ?? "local";
      const durable =
        scopeToken === "local"
          ? `cortex-dev-consumer-${principalId}-${consumer.agent.id}`
          : `cortex-dev-consumer-offer-${scopeToken}-${principalId}-${consumer.agent.id}`;
      const started = await consumer.start({
        pattern,
        stream: "DEV_IMPLEMENT",
        durable,
      });
      const scopeTag = scopeToken === "local" ? "" : ` (offer:${scopeToken})`;
      if (started.subscribed) {
        console.log(
          `cortex: dev.implement consumer${scopeTag} ready for agent=${consumer.agent.id} pattern=${pattern}`,
        );
      } else {
        console.log(
          `cortex: dev.implement consumer${scopeTag} DORMANT for agent=${consumer.agent.id} — ` +
            `cortex MyelinRuntime subscriptions disabled (G-1111 pending; ${pattern} ` +
            `envelopes will not be claimed by this consumer)`,
        );
      }
    } catch (err) {
      // Per CLAUDE.md: log every error. One agent's consumer crash does NOT
      // abort boot; siblings still wire and the shutdown drain still calls
      // `.stop()` (idempotent — handles the "never subscribed" case).
      process.stderr.write(
        `cortex: dev consumer init failed for agent=${consumer.agent.id}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
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
  // check alone is the B.1a contract and principals flip to crypto
  // verify once every trusted peer has an `nkey_pub` declared. The
  // flag is a small follow-up plumbing (cortex.yaml flag → option) once
  // the rollout window closes.
  //
  // TC-0 (#628) — `rejectEmpty` is now posture-gated: `enforce` → reject
  // unsigned peer dispatches; `off`/`permissive` → surface but do not
  // reject. The listener's default (`true`) is preserved under `enforce`.

  // TC-2d (cortex#635) — federated.* crypto-verify seam. The CAPSTONE of
  // the cross-principal trust chain: it lets THIS node verify an envelope
  // signed by a PEER principal (not just the local boot principal) by
  // resolving the peer's Ed25519 pubkey from the network registry (TC-2a
  // `PrincipalPubkeyResolver`) into a multi-principal `IdentityRegistry`
  // (TC-2b) the `federated.*` verify path consumes. Built ONCE here and
  // threaded into every inbound verify call site (bus-dispatch-listener,
  // dispatch-listener, review-consumer) so they share one resolver cache.
  //
  // ⚠️ LOAD-BEARING #635 GATE — `enabled` is driven by
  // `signing === "enforce"`, NOT by `signingKnobs.cryptoVerify`.
  // `resolveSigningKnobs` sets `cryptoVerify: true` for ALL postures
  // (off/permissive/enforce) as cheap observability; deriving the gate
  // from it would make OFF/permissive dev stacks reach out to the registry
  // on every inbound federated envelope — the regression the #635 wiring
  // note forbids. Under `off`/`permissive` the seam stays `undefined` and
  // the verify path NEVER constructs a resolver: ZERO registry I/O.
  //
  // Construction requires (a) `signing === "enforce"`, (b) a federation
  // registry URL, and (c) a derivable local boot `Identity` (the stack
  // signer staged above → its NKey pubkey). Missing any → seam stays
  // `undefined` and federated envelopes fall through to the local-only
  // verify exactly as today (single-principal path untouched).
  let resolveFederatedPeer:
    | ((peerPrincipal: string) => Promise<FederatedPeerResolution>)
    | undefined;
  const federationRegistryConfig = resolvedPolicy?.federated?.registry;
  const federationVerifyEnabled = config.security.signing === "enforce";
  if (
    federationVerifyEnabled &&
    federationRegistryConfig !== undefined &&
    signer !== undefined &&
    stackNKeyPubForVerifier !== undefined
  ) {
    const bootPublicKey = nkeyToBase64Pubkey(stackNKeyPubForVerifier);
    if (bootPublicKey === undefined) {
      // The stack NKey already passed the AgentSchema/StackConfig regex on
      // load, so a decode failure here is defensive-only — log and leave
      // the seam unwired (federated envelopes verify local-only, as today)
      // rather than crash boot.
      process.stderr.write(
        "cortex: TC-2d federated-verify seam NOT wired — could not decode " +
          `stack NKey pubkey ${stackNKeyPubForVerifier} to base64 ed25519\n`,
      );
    } else {
      const peerResolver = new PrincipalPubkeyResolver({
        enabled: federationVerifyEnabled,
        baseUrl: federationRegistryConfig.url,
        ...(federationRegistryConfig.pubkey !== undefined && {
          registryPubkey: federationRegistryConfig.pubkey,
        }),
      });
      const peerRegistry = new MultiPrincipalIdentityRegistry({
        bootPrincipal: {
          principalId,
          identity: {
            id: signer.principal,
            display_name: signer.principal,
            network: principalId,
            public_key: bootPublicKey,
            type: "agent",
            created_at: new Date(0).toISOString(),
          },
        },
        resolver: peerResolver,
      });
      resolveFederatedPeer =
        peerRegistry.resolveFederatedPeer.bind(peerRegistry);
      console.log(
        `cortex: TC-2d federated-verify seam wired (signing=enforce, registry=${federationRegistryConfig.url}) — ` +
          `inbound federated.* envelopes verify against registry-resolved peer pubkeys`,
      );
    }
  } else if (federationVerifyEnabled && federationRegistryConfig === undefined) {
    console.log(
      "cortex: security.signing=enforce but no policy.federated.registry configured — " +
        "federated.* envelopes verify local-only (no peer-pubkey resolution)",
    );
  }

  let busDispatchListener: BusDispatchListener | undefined;
  const firstAgent = mergedAgents[0];
  if (firstAgent !== undefined) {
    busDispatchListener = new BusDispatchListener({
      runtime,
      resolver: trustResolver,
      receivingAgentId: firstAgent.id,
      // cortex#427 — same `{principal}` segment the surface-router
      // and createDispatchListener below use. PR-R2a (cortex#439)
      // renamed the constructor parameter to `principalId`.
      principalId,
      // TC-0 (#628) — posture-gated empty-chain rejection for peer dispatch.
      rejectEmpty: signingKnobs.rejectEmpty,
      source: systemEventSource,
      // cortex#480 — implicit own-stack trust. When the stack has a
      // signing key staged (signer !== undefined), pass the DID and
      // NKey pubkey so peer-dispatch envelopes signed by THIS stack
      // (e.g. loopback / future federated self-relays) verify cleanly
      // instead of being rejected as unknown_agent.
      ...(signer !== undefined && { stackIdentity: signer.principal }),
      ...(stackNKeyPubForVerifier !== undefined && {
        stackNKeyPub: stackNKeyPubForVerifier,
      }),
      // TC-2d (cortex#635) — federated.* peer-pubkey resolution seam.
      // `undefined` unless `signing === "enforce"` + registry configured.
      ...(resolveFederatedPeer !== undefined && { resolveFederatedPeer }),
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
  // `system.access.filtered` envelopes principals can subscribe to — see
  // `evaluateVisibility()` in surface-router.ts.
  //
  // IAW Phase D.2 (refs cortex#116) — also receives `policy.federated`
  // so inbound `federated.*` envelopes get gated against the principal's
  // declared accept/deny/max_hop config before adapter fan-out. When
  // `policy.federated` is absent or `networks[]` is empty, the gate is
  // fully inert — `federated.*` envelopes pass through unchanged
  // (mirrors the C.3.1 policy-engine contract: no policy → no gating).
  // Federation enforcement is opt-in.
  const router: SurfaceRouter = createSurfaceRouter(runtime, {
    systemEventSource,
    ...(resolvedPolicy?.federated !== undefined && { federated: resolvedPolicy.federated }),
    // IAW S5 (#739) — the public-scope opt-in. Absent ⇒ the router drops all
    // inbound `public.*` (deny-by-default, OQ1 safe). Written by
    // `cortex network join public`; an inbound public sender is admitted only
    // when `enabled: true` AND its source principal is on `allow_principals[]`.
    ...(resolvedPolicy?.public !== undefined && { public: resolvedPolicy.public }),
    onAdapterError: (adapterId, err) => {
      console.error(`cortex: surface adapter "${adapterId}" render error:`, err.message);
    },
  });

  // IAW Phase D.4.3 (refs cortex#116) — registry client. Opt-in:
  // instantiated only when `policy.federated.registry.url` is set
  // AND `policy.federated.networks[].peers[]` declares at least one
  // peer. When dormant, callers asking for a principal simply get
  // `undefined` — the rest of cortex never has to special-case
  // "no registry configured".
  //
  // The client populates an in-memory cache of registry-verified peer
  // pubkeys (base64 Ed25519) on a 5-minute refresh schedule. Each
  // fetched assertion is verified against the pinned registry pubkey
  // before mutating the cache; verification failures log to stderr
  // and leave the cache untouched (fail-safe).
  //
  // Phase-B caveat: the registry trust anchor is principal-supplied
  // via `policy.federated.registry.pubkey` (pinned at config time) OR
  // TOFU at boot via `GET /registry/pubkey`. The TOFU window is
  // exactly the first call against an unknown registry; principals
  // wanting zero-TOFU populate the pubkey field out-of-band. See
  // `src/common/registry/client.ts` JSDoc for the full failure-mode
  // table.
  let registryClient: RegistryClient | null = null;
  const registryConfig = resolvedPolicy?.federated?.registry;
  if (registryConfig !== undefined) {
    const peerPrincipalIds = Array.from(
      new Set(
        (resolvedPolicy?.federated?.networks ?? []).flatMap((n) =>
          n.peers.map((p) => p.principal_id),
        ),
      ),
    );
    if (peerPrincipalIds.length === 0) {
      console.log(
        `cortex: policy.federated.registry configured (${registryConfig.url}) but no peers declared — registry client dormant`,
      );
    } else {
      registryClient = new RegistryClient({
        url: registryConfig.url,
        ...(registryConfig.pubkey !== undefined && { pubkey: registryConfig.pubkey }),
        principalIds: peerPrincipalIds,
      });
      // Boot the client asynchronously — TOFU + initial refresh must
      // not block the rest of cortex boot. Errors inside `start()`
      // are already logged via the client's own `logError` seam.
      void registryClient.start();
      console.log(
        `cortex: registry client started (${registryConfig.url}, tracking ${peerPrincipalIds.length} peer(s))`,
      );
    }
  }

  // v2.0.0 (cortex#297) — build engine + lookup index + principal registry
  // ONCE so the dispatch handler and the three adapter loops below share
  // the same instances. The policy block is parsed at config-load time;
  // the factory + index builders are idempotent over the same input.
  //
  // v2.0.1 (cortex#311): retired the `CORTEX_POLICY_REQUIRE_UNVERIFIED_ACK`
  // env-var gate. PolicyEngine activates whenever a `policy:` block is
  // declared (which v2.0.0's schema already enforces for boot). The
  // pre-Phase-B unverified-principal-claim trade-off is now an
  // informational boot-log notice from the dispatch-listener builder
  // below — gating it behind an env var created an M-3 split-brain where
  // adapters denied every inbound while bus dispatches bypassed auth
  // entirely (Echo PR #310 r1 finding, cortex#311).
  //
  // cortex#486 — moved earlier (was constructed just before the discord
  // adapter loop) so the DispatchHandler can consume the engine for
  // adapter-side platform-id → principal resolution at envelope-publish
  // time. See `dispatch-source-publisher` / CONTEXT.md §Dispatch-source.
  const adapterPolicyEngine = policyEngineFromConfig(resolvedPolicy);
  const adapterPolicyLookup = buildPlatformPrincipalIndex(resolvedPolicy);
  const adapterPolicyRegistry = buildPrincipalRegistry(resolvedPolicy);

  // Dispatch-handler — synchronous platform-message → CC pipeline.
  //
  // MIG-3.8 / C-104: hand the runtime + systemEventSource down so the handler
  // can publish `system.inbound.aborted` envelopes when an adapter outbound
  // (today: Discord attachment fetch) trips `TimeoutSourceError`. Both
  // fields are passed unconditionally — when the runtime is the no-op stub
  // (NATS absent), `MyelinRuntime.publish` is a no-op and emission falls
  // through silently. See `DispatchHandler.canPublishSystemEvent`.
  //
  // cortex#486 — `policyEngine` is required for the canonical
  // dispatch-source envelope publish path. When no `policy:` block is
  // declared `adapterPolicyEngine` is undefined and the publish fails
  // closed with `invalid-originator` (deliberate — pre-Phase-B silently
  // accepted unmapped originators; the v2.0.x policy-gated stack does
  // not).
  const dispatchHandler = new DispatchHandler({
    config,
    securityPreamble,
    configPath: expandedConfigPath,
    runtime,
    systemEventSource,
    stack: derivedStack.stack,
    ...(adapterPolicyEngine !== undefined && { policyEngine: adapterPolicyEngine }),
  });

  // Cloud publisher (G-401 + G-500) — opt-in via cloud-capable network.
  let cloudPublisher: CloudPublisher | null = null;
  const hasCloudNetworks = config.networks.some((n) => !!n.cloud);
  if (hasCloudNetworks) {
    const networkResolver = createNetworkResolver(config);
    // TC-4e (#627 Phase 4) — optional client-cert material for the
    // publisher→Worker HTTPS leg, gated by the same `security.transport.mtls`
    // posture as the bus links. `off` (default) ⇒ undefined ⇒ ordinary
    // server-auth HTTPS, byte-identical to today; `require` fails closed at
    // boot if the cert/key/ca are missing/invalid.
    const cloudMtls = buildHttpsMtlsMaterial(
      config.security.transport.mtls,
      config.security.transport.tls,
      { site: "cloud-publisher" },
    );
    cloudPublisher = new CloudPublisher({
      networkResolver,
      ...(cloudMtls !== undefined && { mtls: cloudMtls }),
    });
    const networkIds = config.networks.filter((n) => n.cloud).map((n) => n.id);
    console.log(`cortex: cloud publisher active (networks: ${networkIds.join(", ")})`);
    CloudPublisher.checkEndpoints(networkResolver, networkIds, cloudMtls).catch((err: unknown) => {
      console.error("cortex: endpoint health check error:", err instanceof Error ? err.message : String(err));
    });
  }

  // Adapters (Discord + Mattermost).
  const adapters: PlatformAdapter[] = [];
  const adapterCleanup: (() => void)[] = [];

  // GW.a.3b.2c (cortex#524) — the surface ownership plan. When
  // `CORTEX_GATEWAY` is set, the shared surface gateway (constructed below via
  // `startGatewayIfEnabled`) builds ONE adapter per `surfaces:` binding on the
  // SAME bot token the fold also wrote into `agents[].presence.{platform}`.
  // Starting the per-stack adapter too would double-connect that bot identity
  // and double-deliver every message (the §1.2 bug). The plan is the single
  // place that computes the per-stack suppression keys, Gateway adapter ids,
  // and outbound stack pairs.
  //
  // SAFETY: the plan returns an EMPTY suppression set when the flag is off (or
  // no surfaces are configured). An empty set makes every `.has(...)` below
  // false → no `continue` → the per-stack loops are byte-identical to the
  // pre-GW boot. `CORTEX_GATEWAY` is off on every live stack, so this is a
  // true no-op on the live boot path.
  const surfaceOwnershipPlan = planSurfaceOwnership({
    surfaces: options.surfaces,
    gatewayEnabled: isGatewayEnabled(process.env),
    principal: principalId,
  });
  const gatewayOwned = surfaceOwnershipPlan.ownedSurfaceKeys;

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
  // resolved across adapters. Pass 1 starts each adapter with its principal-
  // explicit `trustedBotIds` set (the cross-process bridge list from
  // cortex.yaml) and registers each agent's freshly-learned bot user id in
  // the TrustResolver. Pass 2 walks each adapter's `agent.trust[]` list,
  // asks the resolver for each peer's bot id, and merges the result into
  // the adapter's allowlist via `setTrustedBotIds`. The split is required
  // because adapter A's `trust` list may reference adapter B, and B's
  // platform id is only known after B's `client.login()` resolves.
  //
  // Started Discord state carried between passes. We capture the adapter,
  // its declaring agent, and the principal-explicit set as a baseline so
  // Pass 2 can produce the merged set in one place (explicit ∪ resolved
  // peers) without re-parsing the instance.
  interface StartedDiscord {
    adapter: DiscordAdapter;
    agent: Agent;
    instance: AgentConfig["discord"][number];
    instanceId: string;
    explicitTrustedBotIds: ReadonlySet<string>;
  }
  const startedDiscord: StartedDiscord[] = [];

  // cortex#486 — `adapterPolicyEngine` / `adapterPolicyLookup` /
  // `adapterPolicyRegistry` are constructed above (before the
  // DispatchHandler) so the dispatch-source publish path can consume the
  // engine for `(platform, authorId) → principal_id` resolution. The
  // three values are shared with the adapter loops below verbatim.

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
    // Schema defaults already applied by `AgentConfigSchema` at load time —
    // this is a structural mapping, not a parse.
    //
    // cortex#98 (part A): `trustedBotIds` carries the principal-explicit
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
      // cortex#709 — DM stack-ownership. Threaded verbatim from the legacy
      // instance shape; the adapter drops DM-scoped messageCreate early when
      // false. Defaults to true at the schema layer (back-compat).
      dmOwner: instance.dmOwner,
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
    // GW.a.3b.2c — the gateway owns this surface; yield it so we don't
    // double-connect the same bot token. `gatewayOwned` is empty when
    // CORTEX_GATEWAY is off → this is never taken on the live boot path. The
    // suppressed instance never enters `startedDiscord`, so the Pass-2 trust
    // merge / outbound-poller bookkeeping simply never sees it.
    if (gatewayOwned.has(`discord:${agent.id}`)) {
      console.log(
        `cortex: per-stack discord adapter for agent "${agent.id}" suppressed — the shared surface gateway owns this surface (CORTEX_GATEWAY).`,
      );
      continue; // skip — the gateway owns this connection
    }
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
          principal: {
            ...(options.principal?.discordId !== undefined && { discordId: options.principal.discordId }),
          },
          runtime,
          systemEventSource,
          trustedBotIds: explicitTrustedBotIds,
          ...(adapterPolicyEngine !== undefined && { policyEngine: adapterPolicyEngine }),
          ...(adapterPolicyLookup !== undefined && { policyLookup: adapterPolicyLookup }),
          ...(adapterPolicyRegistry !== undefined && { policyRegistry: adapterPolicyRegistry }),
          // cortex#205: plumb the principal's configured subject patterns
          // through to the surface-router. Pass the array verbatim — `[]`
          // included — so the adapter's one-shot empty-array warning at
          // `discord/index.ts:178` actually fires for the "principal
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
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg, targetAgentForDispatch(agent, configDir)));
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
  // bot ids on top of each adapter's principal-explicit set, and log the
  // final allowlist size per adapter. Peers absent from the resolver
  // (cross-process — they live in a different cortex deployment) are
  // silently skipped; the principal-explicit field in
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
    // GW.a.3b.2c — yield to the gateway when it owns this surface (see the
    // Discord block above). `gatewayOwned` is empty when CORTEX_GATEWAY is off,
    // so this never fires on the live boot path. The Mattermost loop pushes
    // nothing to a later bookkeeping pass, so skipping is a clean `continue`.
    if (gatewayOwned.has(`mattermost:${agent.id}`)) {
      console.log(
        `cortex: per-stack mattermost adapter for agent "${agent.id}" suppressed — the shared surface gateway owns this surface (CORTEX_GATEWAY).`,
      );
      continue; // skip — the gateway owns this connection
    }
    try {
      const adapter = new MattermostAdapter(
        agent,
        presence,
        {
          instanceId,
          principal: {
            ...(options.principal?.mattermostId !== undefined && { mattermostId: options.principal.mattermostId }),
          },
          ...(adapterPolicyEngine !== undefined && { policyEngine: adapterPolicyEngine }),
          ...(adapterPolicyLookup !== undefined && { policyLookup: adapterPolicyLookup }),
          ...(adapterPolicyRegistry !== undefined && { policyRegistry: adapterPolicyRegistry }),
        },
      );
      router.register(adapter.surfaceConfig);
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg, targetAgentForDispatch(agent, configDir)));
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
  // Pass 1 starts each adapter with its principal-explicit trustedBotIds
  // set + registers the adapter's bot user id in the TrustResolver.
  // Pass 2 walks each adapter's `agent.trust[]` list, resolves peer
  // agent ids to in-process Slack user ids via the resolver, merges
  // those into the adapter's allowlist via `setTrustedBotIds`, and
  // calls `attachInboundDispatch` to drain any pre-merge queued events
  // (Slack's analogue to discord.js's gateway-buffered events).
  interface StartedSlack {
    adapter: SlackAdapter;
    agent: Agent;
    instance: AgentConfig["slack"][number];
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
    // Schema defaults have already been applied by `AgentConfigSchema` —
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
    // GW.a.3b.2c — yield to the gateway when it owns this surface (see the
    // Discord block above). `gatewayOwned` is empty when CORTEX_GATEWAY is off,
    // so this never fires on the live boot path. The suppressed instance never
    // enters `startedSlack`, so the Pass-2 trust merge never sees it.
    if (gatewayOwned.has(`slack:${agent.id}`)) {
      console.log(
        `cortex: per-stack slack adapter for agent "${agent.id}" suppressed — the shared surface gateway owns this surface (CORTEX_GATEWAY).`,
      );
      continue; // skip — the gateway owns this connection
    }
    try {
      const adapter = new SlackAdapter(
        agent,
        presence,
        {
          instanceId,
          principal: {
            ...(options.principal?.slackId !== undefined && { slackId: options.principal.slackId }),
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
      await adapter.start((msg) => dispatchHandler.handleMessage(adapter, msg, targetAgentForDispatch(agent, configDir)));
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
  // bot ids on top of each adapter's principal-explicit set, log the
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
  // classes covering `local.{principal}.system.>` so an operational alert
  // reliably reaches the principal even if one sink is the thing that
  // broke. Renderers never publish on the bus (architecture §9.3).
  // cortex#269 — substitute `{principal}` AND `{stack}` in renderer subscribe
  // patterns so they resolve against the same canonical shape that
  // `MyelinRuntime` already substitutes for `nats.subjects`. Without
  // this, a principal-written `local.{principal}.{stack}.system.>` pattern
  // never matches an actual envelope's wire subject. The `{stack}.`
  // placeholder includes the trailing dot so stack-less deployments
  // collapse cleanly to `local.{principal}.system.>`.
  //
  // cortex#279 cycle 2 — extracted to a shared helper so renderer- and
  // runtime-side substitution can't drift. The stack-less branch
  // (`{stack}.` → empty) mirrors `MyelinRuntime.publish`'s same-named
  // helper, satisfying Sage's "renderer stack-less collapse missing"
  // finding even though `derivedStack.stack` is currently always
  // defined in production. Symmetric logic keeps future refactors
  // honest if the boot ever passes `undefined`.
  const subjectPlaceholderSubstituter = makeSubjectPlaceholderSubstituter({
    // cortex#427 — renderer subscribe-pattern substitution reads the
    // shared `principalId` so renderer subjects and runtime-side emit
    // subjects can't drift. R4 (cortex#453) renamed the helper field
    // from `org` to `principal` so the parameter name matches the
    // subject grammar canonicalised in myelin#185.
    principal: principalId,
    stack: options.stack !== undefined ? derivedStack.stack : undefined,
  });

  const renderers: Renderer[] = [];
  for (const raw of config.renderers ?? []) {
    // AgentConfig types renderers as z.unknown() so legacy bot.yaml loads
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
  // verify against the principal's NKey roster. The pre-Phase-B
  // authorization-without-authentication gap is closed.
  if (resolvedPolicy?.principals.length === 0) {
    console.warn(
      `cortex: policy: block declared with empty principals[] — no authorisation gate engages; the dispatch-listener stays on the legacy path.`,
    );
  }
  const policyEngine = policyEngineFromConfig(resolvedPolicy);
  if (policyEngine !== undefined) {
    console.log(
      `cortex: policy-engine active — principals=${policyEngine.principalCount} roles=${policyEngine.roleCount} (signed_by chain verified; empty chains accepted for adapter-originated dispatches)`,
    );
  }

  // Dispatch-listener — bus envelope → CC spawn.
  //
  // v2.0.2 (cortex#320): also receives `trustResolver` + `receivingAgentId`
  // + `principalId` so the listener can chain-verify every inbound
  // envelope. Mirrors the `BusDispatchListener` wiring above
  // (`firstAgent.id` + `principalId`). `cryptoVerify` defaults to `true`
  // in `createDispatchListener`; explicit here for principal clarity.
  //
  // cortex#427 — `principalId` is the shared `{principal}` segment so
  // the listener subscribes on the SAME segment the adapter publishes
  // on. PR-R2a (cortex#439) renamed the constructor parameter to
  // `principalId` to match the canonical vocabulary.
  // cortex#484 Option D — the listener no longer takes a `router`
  // parameter. It consumes envelopes directly from `runtime.onEnvelope`
  // (with a subject filter) rather than registering as a SurfaceAdapter
  // under the surface-router's 5s render-timeout. See
  // `src/runner/dispatch-listener.ts` file-header docblock for the
  // executor-vs-renderer rationale.
  const dispatchListener: DispatchListener = createDispatchListener({
    runtime,
    source: systemEventSource,
    stack: derivedStack.stack,
    ...(policyEngine !== undefined && { policyEngine }),
    trustResolver,
    // TC-0 (#628) — verifier knobs resolved from `security.signing`. `off`/
    // `permissive` → verify but never reject empty adapter chains
    // (`rejectEmpty: false`); `enforce` → reject unsigned (`rejectEmpty:
    // true`). `cryptoVerify` stays `true` across all postures (cheap).
    cryptoVerify: signingKnobs.cryptoVerify,
    rejectEmpty: signingKnobs.rejectEmpty,
    principalId,
    ...(firstAgent !== undefined && { receivingAgentId: firstAgent.id }),
    // cortex#480 — implicit own-stack trust. Adapter-originated
    // dispatches are signed by the stack identity (`did:mf:<principal>-
    // <stack>`) via MyelinRuntime.publish; without this the verifier
    // rejects them as `unknown_agent` because the stack is not in the
    // agent registry. The stack is the RECEIVER; trust is implicit.
    ...(signer !== undefined && { stackIdentity: signer.principal }),
    ...(stackNKeyPubForVerifier !== undefined && {
      stackNKeyPub: stackNKeyPubForVerifier,
    }),
    // TC-1c (#552) — Shape B re-sign on ingest. Hand the dispatch-listener
    // the SAME stack signer the runtime uses, so an empty-chain inbound
    // envelope (a gateway Shape-A injection or adapter-originated dispatch)
    // is re-stamped with the stack NKey on ingest and becomes
    // cryptographically attributable to this stack. `signer` is non-undefined
    // ONLY when `security.signing` resolved `attachSigner: true`
    // (`permissive`/`enforce`) AND a stack seed loaded — so under
    // `signing: off` (the default) `resignSigner` is omitted entirely and
    // ingest stays pure Shape A (byte-identical to today). The empty-chain
    // gate inside the listener prevents double-stamping already-signed
    // traffic.
    ...(signer !== undefined && { resignSigner: signer }),
    // TC-2d (cortex#635) — federated.* peer-pubkey resolution seam.
    // Inert for local.* dispatches; `undefined` under off/permissive.
    ...(resolveFederatedPeer !== undefined && { resolveFederatedPeer }),
    // cortex#127 — RECEIVING-STACK-AUTHORITATIVE bash allowlist. Thread the
    // executing stack's OWN `claude.bashAllowlist` config to the listener so
    // every bus-mediated dispatch's CC session gets `CORTEX_BASH_GUARD` set
    // (the bus path previously dropped it — the guard hook then fell through
    // to an unanswerable `claude --print` permission prompt and bounced every
    // allowlisted command, blocking GUILD-only stacks). Spread-guarded like
    // the other optional fields so an unconfigured stack stays default-deny.
    // Never wire-supplied: the payload has no bash_allowlist by design.
    // (No `claude.bashGuardDisabled` config field exists, so it is not passed
    // here; the listener option remains available for a future config knob.)
    ...(config.claude.bashAllowlist !== undefined && {
      bashAllowlist: config.claude.bashAllowlist,
    }),
  });
  await dispatchListener.start();

  // signal#113 P-11 (#56) — federated echo responder. The ICMP-analog of the
  // agent network: answers a reserved `probe.echo` capability IN THE RUNTIME
  // (no harness, no `claude`, no Discord, no tools) on our own
  // `federated.{us}.{stack}.tasks.*.>` subject. Always-on between configured
  // `peers[]` (the responder only ever answers a mutually-configured, gated
  // peer; absent/forged originator or a non-peer is dropped fail-closed; the
  // reply is exactly-one-bounded, keyed to the originator-attributed requester
  // scope, per-source rate-limited — no amplification). Dormant when no
  // `policy.federated.networks[]` is declared (no peers ⇒ nothing to answer).
  const probeResponderNetworks = new Map(
    (options.policy?.federated?.networks ?? []).map((n) => [n.id, n] as const),
  );
  const probeResponder: ProbeResponder = createProbeResponder({
    runtime,
    source: systemEventSource,
    stack: derivedStack.stack,
    federatedNetworksById: probeResponderNetworks,
    // PR #822 NIT-2 — stamp OUR residency on the replies we author (not the
    // requester-supplied inbound one). `undefined` → the responder defaults NZ.
    ...(systemEventSource.dataResidency !== undefined && {
      dataResidency: systemEventSource.dataResidency,
    }),
  });
  await probeResponder.start();
  console.log(
    `cortex: probe-responder started — subjects=[${probeResponder.subjects.join(", ")}], ` +
      `peers-networks=${probeResponderNetworks.size}`,
  );

  // cortex#491 — dispatch sink (OUTBOUND). The single delivery path for
  // dispatch lifecycle replies (CONTEXT.md §Dispatch-sink). Subscribes to
  // `local.{principal}[.{stack}].dispatch.task.>` via the runtime
  // (symmetric with the runner's self-subscribe — NOT via
  // `surfaceSubjects`, which would be a second, double-replying path),
  // filters each lifecycle envelope to the adapter instance named by its
  // echoed `response_routing` (cortex#491 plumbing), renders the text via
  // `formatDispatchLifecycle` (cortex#497), and posts back to the exact
  // originating channel/thread via `adapter.postResponse` /
  // `adapter.sendProgress`. Dormant when the runtime is disabled (no
  // NATS) or no adapters started.
  const dispatchSink: DispatchSink = createDispatchSink({
    runtime,
    adapters,
    principal: principalId,
    // `derivedStack.stack` is always defined in production (boot derives a
    // stack id); pass it so the sink's subscribe pattern lands on the same
    // 6-segment grammar the runtime publishes lifecycle envelopes on. The
    // dispatch-listener wiring above passes `derivedStack.stack` the same
    // way.
    stack: derivedStack.stack,
  });
  await dispatchSink.start();
  console.log(
    `cortex: dispatch-sink started — subjects=[${dispatchSink.subjects.join(", ")}], ` +
      `adapters=${adapters.length}`,
  );

  // cortex#502 — review sink (OUTBOUND). The SOLE deliverer of review
  // replies (verdict + lifecycle) back to the originating surface. An
  // ADDITIONAL `onEnvelope` subscriber alongside the chat dispatch sink:
  // subscribes to `local.{principal}[.{stack}].dispatch.task.>` AND
  // `…review.verdict.>`, reads each envelope's echoed LOGICAL routing
  // (`response_routing` = `{ surface, channel, thread? }` — repo→channel,
  // entity→thread per the channel-routing SOP), filters to the surface a
  // driven adapter matches, resolves logical→native via
  // `adapter.resolveLogicalTarget`, renders the verdict one-liner via
  // `formatReviewVerdict` (+ a requester ping) / the lifecycle via
  // `formatDispatchLifecycle`, and posts back. NOT wired via
  // `surfaceSubjects` (that would double-reply). Dormant when the runtime
  // is disabled (no NATS) or no adapters started.
  // ML.5 — attention notifications (system.attention.*) render to the configured
  // cockpit channel. Only wired when a channel is set; otherwise the sink ignores
  // attention envelopes (unchanged behaviour).
  const attn = config.cockpit.attention;
  const attentionRouting =
    attn.channel !== ""
      ? { surface: attn.surface, channel: attn.channel, ...(attn.thread !== undefined && { thread: attn.thread }) }
      : undefined;
  const reviewSink: ReviewSink = createReviewSink({
    runtime,
    adapters,
    principal: principalId,
    stack: derivedStack.stack,
    ...(attentionRouting !== undefined && { attentionRouting }),
  });
  await reviewSink.start();
  console.log(
    `cortex: review-sink started — subjects=[${reviewSink.subjects.join(", ")}], ` +
      `adapters=${adapters.length}`,
  );

  // cortex#480 + TC-1b (#632) — boot-time self-signed envelope sanity check,
  // posture-aware. After the listeners are wired with `stackIdentity` +
  // `stackNKeyPub`, build a tiny envelope signed by the stack's own NKey and
  // round-trip it through `verifySignedByChain` to confirm the verifier
  // admits it. The check exists because the cortex#480 root-cause (verifier
  // rejecting `did:mf:<stack>` as unknown_agent) shipped to prod unnoticed —
  // no boot-side observability exercised the identity the wire would actually
  // carry.
  //
  // TC-1b makes the gate **posture-aware** (per design §Phase 1.1b
  // "`verifier-self-check` passes on every stack at boot"):
  //   - `enforce` → a missing OR unverifiable stack identity FAILS FAST: the
  //     gate throws, the catch below maps it to a fatal boot error and the
  //     CLI exits non-zero. A stack serving SIGNED traffic must not run with
  //     an identity its own verifier rejects.
  //   - `permissive`/`off` → advisory: WARN on failure (or when no identity
  //     is wired, no-op), boot continues — the pre-TC-1b behaviour.
  //
  // We `await` (not fire-and-forget) so the `enforce` throw can abort boot
  // deterministically before the router starts admitting envelopes. The
  // grep-friendly `verifier-self-check` stderr line is preserved for
  // pilot-loop / on-call pattern matching.
  if (firstAgent !== undefined) {
    const selfCheckIdentity =
      signer !== undefined && stackNKeyPubForVerifier !== undefined
        ? {
            stackIdentity: signer.principal,
            stackNKeyPub: stackNKeyPubForVerifier,
            stackSeedBytes: signer.rawSeedBytes,
          }
        : undefined;
    await bootVerifierSelfCheck({
      posture: config.security.signing,
      identity: selfCheckIdentity,
      resolver: trustResolver,
      receivingAgentId: firstAgent.id,
      principalId,
    });
  } else if (config.security.signing === "enforce") {
    // No agents at all under `enforce` — there is no `receivingAgentId` to run
    // the self-check against, but a stack with no agents cannot serve signed
    // traffic meaningfully either. Refuse to boot with the same fail-fast
    // posture so a misconfigured enforce stack does not start silently.
    throw new Error(
      "verifier-self-check: REFUSING TO BOOT — security.signing=enforce but no " +
        "agents are configured; cannot run the boot self-check. Configure at " +
        "least one agent, or drop signing to permissive/off.",
    );
  }

  // Start router AFTER all surfaces register so the first envelope
  // (which may arrive synchronously after `runtime.onEnvelope`) fans
  // out to every registered adapter.
  await router.start();

  // Config watcher (hot-reload for safe fields).
  //
  // G-1114.C.1 — the agent-presence producer is constructed LATER (the
  // MC-registry block below), but the config-reload onChange handler needs a
  // reference to emit `agent.capabilities-changed` on a mid-life capability
  // drift. Forward-declare the holder here and read it lazily inside the
  // closure (it's still `null` until the registry block assigns it — a reload
  // that races boot before the producer exists simply skips the emit).
  let presenceProducerForReload: AgentPresenceProducer | null = null;
  let configWatcher: ConfigWatcher | null = null;
  if (
    !options.disableConfigWatcher
    && options.configPath
    && existsSync(expandedConfigPath)
  ) {
    configWatcher = new ConfigWatcher(expandedConfigPath, config, (event) => {
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

      // G-1114.C.1 — capability-delta re-emit (THE FINDING, honest scope).
      //
      // Per-agent capabilities live on `Agent.runtime.capabilities[]` (the
      // agents.d/ fragments), NOT on `AgentConfig` (the `event.config` this
      // reload carries) — and the ConfigWatcher does not rebuild `mergedAgents`.
      // So today capabilities are effectively RESTART-ONLY: the only daemon-level
      // watcher is this one, it fires on the bot.yaml/pointer config (not on a
      // fragment edit), and a fresh capability set normally arrives via the next
      // boot's `agent.online`. This block is the defensive EMIT side: when a
      // reload DOES fire, we re-scan the agents.d/ fragments (the same load boot
      // does) and ask the producer to diff each known agent's capability set
      // against its tracked baseline — emitting `agent.capabilities-changed` only
      // on a real delta. It is a no-op in the common case (no fragment changed,
      // or no producer yet), and becomes a live hot-reload path the moment a
      // capability fragment is edited under a watched config dir. Best-effort:
      // a fragment re-load fault must never break the rest of the reload.
      const producer = presenceProducerForReload;
      if (producer !== null) {
        try {
          const freshFragments = loadAgentsDirectory(agentsDir);
          const freshById = new Map(freshFragments.map((a) => [a.id, a]));
          let emitted = 0;
          for (const prior of mergedAgents) {
            const fresh = freshById.get(prior.id);
            if (fresh === undefined) continue; // removed/renamed — not a cap delta
            const caps = fresh.runtime?.capabilities ?? [];
            if (producer.publishCapabilitiesChanged(prior.id, caps)) emitted += 1;
          }
          if (emitted > 0) {
            console.log(
              `cortex: agent-presence — emitted ${emitted} agent.capabilities-changed on reload`,
            );
          }
        } catch (err) {
          // FragmentLoadError or any re-scan fault: log + carry on. The producer
          // keeps its prior baseline; the next clean reload (or restart) reconciles.
          process.stderr.write(
            `cortex: capabilities-changed re-scan skipped on reload — ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    });
    configWatcher.start();
  }

  // MC-I1.S1 (ADR-0005): in-process Mission Control embed — opt-in via `config.mc.enabled`.
  // The legacy `api.*` embedded-dashboard path (G-201) was retired per ADR-0005 /
  // #712 (its dynamic import never migrated from grove-v2 and threw on every
  // boot) and its schema block was dropped in #882, so there is no longer an
  // `api.enabled` to nudge off — `mc:` is the only embedded-dashboard path.
  let mcHandle: MissionControlHandle | null = null;
  let mcDb: BunDatabase | null = null;
  // G-1114.B.4 — mutable holder threaded into the MC server as a lazy getter so
  // `GET /api/agents` can read the stack-local agent-presence registry. The
  // registry boots AFTER this embed (below), so the getter returns `null` until
  // we assign it post-registry-start. The MC server resolves it per request.
  let presenceViewForApi: AgentPresenceView | null = null;
  // #1008 — discovered LOCAL sibling stacks, computed ONCE here and shared by
  // BOTH the DB-read pane-of-glass aggregation (the embed's `localAggregation`
  // getter, below) AND the #989 bus sibling-presence aggregator (later) — so the
  // two paths agree on the same roster and the dbRead-supersedes-bus gate is
  // coherent. Empty until the aggregation block computes it; the getter reads
  // this holder lazily (the embed starts before discovery runs).
  const aggCfg = config.mc.aggregateLocalStacks;
  let discoveredSiblings: readonly SiblingStackDescriptor[] = [];
  let siblingResolveOpts: SiblingDbResolveOptions | null = null;
  if (config.mc.enabled && !options.disableDashboard) {
    // Per-slug default keeps each stack's MC db isolated; the cursor lands beside it.
    const defaultDbPath = join(
      homedir(), ".local", "share", "cortex", "mc", derivedStack.stack, "mission-control.db",
    );
    const dbPath = config.mc.dbPath !== "" ? expandTilde(config.mc.dbPath) : defaultDbPath;

    // #1008 — discover the principal's LOCAL sibling stacks (reusing #989's
    // `discoverSiblingStacks` for the stack LIST; the DB-read path needs the
    // roster, not the bus part). The DB-read aggregation context resolves each
    // sibling's `mission-control.db` per-request and excludes THIS stack's own
    // db (`selfDbPath = dbPath`). Built only when `aggregateLocalStacks.enabled`
    // AND `dbRead` are both on; otherwise the context getter returns null and
    // the feeds stay single-db.
    if (aggCfg.enabled && aggCfg.dbRead) {
      try {
        const configRoot =
          aggCfg.configRoot !== ""
            ? expandTilde(aggCfg.configRoot)
            : dirname(configDir);
        const explicit =
          aggCfg.stacks.length > 0
            ? aggCfg.stacks.map((s) => ({
                stack: s.stack,
                principal: s.principal,
                url: s.url,
                credential: { kind: "creds" as const, credsPath: s.credsPath },
              }))
            : undefined;
        discoveredSiblings = discoverSiblingStacks({
          configRoot,
          selfPrincipal: principalId,
          selfStack: derivedStack.stack,
          ...(explicit !== undefined && { explicit }),
        });
        siblingResolveOpts = { configRoot, selfDbPath: dbPath };
        console.log(
          `cortex: pane-of-glass DB-read aggregation ON — ${discoveredSiblings.length} local sibling stack(s) ` +
            `(${discoveredSiblings.map((s) => s.stack).join(", ") || "none"})`,
        );
      } catch (err) {
        // Discovery failure must never block the embed boot — degrade to single-db.
        console.error(
          "cortex: pane-of-glass sibling discovery error (non-fatal, single-db feed):",
          err instanceof Error ? err.message : err,
        );
      }
    }
    try {
      mcHandle = await startMissionControl({
        configPath: config.mc.configPath || undefined,
        dbPath,
        port: config.mc.port,
        agentPresence: () => presenceViewForApi,
        // #1008 — DB-read pane-of-glass aggregation. The getter returns a context
        // only when discovery produced a resolve-opts (dbRead on); otherwise null
        // ⇒ single-db feeds. Lazy so the roster can be (re)read consistently.
        localAggregation: (): LocalAggregationContext | null =>
          siblingResolveOpts === null
            ? null
            : { siblings: discoveredSiblings, resolve: siblingResolveOpts },
        // P-14 U0.1 — Tier-3 sideband proxy. Loopback-enforced at config-parse
        // time; the embed wires it onto the `/api/observability/*` proxy.
        sidebandUrl: config.mc.sideband,
      });
      mcDb = mcHandle.db;
      console.log(`cortex: Mission Control embed listening on http://localhost:${mcHandle.port} — db ${dbPath}`);

      // MC-I1.S4/S6 (ADR-0005 §3/§4) — register the bus→MC projection renderer.
      // The seam is a surface-router renderer (§4) with a single project()
      // dispatcher: S4 lands `dispatch.task.*` lifecycle envelopes as
      // session/assignment rows; S6 (#848) generalises it to review verdicts,
      // agent heartbeats, federated attention, and adapter health. Its render()
      // is non-throwing (the surface-router isolates errors too, but the
      // renderer owns the contract). The embed's `wsRegistry` is threaded in so
      // projected mutations broadcast `mc.projection` refresh signals to live
      // dashboard clients (S6 — closes the S4 WS fan-out gap). No
      // restart-on-config — like every renderer, the registration is static for
      // the daemon's lifetime.
      //
      // MC-I1.S7 (#849) — the event-driven failed_dispatch attention producer
      // rides this same seam. We stamp it with the stack id and funnel its
      // open/resolve delta onto the SAME `system.attention.*` bus path the
      // cockpit loop uses — via the established `publishReconcileDelta` builder
      // (attention-notify.ts) with the same notifySource the loop uses. This
      // makes failed_dispatch attention work whenever `mc.enabled`, independent
      // of `cockpit.enabled` (it's event-driven, not state-derived). The
      // deep-link for a session-anchored item is the dashboard drill-down route.
      const mcBaseUrl =
        config.grove.baseUrl !== "" ? config.grove.baseUrl : `http://localhost:${mcHandle.port}`;
      router.register(
        createDispatchProjectionRenderer(mcDb, mcHandle.wsRegistry, {
          stackId: derivedStack.stack,
          publishDelta: async (delta) => {
            await publishReconcileDelta(
              delta,
              {
                source: { principal: principalId, agent: "cortex", instance: "local" },
                deepLinkFor: (item) =>
                  item.sessionId !== null ? `${mcBaseUrl}/sessions/${item.sessionId}` : null,
              },
              (env) => runtime.publish(env),
            );
          },
        }),
      );
      console.log("cortex: Mission Control bus→MC projection renderer registered (dispatch + verdicts + heartbeats + attention + adapter health + failed-dispatch)");
      // P-14 U2.1 (#934) — the observability projection renderer for signal's
      // four system.* families. Its OWN surface-router renderer (own id +
      // subjects); shares the embed's db + wsRegistry so its rows + att:adapter:
      // attention items push the `observability` / `attention` mc.projection
      // refresh families to live dashboard clients. Federation/transport are
      // hub-emitted — on a non-hub stack the renderer simply never receives
      // those subjects, so the tab's federation/transport sections stay honestly
      // empty (no synthesized rows).
      router.register(createObservabilityProjectionRenderer(mcDb, mcHandle.wsRegistry));
      console.log("cortex: Mission Control observability projection renderer registered (signal + collector + federation + transport)");
    } catch (err) {
      console.error("cortex: Mission Control embed startup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // G-1114.B.2 + B.3 — live agent-presence producer + runtime registry
  // subscriber (STACK-LOCAL ONLY — no federation; that is Phase E).
  //
  // #1003 — the PRODUCER (publish side) is DECOUPLED from `config.mc.enabled`;
  // the consuming REGISTRY (+ federated/sibling subscribers + WS broadcast) stay
  // MC-gated. The split follows ADR-0007: presence is a BUS concern — "this
  // agent process is up and consuming" — independent of whether this stack ALSO
  // serves an MC dashboard. So:
  //
  //   - The PRODUCER runs whenever the stack hosts ≥1 agent on the bus,
  //     REGARDLESS of `mc.enabled`. A non-dashboard stack (work/halden) must
  //     still PUBLISH `local.{principal}.{stack}.agent.{online,heartbeat,offline}`
  //     so #989's multi-bus aggregator (running on the dashboard stack) has
  //     something to render. The producer's only deps are the bus runtime
  //     (`runtime.publish`) + the hosted-agent roster + heartbeat config — NOT
  //     the MC db / dashboard / registry. (No agents ⇒ no producer: nothing to
  //     announce, so an empty roster constructs nothing.)
  //   - The REGISTRY + federated/sibling subscribers + the WS broadcast stay
  //     gated on `config.mc.enabled`: they CONSUME presence to render the B.4
  //     agents panel + Network view. A non-dashboard stack only needs to PUBLISH
  //     its own presence, not CONSUME others' — so it does not subscribe.
  //
  // Both halves are best-effort: a fault logs + boot continues. Independent of
  // `disableDashboard`: the registry is pure bus wiring (no MC DB / no HTTP
  // port), so the MC-gated consumer half runs on `mc.enabled` even when the HTTP
  // embed is skipped (tests that disable the embed but still want the roundtrip).
  //
  // Ordering when MC is on: the REGISTRY subscriber starts FIRST (in the MC
  // block) so it's listening before the producer's `agent.online` envelopes go
  // out below — the roundtrip lands the hosted agents in the registry
  // immediately. With MC off, the producer simply publishes onto the bus with no
  // local consumer.
  //
  // `runtime.publish` is a no-op when the runtime is dormant (no NATS), so this
  // is safe to run without a bus — the producer emits into the void.
  //
  // Liveness FSM (G-1114.C.3): `startAgentPresenceRegistry` starts the 5-min
  // TTL reaper by default — an `online` record whose `agent.heartbeat` stops for
  // longer than PRESENCE_LIVENESS_TTL_MS transitions to `offline`
  // (reason `ttl_lapse`, distinct from a graceful `agent.offline`), firing
  // onChange → the WS broadcast below → the live panel. The reaper interval is
  // owned by the registry handle and stopped by `presenceRegistryHandle.stop()`
  // in the shutdown drain (the "agent-presence registry stop" slot), so no
  // separate drain slot is needed.
  let presenceRegistryHandle: AgentPresenceRegistryHandle | null = null;
  let presenceProducer: AgentPresenceProducer | null = null;
  // G-1114.E.2 — trust-verified federated presence subscriber (folds peers'
  // agents into the SAME registry, tagged with foreign provenance).
  let federatedPresenceHandle: FederatedAgentPresenceSubscriberHandle | null = null;
  // P-14 U3.3 (#937) — trust-verified federated OBSERVABILITY fold (folds peers'
  // curated+signed system.{transport,federation}.* into the observability
  // projection, ORIGIN-BADGED — the Option-D sibling of the presence subscriber).
  let federatedObservabilityHandle: FederatedObservabilityFoldHandle | null = null;
  // #989 part-1 — LOCAL same-principal sibling-stack presence aggregator (folds
  // the principal's OTHER local stacks' agents into the SAME registry, tagged by
  // sibling origin, so the Network view shows every local stack as its own hub).
  let siblingPresenceHandle: SiblingPresenceAggregatorHandle | null = null;
  // G-1114.E.1 — federate presence ONLY when the stack has opted into
  // federation (it declares at least one `policy.federated.networks[]`). This is
  // the SAME opt-in lever the federated subscriber + the dispatch-listener gate
  // use — a stack with no networks emits local-only presence (default OFF). When
  // on, the producer dual-emits a `classification: "federated"` copy so peers'
  // E.2 subscribers can fold it (the existing federated-classification
  // mechanism, not a new toggle).
  const federatePresence =
    (resolvedPolicy?.federated?.networks ?? []).length > 0;
  // The onChange→WS-broadcast subscription handle, captured so shutdown can
  // unsubscribe it explicitly — making teardown order-independent rather than
  // relying on the registry stop severing the envelope feed first (#899 review).
  let presenceBroadcastSub: { unsubscribe: () => void } | null = null;

  // #1003 — build the per-agent presence descriptors ONCE, BEFORE both the
  // MC-gated consumer block and the unconditional producer block, so the
  // producer is constructed exactly once (no double-construct across the two
  // paths). The stack's own NKey pubkey is the fallback identity for any agent
  // that hasn't declared its own `nkey_pub`. #1006: this uses
  // `stackNKeyPubForPresence` (declared `stack.nkey_pub` OR the seed-loaded
  // key) rather than `stackNKeyPubForVerifier` (set only when signing is on),
  // so a `signing: off` stack still announces its keyless agents. Agents with
  // no resolvable key are skipped (the presence payload requires a non-empty
  // key).
  const presenceAgents: PresenceAgent[] = [];
  {
    let skippedNoKey = 0;
    for (const a of mergedAgents) {
      const pa = presenceAgentFromAgent(
        a,
        { principal: principalId, stack: derivedStack.stack },
        stackNKeyPubForPresence,
      );
      if (pa === null) {
        skippedNoKey += 1;
        continue;
      }
      presenceAgents.push(pa);
    }
    if (skippedNoKey > 0) {
      console.warn(
        `cortex: agent-presence — ${skippedNoKey} agent(s) skipped (no agent.nkey_pub ` +
          `and no stack NKey to fall back to); they will not appear in the presence registry`,
      );
    }
  }

  // MC-gated CONSUMER half — the registry subscriber + WS broadcast. Starts
  // FIRST (before the producer below) so it's listening before the producer's
  // own `agent.online` envelopes go out, landing the hosted agents in the
  // registry immediately on the local roundtrip.
  if (config.mc.enabled) {
    try {
      presenceRegistryHandle = await startAgentPresenceRegistry({
        runtime,
        principal: principalId,
        stack: derivedStack.stack,
      });
      // G-1114.B.4 — expose the live registry to `GET /api/agents` (the holder
      // the MC embed's lazy getter reads) AND push live updates to dashboard WS
      // clients. The `onChange` seam fires after every applied presence mutation;
      // we broadcast a minimal additive `agent.presence` REFRESH SIGNAL (the
      // panel refetches `/api/agents` on receipt — the frame is not
      // authoritative). Reuses the embed's existing `wsRegistry.broadcast`,
      // matching the S6 `mc.projection` fan-out pattern. Wired here — BEFORE the
      // producer's own `agent.online` goes out below — so the roundtrip's first
      // mutations already push live. Only active when the embed is up
      // (`mcHandle` non-null); on a registry-without-embed boot the holder stays
      // null and there are no WS clients to notify.
      presenceViewForApi = presenceRegistryHandle.registry;
      if (mcHandle !== null) {
        const broadcastWsRegistry = mcHandle.wsRegistry;
        presenceBroadcastSub = presenceRegistryHandle.registry.onChange((key, record) => {
          broadcastWsRegistry.broadcast({
            type: "agent.presence",
            key,
            state: record.state,
          });
        });
      }
    } catch (err) {
      console.error(
        "cortex: agent-presence registry/WS startup error (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // #1003 — PRODUCER half — DECOUPLED from `config.mc.enabled`. Constructed +
  // started whenever the stack hosts ≥1 agent on the bus, so a non-dashboard
  // stack (work/halden) still publishes `agent.{online,heartbeat,offline}` for
  // #989's aggregator to render. Its only deps are the bus runtime + the agent
  // roster + heartbeat config — NOT the MC db/dashboard/registry (see
  // agent-presence-producer.ts: "safe to run unconditionally"). Constructed ONCE
  // here (the roster was built above), never in the MC block — no
  // double-construct. No agents ⇒ no producer (nothing to announce).
  if (presenceAgents.length > 0) {
    try {
      presenceProducer = new AgentPresenceProducer({
        runtime,
        source: {
          principal: principalId,
          stack: derivedStack.stack,
          instance: "local",
          ...(config.agent.dataResidency !== undefined && {
            dataResidency: config.agent.dataResidency,
          }),
        },
        agents: presenceAgents,
        // G-1114.E.1 — opt-in federation dual-emit (default OFF).
        federate: federatePresence,
      });
      presenceProducer.start();
      // G-1114.C.1 — publish the now-started producer to the config-reload
      // onChange handler so a mid-life capability drift can emit
      // `agent.capabilities-changed` without restart (see that handler's block
      // for THE FINDING — restart-only in the common case, this is the
      // defensive emit side). Wired regardless of `mc.enabled` so capability
      // hot-reload tracks presence even on a non-dashboard stack.
      presenceProducerForReload = presenceProducer;
      console.log(
        `cortex: agent-presence producer started — ${presenceAgents.length} agent(s) announced ` +
          `(stack-local${config.mc.enabled ? " + local registry" : ", mc disabled"}; ` +
          `heartbeat every ${DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS}ms)`,
      );
    } catch (err) {
      console.error(
        "cortex: agent-presence producer startup error (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // MC-gated CONSUMER half (cont.) — federated + sibling presence subscribers
  // fold OTHER stacks' agents into the local registry that backs the Network
  // view. A non-dashboard stack has no registry to fold into and does not
  // consume others' presence, so these stay gated on `mc.enabled` and require
  // the registry the MC block above started.
  if (config.mc.enabled && presenceRegistryHandle !== null) {
    try {
      // G-1114.E.2 + E.5 — start the trust-verified federated presence
      // subscriber. INERT (no NATS subscription, no folds) when the stack hasn't
      // opted into federation. When opted in, it folds peers' accept-listed +
      // chain-verified presence into the SAME registry, tagged foreign. Reuses
      // the EXACT trust config the dispatch-listener uses (the federation gate +
      // `verifySignedByChain` + the `resolveFederatedPeer` seam wired only under
      // `signing === "enforce"`) — the registry is an Option-D direct consumer,
      // so it MUST verify foreign presence itself (the surface-router gate does
      // not cover it). See `federated-subscriber.ts` THE DESIGN QUESTION.
      federatedPresenceHandle = await startFederatedAgentPresenceSubscriber({
        runtime,
        registry: presenceRegistryHandle.registry,
        federated: resolvedPolicy?.federated,
        source: systemEventSource,
        trustResolver,
        receivingAgentId: mergedAgents[0]?.id,
        principalId,
        cryptoVerify: signingKnobs.cryptoVerify,
        rejectEmpty: signingKnobs.rejectEmpty,
        ...(signer !== undefined && { stackIdentity: signer.principal }),
        ...(stackNKeyPubForVerifier !== undefined && {
          stackNKeyPub: stackNKeyPubForVerifier,
        }),
        ...(resolveFederatedPeer !== undefined && { resolveFederatedPeer }),
      });

      // P-14 U3.3 (#937) — the trust-verified federated OBSERVABILITY fold, the
      // observability sibling of the presence subscriber above. Reuses the EXACT
      // same trust config (federation gate + `verifySignedByChain` + the
      // `resolveFederatedPeer` seam) PLUS cortex's curation gate (ALLOW
      // system.{transport,federation}.>; DENY trace/metric/log/session/
      // system.signal — signal#141). Folds peers' curated+signed substrate
      // observability into the SAME observability projection the U2.1 renderer
      // writes, but ORIGIN-BADGED foreign (chain-verified `{principal}/{stack}`),
      // and NEVER opening a local attention item. The U2.1 renderer was narrowed
      // to `local.*` at U3.3, so the federated path is exclusively this verified
      // fold — no double-fold. INERT when federation isn't opted into. Needs
      // `mcDb` (the projection target); on the mc.enabled boot it is non-null.
      if (mcDb !== null) {
        const observabilityFoldDb = mcDb;
        const observabilityFoldWs = mcHandle?.wsRegistry;
        federatedObservabilityHandle = await startFederatedObservabilityFold({
          runtime,
          // The injected projection write — bus/ never imports surface/mc/, so
          // the DB write is wired here. Non-throwing: projectForeignObservability
          // never throws on a valid envelope; a defensive guard keeps a poison
          // peer envelope from perturbing the verify fan-out.
          foldObservability: ({ envelope, peer }) => {
            try {
              projectForeignObservability(
                observabilityFoldDb,
                { id: envelope.id, type: envelope.type, payload: envelope.payload },
                peer,
                observabilityFoldWs,
              );
            } catch (err) {
              process.stderr.write(
                `cortex: federated observability fold projection error (non-fatal) ` +
                  `for ${envelope.type} (id=${envelope.id}): ` +
                  `${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          },
          federated: resolvedPolicy?.federated,
          source: systemEventSource,
          trustResolver,
          receivingAgentId: mergedAgents[0]?.id,
          principalId,
          cryptoVerify: signingKnobs.cryptoVerify,
          rejectEmpty: signingKnobs.rejectEmpty,
          ...(signer !== undefined && { stackIdentity: signer.principal }),
          ...(stackNKeyPubForVerifier !== undefined && {
            stackNKeyPub: stackNKeyPubForVerifier,
          }),
          ...(resolveFederatedPeer !== undefined && { resolveFederatedPeer }),
        });
        console.log(
          "cortex: federated observability fold started (Option-D trust path: curation gate + accept-list + chain-verify; origin-badged)",
        );
      }

      // #989 part-1 — LOCAL same-principal sibling-stack presence aggregation.
      // When enabled (default ON), auto-discover the principal's OTHER local
      // stacks (sibling config-split dirs under the config root), open a
      // READ-ONLY subscriber to each one's loopback bus using ITS OWN creds, and
      // fold its `agent.*` presence into the SAME registry tagged with the
      // sibling's origin — so the Network view renders every local stack as its
      // own hub (not just this serving stack). NO federation, NO cross-principal
      // trust: every bus is the principal's own loopback bus (ADR-0005). Any
      // sibling that can't be reached / authed degrades to absent — it never
      // blocks this boot or perturbs the serving stack's own presence.
      //
      // #1008 RECONCILIATION (DB-read OWNS local siblings): when `dbRead` is on
      // (default), the DB-read pane-of-glass aggregation already merges every
      // LOCAL sibling's agents (+ session trees) straight off its db into the
      // /api/agents + /api/working-agents feeds. Running this BUS sibling-presence
      // aggregator too would DOUBLE-COUNT the same local agents (db + bus). So the
      // bus path is gated OFF for local siblings whenever DB-read aggregation is
      // on. The bus sibling path remains the mechanism for FEDERATED / cross-
      // principal peers (whose dbs live on another machine/principal and cannot be
      // read here) — that is the separate `startFederatedAgentPresenceSubscriber`
      // above, NOT this local-sibling aggregator. Clean reach/depth split: DB-read
      // = my own local stacks; bus = remote peers. Set `dbRead: false` to restore
      // the bus path for local siblings (agents only, no session trees).
      const runBusSiblingPresence = aggCfg.enabled && !aggCfg.dbRead;
      if (runBusSiblingPresence) {
        try {
          // Precedence: explicit `stacks[]` overrides discovery. Empty ⇒ scan
          // the config root (default = the serving config dir's parent, the
          // conventional `~/.config/cortex`).
          const configRoot =
            aggCfg.configRoot !== ""
              ? expandTilde(aggCfg.configRoot)
              : dirname(configDir);
          const explicit =
            aggCfg.stacks.length > 0
              ? aggCfg.stacks.map((s) => ({
                  stack: s.stack,
                  principal: s.principal,
                  url: s.url,
                  credential: {
                    kind: "creds" as const,
                    credsPath: s.credsPath,
                  },
                }))
              : undefined;
          const siblings = discoverSiblingStacks({
            configRoot,
            selfPrincipal: principalId,
            selfStack: derivedStack.stack,
            ...(explicit !== undefined && { explicit }),
          });
          siblingPresenceHandle = await startSiblingPresenceAggregator({
            registry: presenceRegistryHandle.registry,
            siblings,
            connect: natsSiblingBusConnector,
          });
          const aggregated = siblings.length - siblingPresenceHandle.degraded.length;
          console.log(
            `cortex: local-stack presence aggregation — ${aggregated}/${siblings.length} sibling stack(s) ` +
              `aggregated` +
              (siblingPresenceHandle.degraded.length > 0
                ? ` (degraded: ${siblingPresenceHandle.degraded
                    .map((d) => d.stack)
                    .join(", ")})`
                : ""),
          );
        } catch (err) {
          // Aggregation is additive + best-effort: a fault here must never crash
          // the serving daemon's boot or its own presence path.
          console.error(
            "cortex: local-stack presence aggregation startup error (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.error(
        "cortex: federated/sibling agent-presence startup error (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // G-1113 ML.5 — cockpit live-refresh loop. Opt-in via `config.cockpit.enabled`;
  // runs refreshCockpit (ingest → reconcile) on an interval and publishes
  // `system.attention.*` notifications via the bus (the review-sink renders them
  // to `cockpit.attention.channel`). Closes the make-it-live loop end-to-end.
  let cockpitLoop: CockpitRefreshLoop | null = null;
  if (config.cockpit.enabled && mcDb !== null) {
    const cockpitDb = mcDb;
    const [repoOwner, repoName] = config.cockpit.repo.split("/");
    const defaultRepo = repoOwner && repoName ? { owner: repoOwner, repo: repoName } : undefined;
    const baseUrl = config.grove.baseUrl !== "" ? config.grove.baseUrl : `http://localhost:${mcHandle?.port ?? 8767}`;
    // Resolve docsDir to an absolute path so the ingest doesn't depend on the
    // launchd plist's CWD (which isn't guaranteed to be the repo root). Warn
    // once at startup if it's missing rather than only failing every tick.
    const docsDir = isAbsolute(config.cockpit.docsDir) ? config.cockpit.docsDir : join(process.cwd(), config.cockpit.docsDir);
    if (!existsSync(docsDir)) {
      console.warn(`cortex: cockpit.enabled but docsDir not found at ${docsDir} — plan ingest will be empty until it exists`);
    }
    if (config.cockpit.attention.channel === "") {
      console.warn("cortex: cockpit.enabled but cockpit.attention.channel is empty — attention notifications publish to the bus only (no surface rendering); set it to route them");
    }
    cockpitLoop = startCockpitRefreshLoop({
      intervalMs: config.cockpit.refreshIntervalMs,
      run: () =>
        refreshCockpit(cockpitDb, {
          docsDir,
          ...(defaultRepo !== undefined && { defaultRepo }),
          stackId: derivedStack.stack,
          publish: (env) => runtime.publish(env),
          notifySource: { principal: principalId, agent: "cortex", instance: "local" },
          deepLinkFor: (item) => (item.workItemId !== null ? `${baseUrl}/work-items/${item.workItemId}` : null),
          workItemSourceFor: defaultWorkItemSourceFor,
        }),
    });
    console.log(`cortex: cockpit refresh loop started — every ${config.cockpit.refreshIntervalMs}ms, docs=${docsDir}`);
  } else if (config.cockpit.enabled && mcDb === null) {
    console.warn(`cortex: cockpit.enabled but Mission Control DB unavailable (mc.enabled=${config.mc.enabled}, disableDashboard=${!!options.disableDashboard}) — refresh loop not started`);
  }

  // MIG-5.6 (C-106): GitHub webhook receiver — opt-in via `github.receiver.enabled`
  // AND a non-empty `github.webhookSecret`. Publishes `local.{principal}.github.{event}.{action}`
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
        // CO-5 (epic cortex#939) — the public PR-review marketplace Stage-1 tap.
        // When the stack OFFERS `code-review` at `public` scope AND a validated
        // PR-opened delivery's surface metadata clears the accept-predicate, the
        // receiver publishes a `public.{principal}.{stack}.tasks.code-review.…`
        // Offer that the CO-2-bound public consumer (above) claims and the
        // CO-7-hardened pipeline reviews.
        //
        // SHIPS DARK / gated on #978: a public `code-review` offering cannot
        // boot on a `local` execution backend — the M3 gate
        // (`checkPublicOfferingBackendGate`, wired into `CortexConfigSchema`)
        // REJECTS that config at validation. So on every live stack today the
        // offerings resolve `local`-only, `translatePrOpenedToOffer` returns
        // `{admit:false}`, and this tap publishes NOTHING — provingly inert.
        // The tap is wired unconditionally (cheap, pure on the inert path) so
        // the seam exists the moment a non-local backend (#978) unblocks a
        // public offering.
        //
        // `publishOnSubject` is the explicit-subject escape hatch (the public
        // subject is not derivable from `envelope.type`); `undefined` when the
        // runtime is dormant (no NATS) — the tap then logs + skips, identical to
        // the generic-event no-op on a dormant runtime.
        publicOfferTap: {
          principal: principalId,
          stack: derivedStack.stack,
          offerings: resolvedPolicy?.offerings,
          // `?.bind(runtime)` rather than a `!`-asserted closure: optional-chain
          // yields `undefined` when the runtime is dormant (no explicit-subject
          // publish), and `.bind` preserves the method's `this` binding to
          // `runtime` (a plain captured reference would call it unbound).
          publishOnSubject: runtime.publishOnSubject?.bind(runtime),
        },
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

  // IAW GW (cortex#524) — shared surface gateway, flag-gated + DORMANT by
  // default. `startGatewayIfEnabled` reads `CORTEX_GATEWAY` from the env;
  // when the flag is unset (every live stack today) it returns `undefined`
  // and constructs NOTHING — this block is a true no-op and the per-stack
  // adapter boot above is entirely unaffected. When the flag IS set AND
  // `surfaces:` bindings exist, it builds one adapter per binding, constructs
  // a SurfaceGateway, starts it, and returns the instance so `gw?.stop()` joins
  // the shutdown drain below. Sink selection is a SECOND opt-in flag: with
  // `CORTEX_GATEWAY_PUBLISH` unset the gateway runs SHADOW (LoggingInboundSink —
  // no bus publish, unchanged from today); only when CORTEX_GATEWAY_PUBLISH=1 is
  // ALSO set does it run LIVE (BusInboundSink — publishing to the bus). This is
  // purely additive — it does not touch, reorder, or risk the existing
  // adapter-construction flow.
  const startedGateway = await startGatewayIfEnabled({
    env: process.env,
    surfaces: options.surfaces,
    principal: principalId,
    runtime,
    // Threaded for the live-path BusInboundSink (selected only when the second
    // opt-in flag CORTEX_GATEWAY_PUBLISH is set). When the gateway is off
    // (default) startGatewayIfEnabled returns before reading either — purely
    // additive args, no behaviour change on a dormant stack.
    source: systemEventSource,
    policyEngine: adapterPolicyEngine,
    ownershipPlan: surfaceOwnershipPlan,
  });
  const gw: SurfaceGateway | undefined = startedGateway?.gateway;

  // a.3d (cortex#524) — gateway OUTBOUND reply round-trip. Reuse the per-stack
  // `createDispatchSink` (cortex#491) over the GATEWAY's own adapters instead
  // of building a second mux. The sink subscribes to every bound stack's
  // lifecycle subject (`stacks` derived from the surface bindings) and posts
  // each reply back to the exact originating channel/thread via the gateway
  // adapter named by the envelope's echoed `response_routing.adapter_instance`.
  //
  // Coexists safely with the per-stack dispatch sink wired above: both register
  // an `onEnvelope` handler on the SAME runtime, but the `adapter_instance`
  // filter keys off disjoint adapter-instance sets (gateway adapters vs the
  // per-stack `adapters[]`), so any one lifecycle envelope is delivered by at
  // most one sink — never double-replied. Idle in SHADOW (no inbound published
  // → nothing routes to the gateway adapters); active once the gateway is LIVE.
  //
  // a.3d review: that no-double-reply / no-wrong-channel safety RESTS on the
  // instance-id sets being disjoint. The gateway-owned-surface suppression
  // (GW.a.3b.2c) already keeps gateway-owned surfaces out of `adapters[]`, but
  // a per-stack adapter whose `instanceId` is hand-set to the gateway's
  // `{platform}:{demuxKey}` form would collide and let one envelope post to two
  // channels. Assert disjointness LOUDLY at boot rather than trust convention.
  if (startedGateway !== undefined) {
    const collisions = gatewayAdapterInstanceCollisions(
      adapters,
      startedGateway.adapters,
    );
    if (collisions.length > 0) {
      throw new Error(
        `cortex: gateway adapter instanceId(s) ${collisions.map((c) => `"${c}"`).join(", ")} ` +
          `collide with per-stack adapter instanceId(s). The gateway and per-stack ` +
          `dispatch sinks share one runtime and route by instanceId, so a collision ` +
          `would deliver one reply through both — posting to two channels. Ensure no ` +
          `per-stack adapter sets its instanceId to the gateway's "{platform}:{demuxKey}" form.`,
      );
    }
  }

  const gatewayDispatchSink: DispatchSink | undefined = startedGateway
    ? createDispatchSink({
        runtime,
        adapters: startedGateway.adapters,
        principal: principalId,
        // F-1 (cortex#629) — subscribe per distinct `(principal, stack)` pair so
        // a multi-principal gateway sees every bound stack's replies on the
        // right principal namespace. `principalStacks` takes precedence over
        // `stacks` in the sink; `stacks` is still passed for the
        // single-principal back-compat path / readability.
        stacks: startedGateway.stacks,
        principalStacks: startedGateway.principalStacks,
      })
    : undefined;
  if (gatewayDispatchSink !== undefined) {
    await gatewayDispatchSink.start();
    console.log(
      `cortex: gateway dispatch-sink started — subjects=[${gatewayDispatchSink.subjects.join(", ")}], ` +
        `adapters=${startedGateway?.adapters.length ?? 0}`,
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
  // (visible to launchd / principals) when shutdown was unclean.
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
      // G-1114.B.2 — publish agent.offline for every hosted agent BEFORE the
      // runtime closes (the offline publish is a no-op once the runtime is
      // down), then stop the B.3 registry subscriber.
      "agent-presence producer stop (offline publish)",
      "agent-presence broadcast unsubscribe",
      "agent-presence registry stop",
      "cockpit refresh loop stop",
      "mc embed stop",
      "github webhook receiver stop",
      ...adapterCleanup.map((_, i) => `outbound poller stop[${i}]`),
      ...reviewConsumers.map((c, i) => `review-consumer stop[${i}] (agent=${c.agent.id})`),
      ...releaseConsumers.map((c, i) => `release-consumer stop[${i}] (agent=${c.agent.id})`),
      ...devConsumers.map((c, i) => `dev-consumer stop[${i}] (agent=${c.agent.id})`),
      "dispatch-listener stop",
      "dispatch-sink stop",
      "review-sink stop",
      // a.3d (cortex#524) — gateway outbound dispatch sink; `undefined` on a
      // dormant (default) stack, in which case the drain step is a no-op and
      // this slot self-completes immediately.
      "gateway-dispatch-sink stop",
      // IAW GW (cortex#524) — only present when the flag-gated gateway started;
      // `gw` is `undefined` on every dormant (default) stack, in which case the
      // drain step below is a no-op and this slot self-completes immediately.
      "surface-gateway stop",
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
      // G-1114.B.2 — publish agent.offline (reason: shutdown) for every hosted
      // agent FIRST, while the runtime/bus is still up. `stop()` awaits the
      // offline publishes so they go out before any later step (and well before
      // `runtime stop`). Then stop the registry subscriber.
      await completeAsync(
        "agent-presence producer stop (offline publish)",
        presenceProducer?.stop("shutdown"),
      );
      // Unsubscribe the onChange→WS-broadcast handle BEFORE stopping the
      // registry, so teardown is order-independent (no broadcast-after-stop
      // window even if the registry stop is reordered) (#899 review).
      completeSync("agent-presence broadcast unsubscribe", () =>
        presenceBroadcastSub?.unsubscribe(),
      );
      // G-1114.E.2 — stop the federated subscriber BEFORE the registry stop so
      // its `removeForeign()` prunes foreign records (disabling federation
      // cleanly removes foreign agents) while the registry is still live.
      await completeAsync(
        "federated agent-presence subscriber stop",
        federatedPresenceHandle?.stop(),
      );
      // P-14 U3.3 — stop the federated observability fold (drains its push
      // subscriber + unregisters its fan-out handler). Projected observability
      // ROWS are append-only history retained by db/retention.ts — stopping the
      // fold stops NEW peer rows; it does not retro-delete (identical to local
      // rows). Order-independent vs. the registry/db teardown.
      await completeAsync(
        "federated observability fold stop",
        federatedObservabilityHandle?.stop(),
      );
      // #989 part-1 — stop the LOCAL sibling-stack aggregator alongside the
      // federated one (both before the registry stop). It closes every sibling
      // read-only link + prunes the sibling foreign records. Both stops call
      // `removeForeign()` (idempotent); ordering relative to the federated stop
      // doesn't matter — by the time the registry stops, all foreign records are
      // gone.
      await completeAsync(
        "local-stack presence aggregator stop",
        siblingPresenceHandle?.stop(),
      );
      await completeAsync(
        "agent-presence registry stop",
        presenceRegistryHandle?.stop(),
      );
      // Await the cockpit loop's stop BEFORE the embed's stop: stop() now awaits
      // any in-flight refreshCockpit tick, so the bun:sqlite handle the embed
      // closes is only released after the last tick settles (no use-after-close).
      await completeAsync("cockpit refresh loop stop", cockpitLoop?.stop());
      await completeAsync("mc embed stop", mcHandle?.stop());
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
      // cortex#835 F-4.1 — drain release consumers on the same boundary as the
      // review consumers (and before the dispatch listener) so any in-flight
      // release cut publishes its terminal envelope before the runtime closes.
      // `ReleaseConsumer.stop()` is idempotent (no-op when never subscribed).
      for (let i = 0; i < releaseConsumers.length; i++) {
        const consumer = releaseConsumers[i];
        if (consumer) {
          await completeAsync(
            `release-consumer stop[${i}] (agent=${consumer.agent.id})`,
            consumer.stop(),
          );
        }
      }
      // F-2.1 (cortex#835) — drain dev consumers on the same boundary so an
      // in-flight implement (worktree + CC + gates + PR) publishes its
      // terminal envelope before the runtime closes. `DevConsumer.stop()` is
      // idempotent and awaits its in-flight set (the "never subscribed" /
      // dormant case is a no-op). Empty on every default stack.
      for (let i = 0; i < devConsumers.length; i++) {
        const consumer = devConsumers[i];
        if (consumer) {
          await completeAsync(
            `dev-consumer stop[${i}] (agent=${consumer.agent.id})`,
            consumer.stop(),
          );
        }
      }
      await completeAsync("dispatch-listener stop", dispatchListener.stop());
      // signal#113 P-11 (#56) — drain the echo responder on the same boundary
      // as the dispatch listener. `stop()` is idempotent (no-op when dormant).
      await completeAsync("probe-responder stop", probeResponder.stop());
      // cortex#491 — drain the dispatch sink after the runner stops
      // publishing lifecycle envelopes but before the surface-router /
      // adapters stop, so no late `postResponse` lands after the
      // platform connections close. `stop()` is idempotent.
      await completeAsync("dispatch-sink stop", dispatchSink.stop());
      // cortex#502 — drain the review sink on the same boundary as the
      // chat dispatch sink: after the runner/consumers stop publishing
      // review lifecycle + verdict envelopes but before the
      // surface-router / adapters close, so no late `postResponse` lands
      // after the platform connections close. `stop()` is idempotent.
      await completeAsync("review-sink stop", reviewSink.stop());
      // a.3d (cortex#524) — drain the gateway outbound dispatch sink BEFORE the
      // gateway's own adapters close (surface-gateway stop, below), mirroring
      // the per-stack dispatch-sink boundary so no late `postResponse` lands
      // after the gateway's platform connections close. `stop()` is idempotent;
      // `undefined` on a dormant stack → no-op.
      await completeAsync(
        "gateway-dispatch-sink stop",
        gatewayDispatchSink?.stop(),
      );
      // IAW GW (cortex#524) — stop the shared surface gateway (its own
      // adapter connections, separate from the per-stack `adapters[]`) on the
      // same boundary as the sinks: after the runner stops publishing but
      // before the surface-router / per-stack adapters close. `gw` is
      // `undefined` on every dormant (default) stack — `gw?.stop()` is then a
      // no-op and the slot self-completes.
      await completeAsync("surface-gateway stop", gw?.stop());
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

/** Subscribe a Discord adapter to the published-events JSONL stream so legacy
 *  `#agent-log` and per-task worklog threads keep working. Mirrors grove-bot's
 *  `setupOutboundLog`. The dispatch.task.* projection has migrated to
 *  `worklog-manager.surfaceConfig` (router-driven); this function runs the
 *  legacy direct-call path while MIG-7.2d Renderer cutover is pending. */
function setupOutboundLog(
  discordAdapter: DiscordAdapter,
  instance: import("./common/types/config").DiscordInstance,
  config: AgentConfig,
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
          principal: systemEventSource.principal,
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
// --dry-run` to principals as a post-migration sanity check. This helper
// implements that contract: parse the file through the normal load path
// (`loadConfigWithAgents`, which validates against both `AgentConfigSchema`
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
    // Principal-readable: surface the Zod-shaped message verbatim. The
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
/**
 * Run the boot sequence and treat ANY boot-phase failure as FATAL. The daemon
 * must NEVER linger half-booted — inbound dispatch listeners already live, the
 * PID file written so launchd sees a "healthy" process — while the failure that
 * should have stopped it is logged and ignored. This is the load-bearing
 * guarantee behind `signing: enforce`: a stack whose `bootVerifierSelfCheck`
 * throws "REFUSING TO BOOT" MUST exit non-zero, not survive serving traffic.
 *
 * Why a helper and not just a try/catch inline: the `start` action is an async
 * commander action invoked by the synchronous `program.parse()`, which does NOT
 * await it. A rejected boot promise would otherwise fall through to the
 * `unhandledRejection` handler and be logged "non-fatal". Because this helper
 * calls `process.exit(1)` itself, the fatal exit happens regardless of whether
 * the dispatcher awaits the action.
 */
export async function bootOrDie<T>(
  boot: () => Promise<T>,
  pidFile: string,
): Promise<T> {
  try {
    return await boot();
  } catch (err) {
    console.error(
      `cortex: FATAL — boot aborted: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Remove the PID file so launchd / `cortex status` don't mistake a process
    // that failed to boot for a healthy daemon. Best-effort — the exit is what
    // actually matters.
    try {
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch (_err) {
      // PID cleanup failed; nothing safe to do but proceed to the fatal exit.
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  const program = new Command()
    .name("cortex")
    .description("Cortex — the M7 conscious processing surface agent")
    // #752 — required so the `network` / `provision-stack` passthrough
    // subcommands below can call `.passThroughOptions()`: commander stops
    // interpreting options after the subcommand name and hands the raw
    // remaining argv to the subcommand's own `[args...]` parser.
    .enablePositionalOptions()
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
      // returns both the AgentConfig projection (for downstream legacy consumers)
      // and the rich cortex `agents[]` so `startCortex` can route per-instance
      // identity correctly.
      //
      // IAW A.5.3 (cortex#113): also pass through the cortex-shape `stack:`
      // block when the principal declared one — `startCortex` calls
      // `deriveStackId` and logs the resolved stack id. Today this is
      // observational only; emit subjects are unchanged.
      // Boot through bootOrDie: a config-load error OR a boot-phase throw
      // (notably the signing:enforce verifier-self-check "REFUSING TO BOOT")
      // exits the process non-zero instead of being swallowed as a "non-fatal"
      // unhandled rejection. The daemon must not survive a failed security gate.
      const handle = await bootOrDie(async () => {
        const { config, inlineAgents, stack, policy, principal, bus, surfaces } =
          loadConfigWithAgents(options.config);
        return startCortex(config, {
          configPath: options.config,
          ...(inlineAgents.length > 0 && { inlineAgents }),
          ...(stack !== undefined && { stack }),
          ...(policy !== undefined && { policy }),
          // PR-R13.B.i: both LoadedConfig and StartCortexOptions now use
          // the canonical `.principal` field.
          ...(principal !== undefined && { principal }),
          ...(bus !== undefined && { bus }),
          // IAW GW (cortex#524) — thread the validated surface binding map
          // through so the flag-gated gateway block in startCortex can read it.
          // Dormant unless CORTEX_GATEWAY is set; undefined when no surfaces:
          // block was declared.
          ...(surfaces !== undefined && { surfaces }),
        });
      }, pidFile);

      const shutdown = async () => {
        await handle.stop();
        if (existsSync(pidFile)) unlinkSync(pidFile);
        // Echo round-1 N2: surface dirty shutdown to launchd / principals
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

  // #752 — passthrough subcommands. The module dispatchers
  // (`dispatchNetwork` / `dispatchProvisionStack`) own their own arg parsing
  // via `parseSubcommandArgs(SPEC, argv)`, so commander must hand them the raw
  // remaining argv UNTOUCHED: no option interpretation, no `--help`
  // interception, no unknown-option rejection. The variadic `[args...]`
  // argument + `.allowUnknownOption()` + `passThroughOptions()` +
  // `.helpOption(false)` achieve that. Neither boots the daemon — only `start`
  // does — so `cortex network join …` runs the CLI flow and exits.
  program
    .command("network")
    .description("Manage federation network membership (join / leave / status)")
    .argument("[args...]", "network subcommand + flags (see `cortex network --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchNetwork(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command("provision-stack")
    .description("Provision a stack signing identity (generate / claim / register)")
    .argument("[args...]", "provision-stack subcommand + flags (see `cortex provision-stack --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchProvisionStack(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // C-808 (#808) — born-aligned, unique stack scaffold. Same passthrough shape
  // as `network` / `provision-stack`: `dispatchStack` owns its own arg parsing,
  // so commander hands it the raw remaining argv untouched.
  program
    .command("stack")
    .description("Scaffold + inspect cortex stacks (create / list)")
    .argument("[args...]", "stack subcommand + flags (see `cortex stack --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchStack(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // CO-3 (#942) — the third control-plane leg (DD-CO-5): set/list/revoke
  // capability offerings + generate the federation-config projections. Same
  // passthrough shape as `network` / `stack`: `dispatchOffer` owns its own arg
  // parsing (incl. the bare-positional `offer <capability>` set form), so
  // commander hands it the raw remaining argv untouched.
  program
    .command("offer")
    .description("Set/list/revoke capability offerings (the provider-side exposure policy)")
    .argument("[args...]", "offer subcommand + flags (see `cortex offer --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchOffer(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program.parse();
}
