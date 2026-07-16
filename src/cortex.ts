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

// cortex#1797 (S12 MOVE) — the Bun WebSocket-transport shim that forces
// @discordjs/ws onto the `ws` package moved OUT of cortex core and INTO the
// discord bundle (`metafactory-cortex-adapter-discord/src/ws-transport.ts`),
// alongside the `discord.js` dependency it protects (which left cortex's own
// package.json this slice). The bundle's `plugin.ts` imports it first, so the
// override still lands before any Discord client connects.

import { Command } from "commander";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";

import {
  loadConfigWithAgents,
  loadAgentsDirectory,
  expandTilde,
  FragmentLoadError,
  flattenDiscordPresences,
  flattenMattermostPresences,
  flattenSlackPresences,
  dedupeSurfaceWarnings,
  type SurfaceTokenWarning,
} from "./common/config/loader";
import {
  ConfigWatcher,
  AgentsDirectoryWatcher,
  type AgentsChangeEvent,
} from "./common/config/watcher";
import { resolveArcPackReposDir } from "./common/config/arc-pack-repos-dir";
import { type AgentConfig } from "./common/types/config";
import { migrateStackDbOnTouch } from "./common/migrate-data-dir";
import { migratePublishedEventsDirValue } from "./common/config/migrate-published-events-value";
import { resolveSigningKnobs } from "./common/security-posture";
import { buildHttpsMtlsMaterial } from "./common/config/transport-mtls";
import { AgentRegistry } from "./common/agents/registry";
import { TrustResolver } from "./common/agents/trust-resolver";
import {
  scaffoldInstance,
  replayPending,
  type ScaffoldOptions,
  type ScaffoldResult,
  type ReplayOptions,
  type ReplayResult,
} from "./common/agents/agent-state-scaffold";
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
// R26 P1 (cortex#1371) — the substrate admission gate + its loud degrade event.
import { createSystemAdmissionDegradedEvent } from "./bus/system-events";
import {
  AdmissionGate,
  admissionBucketName,
  provisionAdmissionKv,
} from "./bus/admission";
import {
  publishCapabilityRegistry,
  buildCapabilityRegisteredEnvelope,
  type CapabilityRegistryEntry,
} from "./bus";
import { ReviewConsumer } from "./bus/review-consumer";
import {
  BrainConsumer,
  buildBrainTaskPayload,
  safeAttachmentRefs,
  type BrainAttachmentRef,
  buildDispatchTaskEnvelope,
  BRAIN_TASK_SUBJECT_FAMILY,
} from "./bus/brain-consumer";
import {
  SurfacePrincipalGate,
  makeDispatchPostRenderer,
  type PrincipalIdentity,
} from "./bus/surface-principal-gate";
import { GateReplyRouter } from "./bus/gate-reply-router";
import { DaemonBrainHost } from "./brain/daemon-brain-host";
import { wireDevConsumers } from "./runner/dev-consumer-boot";
import { wireReviewConsumers } from "./runner/review-consumer-boot";
import { setActiveSubstrates, activeConfigHomeEnv } from "./common/substrates/config-home";
import { wireBrainConsumers } from "./runner/brain-consumer-boot";
import { wireReleaseConsumers } from "./runner/release-consumer-boot";
import { wireSurfaceAdapters } from "./runner/surface-adapter-boot";
import { ReleaseConsumer } from "./runner/release-consumer";
import {
  provisionReviewStream,
  provisionReviewConsumer,
} from "./bus/jetstream/provision";
import { reviewScopePatterns, REVIEW_OFFER_TASK_SUFFIX } from "./bus/jetstream/review-subjects";
import { nkeyToBase64Pubkey } from "./bus/verify-signed-by-chain";
import { bootVerifierSelfCheck } from "./bus/verifier-self-check";
import { type CCSessionOpts } from "./runner/cc-session";
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
import { resolveComplianceOk } from "./runner/co7-review-hardening";
import {
  getSignedByChain,
  type Envelope,
} from "./bus/myelin/envelope-validator";

