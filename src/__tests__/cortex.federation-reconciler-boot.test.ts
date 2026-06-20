/**
 * P3 (cortex#1088) — boot wiring for the continuous federation roster reconciler.
 *
 * Asserts the `startCortex` integration:
 *
 *   1. Opted-in network (`reconcile.enabled: true`) + an injected roster provider
 *      ⇒ the reconciler runs a pass on boot and MUTATES the LIVE
 *      `resolvedPolicy.federated.networks[]` (the SAME objects the federation
 *      gate reads): the roster peer's subtree lands on `accept_subjects` + the
 *      peer lands on `peers[]`. This is the end-to-end "jc shows on my pane
 *      without a manual network join" wire.
 *   2. No opted-in network ⇒ the reconciler is INERT (the live accept-list is
 *      left exactly as configured; a later-joining peer is NOT auto-admitted).
 *
 * Mirrors the `cortex.agent-presence-boot.test.ts` harness — NATS-absent
 * recording runtime, headless presence, inline agents. The reconciler boot path
 * is gated behind `mc.enabled` (it feeds the same Network-view registry the
 * federated presence subscriber folds into), so MC is enabled here.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentConfigSchema, type AgentConfig } from "../common/types/config";
import {
  PolicySchema,
  type Agent,
  type AgentRuntime,
  type Policy,
} from "../common/types/cortex-config";
import { startCortex } from "../cortex";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { EnvelopeHandler, MyelinRuntime } from "../bus/myelin/runtime";
import type { MyelinSubscriber } from "../bus/myelin/subscriber";
import type { NetworkRosterProvider } from "../common/registry/resolve-federated-peers";
import type { NetworkFetchResult } from "../common/registry/network-client";
import type {
  NetworkRosterResult,
  NetworkRosterPeer,
} from "../common/registry/types";

function minimalConfig(overrides: Record<string, unknown> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/grove-cortex-reconciler-test-published" },
    ...overrides,
  });
}

function createRecordingRuntime(): MyelinRuntime {
  const handlers = new Set<EnvelopeHandler>();
  const fakeSubscriber: MyelinSubscriber = {
    stop: () => Promise.resolve(),
  } as unknown as MyelinSubscriber;
  const rt: Partial<MyelinRuntime> = {
    enabled: true,
    onEnvelope(handler: EnvelopeHandler) {
      handlers.add(handler);
      return { unregister: () => handlers.delete(handler) };
    },
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve(fakeSubscriber),
    stop: () => Promise.resolve(),
  };
  return rt as MyelinRuntime;
}

function makeAgent(id: string, capabilities: readonly string[]): Agent {
  const runtime: AgentRuntime = {
    substrate: "claude-code",
    mode: "in-process",
    capabilities: [...capabilities],
  };
  return {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    persona: `/tmp/${id}-persona.md`,
    trust: [],
    presence: {},
    nkey_pub: "UA" + id.toUpperCase().padEnd(54, "X"),
    runtime,
  };
}

const FAKE_PUBKEY = "A".repeat(43) + "=";

function rosterProvider(
  members: NetworkRosterPeer[],
  networkId: string,
): NetworkRosterProvider {
  return {
    fetchAndCache(
      id: string,
    ): Promise<NetworkFetchResult<{ roster: NetworkRosterResult }>> {
      if (id !== networkId) return Promise.resolve({ status: "not_found" });
      return Promise.resolve({
        status: "ok",
        value: { roster: { network_id: id, members } },
      });
    },
    loadCached() {
      return undefined;
    },
  };
}

/**
 * A federation policy with ONE network. `reconcile` opt-in is parameterised.
 * `registry` is present so the reconciler's live-provider branch is taken when
 * no test provider is injected — but here we always inject, so the registry is
 * just the opt-in signal the boot reads.
 */
