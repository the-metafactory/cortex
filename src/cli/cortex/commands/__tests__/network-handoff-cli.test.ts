/**
 * CLI-level tests for `cortex network handoff status` (cortex#1485, epic #1479).
 *
 * Drives `dispatchNetwork(["handoff", "status", <member>, "--network", ...],
 * fakeReader, ...defaults, handoffPortsFactory)` with an injected fake config
 * reader AND an injected fake handoff-ports factory — no NATS, no ~/.config,
 * no live wire, no fs. Mirrors `network-doctor-cli.test.ts`'s dispatch-level
 * factory injection.
 */

import { describe, expect, test } from "bun:test";

import { dispatchNetwork, type HandoffPortsFactory } from "../network";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
import type { ResolveOwnAdmissionStateResult } from "../../../../common/registry/admission-state";
import type { NetworkHandoffPorts, HandoffHubAuthPort } from "../network-handoff-ports";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function reader(): () => LoadedConfig {
  return () =>
    ({
      config: { nats: { url: "nats://127.0.0.1:4222" } } as unknown as AgentConfig,
      inlineAgents: [{ id: "sage" } as unknown as LoadedConfig["inlineAgents"][number]],
      principal: { id: "andreas" },
      stack: { id: "andreas/community", nkey_seed_path: "~/.config/nats/andreas-community.seed" },
      policy: {
        federated: {
          networks: [
            {
              id: "metafactory-community",
              leaf_node: "hub",
              peers: [{ principal_id: "jc", stack_id: "jc/default" }],
              accept_subjects: ["federated.>"],
              deny_subjects: [],
            } as unknown as PolicyFederatedNetwork,
          ],
        },
      } as unknown as LoadedConfig["policy"],
    });
}

const STUB_HUB_AUTH: HandoffHubAuthPort = {
  resolveHubAuthorized: async () => ({ confirmed: undefined, reason: "documented stub" }),
};

function admitted(hasSealedSecret: boolean): ResolveOwnAdmissionStateResult {
  return {
    ok: true,
    state: {
      state: hasSealedSecret ? "admitted-sealed" : "admitted-unsealed",
      networkId: "metafactory-community",
      requestId: "req-1",
      hasSealedSecret,
      peerPubkey: "PUBKEY_FIXTURE",
    },
  };
}

/** A fake handoff-ports factory — records invocation, hands back canned ports. */
function fakeHandoffFactory(opts: {
  sealed: boolean;
  hubConfirmed?: boolean;
  leafUp?: boolean;
}): { factory: HandoffPortsFactory; invoked: () => boolean } {
  let wasInvoked = false;
  const ports: NetworkHandoffPorts = {
    admission: { resolve: async () => admitted(opts.sealed) },
    hubAuth:
      opts.hubConfirmed === undefined
        ? STUB_HUB_AUTH
        : { resolveHubAuthorized: async () => ({ confirmed: opts.hubConfirmed }) },
    config: {
      readNetworks: () => ({
        networks: [
          {
            id: "metafactory-community",
            leaf_node: "hub",
            peers: [{ principal_id: "jc", stack_id: "jc/default" }],
            accept_subjects: ["federated.>"],
            deny_subjects: [],
          } as unknown as PolicyFederatedNetwork,
        ],
      }),
    },
    monitor: {
      resolve: () => ({ url: "http://127.0.0.1:8222", configured: true }),
      fetchLeafz: async () =>
        opts.leafUp === true ? { leafs: [{ name: "hub", account: "A" }] } : { leafs: [] },
    },
  };
  const factory: HandoffPortsFactory = () => {
    wasInvoked = true;
    return ports;
  };
  return { factory, invoked: () => wasInvoked };
}

/** dispatchNetwork(argv, load, ping, provision, secret, makeLive, keyRotation, doctor, handoff). */
async function runHandoffCli(argv: string[], factory: HandoffPortsFactory) {
  return dispatchNetwork(
    argv,
    reader(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    factory,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cortex network handoff status — human output", () => {
  test("sealed, hub-authorize stub: lists 3 legs, outstanding hub-authorize, cannot bring leaf up", async () => {
    const f = fakeHandoffFactory({ sealed: true });
    const res = await runHandoffCli(
      ["handoff", "status", "andreas", "--network", "metafactory-community", "--principal", "andreas"],
      f.factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex network handoff status andreas");
    expect(res.stdout).toContain("seal [done]");
    expect(res.stdout).toContain("hub-authorize [pending]");
    expect(res.stdout).toContain("leaf-up [blocked]");
    expect(res.stdout).toContain("outstanding: hub-authorize (owner: hub-owner)");
    expect(res.stdout).toContain("can bring leaf up: no");
    expect(f.invoked()).toBe(true);
  });

  test("all legs done when hub confirmed + leaf up", async () => {
    const f = fakeHandoffFactory({ sealed: true, hubConfirmed: true, leafUp: true });
    const res = await runHandoffCli(
      ["handoff", "status", "andreas", "--network", "metafactory-community", "--principal", "andreas"],
      f.factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("outstanding: none");
    expect(res.stdout).toContain("can bring leaf up: yes");
  });
});

describe("cortex network handoff status — --json", () => {
  test("emits per-leg rows + next_leg / can_bring_leaf_up data", async () => {
    const f = fakeHandoffFactory({ sealed: true });
    const res = await runHandoffCli(
      ["handoff", "status", "andreas", "--network", "metafactory-community", "--principal", "andreas", "--json"],
      f.factory,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      status: string;
      items: { id: string; status: string; owner: string }[];
      data: { network: string; member: string; next_leg?: string; next_owner?: string; can_bring_leaf_up: string };
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.data.network).toBe("metafactory-community");
    expect(parsed.data.member).toBe("andreas");
    expect(parsed.data.next_leg).toBe("hub-authorize");
    expect(parsed.data.next_owner).toBe("hub-owner");
    expect(parsed.data.can_bring_leaf_up).toBe("false");
    expect(parsed.items.map((i) => i.id)).toEqual(["seal", "hub-authorize", "leaf-up"]);
    for (const item of parsed.items) {
      expect(["admin", "hub-owner", "member"]).toContain(item.owner);
    }
  });
});

describe("cortex network handoff — usage errors", () => {
  test("--network required", async () => {
    const f = fakeHandoffFactory({ sealed: true });
    const res = await runHandoffCli(
      ["handoff", "status", "andreas", "--principal", "andreas"],
      f.factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--network");
  });

  test("unknown action rejected", async () => {
    const f = fakeHandoffFactory({ sealed: true });
    const res = await runHandoffCli(
      ["handoff", "wat", "andreas", "--network", "metafactory-community", "--principal", "andreas"],
      f.factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('unknown action "wat"');
  });
});