import { resolveRendererPluginAndConfig, UnimplementedRendererKindError, type Renderer } from "./renderers";
import { assertRuntimeSystemCoverage } from "./renderers/coverage";
import { createDefaultSurfacePluginRegistry, validateSurfacesAgainstRegistry } from "./adapters/registry";
import { loadExternalPlugins } from "./adapters/loader";
import { createSystemPluginLoadFailedEvent, createSystemPluginLoadedEvent } from "./bus/system-events";
import { startPluginControlServer } from "./gateway/plugin-control-server";
import type { PluginRuntimeDeps, RendererHandle } from "./gateway/plugin-runtime";
import { deriveStackId, DEFAULT_STREAM_MAX_BYTES } from "./common/types/cortex-config";
import type {
  Agent,
  AgentRuntime,
  BusConfig,
  Policy,
  ReflexActivationConfig,
  NotifyConfig,
  StackConfig,
} from "./common/types/cortex-config";
import {
  ReflexActivationListener,
  inMemoryReflexDedup,
  type ReflexActivationHandler,
} from "./bus/reflex-activation-listener";
import { createDiscordNotifier } from "./bus/notify-discord";
import { createProcessRunner } from "./bus/process-runner";
import { policyEngineFromConfig } from "./common/policy/factory";
import {
  buildPlatformPrincipalIndex,
  buildPrincipalRegistry,
} from "./common/policy";
import type { InboundMessage, PlatformAdapter } from "./adapters/types";
import { createDispatchSink, type DispatchSink } from "./adapters/dispatch-sink";
import { createReviewSink, type ReviewSink } from "./adapters/review-sink";
import { startGatewayIfEnabled } from "./gateway/start-gateway";
// G-1113 ML.5 — cockpit live-refresh loop (opt-in via config.cockpit).
import { refreshCockpit, defaultWorkItemSourceFor } from "./surface/mc/refresh";
import { startCockpitRefreshLoop, type CockpitRefreshLoop } from "./surface/mc/refresh-loop";
// MC-I1.S1 (ADR-0005) — in-process Mission Control embed (supersedes api.*).
import { startMissionControl, type MissionControlHandle } from "./surface/mc/embed";
import type { AgentPresenceView } from "./surface/mc/api/agents";
import type { NetworksView } from "./surface/mc/api/networks";
// FLG-1 (docs/plan-mc-future-state.md §4.D) — guided-join handoff banner: the MC
// read seam + the shared signal-gathering / live-ports the daemon wires it to.
import type { HandoffView } from "./surface/mc/api/handoff";
import { gatherHandoffSignals } from "./cli/cortex/commands/network-handoff-lib";
import { buildLiveHandoffPorts } from "./cli/cortex/commands/network-handoff-adapters";
import type { LivePortsConfig } from "./cli/cortex/commands/network-adapters";
// FLG-3 (docs/plan-mc-future-state.md §4.D) — network doctor-on-glass: the MC
// read seam + the pure orchestrator / live ports the daemon wires it to. The
// daemon reuses its ALREADY-RUNNING runtime as the peer-reachable probe bus
// (`wrapRuntimeAsProbeBus`) — same probe transport `cortex network ping` /
// `doctor` use, without opening a second NATS connection.
import type { DoctorView } from "./surface/mc/api/doctor";
import { runDoctorChecks } from "./cli/cortex/commands/network-doctor-lib";
import {
  buildDoctorConfigPort,
  buildMonitorPort,
} from "./cli/cortex/commands/network-doctor-adapters";
import type { NetworkDoctorPorts } from "./cli/cortex/commands/network-doctor-ports";
import { wrapRuntimeAsProbeBus } from "./cli/cortex/commands/network-ping-adapters";
import type { LoadedConfig } from "./common/config/loader";
import type {
  AdmissionDecider,
  AdmissionDecisionResult,
} from "./surface/mc/api/networks-admission";
// FLG-2 (docs/plan-mc-future-state.md Track FLG, cortex#1706) — authorize-from-
// glass: reuse the CLI's hub-admin seed loader + authorize orchestrator/ports so
// the daemon route signs the SAME hub-admin claim `cortex network authorize`
// does (no hand-rolled seed loading / signing).
import type {
  Authorizer,
  AuthorizeResult,
  AuthorizeFailure,
} from "./surface/mc/api/networks-authorize";
import { hubAdminMaterialFromSeedFile } from "./cli/cortex/commands/network-secret-adapters";
import {
  resolveAdmittedRoster,
  type AdmissionRowsProvider,
  type AdmissionRowsResult,
} from "./bus/agent-network/admission-read";
// MC-A2 (cortex#1276) — the LIVE member-posture admission-rows provider +
// per-principal acceptance resolution (the second trust layer).
import { createMemberRosterAdmissionProvider } from "./bus/agent-network/admission-rows-member-provider";
// MC-B2 (cortex#1279) — the WRITE sibling: sign a Tier-2 admit/reject decision
// with the stack seed and POST it to the registry (local-daemon-signed).
import { postAdmissionDecision } from "./bus/agent-network/admission-decision";
import {
  summarizeAcceptancePolicy,
  resolvePeerAcceptance,
} from "./bus/agent-network/peer-acceptance";
import { materialFromSeedString, signAdminRequest, randomNonce } from "./bus/stack-provisioning";
// MC-A3 (cortex#1277, ADR-0019/0018) — derive each joined network's read-only
// confidentiality posture from config for the `/api/networks` view.
import { confidentialityPosture } from "./common/crypto/network-encryption-policy";
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
// API-P1.3 (#2063) — build the inference registry (real provider factories
// injected) so `substrate: api-agent` agents resolve their `inferenceProfile`.
import { createInferenceRegistry } from "./substrates/api-agent/provider-factories";
// S2 (cortex#1160) — per-agent chat dispatch listeners derive their scoped
// subscription subject (`local.{principal}.{stack}.tasks.@{enc-did}.>`) via the
// canonical myelin subject builder so the subscribe-side pattern matches the
// `dispatch-source-publisher` emit side byte-for-byte.
import { directTaskSubject } from "@the-metafactory/myelin/subjects";
import { chatCapableAgents } from "./runner/chat-capable-agents";
// G-1114.B.2 — live agent-presence producer (online/heartbeat/offline) wired
// into boot. G-1114.B.3 — the runtime registry subscriber it feeds.
import {
  AgentPresenceProducer,
  presenceAgentFromAgent,
  shouldFederatePresence,
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
// FS-6 (cortex#1821) — per-peer received-presence ledger (offline vs unheard split).
import { FederatedPresenceReceipts } from "./bus/agent-network/federated-presence-receipts";
// P3 (cortex#1088) — continuous federation roster reconciler. Mutates the LIVE
// `policy.federated.networks[]` the gate reads so a later-joining roster peer is
// admitted within one reconcile interval, no manual `network join`.
import {
  startFederationReconciler,
  type FederationReconcilerHandle,
} from "./bus/agent-network/federation-reconciler";
// FS-1 (cortex#1825, design §3 D-1) — presence-by-membership oracle: "is this
// source principal an ADMITTED member?" resolved from the authoritative
// admission-rows roster (ADR-0018 Q3 — the SAME source `/api/networks` uses).
import {
  createFederatedMembershipOracle,
  type FederatedMembershipOracleHandle,
} from "./bus/agent-network/federated-membership";
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

// #752 — the `network` + `provision-stack` subcommand dispatchers. Registered
// as passthrough commander subcommands below so `cortex network join …` and
// `cortex provision-stack register …` work directly (no `bun src/...` prefix).
// These do NOT boot the daemon — only `start` does.
import { dispatchNetwork } from "./cli/cortex/commands/network";
import { resolveRegistryAnchor } from "./cli/cortex/commands/default-registry";
import { dispatchOffer } from "./cli/cortex/commands/offer";
import { dispatchProvisionStack } from "./cli/cortex/commands/provision-stack";
import { dispatchRelease } from "./cli/cortex/commands/release";
import { dispatchStack } from "./cli/cortex/commands/stack";
import { dispatchQuickstart } from "./cli/cortex/commands/quickstart";
import { dispatchPlugin } from "./cli/cortex/commands/plugin";
import { dispatchConfig } from "./cli/cortex/commands/config";
import { dispatchCreds } from "./cli/cortex/commands/creds";
import { dispatchStepUp } from "./cli/cortex/commands/stepup";
// #1352 — `agents` + `migrate-config` were complete standalone `import.meta.main`
// scripts, unreachable from the installed binary while docs
// (docs/design-arc-agent-bots.md) and cortex.ts:682 told users to run them as
// `cortex agents …` / `cortex migrate-config …`. Registered as passthrough
// commander subcommands below so those references resolve. `dispatchAgents`
// returns an ExitResult synchronously; `runMigrateConfig` returns the exit code
// (it writes its own stdout/stderr). Neither boots the daemon — only `start` does.
import { dispatchAgents } from "./cli/cortex/commands/agents";
import { runMigrateConfig } from "./cli/cortex/commands/migrate-config";

import { CloudPublisher } from "./taps/cc-events/cloud-publisher";
import {
  RegistryClient,
  PrincipalPubkeyResolver,
  MultiPrincipalIdentityRegistry,
  NetworkRegistryClient,
} from "./common/registry";
import type {
  RegistryClientReader,
  FederatedPeerResolution,
} from "./common/registry";
import { resolveBootFederatedPeers } from "./common/registry/resolve-federated-peers-boot";
import type { NetworkRosterProvider } from "./common/registry/resolve-federated-peers";
import {
  startGithubWebhookReceiver,
  type GithubWebhookReceiverHandle,
} from "./taps/gh-webhook-receiver/server";

// MIG-7.9 (deferred) flips these to `~/.config/cortex/`. Keeping grove-shaped
// paths for now so the principal's existing `bot.yaml` continues to work.
// B-0 (cortex#1021) — the PID-file resolution moved to `./common/pidfile` so
// the lightweight `cortex agents reload` CLI can resolve the running daemon's
// PID (to signal a reload) without importing this whole module graph. Re-import
// here so cortex.ts's lifecycle paths stay on the single source of truth.
import { STATE_DIR, DEFAULT_CONFIG, pidFileFor, migrateLegacyPidFile } from "./common/pidfile";
// FS-7 / D-3 (cortex#1839) — last-known-good boot fallback + degraded state.
import { readLastGoodSnapshotPath, writeLastGoodSnapshot } from "./common/config/last-good";
import { resolveConfigDir } from "./common/config/config-path";
import {
  clearDegradedMarker,
  readDegradedMarker,
  writeDegradedMarker,
  type DegradedInfo,
} from "./common/config/degraded-state";
import { formatConfigLoadError } from "./common/config/validate-on-write";

/**
 * Resolve the PID file path for a given `--config` value.
 *
 * Principals running multiple cortex instances on a single machine (per
 * Phase A.5's stack-aware namespace — e.g. `andreas/research` and
 * `andreas/work` side-by-side) need distinct PID files so the
 * singleton check in {@link checkSingleton} only blocks duplicates of
 * the same stack, not unrelated stacks.
 *
 * Resolution (see `./common/pidfile` for the authoritative doc):
 *   - Default config (or unspecified) → legacy `cortex.pid` (preserves
 *     single-instance backward compat — principals on the default path
 *     see no behaviour change).
 *   - Custom config → `cortex-<basename>-<hash8>.pid`, keyed on a hash of
 *     the canonical FULL config path (cortex#1900). Two config trees that
 *     share a filename resolve to DISTINCT PID files, so `start`/`stop`
 *     can never collide across trees.
 */
// B-0 (cortex#1021) — `pidFileFor` is imported from `./common/pidfile` (single
// source of truth shared with the `cortex agents reload` daemon-signal path)
// and re-exported here so existing importers of `pidFileFor` from `cortex.ts`
// (tests, the lifecycle commands below) are unaffected.
export { pidFileFor };

/**
 * cortex#400 — derive the per-agent CC session opts handed to the
 * bus-side review-consumer. Mirrors the Discord path's wiring at
 * `src/bus/dispatch-handler.ts:1014` so a `/review owner/repo#N`
 * dispatch over the bus spawns CC with the same toolset (Bash/Read/gh
 * + `bypassPermissions`) the Discord path uses. Without this, the
 * spawned CC sees only globally-configured MCP tools and politely
 * refuses with "I don't have access to GitHub CLI tools".
 *
 * compass#96 F3 — also pins `allowedSkills: ['code-review']` so the
 * contractual "Invoke the CodeReview skill — {Workflow} workflow"
 * directive that `buildReviewPrompt` now emits can actually resolve the
 * Skill tool (cc-session strips any `Skill` deny + registers the Skill
 * Guard hook that pins the grant list, cortex#710).
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
    // compass#96 F3 — pin the CodeReview skill for the review session. The
    // prompt (`buildReviewPrompt`) now contractually names a CodeReview
    // workflow (`workflowForFlavor`), so the reviewer must be able to invoke
    // the Skill tool for `code-review`. cc-session honours `allowedSkills` by
    // stripping any `Skill` deny + registering the Skill Guard hook that pins
    // the grant list (cortex#710). Grant exactly the one skill the review path
    // needs — nothing wider.
    allowedSkills: ["code-review"],
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
   * B-0 (cortex#1021) — the live agent-registry generation. 0 at boot; each
   * successful agents.d/ reload that CHANGES the agent set increments it. A
   * no-op reload (no add/remove/change) does not advance it. Read it after a
   * `reloadAgents()` (or a fs.watch-driven reload) to confirm a swap happened.
   */
  readonly agentGeneration: number;
  /**
   * B-0 (cortex#1021) — trigger an agents.d/ reload on the SAME path the
   * fs.watch callback uses: revalidate fragments, rebuild the merged set
   * (inline cortex.yaml agents still win on id conflict), swap the registry,
   * reconcile review consumers (add → start, remove → drain, change →
   * remove+add), and re-publish the capability registry. `cortex agents
   * reload` and SIGHUP route here. `source` tags the reload's origin for
   * logging/observation. Resolves once the reconcile completes (consumers
   * drained/started). A no-op when no `agents.d/` directory is in play.
   */
  reloadAgents(source?: "cli" | "sighup"): Promise<void>;
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
  /**
   * FS-7 / D-3 (cortex#1839) — set when the daemon booted DEGRADED on the
   * last-known-good snapshot because the LIVE config failed to load. Carries the
   * precise load error + the snapshot path. Surfaced on the MC `/health` endpoint
   * (via the embed) so the degraded state is visible, never silent. Undefined on
   * a healthy boot.
   */
  degraded?: DegradedInfo;
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
   * B-0 (cortex#1021) — skip the daemon-level `agents.d/` fragment watcher
   * (tests that don't want a live fs.watch, or that drive reloads through the
   * handle's `reloadAgents()` directly). Production omits this; the watcher
   * starts whenever `agentsDir` exists.
   */
  disableAgentsWatcher?: boolean;
  /**
   * B-0 (cortex#1021) — override the `agents.d/` watcher debounce (tests use a
   * short window to keep fs.watch assertions fast). Defaults to the watcher's
   * own 200ms — the same window the main ConfigWatcher uses.
   */
  agentsWatcherDebounceMs?: number;
  /**
   * Bot Packs B-1 (cortex#1021) — base directory under which an `exec` brain's
   * pack is resolved: `{brainPackBaseDir}/{agentId}` substitutes for the
   * `{pack}` placeholder in `brain.run`. Defaults to
   * `~/.config/metafactory/pkg/repos/` (the arc install path per
   * design-bot-packs.md §7.1). Tests point it at a tmp dir holding fixture
   * brains. arc#117's HostAdapter will own this resolution end-to-end (B-3);
   * until then a pack can be hand-dropped under this base.
   */
  brainPackBaseDir?: string;
  /**
   * B-0 (cortex#1021) — test-only observation hook fired after EVERY
   * agents.d/ reload attempt (watcher-, cli-, or sighup-sourced), including
   * failed ones. Surfaces the post-reload generation + the add/remove/change
   * sets so tests can assert reconcile behaviour without scraping logs.
   */
  onAgentsReloaded?: (info: {
    generation: number;
    source: AgentsChangeEvent["source"];
    failed: boolean;
    added: string[];
    removed: string[];
    changed: string[];
    consumerAgentIds: string[];
  }) => void;
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
   * cortex#1720 S1 — override the AgentState scaffolder invoked on activation
   * of a fragment that declares `state:`. Production omits this and the real
   * `scaffoldInstance` (subprocess to the bundle, ~/.config/cortex/agents/<id>/
   * fallback) runs. Tests inject a recorder so the opt-in / idempotency /
   * regression-stateless assertions run WITHOUT touching the principal's real
   * `~/.config` or spawning `bun`.
   *
   * The default is a thin wrapper so a test can pass either just a `spawn` seam
   * (to exercise the real `scaffoldInstance` with a stub script) or replace the
   * whole scaffolder.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  scaffoldAgentState?: (agent: Agent, opts?: ScaffoldOptions) => ScaffoldResult;
  /**
   * cortex#1720 S2 — override the AgentState ReplayPending invoked after a
   * stateful fragment's scaffold succeeds on activation (the `onStart` hook).
   * Production omits this and the real `replayPending` (subprocess to the
   * bundle's `errands.ts pending`, soft-skip when the bundle isn't installed)
   * runs. Tests inject a recorder so the "stateful triggers replay / stateless
   * doesn't / missing-script soft-skips / throwing replay never crashes boot"
   * assertions run WITHOUT touching `~/.config` or spawning `bun`.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  replayPendingAgentState?: (agent: Agent, opts?: ReplayOptions) => ReplayResult;
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
   * F-6 — reflex activation bridge block from `LoadedConfig.reflexActivation`.
   * The boot path mounts `ReflexActivationListener` only when `targets` is
   * non-empty; absent/empty → no listener, zero behaviour change. Undefined
   * for legacy `bot.yaml` input.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  reflexActivation?: ReflexActivationConfig;
  /**
   * F-6 downstream — `notify:` block from `LoadedConfig.notify`. The boot path
   * mounts `NotifyDiscordResponder` only when `notify.discord` is non-empty;
   * absent/empty → no responder, zero behaviour change.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  notify?: NotifyConfig;
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
   * cortex#1217 — disabled-surface warnings from the INLINE/gateway config
   * load (`LoadedConfig.surfaceWarnings`). The boot path merges these with the
   * agents.d/ FRAGMENT disabled-surface warnings (collected when this function
   * loads `agents.d/`) and emits ONE consolidated, deduped principal-facing
   * banner — so a fail-soft-disabled surface on a fragment agent (e.g. vega)
   * bubbles UP, not only to stderr. Undefined/empty → no banner.
   *
   * @internal — not part of the public API; semver does not apply.
   */
  surfaceWarnings?: SurfaceTokenWarning[];
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
/**
 * FLG-2 (cortex#1706) — map the registry authorize endpoint's HTTP status +
 * `error` code onto the surface's structured {@link AuthorizeFailure}. Prefers
 * the registry's own error code (its gate order is `503 admin_not_configured →
 * 401 signature_invalid → 403 admin_not_authorized`, plus `409 not_admitted`),
 * falling back to the raw status for anything unmapped. Pure.
 */
function mapAuthorizeStatus(status: number, registryError: string | undefined): AuthorizeFailure {
  switch (registryError) {
    case "admin_not_configured":
      return "hub_admin_not_configured";
    case "signature_invalid":
      return "signature_invalid";
    case "admin_not_authorized":
      return "admin_not_authorized";
    case "not_admitted":
      return "not_admitted";
    case "not_found":
      return "not_found";
    default:
      break;
  }
  switch (status) {
    case 503:
      return "hub_admin_not_configured";
    case 401:
      return "signature_invalid";
    case 403:
      return "admin_not_authorized";
    case 409:
      return "not_admitted";
    case 429:
      return "rate_limited";
    case 400:
      return "invalid";
    case 404:
      return "not_found";
    default:
      return "unreachable";
  }
}

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
  agent: Pick<Agent, "id" | "displayName" | "persona" | "openOnboarding" | "openOnboardingAllowedTools" | "runtime" | "agentDisallowedTools" | "strictMcpConfig" | "env">,
  configDir: string,
): {
  id: string;
  displayName: string;
  persona: string;
  openOnboarding?: boolean;
  openOnboardingAllowedTools?: string[];
  capabilities?: readonly string[];
  agentDisallowedTools?: string[];
  strictMcpConfig?: boolean;
  env?: Record<string, string>;
} {
  const expandedPersona = expandTilde(agent.persona);
  return {
    id: agent.id,
    displayName: agent.displayName,
    persona: isAbsolute(expandedPersona)
      ? expandedPersona
      : join(configDir, expandedPersona),
    // cortex#1165 — carry the open-onboarding gate flag per target agent so the
    // dispatch handler can admit unmapped senders for flagged concierges only.
    ...(agent.openOnboarding === true && { openOnboarding: true }),
    // cortex#1167 — carry the explicit anon-session tool allowlist (mirrors the
    // persona allowedTools). Only meaningful when openOnboarding is set.
    ...(agent.openOnboarding === true &&
      agent.openOnboardingAllowedTools !== undefined && {
        openOnboardingAllowedTools: agent.openOnboardingAllowedTools,
      }),
    // #1206 (principal-driven dev-loop, S1) — carry the agent's declared
    // `runtime.capabilities[]` so the dispatch handler's orchestrator-command
    // gate activates ONLY for the agent declaring `dev.orchestrate` (e.g. vega).
    ...(agent.runtime?.capabilities !== undefined && {
      capabilities: agent.runtime.capabilities,
    }),
    // WEB-2 / B1 — carry the per-agent structural tool-confinement fields so the
    // dispatch handler can merge them into effectiveDisallowed and add
    // --strict-mcp-config regardless of which dispatch path fires.
    ...(agent.agentDisallowedTools !== undefined && {
      agentDisallowedTools: agent.agentDisallowedTools,
    }),
    ...(agent.strictMcpConfig === true && { strictMcpConfig: true }),
    // cortex#2133 — carry the agent's declared env passthrough so the DIRECT
    // dispatch paths (async/team/sync-fallback) layer it onto the CC session
    // (resolved + CLAUDE_* re-denied in cc-session). The canonical bus-mediated
    // sync path is injected receiving-stack-authoritatively in the listener.
    ...(agent.env !== undefined && { env: agent.env }),
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
  // Publish the deployment `substrates:` block process-wide so EVERY claude-code
  // session this daemon spawns (dispatch, dev-loop, review, agent-team) resolves
  // against the declared config home (cc-session reads it at spawn). Set-once at
  // boot; refreshed on config reload below. See common/substrates/config-home.ts.
  setActiveSubstrates(config.substrates);
  const securityPreamble = buildSecurityPreamble(config, expandedConfigPath);
  console.log("cortex: starting...");
  console.log(`  Agent: ${config.agent.displayName}`);
  console.log(`  Config: ${options.configPath ?? "(in-memory)"}`);
  console.log(`  PID: ${process.pid}`);
  // Make the config home VISIBLE at boot. Sessions fall back to the vendor
  // default silently when no `substrates.claude-code.configHome` is declared —
  // which is a legitimate default, but indistinguishable at runtime from a
  // misconfiguration. Logging it once turns a silent fallback into an
  // observable fact the principal can check against intent.
  const bootConfigHome = activeConfigHomeEnv("claude-code");
  console.log(
    `  Claude config home: ${bootConfigHome?.value ?? "(vendor default — no substrates.claude-code.configHome)"}`,
  );

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
    // log + stderr WARNING with the `arc upgrade cortex` fix-path AND
    // the manual cortex.yaml fix-path, plus a docs/sop-stack-identity.md
    // cross-link for the rotation / threat-model background.
    console.log(
      "cortex: stack signing key not configured — outbound envelopes will be unsigned",
    );
    process.stderr.write(
      "WARNING: stack identity not configured — cortex will publish unsigned envelopes.\n" +
        "  Peers that verify signed_by[] will reject these messages.\n" +
        "  Run `arc upgrade cortex --force` to auto-provision, or add\n" +
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
    // XDG wave-4 (cortex#1869): the no-configPath fallback resolves the active
    // config dir (canonical ~/.config/metafactory/cortex first, legacy trees
    // during transition, or $CORTEX_CONFIG_DIR) instead of a hardcoded
    // ~/.config/cortex. `agents.d/` is config-class (identity fragments) and is
    // carried with the config move — distinct from the state-class `agents/`
    // (per-agent state.sqlite, G-15) the migrator excludes.
    ?? (options.configPath ? join(dirname(expandedConfigPath), "agents.d") : join(resolveConfigDir(), "agents.d"));
  let fragmentAgents: Agent[] = [];
  // cortex#1217 — collect fail-soft disabled-surface warnings from agents.d/
  // fragments (vega ships its Discord token as a fragment placeholder). These
  // are merged with the inline/gateway warnings from `options.surfaceWarnings`
  // and surfaced in ONE consolidated boot banner below — so a disabled fragment
  // surface bubbles UP, not only to stderr.
  const fragmentSurfaceWarnings: SurfaceTokenWarning[] = [];
  try {
    fragmentAgents = loadAgentsDirectory(agentsDir, fragmentSurfaceWarnings);
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      console.error(`cortex: agents.d fragment load failed (non-fatal during AgentConfig migration): ${err.message}`);
    } else {
      throw err;
    }
  }

  // cortex#1217 — consolidated disabled-surface banner: inline/gateway warnings
  // (from the config load) + agents.d/ fragment warnings, deduped per
  // agent|platform|envVar so each disabled surface is reported ONCE. The
  // per-surface stderr WARN already fired at resolve time; this is the
  // principal-facing roll-up that names exactly what degraded and how to fix it.
  const allSurfaceWarnings = dedupeSurfaceWarnings([
    ...(options.surfaceWarnings ?? []),
    ...fragmentSurfaceWarnings,
  ]);
  if (allSurfaceWarnings.length > 0) {
    const lines = allSurfaceWarnings
      .map((w) => `  • ${w.platform} for agent "${w.agent}" — set ${w.envVar} (\`arc secrets set ${w.agent} ${w.envVar}\`)`)
      .join("\n");
    console.warn(
      `cortex: ${allSurfaceWarnings.length} surface(s) DISABLED due to unresolved secret placeholders ` +
        `(the stack booted; only these surfaces are degraded):\n${lines}`,
    );
  }

  // Merge: inline wins on id conflict (design §6.1). AgentConfig today carries
  // no inline `agents[]`, so production callers pass `inlineAgents: undefined`
  // and the merged list is just the fragments. The seam exists so tests can
  // exercise the merge rule without writing fragment files, and so MIG-7.2e
  // can plumb the real inline list through without changing the signature.
  const inlineAgents = options.inlineAgents ?? [];
  const inlineIds = new Set(inlineAgents.map((a) => a.id));
  const shadowedFragmentCount = fragmentAgents.filter((a) => inlineIds.has(a.id)).length;
  // S1 (cortex#1159) — agents installed as agents.d/ fragments (not inline) whose
  // ids are NOT already shadowed by an inline agent. Inline agents already feed
  // `config.discord` / `config.mattermost` / `config.slack` via the loader's
  // presence-flatten; fragment-only agents do not, so their presence blocks must
  // be flattened and APPENDED to the adapter-construction instance lists below
  // (see `discordInstances` / `mattermostInstances` / `slackInstances`). Filtering
  // out inline-shadowed ids here is what keeps the append from double-counting an
  // agent that is both inline and a fragment (inline wins; fragment shadowed).
  const fragmentOnlyAgents = fragmentAgents.filter((a) => !inlineIds.has(a.id));
  const mergedAgents: Agent[] = [...inlineAgents, ...fragmentOnlyAgents];
  // cortex#1167 — ids of agents flagged `openOnboarding`. Threaded into the
  // policy engine so the single synthetic `public` principal is granted exactly
  // `dispatch.<id>` for each (and nothing else). Boot snapshot; an agents.d
  // hot-reload that toggles the flag requires a restart to re-grant (acceptable
  // for an auth-gate flag — same posture as the rest of the policy block).
  const openOnboardingAgentIds: string[] = mergedAgents
    .filter((a) => a.openOnboarding === true)
    .map((a) => a.id);
  // B-0 (cortex#1021) — `agentRegistry` is the live, swappable snapshot. The
  // agents.d/ hot-reload path (below) rebuilds the merged set and reassigns
  // this binding under a bumped generation counter; the handle's
  // `agentRegistry` getter reads the live binding so callers always see the
  // current generation. `mergedAgents` stays the BOOT snapshot (it is consumed
  // structurally by the boot-time adapter / presence / dispatch wiring); the
  // reload path tracks its own current view in `liveFragmentAgents` below.
  let agentRegistry = AgentRegistry.fromAgents(mergedAgents);
  // The registry generation. Starts at 0 (boot); each successful agents.d/
  // reload that changes the agent set increments it. Surfaced for tests +
  // observability — a generation that doesn't advance on a no-op reload is the
  // signal that nothing structurally changed.
  let agentGeneration = 0;
  if (mergedAgents.length > 0) {
    console.log(
      `cortex: agent registry assembled — ${mergedAgents.length} agent(s) `
        + `(${inlineAgents.length} inline + ${fragmentAgents.length} fragment, `
        + `${shadowedFragmentCount} fragment override(s) shadowed by inline)`,
    );
  } else {
    console.log("cortex: agent registry assembled — 0 agents (no inline agents, no fragments)");
  }

  // ===========================================================================
  // cortex#1720 S1 — AgentState scaffold-on-activation (OPT-IN).
  // ===========================================================================
  //
  // For each agent that declares `state:`, ensure its per-instance dir
  // (`~/.config/cortex/agents/<id>/`) exists by delegating to the AgentState
  // bundle (subprocess; manual fallback when the bundle isn't installed).
  //
  // Three guarantees the S1 spec pins down:
  //   (a) OPT-IN — `if (agent.state)` guards EVERY invocation. A stateless
  //       fragment takes ZERO new code paths: `scaffoldStatefulAgent` returns
  //       immediately and never touches the filesystem or spawns anything.
  //   (b) IDEMPOTENT — the underlying `scaffoldInstance` skips existing files,
  //       so re-activation (a reload, a restart) is a safe no-op.
  //   (c) NON-FATAL — a thrown error or a bundle non-zero exit is logged and
  //       swallowed; activation continues and the daemon never crashes on a
  //       scaffold fault.
  //
  // The scaffolder is injectable (`options.scaffoldAgentState`) so tests assert
  // the opt-in / idempotency / regression behaviour without touching the
  // principal's real `~/.config` or spawning `bun`.
  const doScaffold = options.scaffoldAgentState ?? scaffoldInstance;
  const doReplayPending = options.replayPendingAgentState ?? replayPending;

  // cortex#1720 S2 — ReplayPending (the `onStart` hook).
  //
  // After a stateful fragment's scaffold succeeds, re-surface the work that was
  // still pending when the daemon last stopped by listing its pending
  // work_items via the bundle's `errands.ts pending`. S2 scope is deliberately
  // MINIMAL: we LOG the count and emit a structured log line — we do NOT wire
  // the pending items back into BrainConsumer dispatch (that re-emission is S3).
  //
  // Same three guarantees as the scaffold above:
  //   (a) OPT-IN — only reached for a stateful agent (guarded at the call site
  //       inside scaffoldStatefulAgent, after a successful scaffold).
  //   (b) SOFT-SKIP — a missing bundle errands.ts yields one log line, no crash.
  //   (c) NON-FATAL — a thrown replay is caught and swallowed; activation
  //       continues and the daemon never crashes on a replay fault.
  const replayStatefulAgent = (agent: Agent): void => {
    try {
      const replay = doReplayPending(agent);
      if (!replay.ran) {
        console.log(
          `cortex: agent-state — replay-pending SKIPPED for "${agent.id}" ` +
            `(reason=${replay.skipReason ?? "unknown"}; dir=${replay.instanceDir})`,
        );
        return;
      }
      // Structured log event: count of pending work_items re-surfaced. S3 will
      // consume these rows into dispatch; S2 just makes them visible.
      console.log(
        `cortex: agent-state — replay-pending for "${agent.id}" re-surfaced ` +
          `${replay.pendingCount} pending item(s) (dir=${replay.instanceDir})`,
      );
    } catch (err) {
      // (c) Non-fatal — a replay fault must never block activation.
      process.stderr.write(
        `cortex: agent-state — replay-pending FAILED for "${agent.id}" (non-fatal; agent still activates): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };

  const scaffoldStatefulAgent = (agent: Agent): void => {
    // (a) Opt-in guard — a stateless fragment returns before any work.
    if (!agent.state) return;
    try {
      // (b) Idempotent by construction of scaffoldInstance (skip-if-exists).
      const result = doScaffold(agent);
      console.log(
        `cortex: agent-state — scaffolded instance for "${agent.id}" via ${result.strategy} ` +
          `(dir=${result.instanceDir}, created=${result.created.length}, skipped=${result.skipped.length})`,
      );
    } catch (err) {
      // (c) Non-fatal — log and carry on. A failed scaffold must never block
      //     activation or crash the daemon (the fragment still activates
      //     stateless; the principal can re-run once the bundle is fixed).
      process.stderr.write(
        `cortex: agent-state — scaffold FAILED for "${agent.id}" (non-fatal; agent still activates): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      // Scaffold failed → do NOT replay (the instance dir / state.sqlite may not
      // exist). The next activation retries both from a clean footing.
      return;
    }
    // cortex#1720 S2 — onStart replay, reached only when scaffold did NOT throw.
    // Note: a bundle that EXITS NON-ZERO does not throw — `scaffoldInstance`
    // degrades to the manual fallback and returns `fallback-manual`, so replay
    // still runs. That is benign: `errands.ts pending` creates `state.sqlite`
    // itself (via the bundle's own `openState`), so a first-run replay against a
    // fallback-scaffolded dir simply finds an empty, freshly-created queue. Only
    // a THROWN scaffold (caught above) skips replay.
    replayStatefulAgent(agent);
  };
  for (const agent of mergedAgents) {
    scaffoldStatefulAgent(agent);
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
  // `arc nats … --json`; arc owns nsc and the principal account.
  // `config.nats.accountSigningKeyPath` survives for the principal-signature
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
  // B-0 (cortex#1021) — the idempotent capability-registry publish, lifted into
  // a reusable closure so the agents.d/ hot-reload path (below) re-publishes
  // through the SAME code at boot. This CLOSES the long-standing TODO in this
  // block's preamble ("we do NOT wire a re-publish into the hot-reload path …
  // when [a fragment watcher] is wired, the re-publish belongs in its
  // callback"): the watcher's reload callback now calls `publishCapabilitiesFor`
  // after swapping the registry. The publisher keys the bucket on `agent_id`
  // and overwrites, so a re-publish reconciles a changed/added agent's caps and
  // is a harmless no-op for unchanged ones. Returns the number of agents whose
  // registrations were attempted (0 when no agent declares capabilities).
  const publishCapabilitiesFor = async (
    agents: readonly Agent[],
    context: "boot" | "reload",
  ): Promise<number> => {
    const entries: CapabilityRegistryEntry[] = agents
      .filter((a): a is Agent & { runtime: { capabilities: readonly string[] } } =>
        (a.runtime?.capabilities.length ?? 0) > 0,
      )
      .map((a) => ({
        agentId: a.id,
        capabilities: a.runtime.capabilities,
      }));
    if (entries.length === 0) return 0;
    // cortex#288 follow-up — closure-scoped success/failure counters.
    //
    // `publishCapabilityRegistry`'s contract is "I called publish() for each
    // envelope" — it pushes to its returned `published[]` *after* awaiting
    // publish(), regardless of whether the call site swallows the rejection.
    // Our `wrappedPublish` below DOES swallow per-envelope failures (so one
    // bad publish doesn't abort the loop), which means `published.length` is
    // really "publishes that returned without throwing into the publisher",
    // not "publishes that actually landed on the wire". The log should
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
        entries,
        publish: wrappedPublish,
      });
      const failureSuffix = failedPublishes > 0 ? ` (${failedPublishes} failure(s))` : "";
      console.log(
        `cortex: published ${successfulPublishes} capability registration(s)${failureSuffix} ` +
          `for ${entries.length} agent(s) (${context})`,
      );
    } catch (err) {
      // Defensive — `publishCapabilityRegistry` is pure orchestration and
      // shouldn't throw once `wrappedPublish` traps per-envelope failures,
      // but a `clock()` or `buildBaseEnvelope` throw would still surface
      // here. Boot/reload continues; the bucket simply stays unpopulated
      // until the next publish.
      console.error(
        `cortex: capability-registry ${context} wiring failed (non-fatal — continues):`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return entries.length;
  };

  // B-0 (Sage cortex#1027) — capability TOMBSTONE publish for REMOVED agents.
  //
  // The bucket consumer keys on `agent_id` and overwrites; an agent that is
  // removed on reload must have its prior registration OVERWRITTEN, not merely
  // omitted from the next republish (omission leaves the stale registration
  // live — the agent stays a "provider" of capabilities it no longer hosts).
  // `publishCapabilityRegistry` deliberately SKIPS empty-capability entries
  // (spec §3.4), so we cannot tombstone through it. We build the empty-capability
  // envelope directly: same `agents.capabilities.registered` type + `agent_id`,
  // `capabilities: []` — which a keyed consumer interprets as "this agent now
  // provides nothing", i.e. an unregister. Errors are trapped per-envelope so one
  // failure doesn't abort the reload.
  const publishCapabilityTombstones = async (
    removedAgentIds: readonly string[],
  ): Promise<number> => {
    if (removedAgentIds.length === 0) return 0;
    let tombstoned = 0;
    for (const agentId of removedAgentIds) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional dual-emit tombstone during the agent.online migration window.
        const envelope = buildCapabilityRegisteredEnvelope({
          source: systemEventSource,
          agentId,
          capabilities: [],
          registeredAt: new Date(),
          instance: systemEventSource.instance,
        });
        await runtime.publish(envelope);
        tombstoned++;
      } catch (err) {
        // Per CLAUDE.md "no empty catch blocks": log, continue. stderr (not the
        // system-events pipeline) for the same reason as publishCapabilitiesFor.
        process.stderr.write(
          `cortex: capability-registry tombstone publish failed for agent_id=${agentId}: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    if (tombstoned > 0) {
      console.log(
        `cortex: published ${tombstoned} capability tombstone(s) for removed agent(s) (reload)`,
      );
    }
    return tombstoned;
  };

  const capabilityEntryCount = mergedAgents.filter(
    (a) => (a.runtime?.capabilities.length ?? 0) > 0,
  ).length;
  if (capabilityEntryCount > 0) {
    await publishCapabilitiesFor(mergedAgents, "boot");
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
  // Bot Packs B-1 (design-bot-packs.md §4, §6) — an agent whose
  // `runtime.brain.kind === "exec"` is hosted by a BrainConsumer for its
  // declared capabilities, NOT a builtin ReviewConsumer. `brain` absent / kind
  // builtin ⇒ the existing review path, byte-for-byte unchanged.
  const isExecBrainAgent = (a: Agent): boolean =>
    a.runtime?.brain?.kind === "exec";
  // Bot Packs B-1 — the SINGLE brain-hosting predicate (cortex#1033
  // §Maintainability): an exec-brain agent that declares at least one capability
  // (the subjects the consumer binds) is hosted by a BrainConsumer. Used by both
  // the boot-time `brainAgents` filter AND the hot-reload `isBrainHosted` path so
  // a B-2 change to the hosting criteria can't drift between them.
  const isBrainHosted = (a: Agent): boolean => {
    const runtime = a.runtime;
    return runtime?.brain?.kind === "exec" && runtime.capabilities.length > 0;
  };
  const brainConsumers: BrainConsumer[] = [];
  // Bot Packs B-2 — the long-lived daemon brain hosts (one per `lifecycle:
  // daemon` agent). Tracked so the shutdown drain + reconcile teardown can stop
  // them; the BrainConsumer already routes per-task drain through `stop()`, but
  // a host also needs an unconditional teardown on process shutdown.
  const daemonBrainHosts: DaemonBrainHost[] = [];
  // Bot Packs B-2 — a mutable holder for the presence producer so the daemon
  // host's `onDegraded` callback (which fires at RUNTIME, long after boot) can
  // surface a degraded agent via `publishCapabilitiesChanged(agentId, [])` —
  // the same capability-change presence signal the reconcile path uses. The
  // producer is constructed later (the MC-registry block); this holder is
  // assigned there and read lazily inside the callback.
  const brainPresenceHolder: { producer: AgentPresenceProducer | null } = {
    producer: null,
  };
  const reviewCapableAgents = mergedAgents.filter((a) => {
    // An exec-brain agent is hosted by the brain path even if it happens to
    // declare a code-review capability — the two consumers are mutually
    // exclusive per agent (§6: "instead of, not in addition to").
    if (isExecBrainAgent(a)) return false;
    const caps = a.runtime?.capabilities ?? [];
    return caps.some(
      (c) => c === "code-review" || c.startsWith("code-review."),
    );
  });
  // Bot Packs B-1 — agents hosted by a BrainConsumer (the shared predicate).
  const brainAgents = mergedAgents.filter(isBrainHosted);
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
  // cortex#1186 — sourced from the shared `reviewScopePatterns` builder so the
  // consumer filters and the disjointness test prove the SAME contract.
  const reviewScopePats = reviewScopePatterns(reviewPrincipalId, derivedStack.stack);
  const reviewSubjectPattern = reviewScopePats.local;
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
    // cortex#1199 — the shared single-token `*` Offer suffix (owned by
    // review-subjects.ts). Single-token (not `>`) keeps the offering-derived
    // federated/public Offer patterns JetStream-disjoint from the 4-token Direct
    // pattern, so CODE_REVIEW provisions even when code-review is offered federated.
    REVIEW_OFFER_TASK_SUFFIX,
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
  const reviewFederatedSubjectPattern = reviewScopePats.federatedOffer;
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
  const reviewFederatedDirectSubjectPattern = reviewScopePats.federatedDirect;
  const reviewConfig = options.bus?.review;
  const reviewStream = reviewConfig?.stream.name ?? "CODE_REVIEW";
  const reviewStreamMaxAgeNs =
    (reviewConfig?.stream.maxAgeSeconds ?? 86_400) * 1_000_000_000;
  const reviewStreamMaxBytes =
    reviewConfig?.stream.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
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
    lifecycleConfig?.stream.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;

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
    devImplementConfig?.stream.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
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

  // ── B-3 (cortex#1021) BRAIN_TASKS subject set ─────────────────────────────
  // Inbound surface tasks addressed TO an exec-brain agent land on
  // `…brain.{capability}` (the `BRAIN_TASK_SUBJECT_FAMILY`), captured by the
  // BRAIN_TASKS stream. The B-1 runtime bound every brain capability on
  // CODE_REVIEW, whose filter is `tasks.code-review.>` — so a non-code-review
  // capability (e.g. `soc.compose.flow`) had NO stream to receive a task from.
  // This stream closes that gap: a brain consumer binds its durable here, and
  // the inbound dispatch publishes to the bus on `…brain.{capability}`.
  //
  // OVERLAP ANALYSIS (JetStream rejects overlapping subjects across streams):
  //   CODE_REVIEW       owns `…tasks.code-review.>`
  //   DEV_IMPLEMENT     owns `…tasks.dev.>`
  //   REVIEW_LIFECYCLE  owns `…review.verdict.>` / `…code.pr.review.>` / `…dispatch.task.>`
  //   BRAIN_TASKS       owns `…brain.>`            (THIS stream)
  // `brain.` is a distinct segment-4 token from `tasks.` / `review.` / `code.`
  // / `dispatch.`: no subject here is a prefix of (or prefixed by) any other
  // stream's subjects. The four streams partition the subject space cleanly.
  const brainTasksStream = "BRAIN_TASKS";
  const brainTasksStreamSubjects = [
    `local.${reviewPrincipalId}.${derivedStack.stack}.${BRAIN_TASK_SUBJECT_FAMILY}.>`,
  ];
  // ── /B-3 BRAIN_TASKS subject set ──────────────────────────────────────────

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

    // ── B-3 (cortex#1021) provision BRAIN_TASKS ─────────────────────────────
    // Same `reviewJsm !== null` gate + posture as CODE_REVIEW / DEV_IMPLEMENT
    // (Interest retention, File storage, idempotent ensure). The exec-brain
    // consumer binds its durable here; the inbound dispatch publishes onto
    // `…brain.{capability}`. A failure does NOT abort boot. Same KNOWN COUPLING
    // as DEV_IMPLEMENT: the gate is review-capability presence, so a
    // brain-ONLY stack would skip provisioning — not reachable today (the
    // switch stack runs sage); the independent-gate fix is the same follow-up.
    try {
      const brainOutcome = await provisionReviewStream({
        jsm: reviewJsm,
        name: brainTasksStream,
        subjects: brainTasksStreamSubjects,
        maxAgeNs: reviewStreamMaxAgeNs,
        maxBytes: reviewStreamMaxBytes,
      });
      if (brainOutcome === "created") {
        console.log(
          `cortex: provisioned JetStream stream "${brainTasksStream}" (subjects=[${brainTasksStreamSubjects.join(", ")}])`,
        );
      } else if (brainOutcome === "exists") {
        console.log(
          `cortex: JetStream stream "${brainTasksStream}" already present — binding existing config`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `cortex: provisionReviewStream failed for "${brainTasksStream}": ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // ── /B-3 provision BRAIN_TASKS ──────────────────────────────────────────
  }

  // S7 (epic #1514, cortex#1521) — the per-agent review-consumer
  // construction now lives in `wireReviewConsumers` (review-consumer-boot.ts),
  // extracted from the ~475-line inline closure that used to live here. Same
  // motivation as before the move: the agents.d/ hot-reload path (below) START
  // a newly-ADDED agent's consumers through the SAME construction boot uses —
  // no duplicated wiring. `startForAgent` pushes the consumers it creates onto
  // `reviewConsumers[]` (the same array the shutdown drain walks), so a
  // hot-added agent's consumers drain on shutdown identically to a boot agent's.
  const { startForAgent } = wireReviewConsumers({
    reviewPrincipalId,
    trustResolver,
    signingKnobs,
    ...(signer !== undefined && { signer }),
    ...(stackNKeyPubForVerifier !== undefined && { stackNKeyPubForVerifier }),
    systemEventSource,
    runtime,
    buildSessionOpts: (agent) => buildReviewSessionOpts(config, agent),
    makeOfferAdmission,
    federatedNetworks: resolvedPolicy?.federated?.networks ?? [],
    reviewConsumers,
    reviewOfferingPatterns,
    reviewSubjectPattern,
    reviewJsm,
    reviewStream,
    reviewConsumerMaxDeliver,
    federationConfigured,
    reviewFederatedSubjectPattern,
    reviewFederatedDirectSubjectPattern,
  });

  // Bot Packs B-1 (design-bot-packs.md §4, §6, §8) — start a BrainConsumer for
  // an `exec`-brain agent. Mirrors review-consumer-boot.ts's `startForAgent` shape: reads
  // the closure-captured boot state (runtime, systemEventSource, the
  // brainConsumers[] array the shutdown drain + reconcile walk), provisions the
  // per-capability JetStream durables, and binds the consumer. NEVER throws —
  // one brain's wiring failure does not abort boot.
  // #1988 — the DEFAULT arc package-repos dir must MIRROR arc's own
  // `dataRoot/repos` resolution (XDG DATA class; arc#287), NOT the moved
  // pre-#287 legacy path. `resolveArcPackReposDir` honors `$XDG_DATA_HOME`
  // (→ `<base>/metafactory/arc/repos`) and existence-gates the legacy
  // `~/.config/metafactory/pkg/repos` fallback (singleTree / `ARC_CONFIG_ROOT`
  // installs). An explicit `options.brainPackBaseDir` (set only in tests) stays
  // the highest-precedence override, unchanged.
  const brainPackBaseDir =
    options.brainPackBaseDir ?? resolveArcPackReposDir();

  // Bot Packs B-3 (cortex#1021 W-1/W-2) — the adapter inbound reply-bridge +
  // the booted surface gate. Constructed ONCE here (before the per-agent brain
  // consumers, which capture the gate) even though the surface adapters boot
  // LATER: the bridge is late-wired —
  //   - `gateReplyRouter` is a passive registry; each adapter's inbound
  //     handler (below, at adapter start) offers every normalized message to
  //     it before chat dispatch;
  //   - `liveSurfaces` is seeded from the CONFIGURED surface instances (sage
  //     #1037 round 1: brain consumers boot BEFORE adapters, so seeding only
  //     at adapter start would fail-close every gate in the boot window even
  //     though the adapter is seconds from being available). A configured
  //     surface whose adapter then fails to start still fails closed: the
  //     gate's rendered prompt has no adapter to deliver it and no reply can
  //     arrive, so the gate times out to `fail`. Adapters still `add()` on
  //     start (idempotent) so a surface added by hot-reload joins late.
  // The gate itself only boots when the principal has at least one configured
  // surface identity (`principal.mattermostId` / `discordId` / `slackId`) —
  // with no platform id there is nothing to verify a reply against, so the
  // consumer keeps its DenyAll default (fail-closed, B-1 behaviour).
  const gateReplyRouter = new GateReplyRouter();

  // One metadata row per surface family (sage #1037 round 2: liveSurfaces,
  // principalIdentity and the has-identity check previously repeated the
  // platform list in three independent shapes — adding a surface meant
  // touching all of them).
  const surfaceGateMeta = [
    {
      surface: "discord",
      configured: config.discord.length > 0,
      identityKey: "discordId" as const,
      principalId: options.principal?.discordId,
    },
    {
      surface: "mattermost",
      configured: config.mattermost.length > 0,
      identityKey: "mattermostId" as const,
      principalId: options.principal?.mattermostId,
    },
    {
      surface: "slack",
      configured: config.slack.length > 0,
      identityKey: "slackId" as const,
      principalId: options.principal?.slackId,
    },
  ];
  const liveSurfaces = new Set<string>(
    surfaceGateMeta.filter((m) => m.configured).map((m) => m.surface),
  );
  const principalIdentity: PrincipalIdentity = {};
  for (const m of surfaceGateMeta) {
    if (m.principalId !== undefined) principalIdentity[m.identityKey] = m.principalId;
  }
  const principalHasSurfaceIdentity = surfaceGateMeta.some(
    (m) => m.principalId !== undefined,
  );

  // sage #1037 round 1 (maintainability): ONE inbound handler shape for all
  // three adapter families — gate reply-bridge first, chat dispatch second.
  // B-3 (cortex#1021 W-1): a message landing in a thread with an open
  // principal gate is that gate's reply (identity checked by the GATE, never
  // here), not a chat dispatch. The InboundMessage → GateReplyOffer mapping
  // lives HERE (surface layer) so the bus-side router stays blind to adapter
  // DTOs (sage round 2, architecture).
  const inboundWithGateBridge =
    (adapter: PlatformAdapter, agent: Agent) =>
    (msg: InboundMessage): Promise<void> => {
      // The routing key for both the gate reply-bridge and a brain task's
      // response_routing. A top-level (non-threaded) surface message has no
      // native thread, so the channel id is the key — used IDENTICALLY on the
      // gate-await side and the offer side, so a gate prompt + the principal's
      // reply correlate whether the conversation is threaded or not.
      const thread = msg.threadId !== undefined && msg.threadId.length > 0
        ? msg.threadId
        : msg.channelId;
      const consumed = gateReplyRouter.offer({
        surface: msg.platform,
        channel: msg.channelId,
        thread,
        authorId: msg.authorId,
        text: msg.content,
      });
      if (consumed) return Promise.resolve();
      // B-3 routing (design-bot-packs.md §6, cortex#1021): an exec-brain agent
      // does NOT run the builtin claude-code chat pipeline (it has no CC
      // substrate). Its inbound @-mention becomes a capability task PUBLISHED
      // TO THE BUS on `…brain.{capability}` (the BRAIN_TASKS stream), which the
      // brain consumer pulls — the documented "bus is the medium" contract
      // (sage #1038 round 1). Fleet `dispatch` effects ride the bus too.
      if (agent.runtime?.brain?.kind === "exec") {
        // Return (not void) so the platform handler applies natural
        // back-pressure on the publish (sage #1038 r2). The publish is cheap
        // — a JetStream write; the long compose is decoupled on the consumer
        // side (the brain pulls the task), so awaiting here bounds inbound
        // publish concurrency without serialising composition.
        return dispatchInboundToBrain(agent, msg, thread);
      }
      return dispatchHandler.handleMessage(adapter, msg, targetAgentForDispatch(agent, configDir));
    };

  /**
   * Publish an inbound surface message to an exec-brain agent as a capability
   * task on the bus. Builds a `brain.{capability}` envelope (BRAIN_TASKS
   * stream) carrying the message text + the surface `response_routing` (so the
   * brain can `post` back and `ask_principal` renders to the originating
   * thread), and `runtime.publish`es it — the brain consumer's durable pulls
   * it through the normal `processEnvelope` path. Non-blocking: the inbound
   * handler never awaits compose/gate/run.
   *
   * Note on the gate thread key (sage #1038 round 1): `thread` is
   * `threadId ?? channelId`, computed once in the caller and used IDENTICALLY
   * for the gate reply-bridge offer (above) AND this task's `response_routing`.
   * A top-level (non-threaded) message would otherwise have no thread for the
   * gate to await on / correlate a reply against; keying both sides on the
   * channel id when there is no native thread makes the gate prompt and the
   * principal's reply correlate either way. The SurfacePrincipalGate is the
   * only PrincipalReplySource consumer, and it awaits on exactly this source —
   * so the normalization is self-consistent, not a generic-router assumption.
   *
   * Capability selection: the brain's FIRST declared capability. A
   * multi-capability brain needs a keyword/prefix selector (follow-up); v1
   * brains (Yarrow → `soc.compose.flow`) declare exactly one.
   */
  const dispatchInboundToBrain = async (
    agent: Agent,
    msg: InboundMessage,
    thread: string,
  ): Promise<void> => {
    const capability = agent.runtime?.capabilities[0];
    if (capability === undefined) {
      process.stderr.write(
        `cortex: exec-brain agent=${agent.id} has no declared capability — dropping inbound message\n`,
      );
      return;
    }
    const envelope = buildDispatchTaskEnvelope({
      source: systemEventSource,
      capability,
      family: BRAIN_TASK_SUBJECT_FAMILY,
      payload: buildBrainTaskPayload({
        text: msg.content,
        user: msg.authorId,
        surface: msg.platform,
        channel: msg.channelId,
        thread,
        // cortex#1038 — the adapter instance the @-mention arrived on, so the
        // brain's posts + the gate prompt route back to THIS adapter via the
        // chat dispatch-sink (which filters on adapter_instance).
        adapterInstance: msg.instanceId,
        // Pass attachment REFERENCES (url, not bytes) so a brain can fetch a
        // dropped file (e.g. Yarrow's A_INGEST_ATTACHMENT). safeAttachmentRefs
        // is the SSRF guard: https + surface host-allowlist, fail-closed.
        ...((): { attachments?: BrainAttachmentRef[] } => {
          const refs = safeAttachmentRefs(msg.platform, msg.attachments);
          return refs.length > 0 ? { attachments: refs } : {};
        })(),
      }),
      ...(agent.runtime?.modelClass !== undefined && { modelClass: agent.runtime.modelClass }),
    });
    try {
      await runtime.publish(envelope);
    } catch (err) {
      // Log AND rethrow (sage #1038 r3): swallowing here would let the
      // platform handler treat the mention as successfully handled while no
      // brain task was actually delivered — a silent drop on a transient bus
      // error. Rejecting lets the adapter surface/retry per its own policy.
      process.stderr.write(
        `cortex: exec-brain agent=${agent.id} inbound publish failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      throw err;
    }
  };
  const surfacePrincipalGate = principalHasSurfaceIdentity
    ? new SurfacePrincipalGate({
        principalIdentity,
        liveSurfaces,
        renderer: makeDispatchPostRenderer({ runtime, source: systemEventSource }),
        replySource: gateReplyRouter,
        // 10 min to review + approve a gate (e.g. a composed flow's run-approval
        // or an analyst gate). The host per-task liveness timeout is PAUSED while
        // a gate is open (daemon-brain-host ask_principal), so this is the real
        // human-reply window — not racing the 5-min task timeout that used to
        // orphan it (cortex#1073).
        timeoutMs: 600_000,
      })
    : undefined;

  // S8 (epic #1514, cortex#1522) — the brain-consumer construction extracted
  // to `wireBrainConsumers` (mirrors S7's `wireReviewConsumers`). Renamed at
  // destructure (`startBrainForAgent`, not the bare `startForAgent` the
  // module returns) because review's own `startForAgent` binding above lives
  // in this SAME top-level scope — the two are unrelated bindings that would
  // otherwise collide. Called at BOTH the boot loop below and the
  // `agents.d/` hot-reload path (isBrainHosted, further down), exactly where
  // the inline closure used to be called.
  const { startForAgent: startBrainForAgent } = wireBrainConsumers({
    brainPackBaseDir,
    reviewPrincipalId,
    stack: derivedStack.stack,
    systemEventSource,
    runtime,
    ...(surfacePrincipalGate !== undefined && { surfacePrincipalGate }),
    brainPresenceHolder,
    brainConsumers,
    daemonBrainHosts,
    reviewJsm,
    brainTasksStream,
    reviewConsumerMaxDeliver,
  });

  // Boot: start review consumers for every code-review-capable agent. Same
  // `startForAgent` the hot-reload path calls for a newly-added agent.
  for (const agent of reviewCapableAgents) {
    await startForAgent(agent);
  }
  // Boot: start brain consumers for every exec-brain agent (B-1). Same closure
  // the hot-reload path calls for a newly-added exec-brain agent.
  for (const agent of brainAgents) {
    await startBrainForAgent(agent);
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
    // infrequent; 24h retention + 64MiB is ample and matches the operational
    // posture principals already understand from CODE_REVIEW.
    const releaseStreamMaxAgeNs = 86_400 * 1_000_000_000;
    const releaseStreamMaxBytes = DEFAULT_STREAM_MAX_BYTES;
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

    // S8 (epic #1514, cortex#1522) — the per-agent construct+provision+start+
    // log body extracted to `wireReleaseConsumers`. Unlike the brain/review
    // lanes, this construction has exactly ONE call site (this loop) and no
    // `agents.d/` hot-reload path — see the module's file header for why that
    // asymmetry is preserved, not "fixed".
    // Block-scoped: shadows nothing outside this `if` (review's own
    // `startForAgent` above is a sibling top-level binding, not visible from
    // inside a nested reload closure the way brain's must be — release has no
    // hot-reload path, so this name only ever needs to live here).
    const { startForAgent } = wireReleaseConsumers({
      principalId,
      systemEventSource,
      runtime,
      makeOfferAdmission,
      releaseConsumers,
      releaseJsm,
      releaseStream,
      releaseConsumerMaxDeliver,
      releaseOfferingPatterns,
      releaseSubjectPattern,
    });
    for (const agent of releaseCapableAgents) {
      await startForAgent(agent);
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
      // cortex#1203 — provision the DEV_IMPLEMENT durable UP-FRONT, then bind.
      // The review, brain and release lanes all `provisionReviewConsumer(...)`
      // (jsm.consumers.add) before `consumer.start()`; the dev lane was the ONLY
      // one that didn't — and `consumer.start()`/`subscribePull` BINDS an
      // existing durable rather than creating it. With no `consumers.add`, the
      // bind fails "consumer not found" and `dev.implement` never reaches ready
      // (the F-2.1 consumer silently dormant). Mirrors the brain lane: the
      // per-scope `pattern` is the durable's `filter_subject` (cortex#1186).
      if (reviewJsm !== null) {
        try {
          await provisionReviewConsumer({
            jsm: reviewJsm,
            // cortex#1203 review major-1: the config-resolved stream name (NOT a
            // hardcoded "DEV_IMPLEMENT") — must match the stream as provisioned
            // AND the `consumer.start({ stream })` below, or a renamed
            // `bus.devImplement.stream.name` reproduces the very "consumer not
            // found" this fixes.
            stream: devImplementStream,
            durable,
            filterSubject: pattern,
            maxDeliver: reviewConsumerMaxDeliver,
            // cortex#1203 review major-2: a dev implement runs far longer than a
            // review, but is bounded by the dev session timeout. Size the durable
            // ack-wait to that (+60s) so a legitimately-long run isn't redelivered
            // mid-flight (the 20-min review default would → dead-letter → dup
            // session). Defaults to 30m+ when the timeout is unset.
            ackWaitNs: (config.claude.asyncTimeoutMs + 60_000) * 1_000_000,
          });
        } catch (provisionErr) {
          // Don't abort — let `consumer.start()` surface the bind failure via
          // its own dormant/skip path (mirrors the review + brain lanes).
          process.stderr.write(
            `cortex: provisionReviewConsumer (dev) failed for "${durable}": ` +
              `${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}\n`,
          );
        }
      }
      const started = await consumer.start({
        pattern,
        // cortex#1203 review major-1 — config-resolved name, matches the durable
        // provisioned just above (not a hardcoded literal).
        stream: devImplementStream,
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
  // verifySignedByChain, emits `system.bus.peer-dispatch-received`
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
      // cortex#1228 — resolve the registry pubkey through the shared anchor:
      // when the configured URL is the default metafactory registry but no
      // pubkey is pinned in config, pin the compiled-in anchor pubkey (no TOFU
      // window on the default). A custom registry with no pin still falls
      // through to the client's TOFU (pubkey left undefined here).
      const resolvedFederationRegistry = resolveRegistryAnchor({
        configUrl: federationRegistryConfig.url,
        ...(federationRegistryConfig.pubkey !== undefined && {
          configPubkey: federationRegistryConfig.pubkey,
        }),
      });
      const peerResolver = new PrincipalPubkeyResolver({
        enabled: federationVerifyEnabled,
        baseUrl: resolvedFederationRegistry.url,
        ...(resolvedFederationRegistry.pubkey !== undefined && {
          registryPubkey: resolvedFederationRegistry.pubkey,
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
    // cortex#1222 — self short-circuit + dedupe on the federation dispatch-deny
    // path (the #1214 follow-up for THIS surface-router path). Mirrors the
    // `startFederatedAgentPresenceSubscriber` wiring EXACTLY: a self-loopback
    // `federated.{us}.{stack}.agent.*` dispatch (signed by our OWN stack DID)
    // is recognised + bytes-checked + dropped instead of denied every tick,
    // and a genuinely-denied foreign dispatch is audited ≤ once per window.
    trustResolver,
    ...(mergedAgents[0]?.id !== undefined && { receivingAgentId: mergedAgents[0].id }),
    principalId,
    cryptoVerify: signingKnobs.cryptoVerify,
    rejectEmpty: signingKnobs.rejectEmpty,
    ...(signer !== undefined && { stackIdentity: signer.principal }),
    ...(stackNKeyPubForVerifier !== undefined && {
      stackNKeyPub: stackNKeyPubForVerifier,
    }),
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
      // cortex#1228 — pin the compiled-in anchor pubkey when the configured URL
      // is the default registry and config omits the pubkey (no TOFU on the
      // default). Custom registries keep the client's TOFU (pubkey undefined).
      const resolvedRegistry = resolveRegistryAnchor({
        configUrl: registryConfig.url,
        ...(registryConfig.pubkey !== undefined && { configPubkey: registryConfig.pubkey }),
      });
      registryClient = new RegistryClient({
        url: resolvedRegistry.url,
        ...(resolvedRegistry.pubkey !== undefined && { pubkey: resolvedRegistry.pubkey }),
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
  const adapterPolicyEngine = policyEngineFromConfig(resolvedPolicy, openOnboardingAgentIds);
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

  // cortex#1788 (S3, ADR-0024 D5) — compose ONE `(kind, id)`-keyed
  // adapter/renderer registry for this boot and thread it to every
  // construction site below: the per-stack boot path (`wireSurfaceAdapters`),
  // the renderer boot loop (`createRenderer`), and the shared surface
  // gateway (`startGatewayIfEnabled`). All three paths dogfood the SAME
  // in-tree registrations (ADR-0024 §3.3) — extraction later moves a plugin
  // out, it never rewires this composition.
  const surfacePluginRegistry = createDefaultSurfacePluginRegistry();

  // cortex#1792 (S6, ADR-0024 D1/D3/D4/D5, OQ9/OQ11) — discover, compat-gate,
  // import, and register out-of-tree plugin bundles into the SAME registry,
  // BEFORE anything below consumes it (surfaces validation, the per-stack
  // adapter loop, the renderer boot loop, the gateway). `loadExternalPlugins`
  // never throws: a bad bundle (bad manifest, incompatible sdkRange, a
  // throwing import, a duplicate-platform shadow attempt, …) is skipped,
  // logged, and returned in `.failed` — every other in-tree AND bundle
  // plugin still loads. `config.plugins.external` (default off) gates every
  // bundle except a first-party bundle: an OQ9-exempt first-party renderer
  // (in-tree allowlist — a stack's paging sink must not silently vanish
  // behind an opt-in flag nobody flipped), or, since cortex#1794 (S9a, epic
  // #1784 "transparent repackaging" decision), a first-party ADAPTER whose
  // repoUrl is declared under THIS repo's own `arc-manifest.yaml`
  // `dependencies:` AND whose declared name follows the compass#115
  // `metafactory-cortex-adapter-<name>` naming standard (PR #1942 fix — a
  // dependency declared for an unrelated reason, e.g. `arc` or
  // `metafactory-bundle-discord`, must NOT get the exemption) — read fresh each
  // boot via `defaultCortexManifestPath()` (the default here; no options
  // passed), so an extracted in-tree adapter (e.g. `web`) keeps loading with
  // zero config change on any existing stack once its bundle is declared as
  // a `metafactory-cortex-adapter-web`-named dependency. The
  // runtime-hard-fail half of OQ9 (does `system.>` coverage still hold two
  // classes after this?) is cortex#1893, a separate issue; this loop only
  // SURFACES what loaded so that check has something to read.
  const pluginLoadResult = await loadExternalPlugins({
    registry: surfacePluginRegistry,
    externalEnabled: config.plugins.external,
  });
  // cortex#1792 — ONE stderr line per outcome, not two: `loadOneBundle`
  // (`src/adapters/loader.ts`) already writes a `cortex plugin-loader: …`
  // stderr line at the exact point each bundle is refused or loaded (and
  // `loadExternalPlugins` does the same for discovery issues). Boot used to
  // ALSO `console.error`/`console.log` the same failed/loaded outcomes here,
  // duplicating every plugin outcome in boot logs. This loop's job is only
  // the structured bus event (`system.plugin.load-failed`/`.loaded`) —
  // logging stays the loader's job. `skipped` is the one outcome the loader
  // never logs (an off-by-default gate skip isn't a failure worth a stderr
  // line), so its `console.log` here remains the single site for it.
  for (const failure of pluginLoadResult.failed) {
    // Per CLAUDE.md "no empty catch blocks" + this file's established
    // publish-site convention (`publishCapabilitiesFor`/tombstone/exec-brain
    // above all `await` + `try`/`catch`, never fire-and-forget `void`) — a
    // rejected bus publish here must not become an unhandled rejection, but
    // it also must not abort the loop or crash boot (one bad plugin outcome
    // failing to PUBLISH is not a reason to stop reporting the rest).
    try {
      await runtime.publish(
        createSystemPluginLoadFailedEvent({
          source: systemEventSource,
          bundleName: failure.bundleName,
          kind: failure.kind,
          pluginId: failure.pluginId,
          stage: failure.stage,
          reason: failure.reason,
        }),
      );
    } catch (err) {
      process.stderr.write(
        `cortex: failed to publish system.plugin.load-failed for "${failure.bundleName}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  for (const skippedPlugin of pluginLoadResult.skipped) {
    console.log(
      `cortex: plugin "${skippedPlugin.bundleName}" (${skippedPlugin.kind}:${skippedPlugin.id}) skipped: ${skippedPlugin.reason}`,
    );
  }
  for (const loadedPlugin of pluginLoadResult.loaded) {
    try {
      await runtime.publish(
        createSystemPluginLoadedEvent({
          source: systemEventSource,
          bundleName: loadedPlugin.bundleName,
          kind: loadedPlugin.kind,
          pluginId: loadedPlugin.id,
          firstParty: loadedPlugin.firstParty,
        }),
      );
    } catch (err) {
      process.stderr.write(
        `cortex: failed to publish system.plugin.loaded for "${loadedPlugin.bundleName}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // cortex#1789 (S4, ADR-0024 D5) — the REGISTRY pass for `surfaces:`
  // bindings, run here because this is the first point in boot where BOTH
  // the composed `Surfaces` (`options.surfaces`, structurally validated
  // already by `SurfacesSchema` at config-load) and a live
  // `SurfacePluginRegistry` are in hand — symmetric to the renderer boot
  // loop below. `loader.ts`'s `parseSurfaces` already runs this SAME check
  // against a freshly-constructed default registry at config-load time (so
  // `cortex config validate`/dry-run/migrate-config callers that never reach
  // this boot function still get the loud typo guard); this call is
  // therefore redundant-but-harmless for the in-tree-only plugin set S4
  // ships with, and becomes load-bearing once S6 lets a stack opt into
  // plugins the config-load-time default registry doesn't know about.
  validateSurfacesAgainstRegistry(options.surfaces, surfacePluginRegistry);

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
    // cortex#1951 — thread the SAME boot-composed registry `buildGatewayAdapters`
    // consumes below, so the ownership plan's Gateway adapter instance ids are
    // derived via each platform's real registered `demuxKey`, not a hardcoded
    // per-platform field read.
    registry: surfacePluginRegistry,
  });
  const gatewayOwned = surfaceOwnershipPlan.ownedSurfaceKeys;

  // S1 (cortex#1159) — the adapter-construction instance lists. `config.discord`
  // / `config.mattermost` / `config.slack` are flattened by the loader from
  // INLINE `agents[].presence.*` only; agents installed as agents.d/ fragments
  // feed the registry (`mergedAgents`) but their presence blocks never enter
  // those flat lists, so no adapter is constructed for them. We re-run the same
  // flatten helpers (now exported from the loader — same agent→flat-instance
  // mapping, identical `instanceId` convention) over the fragment-only agents
  // and APPEND the result. Inline agents are already in `config.X`, so we append
  // ONLY `fragmentOnlyAgents` (inline-shadowed fragments filtered out at the
  // registry-merge block) — no double-counting. Legacy bot.yaml (no inline
  // agents, empty agents.d) yields empty fragment lists → byte-identical to the
  // pre-S1 `for (const instance of config.X)` behavior. Each appended instance
  // carries an explicit `instanceId`, so the loops' `config.X.indexOf` /
  // `config.X.length` fallback (used only when `instanceId` is absent) never
  // runs for a fragment instance — that branch stays inline-only.
  const discordInstances = [...config.discord, ...flattenDiscordPresences(fragmentOnlyAgents)];
  const mattermostInstances = [...config.mattermost, ...flattenMattermostPresences(fragmentOnlyAgents)];
  const slackInstances = [...config.slack, ...flattenSlackPresences(fragmentOnlyAgents)];

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

  // S9 (epic #1514, plan §2, cortex#1523) — the inline Discord/Mattermost/
  // Slack construct→register→start→trust-merge sequence (three near-
  // identical loops, ~600 lines) extracted to `wireSurfaceAdapters`.
  // Construction now routes through the SAME `SurfacePluginRegistry` the
  // shared surface gateway uses (cortex#524 / ADR-0024 D5) — see that
  // module's doc for the full "what moved, what stayed" + PRESERVE ORDER
  // contract.
  // `adapterPolicyEngine` / `adapterPolicyLookup` / `adapterPolicyRegistry`
  // (constructed above, before the DispatchHandler) are shared verbatim
  // across all three platforms, same as pre-extraction.
  await wireSurfaceAdapters({
    config,
    discordInstances,
    mattermostInstances,
    slackInstances,
    agentByDiscordToken,
    agentByMattermostApiToken,
    agentBySlackBotToken,
    gatewayOwned,
    router,
    runtime,
    systemEventSource,
    principalDiscordId: options.principal?.discordId,
    principalMattermostId: options.principal?.mattermostId,
    principalSlackId: options.principal?.slackId,
    policyEngine: adapterPolicyEngine,
    policyLookup: adapterPolicyLookup,
    policyRegistry: adapterPolicyRegistry,
    agentRegistry,
    trustResolver,
    inboundWithGateBridge,
    disableOutboundPoller: options.disableOutboundPoller ?? false,
    // cortex#1797 (S12 MOVE) — `attachLegacyOutboundLog` moved into the
    // metafactory-cortex-adapter-discord bundle alongside the rest of
    // src/adapters/discord/; it's no longer statically importable here
    // (bundles load dynamically via the plugin loader, not via a
    // compile-time `import`). `setupOutboundLog` is now optional on
    // `WireSurfaceAdaptersOpts` and simply omitted — see that field's doc
    // for the accepted behaviour change (the legacy JSONL-polling
    // #agent-log/worklog direct-call bridge goes unwired; the bus-driven
    // `WorklogManager.surfaceConfig` path is unaffected).
    adapters,
    adapterCleanup,
    liveSurfaces,
    registry: surfacePluginRegistry,
  });

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
  // cortex#1793 (S8, ADR-0024 D3) — the renderer instance-handle map runtime
  // attach/detach/reload reads and mutates (`src/gateway/plugin-runtime.ts`).
  // Retains what `SurfaceRouter.register()`'s `{ unregister }` return value
  // used to be discarded here (ADR-0024's "the renderer boot loop simply
  // discards it" finding) — S8 keeps it, so a live renderer can leave the
  // router's dispatch list before teardown instead of only at full `stop()`.
  const rendererHandles = new Map<string, RendererHandle>();
  // `pluginLoadResult.loaded` (composed above, S6) tells us which renderer
  // ids came from an arc-installed bundle vs an in-tree registration — the
  // `bundleName` a `cortex plugin reload` needs to find the bundle again.
  const loadedRendererBundleById = new Map<string, string>(
    pluginLoadResult.loaded
      .filter((p) => p.kind === "renderer")
      .map((p) => [p.id, p.bundleName]),
  );
  // cortex#1793 (S8) — `renderers[]` entries whose `kind` wasn't registered
  // at boot time (`UnimplementedRendererKindError` specifically — a plugin
  // that hasn't loaded yet, NOT a malformed entry), keyed by the declared
  // kind. `cortex plugin load <bundleName>` reuses the retained raw entry
  // verbatim once its bundle becomes loadable, so `load` constructs EXACTLY
  // what boot would have — never a runtime-improvised config.
  const skippedRendererConfigs = new Map<string, unknown[]>();
  for (const raw of config.renderers ?? []) {
    // AgentConfig types renderers as z.unknown() so legacy bot.yaml loads
    // without breakage (the canonical shape lives on cortex-config's
    // RendererSchema). cortex#1789 (S4) — this is now a TWO-STAGE parse:
    // `resolveRendererPluginAndConfig` runs the structural pass
    // (`RendererSchema` — `{kind, ...}`) AND the registry pass (kind must
    // name an INSTALLED renderer plugin; the raw entry must satisfy that
    // plugin's real `configSchema`) in one call, using the SAME
    // `surfacePluginRegistry` this boot composed above. A typo or
    // unregistered kind fails here with a Zod/UnimplementedRendererKindError
    // — same "log + skip, other renderers still boot" fail-isolation as
    // before, just resolved through the registry instead of a closed enum.
    let kindForLog = "(unknown)";
    try {
      const { plugin, config: parsedConfig } = resolveRendererPluginAndConfig(raw, surfacePluginRegistry);
      kindForLog = plugin.rendererKind;
      const rawSubscribe = (parsedConfig as { subscribe?: unknown }).subscribe;
      const rendererConfig = {
        ...parsedConfig,
        ...(Array.isArray(rawSubscribe) && {
          subscribe: subjectPlaceholderSubstituter(rawSubscribe as string[]),
        }),
      };
      const renderer = plugin.createRenderer(rendererConfig);
      await renderer.start();
      const registration = router.register(renderer.surfaceConfig);
      renderers.push(renderer);
      rendererHandles.set(renderer.id, {
        renderer,
        unregister: registration.unregister,
        bundleName: loadedRendererBundleById.get(plugin.id) ?? "in-tree",
        rendererKind: renderer.kind,
        config: rendererConfig,
      });
      console.log(`cortex: ${kindForLog} renderer started (id: ${renderer.id})`);
    } catch (err) {
      // Parse failure (structural or registry pass), construction failure,
      // or `start()` failure. Per the G-1111 fail-safe rule, ONE broken
      // renderer must not prevent the others from coming up — log + skip.
      console.error(
        `cortex: ${kindForLog} renderer failed to start:`,
        err instanceof Error ? err.message : err,
      );
      // cortex#1793 (S8) — retain the raw entry ONLY for the "plugin hasn't
      // loaded yet" case, keyed by its declared kind, so `cortex plugin
      // load` can find it later. A structurally-invalid entry (caught by
      // `RendererSchema.parse` before the kind is even resolved) is a config
      // bug, not a load-order gap — never retained.
      if (err instanceof UnimplementedRendererKindError) {
        const declaredKind = (raw as { kind?: unknown }).kind;
        if (typeof declaredKind === "string") {
          const existing = skippedRendererConfigs.get(declaredKind) ?? [];
          existing.push(raw);
          skippedRendererConfigs.set(declaredKind, existing);
        }
      }
    }
  }

  // cortex#1893 (S12b-pre, ADR-0024 §OQ9) — the INSTALL-STATE half of the
  // G-1111 §4.6 renderer-coverage HARD-FAIL guard. This is the post-S6 seam:
  // `loadExternalPlugins` (S6, above) has already imported+registered any
  // arc-installed renderer bundles, and the renderer boot loop just above has
  // STARTED every renderer whose kind resolved — populating `renderers[]`
  // (what actually delivers) and `skippedRendererConfigs` (entries whose kind
  // is unregistered because their bundle isn't loaded → the install-state
  // signal). Only HERE is "did the bundle load?" answerable, so the
  // config-vs-install-state distinction (OQ9) is drawn here, not at
  // config-load. The config-load half (`loadCortexShape`) already asserted the
  // CONFIGURED set meets the floor, so a shortfall now is attributable to an
  // absent covering bundle → a loud INSTALL-STATE hard-fail naming the bundle +
  // `arc install` remedy, rather than the pager silently not paging. pagerduty
  // is now EXTRACTED to the metafactory-cortex-renderer-pagerduty bundle
  // (cortex#1894, ADR-0024), so the second renderer class is a first-party bundle
  // the loader installs at boot: with it loaded, the dashboard+pagerduty pair
  // passes; if that bundle fails to load, THIS is where the install-state
  // hard-fail bites (dashboard alone is inert and never satisfies the floor).
  assertRuntimeSystemCoverage(
    {
      // `r.subjects` are already placeholder-substituted (the boot loop above
      // substitutes `subscribe` before construction); re-substituting concrete
      // subjects in the coverage check is idempotent.
      started: renderers.map((r) => ({ kind: r.kind, subscribe: r.subjects })),
      skippedForMissingBundle: [...skippedRendererConfigs.entries()].flatMap(
        ([kind, rawEntries]) =>
          rawEntries.map((raw) => ({
            kind,
            subscribe: Array.isArray((raw as { subscribe?: unknown }).subscribe)
              ? ((raw as { subscribe: string[] }).subscribe)
              : [],
          })),
      ),
    },
    {
      principal: principalId,
      stack: options.stack !== undefined ? derivedStack.stack : undefined,
    },
  );

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
  const policyEngine = policyEngineFromConfig(resolvedPolicy, openOnboardingAgentIds);
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
  // S2 (cortex#1160) — per-agent builtin chat dispatch listeners.
  //
  // The builtin chat path is `createDispatchListener`: it consumes
  // `tasks.@{agent}.chat` envelopes off the bus and spawns a CC session. The
  // PERSONA / identity it runs under is NOT carried on the listener — it rides
  // the envelope payload (`agent_id`, `agent_name`, the persona-baked `prompt`)
  // stamped on the EMIT side by the per-agent `DispatchHandler.handleMessage`
  // (S1 routes each adapter instance to its matched agent via
  // `agentByDiscordToken`). So the only per-agent state a listener carries is
  // (a) its `receivingAgentId` trust anchor and (b) its subscribed subject.
  //
  // Pre-S2 a SINGLE listener was constructed bound to `firstAgent.id`,
  // subscribing to the default wildcard `tasks.*.>`. The wildcard caught EVERY
  // agent's tasks subtree, but the handler does NOT filter inbound `agent_id`
  // against `receivingAgentId` — so a second presence agent (Pier, installed as
  // an agents.d fragment per S1) had an adapter that published
  // `tasks.@pier.chat` but no listener consuming it on a per-agent subject →
  // silence (epic #1158 Gap 2).
  //
  // The fix constructs one listener per CHAT-CAPABLE agent: an agent in
  // `mergedAgents` with a platform `presence` (the surfaces it can be
  // @-mentioned on) AND a builtin brain (NOT `runtime.brain.kind === "exec"` —
  // those route via `BrainConsumer`). Headless agents (`presence: {}` —
  // approver/dev/release) get NONE; they run via the dispatch-listener as
  // bus-only workers but are never @-mentioned on a surface.
  //
  // **Double-delivery safety.** Because the handler does NOT filter by
  // `agent_id`, N listeners ALL subscribing to the shared wildcard `tasks.*.>`
  // would each process every agent's envelope → N-fold double-spawn. So when
  // there are 2+ chat-capable agents, each listener subscribes to its OWN
  // scoped subtree `local.{principal}.{stack}.tasks.@{enc-did}.>` (built via
  // the canonical `directTaskSubject`, byte-matching the emit side) — the
  // runtime fan-out delivers an agent's envelopes ONLY to that agent's
  // listener. No subject overlap ⇒ no double-delivery.
  //
  // **Single-agent byte-identity (non-negotiable).** When there is AT MOST one
  // chat-capable agent, we construct exactly ONE listener bound to
  // `firstAgent.id` with the subject OMITTED — i.e. the default wildcard
  // `tasks.*.>` — wiring byte-identical to pre-S2. This covers the common
  // single-inline-agent stack (Luna-only), a legacy flat `bot.yaml` (no
  // `agents[]` ⇒ `firstAgent` undefined ⇒ the existing no-listener guard), AND
  // a headless-only multi-agent stack (dev-loop): none gain a spurious extra
  // chat listener.
  // S2 (cortex#1160) — the chat-capable set: an enabled platform presence AND a
  // builtin (non-exec) brain. `isExecBrainAgent` is the SAME predicate the
  // brain-hosting path uses, injected so the rule can't drift. Pure helper in
  // `runner/chat-capable-agents.ts` so boot + tests share one definition.
  const chatAgents = chatCapableAgents(mergedAgents, isExecBrainAgent);
  // Per-agent listeners; `start()`/`stop()`-ed as a set (mirrors how
  // `reviewConsumers` / `brainConsumers` are tracked + drained).
  const dispatchListeners: DispatchListener[] = [];
  // R26 P1 (cortex#1371) — the substrate ADMISSION GATE (design
  // `docs/design-substrate-rate-limiting.md` Design B; contract myelin
  // `specs/admission.md`). Constructed ONLY when the principal declared a
  // `policy.admission` block — absent block ⇒ `admissionGate` stays
  // `undefined`, the listeners below receive no gate, and behaviour is
  // byte-identical to a pre-R26 build (the CO-4 inertness rule,
  // `gate-floor.ts:29-37`): no KV bucket provisioned, no admission reads,
  // no new envelopes.
  //
  // State lives in the per-(principal, stack) NATS-KV bucket
  // `admission_{principal}_{stack}` — provisioned idempotently here
  // (mirroring the review-stream provisioning above) and arbitrated by CAS,
  // so admission counters are EXACT across N cortex nodes. Provisioning
  // failure is NON-FATAL: the gate starts in its designed DEGRADED posture
  // (node-local approximate buckets + loud `system.admission.degraded`
  // event; anonymous dispatches fail closed) rather than blocking boot.
  let admissionGate: AdmissionGate | undefined;
  if (resolvedPolicy?.admission !== undefined) {
    const admissionBucket = admissionBucketName(principalId, derivedStack.stack);
    let admissionJsm: import("./bus/jetstream/types").ProvisionJsm | null = null;
    if (runtime.jetstreamManager !== undefined) {
      try {
        admissionJsm = await runtime.jetstreamManager();
      } catch (err) {
        process.stderr.write(
          `cortex: jetstreamManager() resolution failed for admission provisioning — ` +
            `continuing to KV open: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    const provisionedAdmission = await provisionAdmissionKv({
      jsm: admissionJsm,
      openKv: async (bucket) =>
        runtime.kvBucket !== undefined ? await runtime.kvBucket(bucket) : null,
      bucket: admissionBucket,
      log: console,
    });
    // Tier-2 resolution input: principal id → declared role ids. Built once
    // from the SAME parsed policy the engine uses, so admission roles can't
    // drift from authorisation roles.
    const admissionPrincipalRoles = new Map<string, readonly string[]>(
      resolvedPolicy.principals.map((p) => [p.id, p.role]),
    );
    admissionGate = new AdmissionGate({
      config: resolvedPolicy.admission,
      kv: provisionedAdmission.kv,
      principalRoles: admissionPrincipalRoles,
      // Design §4.4 — degrade transitions MUST be loud: a `system.admission.
      // degraded` envelope per transition (the gate also writes stderr).
      // Fire-and-forget with a logged rejection — the transition event must
      // never block or fail an admission decision (no-empty-catch rule).
      onDegradeTransition: (mode, detail) => {
        void runtime
          .publish(
            createSystemAdmissionDegradedEvent({
              source: systemEventSource,
              mode,
              detail,
              bucket: admissionBucket,
            }),
          )
          .catch((err: unknown) => {
            process.stderr.write(
              `cortex: system.admission.degraded publish failed (mode=${mode}): ` +
                `${err instanceof Error ? err.message : String(err)}\n`,
            );
          });
      },
    });
    console.log(
      `cortex: admission gate ENABLED — bucket=${admissionBucket} ` +
        `(${provisionedAdmission.outcome}), tiers=stack+principal, ` +
        `stack=${resolvedPolicy.admission.stack !== undefined ? "configured" : "unset"}, ` +
        `defaults=${resolvedPolicy.admission.defaults !== undefined ? "configured" : "unset"}, ` +
        `anonymous=built-in-ceiling${resolvedPolicy.admission.anonymous !== undefined ? "+config" : ""}`,
    );
  }

  // Shared options every listener carries — only `receivingAgentId` + the
  // scoped `subjects` differ per agent. Built once so the per-agent wiring
  // can't drift between listeners.
  // API-P1.3 (#2063) — thread receiving agents' runtime configs + the inference
  // registry into the dispatch listener so `substrate: api-agent` agents resolve
  // through the `ApiAgentHarness`. The map is the BOOT snapshot of `mergedAgents`
  // (agents with a `runtime` block only); the registry wires the real provider
  // factories over the machine-layer `inference` config (empty → any `api-agent`
  // dispatch fails closed at the harness). claude-code agents are untouched.
  const agentRuntimesById = new Map<string, AgentRuntime>();
  for (const a of mergedAgents) {
    if (a.runtime !== undefined) agentRuntimesById.set(a.id, a.runtime);
  }
  // cortex#2133 (epic #2164) — BOOT snapshot of each agent's declared `env:`
  // passthrough, keyed by agent id. The dispatch-listener injects the RECEIVING
  // agent's map onto `req.runtime.agentEnv` receiving-stack-authoritatively (the
  // executing stack's config is the single source of truth — the value NEVER
  // comes from the inbound wire, mirroring the `bashAllowlist`/`mcpGrants`
  // receiving-side authority). Empty map ⇒ no agent declared `env:` ⇒ no-op.
  const agentEnvById = new Map<string, Record<string, string>>();
  for (const a of mergedAgents) {
    if (a.env !== undefined) agentEnvById.set(a.id, a.env);
  }
  const inferenceRegistry = createInferenceRegistry(
    config.inference ?? { providers: {}, profiles: {} },
  );
  // API-P1.4 — pre-flight EVERY inference profile at boot (design §"fail at
  // config load"). An unresolvable profile (unknown provider, no factory for
  // its protocol) surfaces HERE, loudly, rather than lurking until the first
  // `substrate: api-agent` dispatch. Kept NON-FATAL: the api-agent harness
  // already fails closed per-dispatch on the same conditions, and one bad
  // profile must not take down a daemon serving unrelated claude-code agents —
  // so this reports (stderr, one line per profile) and boot continues. Empty
  // `inference` config ⇒ no profiles ⇒ no output.
  for (const err of inferenceRegistry.validateAll()) {
    process.stderr.write(
      `[boot/inference] inference profile "${err.profileName}" does not resolve ` +
        `(${err.code}): ${err.message} — any \`substrate: api-agent\` agent bound ` +
        `to it will fail closed at dispatch.\n`,
    );
  }

  const sharedDispatchListenerOpts = {
    runtime,
    source: systemEventSource,
    stack: derivedStack.stack,
    agentRuntimesById,
    agentEnvById,
    inferenceRegistry,
    ...(policyEngine !== undefined && { policyEngine }),
    trustResolver,
    // TC-0 (#628) — verifier knobs resolved from `security.signing`. `off`/
    // `permissive` → verify but never reject empty adapter chains
    // (`rejectEmpty: false`); `enforce` → reject unsigned (`rejectEmpty:
    // true`). `cryptoVerify` stays `true` across all postures (cheap).
    cryptoVerify: signingKnobs.cryptoVerify,
    rejectEmpty: signingKnobs.rejectEmpty,
    principalId,
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
    // R26 P1 (cortex#1371) — admission gate. Spread-guarded like the other
    // optional fields: an unconfigured stack passes NO gate and the listener's
    // admission stage is skipped entirely (CO-4 inertness).
    ...(admissionGate !== undefined && { admissionGate }),
  };
  if (chatAgents.length >= 2) {
    // Multi-agent: each chat-capable agent gets its OWN listener on its OWN
    // scoped subtree subject so the runtime never fans the same envelope to
    // two listeners.
    for (const agent of chatAgents) {
      const agentChatSubject = directTaskSubject(
        principalId,
        `did:mf:${agent.id}`,
        derivedStack.stack,
      );
      const listener = createDispatchListener({
        ...sharedDispatchListenerOpts,
        receivingAgentId: agent.id,
        subjects: [agentChatSubject],
        // Disambiguate stderr/audit log prefixes per agent.
        adapterId: `runner-dispatch-listener-${agent.id}`,
      });
      dispatchListeners.push(listener);
      console.log(
        `cortex: dispatch-listener started — receivingAgentId=${agent.id} ` +
          `subject=${agentChatSubject}`,
      );
    }
  } else {
    // At-most-one chat-capable agent → exactly ONE listener, wiring
    // byte-identical to pre-S2: bound to `firstAgent.id` (the existing
    // `mergedAgents[0]` fallback, or undefined → the no-receivingAgentId
    // path) with the default wildcard `tasks.*.>` subscription (subject
    // OMITTED). Legacy flat bot.yaml (`firstAgent` undefined) keeps the
    // historical no-op-receiver behaviour.
    const listener = createDispatchListener({
      ...sharedDispatchListenerOpts,
      ...(firstAgent !== undefined && { receivingAgentId: firstAgent.id }),
    });
    dispatchListeners.push(listener);
  }
  for (const listener of dispatchListeners) {
    await listener.start();
  }

  // F-6 — reflex activation bridge. Config-gated: mounted only when the
  // principal declared `reflex_activation.targets`. Binds a durable consumer
  // on the reflex-owned REFLEX stream; CC-prompt targets re-emit as `tasks.*`
  // dispatches the executor above runs, `handler` targets are invoked
  // in-process by a code handler below. Dormant (and not constructed)
  // otherwise → zero behaviour change on default deployments.
  let reflexActivationListener: ReflexActivationListener | undefined;
  const reflexTargets = options.reflexActivation?.targets ?? [];
  if (reflexTargets.length > 0) {
    // F-6 downstream — code handlers for `handler`-flagged targets. The
    // notify.discord handler posts reflex-bridged GitHub issues to a per-repo
    // Discord webhook (no Claude session); mounted only when `notify.discord`
    // is configured. The bridge invokes it directly — no bus re-emit.
    const handlers: Record<string, ReflexActivationHandler> = {};
    const notifyDiscordTargets = options.notify?.discord ?? [];
    if (notifyDiscordTargets.length > 0) {
      handlers["discord-webhook"] = createDiscordNotifier({
        runtime,
        source: systemEventSource,
        targets: notifyDiscordTargets,
      });
    }
    // Generic command runner for `handler: "process"` targets. Shipped once;
    // each process is a DATA spec file in the processes directory (read fresh
    // per fire, so a new spec needs no restart). Always registered when the
    // bridge mounts — inert unless a `handler: process` target fires. The dir:
    // $CORTEX_PROCESSES_DIR, else `<config-dir>/processes`, else
    // `~/.config/cortex/processes`.
    const expandedConfigPath = options.configPath?.replace(/^~/, homedir());
    const processesDir =
      process.env.CORTEX_PROCESSES_DIR ??
      (expandedConfigPath !== undefined
        ? join(dirname(expandedConfigPath), "processes")
        : join(homedir(), ".config", "cortex", "processes"));
    handlers.process = createProcessRunner({
      runtime,
      source: systemEventSource,
      processesDir,
    });
    reflexActivationListener = new ReflexActivationListener({
      runtime,
      source: systemEventSource,
      reEmitPrincipal: principalId,
      reEmitStack: derivedStack.stack,
      // Same-principal only (v1): consume + re-emit under THIS principal.
      // Bridging another principal's `local.` subject would breach the
      // principal boundary (CONTEXT.md §Network) — that's a federated path,
      // out of scope here. Only the reflex stack segment is configurable.
      reflexPrincipal: principalId,
      reflexStack: options.reflexActivation?.stack ?? "default",
      resolveTarget: (target) => reflexTargets.find((t) => t.target === target),
      handlers,
      dedup: inMemoryReflexDedup(),
    });
    await reflexActivationListener.start();
    console.log(
      `cortex: reflex-activation-listener mounted — ${reflexTargets.length} target(s), ${Object.keys(handlers).length} handler(s)`,
    );
  }

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
      // Keep the process-wide config-home current on hot reload (a `substrates:`
      // edit takes effect for subsequently-spawned sessions without a restart),
      // and re-log on CHANGE. Without the re-log the boot line goes stale-but-
      // confident: deleting `substrates:` and reloading silently reverts every
      // later session to the vendor default while the one line the principal can
      // check still reports the old home. A confidently wrong log is worse than
      // no log.
      const homeBeforeReload = activeConfigHomeEnv("claude-code")?.value;
      setActiveSubstrates(event.config.substrates);
      const homeAfterReload = activeConfigHomeEnv("claude-code")?.value;
      if (homeBeforeReload !== homeAfterReload) {
        console.log(
          `cortex: Claude config home changed on reload → ${homeAfterReload ?? "(vendor default — no substrates.claude-code.configHome)"}`,
        );
      }
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

  // ===========================================================================
  // B-0 (cortex#1021, design-bot-packs §7 + §11) — daemon-level agents.d/
  // fragment watcher + hot reload.
  // ===========================================================================
  //
  // This wires the in-tree `AgentsDirectoryWatcher` (cortex#60 A.1, which until
  // now was unit-tested but UNWIRED at the daemon level — see the historical
  // TODO this section closes) into the running daemon, EXTENDING the existing
  // reload machinery (the ConfigWatcher above) rather than inventing a parallel
  // one. On a fragment add/change/remove (debounced), or an explicit
  // `cortex agents reload` / SIGHUP, it:
  //
  //   1. revalidates fragments + rebuilds the merged agent set (inline
  //      cortex.yaml agents still WIN on id conflict — design §6.1);
  //   2. swaps `agentRegistry` under a bumped `agentGeneration`;
  //   3. reconciles REVIEW CONSUMERS — an ADDED agent's consumers START via the
  //      same `startForAgent` boot uses; a REMOVED agent's
  //      consumers DRAIN (`.stop()` lets in-flight finish) and leave
  //      `reviewConsumers[]`; a CHANGED agent is remove-then-add;
  //   4. reconciles the capability registry (Sage cortex#1027): re-publishes
  //      registrations for ADDED + CHANGED agents only (diff-only, not the whole
  //      roster), and TOMBSTONES removed agents (and changed-to-empty agents) with
  //      an empty-capability registration so a removed agent stops being a
  //      registered provider — both keyed on agent_id;
  //   5. an invalid fragment is REJECTED without killing the daemon — the old
  //      generation is retained and a warning is logged.
  //
  // HONEST SCOPE — PRESENCE ADAPTERS ARE RESTART-ONLY (documented limitation).
  // Live presence-adapter (Discord/Mattermost/Slack) start/stop on reload is
  // deeply entangled with boot: the two-pass cross-adapter trust resolution
  // (cortex#98 part B) and the surface-router registration both run once over
  // the full roster at boot. Hot-swapping a single adapter would have to
  // re-run those shared passes safely mid-flight. Per the task's honest-scope
  // rule we DO NOT half-implement that — the registry + review-consumer +
  // capability hot path is fully live; presence changes for a hot-added/removed
  // agent require a daemon restart. The reconcile logs a warning and
  // `reloadAgents()` callers (the CLI) surface the same notice.
  //
  // The reconcile is SERIALIZED behind `reloadInFlight` so overlapping triggers
  // (a fast double fs.watch event, or a CLI reload racing a watcher reload)
  // don't interleave consumer start/stop. Each trigger awaits the prior one.
  let liveFragmentAgents: Agent[] = fragmentAgents;
  let liveMergedAgents: Agent[] = mergedAgents;
  let reloadInFlight: Promise<void> = Promise.resolve();

  // Predicate mirrors the boot-time `reviewCapableAgents` filter so a
  // hot-added agent is started iff it would have been started at boot — an
  // exec-brain agent is hosted by the BRAIN path, never the review path.
  const isReviewCapable = (a: Agent): boolean => {
    if (isExecBrainAgent(a)) return false;
    const caps = a.runtime?.capabilities ?? [];
    return caps.some((c) => c === "code-review" || c.startsWith("code-review."));
  };
  // Bot Packs B-1 — the hot-reload path reuses the SINGLE `isBrainHosted`
  // predicate defined at boot setup (cortex#1033 §Maintainability) so a hot-added
  // exec-brain agent is started iff it would have been started at boot, with no
  // chance of the two filters drifting.

  // Drain + remove every review consumer owned by `agentId` from
  // `reviewConsumers[]`. `ReviewConsumer.stop()` is idempotent and awaits the
  // in-flight set per its own drain contract (cortex#237 PR-6), so a removed
  // agent's in-flight reviews publish their terminal envelope before teardown.
  const drainConsumersForAgent = async (agentId: string): Promise<void> => {
    // Iterate a snapshot of the indices to remove (consumers can appear more
    // than once per agent: local + offer-scope + federated offer/direct).
    const toStop = reviewConsumers.filter((c) => c.agent.id === agentId);
    // Bot Packs B-1 — the agent's brain consumer (if any) drains on the SAME
    // path. A reload that removes/changes an exec-brain agent must stop its
    // BrainConsumer (which drains its in-flight brain tasks per its own
    // contract) just like a review agent's consumers.
    const brainToStop = brainConsumers.filter((c) => c.agent.id === agentId);
    // Sage cortex#1027 — drain this agent's consumers CONCURRENTLY. Each
    // `stop()` drains in-flight work; serializing them made one agent's reload
    // latency the SUM of its consumers' drains. `allSettled` so one failing
    // stop doesn't abort the siblings; we log each rejection by index.
    const outcomes = await Promise.allSettled([
      ...toStop.map((c) => c.stop()),
      ...brainToStop.map((c) => c.stop()),
    ]);
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "rejected") {
        const err: unknown = outcome.reason;
        process.stderr.write(
          `cortex: agents-reload — consumer drain failed for agent=${agentId} ` +
            `(consumer ${i}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });
    // Compact `reviewConsumers[]` + `brainConsumers[]` in place, preserving
    // order of survivors.
    for (let i = reviewConsumers.length - 1; i >= 0; i--) {
      if (reviewConsumers[i]?.agent.id === agentId) {
        reviewConsumers.splice(i, 1);
      }
    }
    for (let i = brainConsumers.length - 1; i >= 0; i--) {
      if (brainConsumers[i]?.agent.id === agentId) {
        brainConsumers.splice(i, 1);
      }
    }
    // Bot Packs B-2 — the removed/changed agent's daemon brain host (if any) was
    // already drained by its BrainConsumer.stop() above (which calls
    // host.drain()); compact it out of the tracking array so a subsequent
    // shutdown doesn't re-stop a host whose generation is gone. stop() is
    // idempotent regardless, so this is bookkeeping, not correctness.
    for (let i = daemonBrainHosts.length - 1; i >= 0; i--) {
      if (daemonBrainHosts[i]?.agentId === agentId) {
        daemonBrainHosts.splice(i, 1);
      }
    }
  };

  // The single reconcile path. Both the fs.watch callback and the handle's
  // `reloadAgents()` route here through `runReconcile`. Computes the merged
  // diff (inline wins), drains removed/changed-old consumers, starts
  // added/changed-new consumers, swaps the registry, re-publishes caps.
  const reconcileFromEvent = async (event: AgentsChangeEvent): Promise<void> => {
    if (event.failed) {
      // Invalid fragment mid-run: keep the old generation alive. The watcher
      // already retained the prior valid agent set; we don't swap anything.
      console.warn(
        `cortex: agents-reload (${event.source}) REJECTED — invalid fragment ${event.error?.file ?? "?"}: ` +
          `${event.error?.reason ?? "unknown"} — keeping generation ${agentGeneration}`,
      );
      options.onAgentsReloaded?.({
        generation: agentGeneration,
        source: event.source,
        failed: true,
        added: [],
        removed: [],
        changed: [],
        consumerAgentIds: reviewConsumers.map((c) => c.agent.id),
      });
      return;
    }

    // `event.agents` is the fresh FRAGMENT set. Re-apply the inline-wins merge
    // (design §6.1) so an inline cortex.yaml agent still shadows a fragment of
    // the same id after the reload.
    const freshFragments = event.agents;
    const freshMerged: Agent[] = [
      ...inlineAgents,
      ...freshFragments.filter((a) => !inlineIds.has(a.id)),
    ];

    // Diff the MERGED view (not the raw fragment view) so a fragment change to
    // an inline-shadowed id is a no-op, and removing a fragment that an inline
    // entry shadows does not tear down the inline agent's consumers.
    const priorById = new Map(liveMergedAgents.map((a) => [a.id, a]));
    const freshById = new Map(freshMerged.map((a) => [a.id, a]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [id, fresh] of freshById) {
      const prior = priorById.get(id);
      if (prior === undefined) added.push(id);
      else if (!agentsEqual(prior, fresh)) changed.push(id);
    }
    for (const id of priorById.keys()) {
      if (!freshById.has(id)) removed.push(id);
    }
    added.sort();
    removed.sort();
    changed.sort();

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      // Nothing structurally changed in the merged view — do not bump the
      // generation, do not churn consumers. (e.g. a fragment touched but its
      // content is byte-identical, or only inline-shadowed ids moved.)
      console.log(
        `cortex: agents-reload (${event.source}) — no effective change (generation ${agentGeneration})`,
      );
      options.onAgentsReloaded?.({
        generation: agentGeneration,
        source: event.source,
        failed: false,
        added: [],
        removed: [],
        changed: [],
        consumerAgentIds: reviewConsumers.map((c) => c.agent.id),
      });
      return;
    }

    // ── Drain consumers for removed + changed (old definition) agents first ──
    //    Sage cortex#1027 — drain all affected agents CONCURRENTLY; each
    //    `drainConsumersForAgent` already settles its own consumers in parallel
    //    and logs failures, so the whole drain is one parallel wave rather than
    //    a per-agent serial chain.
    await Promise.all(
      [...removed, ...changed].map((id) => drainConsumersForAgent(id)),
    );

    // ── Swap the registry + bump the generation BEFORE starting new consumers,
    //    so a started consumer reads the new registry generation. ──
    liveFragmentAgents = [...freshFragments];
    liveMergedAgents = freshMerged;
    agentRegistry = AgentRegistry.fromAgents(freshMerged);
    agentGeneration += 1;

    // ── cortex#1720 S1 — scaffold-on-activation for added + changed agents. ──
    //    Same opt-in / idempotent / non-fatal helper boot uses. A hot-added (or
    //    changed-into-stateful) fragment gets its instance dir ensured here; a
    //    stateless add is a no-op (the `if (agent.state)` guard inside). Removed
    //    agents are intentionally NOT torn down — the events log is append-only
    //    and the principal owns the instance dir's lifecycle.
    for (const id of [...added, ...changed]) {
      const agent = freshById.get(id);
      if (agent !== undefined) scaffoldStatefulAgent(agent);
    }

    // ── Start consumers for added + changed (new definition) agents via the
    //    SAME construction path boot uses — concurrently (sage round 2),
    //    mirroring the parallel drain wave above. A review-capable agent starts
    //    a ReviewConsumer; an exec-brain agent starts a BrainConsumer (the two
    //    are mutually exclusive per agent, §6). ──
    await Promise.all(
      [...added, ...changed].map(async (id) => {
        const agent = freshById.get(id);
        if (agent === undefined) return;
        if (isReviewCapable(agent)) {
          await startForAgent(agent);
        } else if (isBrainHosted(agent)) {
          await startBrainForAgent(agent);
        }
      }),
    );

    // ── Re-publish the capability registry (deliverable 3). ──
    //    Sage cortex#1027:
    //    (a) DIFF-ONLY republish — only re-emit registrations for added + changed
    //        agents. Unchanged agents' registrations are already live and keyed by
    //        agent_id; re-emitting all of them made a one-fragment edit cost
    //        O(total agents) bus publishes. We republish O(changed agents).
    //    (b) TOMBSTONE removed agents — a removed agent must have its prior
    //        registration OVERWRITTEN with an empty-capability registration, else
    //        it stays registered as a provider of capabilities it no longer hosts.
    const republishIds = new Set([...added, ...changed]);
    const republishAgents = freshMerged.filter((a) => republishIds.has(a.id));
    if (republishAgents.length > 0) {
      await publishCapabilitiesFor(republishAgents, "reload");
    }
    // Tombstone every agent whose registration must be CLEARED: removed agents,
    // plus CHANGED agents that dropped to zero capabilities (publishCapabilities-
    // For skips empty-capability entries, so without an explicit tombstone such an
    // agent would keep its stale prior registration).
    const changedToEmpty = changed.filter((id) => {
      const a = freshById.get(id);
      if (a === undefined) return true;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tolerate partially-loaded runtime fragments during reload; missing capabilities means empty.
      return (a.runtime?.capabilities?.length ?? 0) === 0;
    });
    await publishCapabilityTombstones([...removed, ...changedToEmpty]);

    // ── Canonical presence envelope (sage round 3): the legacy registry write
    //    above is the migration-period dual-emit; `agent.capabilities-changed`
    //    is the canonical signal presence consumers follow (CONTEXT.md §Agent
    //    presence). Diff-based: the producer only emits on a real delta.
    const presenceProducer = presenceProducerForReload;
    if (presenceProducer !== null) {
      let emitted = 0;
      for (const id of [...added, ...changed]) {
        const fresh = freshById.get(id);
        if (fresh === undefined) continue;
        const caps = fresh.runtime?.capabilities ?? [];
        if (presenceProducer.publishCapabilitiesChanged(id, caps)) emitted += 1;
      }
      for (const id of removed) {
        if (presenceProducer.publishCapabilitiesChanged(id, [])) emitted += 1;
      }
      if (emitted > 0) {
        console.log(
          `cortex: agents-reload — emitted ${emitted} agent.capabilities-changed`,
        );
      }
    }

    // ── Honest-scope: presence-adapter changes are restart-only. Warn when a
    //    reload added/removed an agent that declares a presence binding (the
    //    case where a restart is actually needed to (dis)connect a bot). ──
    const presenceAffected = [...added, ...removed, ...changed].filter((id) => {
      const a = freshById.get(id) ?? priorById.get(id);
      return (
        a?.presence.discord !== undefined ||
        a?.presence.mattermost !== undefined ||
        a?.presence.slack !== undefined
      );
    });
    if (presenceAffected.length > 0) {
      process.stderr.write(
        `cortex: agents-reload (${event.source}) — presence changes for ${presenceAffected.join(", ")} ` +
          `require a daemon restart (registry + review consumers + capabilities updated live; ` +
          `presence adapters are restart-only — see B-0 honest-scope note).\n`,
      );
    }

    console.log(
      `cortex: agents-reload (${event.source}) — generation ${agentGeneration} ` +
        `(added: [${added.join(",")}], removed: [${removed.join(",")}], changed: [${changed.join(",")}])`,
    );
    options.onAgentsReloaded?.({
      generation: agentGeneration,
      source: event.source,
      failed: false,
      added,
      removed,
      changed,
      consumerAgentIds: reviewConsumers.map((c) => c.agent.id),
    });
  };

  // Serialize every reconcile behind `reloadInFlight` so triggers can't
  // interleave consumer start/stop. Returns the chained promise so callers
  // (the CLI handle path) can await completion.
  const runReconcile = (event: AgentsChangeEvent): Promise<void> => {
    const next = reloadInFlight.then(() => reconcileFromEvent(event));
    // Swallow the rejection on the CHAIN (not on `next`) so one failed
    // reconcile doesn't poison every subsequent trigger; the per-reconcile
    // body already logs its own errors.
    reloadInFlight = next.catch((err: unknown) => {
      process.stderr.write(
        `cortex: agents-reload reconcile error (non-fatal): ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
    return next;
  };

  // The watcher itself. Constructed with the BOOT fragment set as its baseline
  // so the first fs.watch diff is computed against what boot actually loaded.
  // `null` when disabled (tests) or when the daemon has no agents.d/ in play.
  let agentsWatcher: AgentsDirectoryWatcher | null = null;
  if (!options.disableAgentsWatcher) {
    agentsWatcher = new AgentsDirectoryWatcher(
      agentsDir,
      fragmentAgents,
      (event) => {
        void runReconcile(event);
      },
      {
        ...(options.agentsWatcherDebounceMs !== undefined && {
          debounceMs: options.agentsWatcherDebounceMs,
        }),
      },
    );
    agentsWatcher.start();
  }

  // `reloadAgents()` (handle) + SIGHUP both call this. When the watcher exists
  // we route through its `triggerReload` (which loads the dir + emits the same
  // AgentsChangeEvent the fs.watch path emits) so there is ONE reconcile path.
  // When the watcher is disabled, we load the directory directly and synthesize
  // the event so the CLI/SIGHUP still works in watcher-less deployments/tests.
  const reloadAgentsViaTrigger = async (
    source: "cli" | "sighup",
  ): Promise<void> => {
    if (agentsWatcher !== null) {
      // Capture the reconcile promise: triggerReload fires the handler
      // synchronously (no debounce for explicit triggers), which calls
      // runReconcile and assigns reloadInFlight. Await that.
      agentsWatcher.triggerReload(source);
      await reloadInFlight;
      return;
    }
    // Watcher-less path: load + reconcile directly.
    let event: AgentsChangeEvent;
    try {
      const fresh = loadAgentsDirectory(agentsDir);
      event = {
        source,
        failed: false,
        agents: fresh,
        // The diff sets are recomputed inside reconcileFromEvent against the
        // live merged view; these fragment-level sets are unused there.
        agentsAdded: [],
        agentsRemoved: [],
        agentsChanged: [],
      };
    } catch (err) {
      const isFragErr = err instanceof FragmentLoadError;
      event = {
        source,
        failed: true,
        error: {
          file: isFragErr ? err.file : agentsDir,
          reason: err instanceof Error ? err.message : String(err),
        },
        agents: liveFragmentAgents,
        agentsAdded: [],
        agentsRemoved: [],
        agentsChanged: [],
      };
    }
    await runReconcile(event);
  };

  // SIGHUP → agents reload, on the SAME path the watcher + CLI use. Registered
  // once; harmless when the watcher is disabled (the trigger still revalidates
  // + reconciles by reloading the dir directly). Deregistered in `drain()`.
  const sighupHandler = (): void => {
    void reloadAgentsViaTrigger("sighup");
  };
  process.on("SIGHUP", sighupHandler);

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
  // MC-A1 (cortex#1275) — mutable holder threaded into the MC server as a lazy
  // getter so `GET /api/networks` can read the joined networks + their admitted
  // roster ⋈ presence. Assigned in the federation block below (after
  // `resolvedPolicy` is known); `null` until then ⇒ the route serves an empty
  // list. The MC server resolves it per request.
  let networksViewForApi: NetworksView | null = null;
  // FLG-1 (docs/plan-mc-future-state.md §4.D) — the guided-join handoff view for
  // `GET /api/networks/:net/handoff/:member`. Assigned in the federation block
  // below alongside `networksViewForApi` (it reuses the SAME resolved registry +
  // stack seed to gather the 3 leg signals via the shared `gatherHandoffSignals`
  // + live ports). `null` until then ⇒ the handoff route 503s honestly. Read-only
  // — signs/mutates nothing; the leaf-up leg reads the LOCAL `/leafz`.
  let handoffViewForApi: HandoffView | null = null;
  // FLG-3 (docs/plan-mc-future-state.md §4.D) — the network doctor view for
  // `GET /api/networks/:net/doctor`. Assigned in the federation block below
  // alongside `handoffViewForApi` (it reuses the SAME resolved policy + the
  // daemon's already-running `runtime` as the probe bus). `null` until then ⇒
  // the doctor route 503s honestly. Read-only — signs/mutates nothing beyond the
  // ONE bounded probe echo per peer (the SAME transport `cortex network ping`
  // uses).
  let doctorViewForApi: DoctorView | null = null;
  // MC-B2 (cortex#1279) — the admission-decision signer for the mutating
  // `POST /api/networks/admission-decision` action. Assigned in the federation
  // block below alongside `networksViewForApi` (it reuses the SAME stack
  // identity material + resolved registry). `null` until then ⇒ the route 503s.
  // Signs LOCALLY with the stack seed; never wired in the CF worker.
  let admissionDeciderForApi: AdmissionDecider | null = null;
  // FLG-2 (cortex#1706) — the authorize-from-glass signer for the trust-granting
  // `POST /api/networks/authorize` action. Assigned in the federation block below
  // from the hub-admin seed (the Q5-collapse hub-admin = the stack seed for a
  // single-principal deployment). `null` until then ⇒ the route returns a
  // structured 503 `hub_admin_not_configured` (fail-closed). Signs LOCALLY with
  // the hub-admin seed; never wired in the CF worker.
  let authorizerForApi: Authorizer | null = null;
  // #1008/#989 — discovered LOCAL sibling stacks, used by BOTH the DB-read
  // pane-of-glass aggregation (the embed's `localAggregation` getter, below, for
  // session trees) AND the #989 bus sibling-presence aggregator (later, for
  // idle-or-active liveness). The two paths COMPOSE (presence via bus, sessions
  // via db) — they are no longer mutually exclusive; `aggregateAgentTiles` dedups
  // the overlap by key. Empty until the aggregation block computes it; the getter
  // reads this holder lazily (the embed starts before discovery runs).
  const aggCfg = config.mc.aggregateLocalStacks;
  let discoveredSiblings: readonly SiblingStackDescriptor[] = [];
  let siblingResolveOpts: SiblingDbResolveOptions | null = null;
  if (config.mc.enabled && !options.disableDashboard) {
    // Per-slug default keeps each stack's MC db isolated. XDG wave-5 (#1902):
    // the canonical per-stack db now lives under the metafactory data root
    // (`~/.local/share/metafactory/cortex/mc/<stack>/…`). `migrateStackDbOnTouch`
    // resolves the canonical path AND carries a legacy `~/.local/share/cortex/mc`
    // db to it (copy-keep-source, WAL-checkpointed) so MC history is continuous
    // across the move; a fresh stack simply lands at the canonical write target.
    const defaultDbPath = migrateStackDbOnTouch(derivedStack.stack, homedir());
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
      // #1044 — headless MC mode (producer/server split). `mc.server.enabled`
      // false ⇒ run db + ingestor only, SKIP the HTTP/WS server. A lean stack
      // (work/halden) WRITES its `mission-control.db` for the pane-of-glass
      // (#1008) to read, without binding a port or serving a dashboard. The
      // db-read aggregation (which SERVES the pane) is full-mode-only, so the
      // `localAggregation` getter only resolves a context on a server stack
      // (`siblingResolveOpts` is computed below under the same `aggCfg` gate,
      // independent of headless — a headless stack simply doesn't serve).
      const mcHeadless = !config.mc.server.enabled;
      mcHandle = await startMissionControl({
        configPath: config.mc.configPath || undefined,
        dbPath,
        port: config.mc.port,
        ...(mcHeadless ? { headless: true } : {}),
        // FS-7 / D-3 (cortex#1839) — surface a degraded boot on MC `/health`.
        ...(options.degraded !== undefined ? { degraded: options.degraded } : {}),
        agentPresence: () => presenceViewForApi,
        // MC-A1 (cortex#1275) — networks view (lazy; assigned in the federation
        // block once `resolvedPolicy` is known). null ⇒ empty `/api/networks`.
        networks: () => networksViewForApi,
        // MC-B2 (cortex#1279) — the local-daemon admission-decision signer
        // (lazy; assigned in the federation block once the stack identity +
        // registry are resolved). null ⇒ `POST /api/networks/admission-decision`
        // 503s honestly.
        admissionDecider: () => admissionDeciderForApi,
        // FLG-2 (cortex#1706) — the local-daemon authorize-from-glass signer
        // (lazy; assigned in the federation block once the hub-admin seed +
        // registry are resolved). null ⇒ `POST /api/networks/authorize` returns
        // 503 `hub_admin_not_configured`.
        authorizer: () => authorizerForApi,
        // FLG-1 (docs/plan-mc-future-state.md §4.D) — the guided-join handoff
        // view (lazy; assigned in the federation block). null ⇒
        // `GET /api/networks/:net/handoff/:member` 503s honestly.
        handoffView: () => handoffViewForApi,
        // FLG-3 (docs/plan-mc-future-state.md §4.D) — the network doctor view
        // (lazy; assigned in the federation block). null ⇒
        // `GET /api/networks/:net/doctor` 503s honestly.
        doctorView: () => doctorViewForApi,
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
      // #1044 — headless mode binds no port (`mcHandle.port === null`); log the
      // producer-only state honestly instead of an unreachable localhost URL.
      if (mcHandle.port !== null) {
        console.log(`cortex: Mission Control embed listening on http://localhost:${mcHandle.port} — db ${dbPath}`);
      } else {
        console.log(`cortex: Mission Control embed HEADLESS (db + ingestor, no HTTP server) — db ${dbPath}`);
      }

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
      // #1044 — headless mode binds no port. Fall back to a non-routable
      // sentinel so deep-links are well-formed but obviously not a live pane;
      // an explicit `grove.baseUrl` (the pane-serving host) still wins. A
      // headless producer's attention items deep-link into the SERVING stack's
      // pane via `grove.baseUrl`, not its own absent port.
      const mcBaseUrl =
        config.grove.baseUrl !== ""
          ? config.grove.baseUrl
          : mcHandle.port !== null
            ? `http://localhost:${mcHandle.port}`
            : "http://localhost";
      router.register(
        createDispatchProjectionRenderer(mcDb, mcHandle.wsRegistry ?? undefined, {
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
      router.register(createObservabilityProjectionRenderer(mcDb, mcHandle.wsRegistry ?? undefined));
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
  // FS-6 (cortex#1821) — per-peer received-presence ledger. The federated-presence
  // subscriber records every federated presence envelope it hears (folded OR
  // gated) against its source principal here; the `/api/networks` view reads
  // `everReceived` to split an absent peer into `absent-offline` (heard, went
  // stale) vs `absent-unheard` (never heard — an import/cred gap). One instance
  // shared subscriber→view; constructed unconditionally (inert until the
  // subscriber records into it — a stack with no federation records nothing).
  const federatedPresenceReceipts = new FederatedPresenceReceipts();
  // P3 (cortex#1088) — continuous federation roster reconciler. Mutates the
  // LIVE `resolvedPolicy.federated.networks[]` (the SAME objects the gate above
  // reads) so a later-joining roster peer's presence is admitted within one
  // reconcile interval. INERT unless a network opts in (`reconcile.enabled`).
  let federationReconcilerHandle: FederationReconcilerHandle | null = null;
  // FS-1 (cortex#1825, D-1) — presence-by-membership oracle. Late-bound: assigned
  // inside the MC-gated block below once the admission-rows provider is built
  // (it reuses the SAME provider `/api/networks` uses). The subscriber's
  // `isAdmittedMember` closure reads this handle at FOLD time (runtime), so the
  // late binding is safe — a member simply isn't membership-folded until the
  // first refresh warms the snapshot (self-heals on the next heartbeat).
  let federatedMembershipHandle: FederatedMembershipOracleHandle | null = null;
  // FS-1 (cortex#1825) — principals that HAND-PINNED a `principal_pubkey`
  // in the ORIGINAL config (pre-resolution). DD-11 stays fail-closed for
  // these: they are NEVER re-admitted by membership (see federated-subscriber.ts
  // `handPinnedPrincipals`). Computed from the raw `options.policy`, not the
  // post-`resolveFederatedPeers` set (which has already DROPPED a mismatched pin).
  const handPinnedPrincipals = new Set<string>();
  for (const n of options.policy?.federated?.networks ?? []) {
    for (const p of n.peers) {
      if (p.principal_pubkey !== undefined) handPinnedPrincipals.add(p.principal_id);
    }
  }
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
  // FS-1 (cortex#1825, D-1 Rider R2) — a stack federates its presence when it has
  // joined ≥1 network, UNLESS it opts out with `policy.federated.presence:
  // hidden`. A hidden stack is still admitted for DISPATCH but never dual-emits
  // the `federated.*` presence copy, so no co-member can fold it (the opt-out is
  // enforced at the SOURCE, not as a subscriber-side filter — truly hidden). The
  // decision is the pure `shouldFederatePresence` helper (unit-tested for R2).
  const federatePresence = shouldFederatePresence(resolvedPolicy?.federated);
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
      // #1044 — the WS broadcast needs a live registry. In HEADLESS mode the
      // embed binds no server, so `mcHandle.wsRegistry` is null (no clients to
      // notify); skip the broadcast subscription entirely. The registry still
      // CONSUMES presence (feeds `/api/agents` on a server stack), but a
      // producer-only stack has no pane to push to.
      if (mcHandle?.wsRegistry != null) {
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
      // Bot Packs B-2 — publish the producer to the daemon-brain degrade holder
      // so a `DaemonBrainHost.onDegraded` (restart budget exhausted, at runtime)
      // can surface the agent via `publishCapabilitiesChanged(agentId, [])`.
      brainPresenceHolder.producer = presenceProducer;
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
        // FS-6 — the per-peer received-presence ledger the `/api/networks` view
        // reads to split absent-offline vs absent-unheard.
        receipts: federatedPresenceReceipts,
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
        // FS-1 (cortex#1825, D-1) — presence-by-membership, NETWORK-SCOPED. The
        // oracle is late-bound (assigned below once the admission-rows provider is
        // built), so read it through the handle at FOLD time. The subscriber keys
        // this off the DELIVERING leaf → network, so a member of Network B can't
        // fold on Network A's leaf (cortex#1825 review). `handPinnedPrincipals`
        // keeps DD-11 fail-closed (a hand-pinned peer is never membership-folded).
        isAdmittedMemberOfNetwork: (
          sourcePrincipal: string,
          networkId: string,
        ): boolean =>
          federatedMembershipHandle?.isAdmittedMemberOfNetwork(
            sourcePrincipal,
            networkId,
          ) ?? false,
        handPinnedPrincipals,
      });

      // P3 (cortex#1088, design §4/§7) — the continuous federation roster
      // reconciler. The subscriber above binds the principal-WILDCARD presence
      // firehose (`federated.*.*.agent.>`) ONCE and gates admissibility at fold
      // time off `resolvedPolicy.federated.networks[]`. So to admit a peer that
      // joins a shared network AFTER us, we don't re-bind NATS — we re-resolve
      // the registry roster on an interval and MUTATE those SAME network objects
      // (peers + accept_subjects, OWN ∪ peer subtrees) IN PLACE. The gate sees
      // the widened accept-list on the next inbound envelope; the firehose
      // already carries every peer's presence. OPT-IN per network (OQ1, default
      // OFF); cortex-owned self-poll (OQ3, signal-optional — no signal import).
      // Best-effort: a registry outage / poison network never throws out of the
      // tick or perturbs the serving stack (mirrors the #989 aggregator).
      //
      // The roster READ uses cortex's OWN NetworkRegistryClient (P1's
      // NetworkRosterProvider slice), built from `policy.federated.registry` —
      // the SAME verified-fetch + DD-10 cache the boot peer-resolve + CLI join
      // use. A test seam (`options.bootFederatedRosterProvider`) injects a fake
      // so the reconciler runs with no network I/O. When no registry is
      // configured AND no test provider is injected, the reconciler stays inert
      // (a fully hand-pinned deployment has no roster to poll).
      const reconcileNetworks = resolvedPolicy?.federated?.networks;
      const reconcileRegistry = resolvedPolicy?.federated?.registry;
      const reconcileProvider: NetworkRosterProvider | undefined =
        options.bootFederatedRosterProvider ??
        (reconcileRegistry !== undefined
          ? new NetworkRegistryClient({
              url: reconcileRegistry.url,
              ...(reconcileRegistry.pubkey !== undefined && {
                pubkey: reconcileRegistry.pubkey,
              }),
            })
          : undefined);
      if (
        reconcileNetworks !== undefined &&
        reconcileNetworks.some((n) => n.reconcile?.enabled === true) &&
        reconcileProvider !== undefined
      ) {
        federationReconcilerHandle = startFederationReconciler({
          networks: reconcileNetworks,
          self: { principal: principalId, stack: derivedStack.stack },
          client: reconcileProvider,
          onResult: (result) => {
            if (result.outcome === "applied") {
              console.log(
                `cortex: federation reconcile — ${result.networkId}: ${result.detail}`,
              );
            }
          },
        });
        if (federationReconcilerHandle.active) {
          console.log(
            "cortex: federation roster reconciler started — continuously admitting roster-named peers (opt-in per network; registry-authoritative; chain-verify unchanged)",
          );
        }
      }

      // MC-A1 (cortex#1275) / MC-A2 (cortex#1276) — wire the `/api/networks`
      // view: surface the joined networks as first-class trust groups with their
      // admitted roster ⋈ presence → membership verdict, PLUS each member's
      // per-principal acceptance (the second trust layer). Membership is sourced
      // from the ADMISSION ROWS (ADR-0018 Q3), NOT the capability-derived
      // `GET /networks/{id}/roster` (`resolveNetworkRoster`) — conflating
      // capability with membership is the bug Q3 forbids.
      //
      // A2 drops in the LIVE admission-rows provider: the PoP-signed member
      // roster read `GET /networks/:id/roster/member` (C-1282 / ADR-0018 Q4,
      // DEPLOYED #1284), signed with this stack's OWN registered key (the seed
      // it already holds — mint nothing) and DD-9-verified against the pinned
      // registry pubkey. It returns the COMPLETE admitted roster (scope
      // `complete`), so membership verdicts are authoritative.
      //
      // POSTURE NOTE: the member read returns ADMITTED peers only — a member
      // never sees a network's PENDING onboarding queue. PENDING enrichment for
      // a network THIS stack ADMINS is the admin-list path (the SAME
      // `AdmissionRowsProvider` seam, fed by the admin-gated list); it composes
      // in once the daemon carries admin credentials (no admin-seed config in
      // the stack today, so it would be dead code now — deliberately not built).
      // The Pier queue (B1) already surfaces PENDING for admin-posture networks.
      const networksList = resolvedPolicy?.federated?.networks;
      if (networksList !== undefined && networksList.length > 0) {
        const registry = resolvedPolicy?.federated?.registry;

        // Load this stack's registered identity material (pubkey + seed) to
        // PoP-sign the member read. Reuses the chmod-600-gated signing-key
        // loader; never mints a key. Non-fatal: a stack with no seed (or a load
        // failure) leaves `material` undefined → the provider stays
        // `not_configured` (honest self-only), never crashes the embed boot.
        let stackMaterial: ReturnType<typeof materialFromSeedString> | undefined;
        if (options.stack?.nkey_seed_path) {
          try {
            const kp = await loadStackSigningKey(
              expandTilde(options.stack.nkey_seed_path),
            );
            stackMaterial = materialFromSeedString(
              new TextDecoder().decode(kp.getSeed()),
            );
          } catch (err) {
            console.error(
              "cortex: MC /api/networks — could not load stack identity for the member roster read (non-fatal, self-only membership):",
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        // Resolve the registry pubkey through the SHARED anchor — exactly as the
        // federated-verify seam (line ~3398) + the join path do. This is what
        // pins the DEFAULT metafactory registry's compiled-in pubkey when config
        // carries no explicit `registry.pubkey`; without it the live read would
        // ship DARK (no pin ⇒ DD-9 fail-closed ⇒ not_configured) on the common
        // production posture. A custom registry with no pin resolves to TOFU
        // (no pubkey) — the provider then honestly stays not_configured (it does
        // not TOFU a roster it cannot verify).
        const resolvedRegistry =
          registry !== undefined
            ? resolveRegistryAnchor({
                configUrl: registry.url,
                ...(registry.pubkey !== undefined && {
                  configPubkey: registry.pubkey,
                }),
              })
            : undefined;

        // The LIVE provider — or a `not_configured` provider when we lack a
        // pinned registry pubkey or the signing material to read + verify.
        const admissionProvider: AdmissionRowsProvider =
          resolvedRegistry?.pubkey !== undefined && stackMaterial !== undefined
            ? createMemberRosterAdmissionProvider({
                registryUrl: resolvedRegistry.url,
                registryPubkey: resolvedRegistry.pubkey,
                material: stackMaterial,
              })
            : {
                readAdmissionRows: (): Promise<AdmissionRowsResult> =>
                  Promise.resolve({
                    ok: false,
                    reason: "not_configured",
                    detail:
                      registry === undefined
                        ? "no federated registry configured (policy.federated.registry) — cannot read the admitted roster"
                        : resolvedRegistry?.pubkey === undefined
                          ? "no pinned registry pubkey (config pin / default-registry anchor / TOFU unavailable) — cannot DD-9-verify the member roster"
                          : "no stack signing identity (stack.nkey_seed_path) — cannot PoP-sign the member roster read",
                  }),
              };

        // FS-1 (cortex#1825, D-1) — presence-by-membership oracle. Reuses the
        // EXACT `admissionProvider` the `/api/networks` view uses (the
        // authoritative ADR-0018 Q3 admission-rows source, PoP-signed +
        // DD-9-verified) — NOT a second key/roster source. It refreshes an
        // admitted-member snapshot on an interval; the presence subscriber's
        // `isAdmittedMember` closure reads it synchronously at fold time so an
        // admitted member folds even with no `peers[]` offering. A
        // `not_configured` provider leaves the snapshot empty → no membership-fold
        // (honest degradation, the existing `peers[]` gate still applies).
        federatedMembershipHandle = createFederatedMembershipOracle({
          networkIds: networksList.map((n) => n.id),
          provider: admissionProvider,
          onRefresh: (info) => {
            if (info.admittedCount > 0) {
              console.log(
                `cortex: federated-membership — ${info.networkId}: ${info.admittedCount.toString()} admitted member(s) (presence-by-membership, D-1)`,
              );
            }
          },
        });
        federatedMembershipHandle.start();

        // The accept-policy summary (the second trust layer), distilled ONCE
        // from this stack's offerings and queried per member.
        const acceptanceSummary = summarizeAcceptancePolicy(
          resolvedPolicy?.offerings,
        );

        networksViewForApi = {
          localPrincipal: principalId,
          networks: () =>
            networksList.map((n) => ({
              networkId: n.id,
              leafNode: n.leaf_node,
              // MC-A3 — config-derived confidentiality posture (ADR-0019/0018).
              // Read-only honesty: surfaces `enabled`/`required` WITH key as
              // sealed, but a configured-without-key network as degraded, never
              // faked "encrypted".
              confidentiality: confidentialityPosture(n),
            })),
          resolveAdmittedRoster: (networkId) =>
            resolveAdmittedRoster(networkId, admissionProvider),
          acceptsPeer: (networkId, memberPrincipal) =>
            resolvePeerAcceptance(
              acceptanceSummary,
              networkId,
              memberPrincipal,
              principalId,
            ),
          // FS-6 (cortex#1821) — have we EVER heard this peer's federated
          // presence? Reads the subscriber's per-peer receipt ledger so the
          // handler splits an absent peer into offline (heard, went stale) vs
          // unheard (never heard — an import/cred gap).
          receivedPresenceFrom: (memberPrincipal) =>
            federatedPresenceReceipts.everReceived(memberPrincipal),
        };
        const live =
          resolvedRegistry?.pubkey !== undefined && stackMaterial !== undefined;
        console.log(
          `cortex: MC /api/networks view wired — ${networksList.length.toString()} joined network(s) ` +
            `as first-class trust groups (admission roster: ${live ? "LIVE member-read (A2)" : "not_configured — self-only"}; ` +
            "per-principal acceptance from offerings)",
        );

        // FLG-1 (docs/plan-mc-future-state.md §4.D) — the guided-join handoff
        // view. Gathers the 3 leg signals (seal via admission `/mine`,
        // hub-authorize via the #1498 registry marker, leaf-up via the LOCAL
        // `/leafz`) through the SAME `gatherHandoffSignals` + live ports the
        // `cortex network handoff status` CLI uses — the surface never re-derives
        // them. Read-only; never-throw (a degraded read fails closed to a
        // `pending` leg + a note). Reuses the resolved registry + stack seed
        // already loaded for the networks view above.
        handoffViewForApi = {
          localPrincipal: principalId,
          resolveHandoffSignals: async (networkId, member) => {
            const network = networksList.find((n) => n.id === networkId);
            if (network === undefined) return null;
            // A minimal per-network LivePortsConfig — `networkId` varies per
            // request; the registry + seed come from the already-resolved
            // federation context. Absent knobs (monitor url, nats config) fall
            // back to the live adapters' local defaults; a missing seed/registry
            // simply degrades the reads to fail-closed signals + notes.
            const cfg: LivePortsConfig = {
              networkId,
              principalId,
              stackId: options.stack?.id ?? principalId,
              ...(resolvedRegistry?.url !== undefined && {
                registryUrl: resolvedRegistry.url,
              }),
              ...(resolvedRegistry?.pubkey !== undefined && {
                registryPubkey: resolvedRegistry.pubkey,
              }),
              ...(options.stack?.nkey_seed_path !== undefined && {
                seedPath: expandTilde(options.stack.nkey_seed_path),
              }),
            };
            return gatherHandoffSignals(buildLiveHandoffPorts(cfg, [network]), {
              networkId,
              member,
              selfPrincipal: principalId,
            });
          },
        };

        // FLG-3 (docs/plan-mc-future-state.md §4.D) — the network doctor view.
        // Runs the SAME pure `runDoctorChecks` + config/monitor adapters the
        // `cortex network doctor` CLI uses, over the daemon's ALREADY-RUNNING
        // `runtime` as the peer-reachable probe bus (`wrapRuntimeAsProbeBus`) —
        // NOT a second NATS connection (the standalone CLI must open one; the
        // daemon already holds one, and `wrapRuntimeAsProbeBus` declares its own
        // per-probe reply subscription, so reuse is the intended path). The lib
        // never calls `bus.stop()`, so the daemon runtime is never torn down.
        // Read-only; never-throw ports degrade a leg to warn/skip rather than
        // failing the whole read. Reuses the resolved policy + stack identity
        // already loaded for the networks view above.
        doctorViewForApi = {
          localPrincipal: principalId,
          runDoctor: async (networkId) => {
            const fedNetworks = resolvedPolicy?.federated?.networks ?? [];
            if (!fedNetworks.some((n) => n.id === networkId)) return null;
            // A minimal LoadedConfig for the pure orchestrator: it reads only
            // `principal.id`, `stack.id`/`stack.nkey_pub`, `inlineAgents[0].id`,
            // and `policy.federated.networks[]` (via `derivePingInputs` + the
            // representation-pair legs) — all already resolved at boot.
            const loadedForDoctor: LoadedConfig = {
              config,
              inlineAgents: [...inlineAgents],
              principal: { id: principalId },
              ...(options.stack !== undefined && { stack: options.stack }),
              ...(resolvedPolicy !== undefined && { policy: resolvedPolicy }),
            };
            // FS-5a (cortex#1814) — thread the daemon's OWN nats-server config
            // path so `resolveMonitorBase` config-derives the monitor URL (a
            // community bus on `:8224`, not the wrong `:8222`) and, absent an
            // `http_port`, falls back to `DEFAULT_MONITOR_URL` — the SAME
            // resolution `status`/`buildLeafStatePort` use. Combined with the
            // FS-5a `checkMonitorReachable` change (probe the default, not
            // skip), the glass doctor now reaches the same verdict as the CLI
            // for a healthy leaf instead of pessimistically warning + skipping.
            const daemonNatsConfigPath = options.stack?.nats_infra?.config_path;
            const livePortsCfg: LivePortsConfig = {
              networkId,
              principalId,
              stackId: options.stack?.id ?? principalId,
              ...(daemonNatsConfigPath !== undefined && daemonNatsConfigPath !== ""
                ? { natsConfigPath: daemonNatsConfigPath }
                : {}),
            };
            const ports: NetworkDoctorPorts = {
              // The composed networks (config-split-aware); `runDoctorChecks`
              // finds the one by id. Same adapter the CLI factory builds.
              config: buildDoctorConfigPort({ networks: fedNetworks }),
              // FS-5a — resolve the monitor via `resolveMonitorBase` (explicit →
              // config-derive from the threaded nats config → DEFAULT_MONITOR_URL)
              // and PROBE it, matching `status`. A genuinely-down monitor still
              // degrades to WARN/unknown (never a hard `broken`), never a crash.
              monitor: buildMonitorPort(livePortsCfg),
              probe: {
                bus: wrapRuntimeAsProbeBus(runtime),
                newNonce: () => crypto.randomUUID(),
                newCorrelationId: () => crypto.randomUUID(),
              },
            };
            return runDoctorChecks(ports, { cfg: loadedForDoctor, networkId });
          },
        };

        // MC-B2 (cortex#1279) — the WRITE sibling of the member-roster read:
        // sign a Tier-2 admit/reject with the SAME `stackMaterial` and POST it to
        // the registry. Unlike the read (which needs a pinned pubkey for the DD-9
        // assertion verify), the write needs only the registry URL + the stack
        // seed — the registry authorizes on the signing pubkey (global or
        // per-network admin). Live iff we hold the stack seed AND a registry URL.
        // Runs LOCALLY (this daemon holds the seed); the CF worker never reaches
        // this code. null ⇒ `POST /api/networks/admission-decision` 503s.
        if (stackMaterial !== undefined && resolvedRegistry !== undefined) {
          const decisionRegistryUrl = resolvedRegistry.url;
          const decisionMaterial = stackMaterial;
          admissionDeciderForApi = {
            decide: async (input): Promise<AdmissionDecisionResult> => {
              const res = await postAdmissionDecision({
                registryUrl: decisionRegistryUrl,
                requestId: input.requestId,
                decision: input.decision,
                material: decisionMaterial,
              });
              // Audit trail (no secrets): who decided what, and the outcome.
              // Deliberately does NOT log the client-supplied `network_id`: the
              // registry authorizes off the request's STORED network, never the
              // wire selector, so echoing a caller-chosen value could mislead a
              // forensic reader (review nit adv-N2/rev-N2). request_id is the
              // stable, registry-authoritative key.
              const auditOutcome = res.ok ? res.status : `refused(${res.reason})`;
              console.log(
                `cortex: MC-B2 admission ${input.decision} — request=${input.requestId} ` +
                  `principal=${input.principal} -> ${auditOutcome}`,
              );
              return res.ok
                ? { ok: true, status: res.status, requestId: res.requestId }
                : { ok: false, reason: res.reason, detail: res.detail };
            },
          };
          console.log(
            "cortex: MC /api/networks/admission-decision wired — LIVE local-daemon-signed " +
              "Tier-2 admit/reject (stack-seed-signed; CF-Access + typed-confirm gated at the surface)",
          );
        }

        // FLG-2 (cortex#1706) — the authorize-from-glass signer: stamp
        // `hub_authorized_at` on an ADMITTED admission row (registry cortex#1498).
        // HUB-ADMIN authority (ADR-0018 Q5) — for the common single-principal
        // deployment the hub-admin seed IS the stack seed, so we load it via the
        // SAME chmod-600-gated `hubAdminMaterialFromSeedFile` the CLI's `cortex
        // network authorize` uses (no hand-rolled seed loading). Live iff the
        // hub-admin seed loads AND a registry URL is resolved. Absent/unloadable
        // seed ⇒ `authorizerForApi` stays null ⇒ the route 503s
        // `hub_admin_not_configured` (fail-closed). Signs LOCALLY; never in the
        // CF worker.
        if (options.stack?.nkey_seed_path && resolvedRegistry !== undefined) {
          const hubSeedPath = options.stack.nkey_seed_path;
          const authorizeRegistryUrl = resolvedRegistry.url;
          const hubAdmin = await hubAdminMaterialFromSeedFile(hubSeedPath);
          if (!hubAdmin.ok) {
            // Honest degradation: the route will 503 `hub_admin_not_configured`.
            // Never crashes the embed boot (mirrors the member-roster read).
            console.error(
              "cortex: MC /api/networks/authorize DARK — could not load the hub-admin seed " +
                `(non-fatal, authorize-from-glass 503s until fixed): ${hubAdmin.reason}`,
            );
          } else {
            const hubMaterial = hubAdmin.material;
            const authorizeBase = authorizeRegistryUrl.replace(/\/+$/, "");
            authorizerForApi = {
              authorize: async (requestId): Promise<AuthorizeResult> => {
                const claim = {
                  request_id: requestId,
                  hub_admin_pubkey: hubMaterial.pubkeyB64,
                  issued_at: new Date().toISOString(),
                  nonce: randomNonce(),
                };
                let resp: Response;
                try {
                  const signed = await signAdminRequest(hubMaterial.seed, claim);
                  resp = await fetch(
                    `${authorizeBase}/admission-requests/${encodeURIComponent(requestId)}/authorize`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(signed),
                    },
                  );
                } catch (err) {
                  const detail = err instanceof Error ? err.message : String(err);
                  console.log(
                    `cortex: FLG-2 authorize — request=${requestId} -> unreachable(${detail})`,
                  );
                  return { ok: false, reason: "unreachable", detail: `registry unreachable: ${detail}` };
                }

                let parsed: unknown;
                try {
                  parsed = await resp.json();
                } catch {
                  // Non-JSON body (e.g. a proxy error page) — map by status below.
                  parsed = null;
                }
                const obj =
                  parsed !== null && typeof parsed === "object"
                    ? (parsed as Record<string, unknown>)
                    : {};

                if (resp.ok) {
                  const hubAuthorizedAt =
                    typeof obj.hub_authorized_at === "string" ? obj.hub_authorized_at : undefined;
                  if (hubAuthorizedAt === undefined) {
                    // 2xx but no stamp — treat as an invalid registry response
                    // rather than fabricate a success signal.
                    console.log(
                      `cortex: FLG-2 authorize — request=${requestId} -> invalid(no hub_authorized_at)`,
                    );
                    return {
                      ok: false,
                      reason: "invalid",
                      detail: "registry returned 2xx but no hub_authorized_at timestamp",
                    };
                  }
                  console.log(
                    `cortex: FLG-2 authorize — request=${requestId} -> authorized(${hubAuthorizedAt})`,
                  );
                  return { ok: true, requestId, hubAuthorizedAt };
                }

                // Failure — map the registry's status + error code to the
                // surface's structured failure (propagated verbatim to the glass).
                const registryError = typeof obj.error === "string" ? obj.error : undefined;
                const registryDetail =
                  typeof obj.details === "string"
                    ? obj.details
                    : typeof obj.detail === "string"
                      ? obj.detail
                      : undefined;
                const reason = mapAuthorizeStatus(resp.status, registryError);
                const detail =
                  registryDetail ??
                  registryError ??
                  `registry rejected authorize (HTTP ${resp.status.toString()})`;
                console.log(
                  `cortex: FLG-2 authorize — request=${requestId} -> refused(${reason}, HTTP ${resp.status.toString()})`,
                );
                return { ok: false, reason, detail };
              },
            };
            console.log(
              "cortex: MC /api/networks/authorize wired — LIVE local-daemon-signed " +
                "hub-admin authorize (stamps hub_authorized_at; step-up-MFA gated at the surface)",
            );
          }
        }
      }

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
        // #1044 — null in headless mode (no server ⇒ no WS clients). The
        // projection's broadcast is a no-op on `undefined`; coalesce so the
        // type matches `WsClientRegistry | undefined`.
        const observabilityFoldWs = mcHandle?.wsRegistry ?? undefined;
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
      // #1008/#989 RECONCILIATION — PRESENCE via bus, SESSIONS via db (they
      // COMPOSE, they are not mutually exclusive). Agent PRESENCE (the liveness
      // a hub renders: "this agent is up, idle or not") lives ONLY in the
      // in-memory registry, fed by the `agent.{online,heartbeat,offline}` bus
      // stream — it is NEVER persisted to a sibling's db. So the DB-read path can
      // only project a sibling agent that "owns a LIVE SESSION" (sibling-db-reader
      // `siblingAgentTiles`); an IDLE local sibling has no live session and thus
      // vanished from the Network view whenever the bus path was gated off (the
      // "only one stack" regression). The earlier "DB-read OWNS local siblings,
      // gate the bus path off to avoid double-count" framing was wrong: db-read
      // owns SESSION TREES (/api/working-agents), not idle PRESENCE.
      //
      // Corrected split: the BUS sibling-presence aggregator owns local-sibling
      // PRESENCE (folds idle-or-active `agent.*` into the registry, origin-tagged)
      // and runs whenever aggregation is enabled — NOT gated by dbRead. The
      // DB-read path keeps the session trees (working-agents) AND a deduped
      // live-session fallback into /api/agents: `aggregateAgentTiles` skips any
      // sibling tile whose key is already live in the registry (the bus fold), so
      // an active sibling present on BOTH paths is counted ONCE (registry wins),
      // and a sibling the bus couldn't reach still surfaces from its db. The
      // separate `startFederatedAgentPresenceSubscriber` above stays the path for
      // FEDERATED / cross-principal peers (remote dbs, unreadable here).
      const runBusSiblingPresence = aggCfg.enabled;
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
    // #1044 — in headless mode `mcHandle.port` is null (no server). An explicit
    // `grove.baseUrl` (the pane-serving host) wins; otherwise use the bound port
    // when present, falling back to a portless localhost rather than a
    // misleading fixed 8767 that nothing is listening on.
    const baseUrl =
      config.grove.baseUrl !== ""
        ? config.grove.baseUrl
        : mcHandle?.port != null
          ? `http://localhost:${mcHandle.port}`
          : "http://localhost";
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
    registry: surfacePluginRegistry,
  });
  const gw: SurfaceGateway | undefined = startedGateway?.gateway;

  // cortex#1793 (S8, ADR-0024 D3) — the `cortex plugin list|unload|reload|load`
  // control channel. `deps` is the SAME live `adapters`/`rendererHandles`/
  // `skippedRendererConfigs` this boot populated above — every control
  // request reads/mutates the running daemon's actual state, never a
  // snapshot. `gw` may be `undefined` (CORTEX_GATEWAY unset, every live
  // stack today) — `plugin-runtime.ts` degrades adapter `unload`/`reload` to
  // a clear refusal in that case rather than silently no-opping.
  const pluginRuntimeDeps: PluginRuntimeDeps = {
    adapters,
    rendererHandles,
    router,
    ...(gw !== undefined && { gateway: gw }),
    skippedRendererConfigs,
    registry: surfacePluginRegistry,
  };
  const pluginControlServer = await startPluginControlServer(runtime, pluginRuntimeDeps, systemEventSource);

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
      ...brainConsumers.map((c, i) => `brain-consumer stop[${i}] (agent=${c.agent.id})`),
      // Bot Packs B-2 — daemon brain host teardown slots (belt-and-braces; the
      // consumer drain already drains the host, these are idempotent).
      ...daemonBrainHosts.map((h, i) => `daemon-brain-host stop[${i}] (agent=${h.agentId})`),
      ...releaseConsumers.map((c, i) => `release-consumer stop[${i}] (agent=${c.agent.id})`),
      ...devConsumers.map((c, i) => `dev-consumer stop[${i}] (agent=${c.agent.id})`),
      // cortex#1793 (S8) — the `cortex plugin` control-channel listener.
      // No-op when the runtime never enabled (fake-runtime tests / a
      // no-NATS stack) — `pluginControlServer.stop()` is always defined
      // (a no-op handle in that case), so this slot always self-completes.
      "plugin-control-server stop",
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
      // B-0 (cortex#1021) — stop the agents.d/ watcher + deregister the SIGHUP
      // handler so no reload fires mid-shutdown. Await any in-flight reconcile
      // first so a reload racing shutdown finishes its consumer start/stop
      // before the runtime closes (the started consumers then drain below with
      // the rest of `reviewConsumers[]`).
      completeSync("agents-watcher stop", () => agentsWatcher?.stop());
      completeSync("agents-sighup deregister", () =>
        process.removeListener("SIGHUP", sighupHandler),
      );
      await completeAsync("agents-reload in-flight drain", reloadInFlight);
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
      // P3 (cortex#1088) — stop the federation roster reconciler poller (cancels
      // the interval + awaits any in-flight pass). It only mutates the in-memory
      // policy objects, so ordering vs. the registry/subscriber teardown is
      // immaterial; stopping it here keeps it adjacent to the subscriber it feeds.
      await completeAsync(
        "federation roster reconciler stop",
        federationReconcilerHandle?.stop(),
      );
      // FS-1 (cortex#1825) — stop the presence-by-membership oracle poller
      // (cancels the interval + awaits any in-flight admission-rows read). It
      // only reads the registry into an in-memory snapshot, so ordering vs. the
      // subscriber teardown is immaterial.
      await completeAsync(
        "federated membership oracle stop",
        federatedMembershipHandle?.stop(),
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
      // Bot Packs B-3 — stop the gate reply-bridge FIRST: every open
      // principal gate resolves `null` (its fail-closed timeout branch)
      // immediately, so the brain-consumer drain below is never held hostage
      // by a gate awaiting a reply that can no longer arrive (the adapters
      // are going down on this same boundary).
      gateReplyRouter.stop();
      // Bot Packs B-1 — drain brain consumers on the SAME boundary as the
      // review consumers so an in-flight brain task publishes its terminal
      // envelope before the runtime closes. `BrainConsumer.stop()` is
      // idempotent and awaits its in-flight set (dormant / never-subscribed is
      // a no-op). Empty on every stack with no exec-brain agents.
      for (let i = 0; i < brainConsumers.length; i++) {
        const consumer = brainConsumers[i];
        if (consumer) {
          await completeAsync(
            `brain-consumer stop[${i}] (agent=${consumer.agent.id})`,
            consumer.stop(),
          );
        }
      }
      // Bot Packs B-2 — belt-and-braces: ensure every daemon brain host is torn
      // down even if its consumer's stop() did not reach the drain (e.g. a host
      // whose consumer init threw after the host spawned). `stop()` is idempotent
      // — a host already drained by its consumer above is a no-op.
      for (let i = 0; i < daemonBrainHosts.length; i++) {
        const host = daemonBrainHosts[i];
        if (host) {
          await completeAsync(
            `daemon-brain-host stop[${i}] (agent=${host.agentId})`,
            host.stop(),
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
      // F-6 — drain the reflex activation bridge BEFORE the executors it feeds.
      // Stopping the bridge first guarantees it can't consume + re-emit a
      // `tasks.*` dispatch after the dispatch listeners have drained (which
      // would leave the activation unhandled mid-shutdown). Only present when
      // config-gated on; `stop()` is idempotent.
      if (reflexActivationListener !== undefined) {
        await completeAsync(
          "reflex-activation-listener stop",
          reflexActivationListener.stop(),
        );
      }
      // S2 (cortex#1160) — drain every per-agent chat dispatch listener.
      for (let i = 0; i < dispatchListeners.length; i++) {
        const listener = dispatchListeners[i];
        if (listener) {
          await completeAsync(
            `dispatch-listener stop[${i}]`,
            listener.stop(),
          );
        }
      }
      // signal#113 P-11 (#56) — drain the echo responder on the same boundary
      // as the dispatch listener. `stop()` is idempotent (no-op when dormant).
      await completeAsync("probe-responder stop", probeResponder.stop());
      // cortex#1793 (S8) — stop accepting new `cortex plugin` control
      // requests before the renderer/adapter state those requests mutate
      // starts tearing down below. `stop()` is idempotent (no-op handle when
      // the runtime never enabled).
      await completeAsync("plugin-control-server stop", pluginControlServer.stop());
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
    get agentGeneration() {
      return agentGeneration;
    },
    // B-0 (cortex#1021) — manual reload entrypoint. `cortex agents reload`
    // (via the CLI's daemon-signal path) and SIGHUP both reach the same
    // reconcile through here.
    reloadAgents(source: "cli" | "sighup" = "cli") {
      return reloadAgentsViaTrigger(source);
    },
    get registryClient() {
      return registryClient;
    },
  };
}

/**
 * B-0 (cortex#1021) — order-independent structural equality for two `Agent`
 * shapes, used by the agents.d/ hot-reload diff to decide whether an agent
 * CHANGED (vs. an untouched fragment touch that produced a byte-identical
 * reload). Mirrors the watcher's private `deepEqual` (it can't be imported
 * without widening the watcher's public surface) but is scoped to the Agent
 * shapes the reconcile actually compares: plain objects, arrays, scalars.
 * No Date/Map/Set handling — Agent values don't inhabit those.
 */
function agentsEqual(a: Agent, b: Agent): boolean {
  return structuralEqual(a, b);
}

function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (
      !structuralEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
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

/** Result of the D-3 boot-config resolution: the loaded config + optional degraded marker. */
export interface BootConfigResolution {
  loaded: ReturnType<typeof loadConfigWithAgents>;
  /** Set when the LIVE config failed to load and the daemon fell back to last-good. */
  degraded?: DegradedInfo;
}

/**
 * FS-7 / D-3 (cortex#1839) — resolve the boot config with a last-known-good
 * fallback. On a healthy load it refreshes the last-good snapshot and clears any
 * stale degraded marker; on a load THROW it either fails hard (`strict`, or no
 * snapshot to fall back to) or loads the last-good snapshot, writes a degraded
 * marker, and returns the config tagged `degraded` so the daemon boots DEGRADED
 * instead of crash-looping.
 *
 * `now` is injectable so tests get a deterministic `since` timestamp.
 * Exported for unit testing.
 */
export function resolveBootConfig(
  configPath: string,
  opts: { strict: boolean; now?: () => string } = { strict: false },
): BootConfigResolution {
  const nowIso = opts.now ?? (() => new Date().toISOString());
  try {
    const loaded = loadConfigWithAgents(configPath);
    // Healthy boot: refresh the last-good snapshot + clear any prior degraded state.
    const snap = writeLastGoodSnapshot(configPath);
    if (!snap.ok) {
      // Non-fatal — a snapshot-write failure must not fail a good boot; log it.
      process.stderr.write(
        `cortex: WARN could not write last-good config snapshot: ${snap.error}\n`,
      );
    }
    clearDegradedMarker(configPath);
    return { loaded };
  } catch (err) {
    const preciseError = formatConfigLoadError(err).join("\n");
    // `--strict` (CI / provisioning) never falls back — fail hard, loudly.
    if (opts.strict) {
      throw new Error(
        `config load failed and --strict is set (no last-known-good fallback):\n  ${preciseError.replace(/\n/g, "\n  ")}`,
        { cause: err },
      );
    }
    const snapshotPath = readLastGoodSnapshotPath(configPath);
    if (snapshotPath === null) {
      // No snapshot to fall back to (first boot with a bad config) — fail hard.
      throw new Error(
        `config load failed and no last-known-good snapshot exists to fall back to:\n  ${preciseError.replace(/\n/g, "\n  ")}`,
        { cause: err },
      );
    }
    // D-3 fallback: boot DEGRADED on the last-good snapshot. A snapshot that
    // itself fails to load (e.g. an env var it needs is now unset) is fatal —
    // there is nothing safe left to boot, so let this throw propagate.
    console.error(
      `cortex: LIVE config failed to load — booting DEGRADED on last-known-good snapshot ${snapshotPath}.\n` +
        `  Underlying error:\n  ${preciseError.replace(/\n/g, "\n  ")}`,
    );
    const loaded = loadConfigWithAgents(snapshotPath);
    const info: DegradedInfo = { error: preciseError, snapshotPath, since: nowIso() };
    writeDegradedMarker(configPath, info);
    return { loaded, degraded: info };
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
    .option(
      "--strict",
      "FS-7/D-3: disable the last-known-good fallback — fail hard on an invalid config (CI / provisioning)",
    )
    .action(async (options: { config: string; dryRun?: boolean; strict?: boolean }) => {
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
      // cortex#1900 continuity AC — adopt a pre-hash `cortex-<basename>.pid` iff
      // this config still owns one AND it names a DEAD/stale PID, so an existing
      // fleet upgrading across the path-hash naming change is not orphaned.
      // adv PR#1923: a LIVE legacy pidfile is REFUSED inside migrateLegacyPidFile
      // (it may belong to a different tree sharing the basename — adopting it
      // would let a later `stop` SIGTERM that foreign daemon; the warning is
      // emitted there). Runs BEFORE the singleton check; on a dead-PID adoption
      // checkSingleton then reaps the stale entry. The migration is internally
      // guarded and never throws, so a lost race can't abort boot.
      const adopted = migrateLegacyPidFile(options.config);
      if (adopted !== undefined) {
        console.error(`cortex: migrated PID file ${adopted} → ${pidFile} (cortex#1900 path-hash naming)`);
      }
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
        // XDG wave-5 (#1902, GAP-3) — the published-events pipeline WRITER
        // (`taps/cc-events/relay.ts` → `publishedEventsDir()`) always writes the
        // canonical metafactory data root; it does NOT read `paths.publishedEventsDir`.
        // The persisted value is pinned into every generated `cortex.yaml`, so an
        // upgraded box can still carry the LEGACY default (`~/.claude/events/published`)
        // in its file. Rewrite that pinned legacy default to the canonical root
        // (targeted one-line edit, comments/quotes preserved; a CUSTOM value is
        // left untouched) BEFORE the config is loaded, so the in-memory value +
        // the persisted file agree with the always-canonical writer. Idempotent
        // and non-destructive; a no-op on a fresh/canonical config.
        const migratedCfgPath = expandTilde(options.config);
        const pubMig = migratePublishedEventsDirValue(migratedCfgPath);
        if (pubMig.changed) {
          console.log(
            `cortex: migrated pinned paths.publishedEventsDir "${pubMig.from}" → "${pubMig.to}" in ${migratedCfgPath} (XDG #1902)`,
          );
        }
        // FS-7 / D-3 (cortex#1839) — resolve the boot config with a last-known-good
        // fallback. A healthy load refreshes the snapshot + clears any degraded
        // marker; a bad load either fails hard (`--strict` / no snapshot) or boots
        // DEGRADED on the last-good snapshot (never a keepalive crash-loop). A
        // fail-hard throw propagates to bootOrDie → FATAL exit, as before.
        const { loaded, degraded } = resolveBootConfig(options.config, {
          strict: options.strict === true,
        });
        const { config, inlineAgents, stack, policy, principal, bus, surfaces, reflexActivation, notify, surfaceWarnings } =
          loaded;
        // cortex#1217 — a surface secret placeholder with an unset env var no
        // longer FATAL-boots the daemon (which crash-looped the whole stack).
        // The resolver disabled that ONE surface; thread the inline/gateway
        // warnings into startCortex, which merges them with the agents.d/
        // fragment warnings it collects and emits ONE consolidated banner.
        return startCortex(config, {
          ...(surfaceWarnings !== undefined && surfaceWarnings.length > 0 && { surfaceWarnings }),
          configPath: options.config,
          // FS-7 / D-3 — thread the degraded marker so MC `/health` surfaces it.
          ...(degraded !== undefined && { degraded }),
          ...(inlineAgents.length > 0 && { inlineAgents }),
          ...(stack !== undefined && { stack }),
          ...(policy !== undefined && { policy }),
          // PR-R13.B.i: both LoadedConfig and StartCortexOptions now use
          // the canonical `.principal` field.
          ...(principal !== undefined && { principal }),
          ...(bus !== undefined && { bus }),
          // F-6 — thread the reflex activation bridge block through.
          ...(reflexActivation !== undefined && { reflexActivation }),
          // F-6 downstream — thread the notify block (notify.discord) through.
          ...(notify !== undefined && { notify }),
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
        // FS-7 / D-3 (cortex#1839) — surface a DEGRADED boot (running on the
        // last-known-good snapshot because the LIVE config failed to load).
        const degraded = readDegradedMarker(options.config);
        if (degraded !== null) {
          console.log(`cortex: running DEGRADED (PID ${pid}, ${pidFile})`);
          console.log(`  booted on last-known-good snapshot: ${degraded.snapshotPath} (since ${degraded.since})`);
          console.log(`  LIVE config load error:\n    ${degraded.error.replace(/\n/g, "\n    ")}`);
          console.log(`  fix the live config, then restart to clear degraded state.`);
        } else {
          console.log(`cortex: running (PID ${pid}, ${pidFile})`);
        }
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

  // cortex#2094 (L3) — env-contract driven one-command first install. Same
  // passthrough shape as `stack`/`network`: `dispatchQuickstart` owns its own
  // flag parsing (there is no subcommand — quickstart is a single, env-driven
  // verb), so commander hands it the raw remaining argv untouched. Does not
  // boot the daemon itself — step 7 hands that off to `systemctl --user`.
  program
    .command("quickstart")
    .description("Env-contract driven one-command first install (preflight → validate → scaffold → services → gate)")
    .argument("[args...]", "quickstart flags (see `cortex quickstart --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchQuickstart(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // cortex#1793 (S8) — runtime plugin attach/detach/reload. Same passthrough
  // shape as `network` / `stack` / `provision-stack`: `dispatchPlugin` owns
  // its own arg parsing, so commander hands it the raw remaining argv
  // untouched. Talks to a RUNNING daemon over the bus — does not boot one.
  program
    .command("plugin")
    .description("Runtime adapter/renderer attach/detach/reload (list / unload / reload / load)")
    .argument("[args...]", "plugin subcommand + flags (see `cortex plugin --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchPlugin(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // `config validate` — pre-flight config check. Same passthrough shape as
  // `network` / `stack`: `dispatchConfig` owns its own arg parsing, so commander
  // hands it the raw remaining argv untouched. Runs the daemon's boot-time
  // config validation (compose config-split layers + CortexConfigSchema)
  // standalone — WITHOUT booting NATS / MC / adapters / the daemon — so a bad
  // edit is caught BEFORE a restart crash-loops the daemon.
  program
    .command("config")
    .description("Inspect + validate cortex config (validate)")
    .argument("[args...]", "config subcommand + flags (see `cortex config --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchConfig(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // FND-3 (#1689) — step-up MFA enrollment/inspection. Same passthrough shape
  // as `network` / `stack`: `dispatchStepUp` owns its own arg parsing, so
  // commander hands it the raw remaining argv untouched. Never boots the
  // daemon — runs the CLI flow and exits.
  program
    .command("step-up")
    .description("Enroll + manage the daemon step-up MFA secret (enroll / status / verify)")
    .argument("[args...]", "step-up subcommand + flags (see `cortex step-up --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchStepUp(args);
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

  // O-2.5 (#1061) — per-agent NATS user credentials (issue/list/revoke/rotate),
  // a thin delegator to `arc nats … --json`. Same passthrough shape as
  // `network` / `stack` / `offer`: `dispatchCreds` owns its own arg parsing
  // (incl. the `creds issue <agent-id> --account/--pub/--sub` form), so
  // commander hands it the raw remaining argv untouched. The module landed in
  // #1061 but was never wired into the CLI here — `cortex creds …` was an
  // unknown command until this registration.
  program
    .command("creds")
    .description("Manage per-agent NATS user credentials (issue / list / revoke / rotate)")
    .argument("[args...]", "creds subcommand + flags (see `cortex creds --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchCreds(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // G4 (#1120) — thin 4-surface deploy orchestrator + version-skew guard.
  // Dry-run by default (prints the ordered plan, runs nothing). `--apply` runs
  // non-prod surfaces (bot, dashboard). `--apply --include-prod` also runs the
  // two production wrangler deploys (api, registry). Same passthrough shape as
  // `network` / `stack` / `offer` / `creds`: `dispatchRelease` owns its own
  // arg parsing, so commander hands it the raw remaining argv untouched.
  program
    .command("release")
    .description(
      "Print the 4-surface deploy plan + version-skew report (dry-run by default; --apply to execute)",
    )
    .argument("[args...]", "release flags (see `cortex release --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const result = await dispatchRelease(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // #1352 — `agents`: inspect + validate agents.d/ fragments and signal the
  // running runtime to reload (SIGHUP). Same passthrough shape as `network` /
  // `stack` / `creds`: `dispatchAgents` owns its own arg parsing (subcommand +
  // flags + its own `--help`), so commander hands it the raw remaining argv
  // untouched. `dispatchAgents` is synchronous (returns an ExitResult) — no
  // await needed, but the write+exit tail matches the other verbs exactly.
  program
    .command("agents")
    .description("Inspect + validate agent fragments; reload the running runtime (reload / list)")
    .argument("[args...]", "agents subcommand + flags (see `cortex agents --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action((args: string[]) => {
      const result = dispatchAgents(args);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // #1352 — `migrate-config`: convert a grove-v2 bot.yaml / legacy cortex.yaml
  // to the cortex config shape (MIG-7.2e). Makes the cortex.ts:682 upgrade hint
  // (`run \`cortex migrate-config\``) true. Same passthrough shape as the verbs
  // above. `runMigrateConfig` writes its own stdout/stderr and returns the exit
  // code, so the action just propagates that code.
  program
    .command("migrate-config")
    .description("Convert a grove-v2 bot.yaml / legacy cortex.yaml to the cortex config shape")
    .argument("[args...]", "migrate-config input + flags (see `cortex migrate-config --help`)")
    .allowUnknownOption()
    .passThroughOptions()
    .helpOption(false)
    .action(async (args: string[]) => {
      const exitCode = await runMigrateConfig(args);
      process.exit(exitCode);
    });

  program.parse();
}
