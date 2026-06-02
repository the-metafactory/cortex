/**
 * GW.a.3b.2c — `gatewayOwnedSurfaceKeys` tests (cortex#524, TDD).
 *
 * The helper builds the `{platform}:{agentId}` suppression set the per-stack
 * adapter loops consult to yield gateway-owned surfaces. Its safety contract is
 * the load-bearing part: it MUST return an empty set whenever the gateway is
 * disabled OR no surfaces are configured, because the per-stack loops gate
 * their skip on `set.has(...)` — an empty set guarantees a byte-identical
 * flag-off boot. These tests pin both the safety contract and the key shape.
 */

import { describe, expect, test } from "bun:test";
import { gatewayOwnedSurfaceKeys } from "../gateway-adapters";
import { isGatewayEnabled } from "../gateway-bootstrap";
import type { Surfaces } from "../../common/types/surfaces";

// A representative multi-platform binding map. Only the fields the helper reads
// (`.agent`) matter for the key; the credential blocks are filled with the
// minimum the `Surfaces` type expects.
const DISCORD_LUNA = {
  agent: "luna",
  binding: {
    token: "discord-bot-token",
    guildId: "111111111111111111",
    agentChannelId: "222222222222222222",
    logChannelId: "333333333333333333",
  },
} as const;

const SURFACES: Surfaces = {
  discord: [DISCORD_LUNA],
  slack: [
    {
      agent: "echo",
      binding: {
        botToken: "xoxb-aaa",
        appToken: "xapp-bbb",
        workspaceId: "T01234567",
      },
    },
  ],
  mattermost: [
    {
      agent: "sage",
      binding: {
        apiUrl: "https://mm.example.com",
        apiToken: "mm-api-token",
      },
    },
  ],
};

describe("gatewayOwnedSurfaceKeys — safety contract (empty set)", () => {
  test("returns an empty set when disabled, even with surfaces present", () => {
    const keys = gatewayOwnedSurfaceKeys(SURFACES, false);
    expect(keys.size).toBe(0);
  });

  test("returns an empty set when surfaces is undefined (flag on)", () => {
    const keys = gatewayOwnedSurfaceKeys(undefined, true);
    expect(keys.size).toBe(0);
  });

  test("returns an empty set when surfaces is undefined AND disabled", () => {
    const keys = gatewayOwnedSurfaceKeys(undefined, false);
    expect(keys.size).toBe(0);
  });

  test("returns an empty set for an all-empty surfaces map when enabled", () => {
    const keys = gatewayOwnedSurfaceKeys(
      { discord: [], slack: [], mattermost: [] },
      true,
    );
    expect(keys.size).toBe(0);
  });
});

describe("gatewayOwnedSurfaceKeys — key shape (enabled)", () => {
  test("builds {platform}:{agentId} keys for every binding", () => {
    const keys = gatewayOwnedSurfaceKeys(SURFACES, true);
    expect(keys.has("discord:luna")).toBe(true);
    expect(keys.has("slack:echo")).toBe(true);
    expect(keys.has("mattermost:sage")).toBe(true);
    expect(keys.size).toBe(3);
  });

  test("does not invent keys for unbound platforms", () => {
    const discordOnly: Surfaces = { discord: [DISCORD_LUNA] };
    const keys = gatewayOwnedSurfaceKeys(discordOnly, true);
    expect(keys.has("discord:luna")).toBe(true);
    expect(keys.has("slack:echo")).toBe(false);
    expect(keys.has("mattermost:sage")).toBe(false);
    expect(keys.size).toBe(1);
  });

  test("handles multiple bindings on one platform", () => {
    const multi: Surfaces = {
      discord: [
        DISCORD_LUNA,
        {
          agent: "nova",
          binding: {
            token: "discord-bot-token-2",
            guildId: "444444444444444444",
            agentChannelId: "555555555555555555",
            logChannelId: "666666666666666666",
          },
        },
      ],
    };
    const keys = gatewayOwnedSurfaceKeys(multi, true);
    expect(keys.has("discord:luna")).toBe(true);
    expect(keys.has("discord:nova")).toBe(true);
    expect(keys.size).toBe(2);
  });

  test("reproduces the §1.2 double-connect decision the per-stack loop makes", () => {
    // This mirrors EXACTLY how src/cortex.ts composes the suppression check:
    //   const gatewayOwned = gatewayOwnedSurfaceKeys(options.surfaces, isGatewayEnabled(process.env));
    //   if (gatewayOwned.has(`discord:${agent.id}`)) continue;  // yield to gateway
    // Staging config: luna's discord binding is folded into presence (per-stack
    // would start it) AND lives in surfaces (gateway starts it). With the flag
    // ON the per-stack loop must yield; with the flag OFF it must not.
    const flagOn = gatewayOwnedSurfaceKeys(
      SURFACES,
      isGatewayEnabled({ CORTEX_GATEWAY: "1" }),
    );
    expect(flagOn.has("discord:luna")).toBe(true); // per-stack loop yields

    const flagOff = gatewayOwnedSurfaceKeys(
      SURFACES,
      isGatewayEnabled({ CORTEX_GATEWAY: undefined }),
    );
    expect(flagOff.has("discord:luna")).toBe(false); // per-stack loop starts (byte-identical)
    expect(flagOff.size).toBe(0);

    // Only "1" is truthy (matches isGatewayEnabled's contract) — "true" is off.
    const flagTrue = gatewayOwnedSurfaceKeys(
      SURFACES,
      isGatewayEnabled({ CORTEX_GATEWAY: "true" }),
    );
    expect(flagTrue.size).toBe(0);
  });

  test("the same agent bound on two platforms yields two distinct keys", () => {
    const crossPlatform: Surfaces = {
      discord: [DISCORD_LUNA],
      slack: [
        {
          agent: "luna",
          binding: {
            botToken: "xoxb-luna",
            appToken: "xapp-luna",
            workspaceId: "T76543210",
          },
        },
      ],
    };
    const keys = gatewayOwnedSurfaceKeys(crossPlatform, true);
    expect(keys.has("discord:luna")).toBe(true);
    expect(keys.has("slack:luna")).toBe(true);
    expect(keys.size).toBe(2);
  });
});
