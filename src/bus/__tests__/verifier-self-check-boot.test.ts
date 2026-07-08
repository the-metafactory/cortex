/**
 * TC-1b (#632) — posture-aware boot gate (`bootVerifierSelfCheck`).
 *
 * Coverage:
 *   1. enforce + missing identity → THROWS (refuse to boot).
 *   2. enforce + valid identity → resolves (boot proceeds), no throw.
 *   3. enforce + INVALID identity (mismatched pubkey) → THROWS.
 *   4. off + missing identity → no-op, no throw (unsigned-dev default).
 *   5. permissive + invalid identity → WARN, no throw (advisory shadow).
 *   6. no secret material (seed bytes) appears in any log/err line.
 */

import { describe, test, expect } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import { bootVerifierSelfCheck } from "../verifier-self-check";
import type { Agent } from "../../common/types/cortex-config";

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1111111111111111111",
    agentChannelId: "2222222222222222222",
    logChannelId: "3333333333333333333",
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

function stackKeypair() {
  const kp = createUser();
  return {
    nkeyPub: kp.getPublicKey(),
    rawSeed: (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed(),
  };
}

function resolverFor(): TrustResolver {
  return new TrustResolver(AgentRegistry.fromAgents([agentFixture()]));
}

describe("bootVerifierSelfCheck (TC-1b #632)", () => {
  test("[1] enforce + missing identity → refuses to boot (throws)", async () => {
    const errs: string[] = [];
    await expect(
      bootVerifierSelfCheck({
        posture: "enforce",
        identity: undefined,
        resolver: resolverFor(),
        receivingAgentId: "luna",
        principalId: "andreas",
        log: () => {},
        err: (l) => errs.push(l),
      }),
    ).rejects.toThrow(/REFUSING TO BOOT/i);
  });

  test("[2] enforce + valid identity → resolves, boot proceeds", async () => {
    const { nkeyPub, rawSeed } = stackKeypair();
    const logs: string[] = [];
    const errs: string[] = [];
    await bootVerifierSelfCheck({
      posture: "enforce",
      identity: {
        stackIdentity: "did:mf:andreas-meta-factory",
        stackNKeyPub: nkeyPub,
        stackSeedBytes: rawSeed,
      },
      resolver: resolverFor(),
      receivingAgentId: "luna",
      principalId: "andreas",
      log: (l) => logs.push(l),
      err: (l) => errs.push(l),
    });
    expect(errs).toHaveLength(0);
    expect(logs.join("\n")).toContain("verifier-self-check OK");
  });

  test("[3] enforce + INVALID identity (mismatched pubkey) → refuses to boot", async () => {
    const { rawSeed } = stackKeypair();
    const { nkeyPub: otherPub } = stackKeypair();
    await expect(
      bootVerifierSelfCheck({
        posture: "enforce",
        identity: {
          stackIdentity: "did:mf:andreas-meta-factory",
          // Declared pubkey belongs to a DIFFERENT key than the seed.
          stackNKeyPub: otherPub,
          stackSeedBytes: rawSeed,
        },
        resolver: resolverFor(),
        receivingAgentId: "luna",
        principalId: "andreas",
        log: () => {},
        err: () => {},
      }),
    ).rejects.toThrow(/REFUSING TO BOOT/i);
  });

  test("[4] off + missing identity → no-op, no throw", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    await bootVerifierSelfCheck({
      posture: "off",
      identity: undefined,
      resolver: resolverFor(),
      receivingAgentId: "luna",
      principalId: "andreas",
      log: (l) => logs.push(l),
      err: (l) => errs.push(l),
    });
    expect(errs).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  test("[5] permissive + invalid identity → advisory WARN, no throw", async () => {
    const { rawSeed } = stackKeypair();
    const { nkeyPub: otherPub } = stackKeypair();
    const errs: string[] = [];
    // Must NOT throw.
    await bootVerifierSelfCheck({
      posture: "permissive",
      identity: {
        stackIdentity: "did:mf:andreas-meta-factory",
        stackNKeyPub: otherPub,
        stackSeedBytes: rawSeed,
      },
      resolver: resolverFor(),
      receivingAgentId: "luna",
      principalId: "andreas",
      log: () => {},
      err: (l) => errs.push(l),
    });
    const joined = errs.join("\n");
    expect(joined).toContain("verifier-self-check: FAILED");
    expect(joined).toContain("continuing boot under signing=permissive");
  });

  test("[6] no secret seed bytes leak into any log/err line", async () => {
    const { nkeyPub, rawSeed } = stackKeypair();
    const seedB64 = Buffer.from(rawSeed).toString("base64");
    const seedHex = Buffer.from(rawSeed).toString("hex");
    const logs: string[] = [];
    const errs: string[] = [];
    await bootVerifierSelfCheck({
      posture: "permissive",
      identity: {
        stackIdentity: "did:mf:andreas-meta-factory",
        stackNKeyPub: nkeyPub,
        stackSeedBytes: rawSeed,
      },
      resolver: resolverFor(),
      receivingAgentId: "luna",
      principalId: "andreas",
      log: (l) => logs.push(l),
      err: (l) => errs.push(l),
    });
    const all = [...logs, ...errs].join("\n");
    expect(all).not.toContain(seedB64);
    expect(all).not.toContain(seedHex);
  });
});
