/**
 * cortex#480 — tests for the boot-time verifier self-check.
 *
 * Coverage:
 *   1. Happy path — self-signed envelope round-trips successfully.
 *   2. Mismatched stackNKeyPub (signer key differs from declared pubkey)
 *      → bytes-check fails, self-check logs error and returns ok=false.
 *   3. Malformed `stackNKeyPub` → bytes-check can't decode, self-check
 *      logs error and returns ok=false (defence-in-depth on the bridge).
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import { runVerifierSelfCheck } from "../verifier-self-check";
import type { Agent } from "../../common/types/cortex-config";

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1487000000000000000",
    agentChannelId: "1487000000000000001",
    logChannelId: "1487000000000000002",
    contextDepth: 10,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: {
      operatorRole: {
        features: ["chat", "async", "team"] as const,
        disallowedTools: [],
        bashGuard: true,
      },
      defaultRole: "denied" as const,
      userRoles: [],
    },
  };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

function generateStackKeypair() {
  const kp = createUser();
  const nkeyPub = kp.getPublicKey();
  const rawSeed = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  return { nkeyPub, rawSeed };
}

describe("runVerifierSelfCheck (cortex#480)", () => {
  test("[1] self-signed round-trip succeeds", async () => {
    const { nkeyPub, rawSeed } = generateStackKeypair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = new TrustResolver(AgentRegistry.fromAgents([luna]));

    const logs: string[] = [];
    const errs: string[] = [];

    const result = await runVerifierSelfCheck({
      stackIdentity: "did:mf:andreas-meta-factory",
      stackNKeyPub: nkeyPub,
      stackSeedBytes: rawSeed,
      resolver,
      receivingAgentId: "luna",
      principalId: "andreas",
      log: (line) => logs.push(line),
      err: (line) => errs.push(line),
    });

    expect(result.ok).toBe(true);
    expect(errs).toHaveLength(0);
    expect(logs.join("\n")).toContain("verifier-self-check OK");
  });

  test("[2] mismatched stackNKeyPub — signer key differs from declared pubkey → fail", async () => {
    // Signer uses key A; we tell the verifier key B is the registered
    // pubkey. The crypto-verify pass MUST fail to detect the
    // split-brain hazard at boot rather than at first Discord chat.
    const { rawSeed } = generateStackKeypair();
    const { nkeyPub: differentKey } = generateStackKeypair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = new TrustResolver(AgentRegistry.fromAgents([luna]));

    const errs: string[] = [];
    const result = await runVerifierSelfCheck({
      stackIdentity: "did:mf:andreas-meta-factory",
      stackNKeyPub: differentKey,
      stackSeedBytes: rawSeed,
      resolver,
      receivingAgentId: "luna",
      principalId: "andreas",
      log: () => {},
      err: (line) => errs.push(line),
    });

    expect(result.ok).toBe(false);
    expect(errs.join("\n")).toContain("verifier-self-check: FAILED");
  });

  test("[3] malformed stackNKeyPub — verifier rejects, error logged", async () => {
    const { rawSeed } = generateStackKeypair();
    const luna = agentFixture({ id: "luna", trust: [] });
    const resolver = new TrustResolver(AgentRegistry.fromAgents([luna]));

    const errs: string[] = [];
    const result = await runVerifierSelfCheck({
      stackIdentity: "did:mf:andreas-meta-factory",
      // Malformed — doesn't pass the U-prefix base32 decode in
      // `nkeyToBase64Pubkey`. The bridge silently drops the entry,
      // so the crypto-verify pass finds no Principal registered and
      // rejects.
      stackNKeyPub: "not-a-valid-nkey",
      stackSeedBytes: rawSeed,
      resolver,
      receivingAgentId: "luna",
      principalId: "andreas",
      log: () => {},
      err: (line) => errs.push(line),
    });

    expect(result.ok).toBe(false);
    expect(errs.join("\n")).toContain("verifier-self-check: FAILED");
  });
});