function federatedPolicy(opts: { reconcileEnabled: boolean }): Policy {
  return PolicySchema.parse({
    federated: {
      registry: { url: "https://registry.example.test" },
      networks: [
        {
          id: "metafactory",
          leaf_node: "metafactory",
          peers: [],
          // The OWN-only accept-list a pre-P3 `network join` wrote.
          accept_subjects: ["federated.andreas.default.>"],
          deny_subjects: [],
          announce_capabilities: [],
          max_hop: 1,
          ...(opts.reconcileEnabled && {
            reconcile: { enabled: true, interval_ms: 60000 },
          }),
        },
      ],
    },
  });
}

describe("startCortex — federation roster reconciler boot (P3 #1088)", () => {
  test("opted-in network: reconciler admits the roster peer into the LIVE policy on boot", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-reconciler-on-"));
    let resolvedPolicy: Policy | undefined;

    const handle = await startCortex(
      minimalConfig({ mc: { enabled: true, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [makeAgent("luna", ["code-review.typescript"])],
        principal: { id: "andreas" },
        policy: federatedPolicy({ reconcileEnabled: true }),
        bootFederatedRosterProvider: rosterProvider(
          [
            {
              principal_id: "jc",
              stack_id: "jc/research",
              principal_pubkey: FAKE_PUBKEY,
            },
          ],
          "metafactory",
        ),
        onBootResolvedPolicy: (p) => {
          resolvedPolicy = p;
        },
      },
    );

    // The reconciler ran on start (runOnStart default true) and mutated the live
    // network object in place. Settle any in-flight async pass first.
    // (startFederationReconciler runs synchronously-scheduled; the boot await
    // doesn't join its first tick, so poll briefly for the applied result.)
    const net = resolvedPolicy?.federated?.networks[0];
    await waitFor(() =>
      (net?.accept_subjects ?? []).includes("federated.jc.research.agent.>"),
    );

    // peers[] now carries jc (gate's resolveSourceNetwork needs this).
    expect(net?.peers.map((p) => p.principal_id)).toEqual(["jc"]);
    // accept_subjects widened OWN ∪ jc's subtree (the defect-#1 fix at runtime).
    expect(net?.accept_subjects).toContain("federated.jc.research.agent.>");
    expect(net?.accept_subjects).toContain("federated.andreas.default.>");

    await handle.stop();
  });

  test("no opt-in: reconciler is inert — the live accept-list is left as configured", async () => {
    const runtime = createRecordingRuntime();
    const tmp = mkdtempSync(join(tmpdir(), "cortex-reconciler-off-"));
    let resolvedPolicy: Policy | undefined;

    const handle = await startCortex(
      minimalConfig({ mc: { enabled: true, configPath: "", dbPath: "", port: 0 } }),
      {
        disableConfigWatcher: true,
        disableDashboard: true,
        disableOutboundPoller: true,
        agentsDir: tmp,
        injectRuntime: runtime,
        inlineAgents: [makeAgent("luna", ["code-review.typescript"])],
        principal: { id: "andreas" },
        policy: federatedPolicy({ reconcileEnabled: false }),
        bootFederatedRosterProvider: rosterProvider(
          [
            {
              principal_id: "jc",
              stack_id: "jc/research",
              principal_pubkey: FAKE_PUBKEY,
            },
          ],
          "metafactory",
        ),
        onBootResolvedPolicy: (p) => {
          resolvedPolicy = p;
        },
      },
    );

    // Give any (erroneously-started) loop a moment; assert jc never appears.
    await new Promise((r) => setTimeout(r, 30));
    const net = resolvedPolicy?.federated?.networks[0];
    expect(net?.accept_subjects).not.toContain("federated.jc.research.agent.>");
    // The OWN-only configured accept-list is untouched.
    expect(net?.accept_subjects).toEqual(["federated.andreas.default.>"]);

    await handle.stop();
  });
});

/** Poll a predicate up to ~1s — the reconciler's first tick is async. */
async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  // Final check throws via the caller's expect() if still false.
}
