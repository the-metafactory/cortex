import { describe, expect, test } from "bun:test";
import {
  gatewayAdapterInstanceCollisions,
  planSurfaceOwnership,
} from "../surface-ownership-plan";
import type { Surfaces } from "../../common/types/surfaces";

const SURFACES: Surfaces = {
  discord: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        token: "discord-token",
        guildId: "111111111111111111",
        agentChannelId: "aaa000000000000001",
        logChannelId: "bbb000000000000002",
      },
    },
    {
      agent: "sage",
      stack: "robin/research",
      binding: {
        token: "discord-token-2",
        guildId: "222222222222222222",
        agentChannelId: "ccc000000000000003",
        logChannelId: "ddd000000000000004",
      },
    },
  ],
  slack: [
    {
      agent: "echo",
      stack: "andreas/meta-factory",
      binding: {
        botToken: "xoxb-aaa",
        appToken: "xapp-bbb",
        workspaceId: "T01234567",
      },
    },
  ],
  mattermost: [
    {
      agent: "nova",
      binding: {
        apiUrl: "https://mm.example.com",
        apiToken: "mm-token",
      },
    },
  ],
};

describe("planSurfaceOwnership", () => {
  test("flag off keeps an inactive plan even when surfaces have bindings", () => {
    const plan = planSurfaceOwnership({
      surfaces: SURFACES,
      gatewayEnabled: false,
      principal: "andreas",
    });

    expect(plan.gatewayEnabled).toBe(false);
    expect(plan.hasSurfaceBindings).toBe(true);
    expect(plan.gatewayStartEligible).toBe(false);
    expect([...plan.ownedSurfaceKeys]).toEqual([]);
    expect(plan.gatewayAdapterInstanceIds).toEqual([]);
    expect(plan.outboundStacks).toEqual([]);
    expect(plan.outboundPrincipalStacks).toEqual([]);
    expect(plan.crossPrincipalBindings).toEqual([]);
  });

  test("flag on with no surfaces keeps a graceful no-start plan", () => {
    const plan = planSurfaceOwnership({
      surfaces: undefined,
      gatewayEnabled: true,
      principal: "andreas",
    });

    expect(plan.gatewayEnabled).toBe(true);
    expect(plan.hasSurfaceBindings).toBe(false);
    expect(plan.gatewayStartEligible).toBe(false);
    expect([...plan.ownedSurfaceKeys]).toEqual([]);
  });

  test("flag on with an empty surfaces map keeps a no-start plan", () => {
    const plan = planSurfaceOwnership({
      surfaces: { discord: [], slack: [], mattermost: [] },
      gatewayEnabled: true,
      principal: "andreas",
    });

    expect(plan.gatewayEnabled).toBe(true);
    expect(plan.hasSurfaceBindings).toBe(false);
    expect(plan.gatewayStartEligible).toBe(false);
    expect([...plan.ownedSurfaceKeys]).toEqual([]);
    expect(plan.gatewayAdapterInstanceIds).toEqual([]);
    expect(plan.outboundStacks).toEqual([]);
    expect(plan.outboundPrincipalStacks).toEqual([]);
  });

  test("flag on with bindings plans suppression, Gateway ids, and outbound subjects", () => {
    const plan = planSurfaceOwnership({
      surfaces: SURFACES,
      gatewayEnabled: true,
      principal: "andreas",
    });

    expect(plan.gatewayStartEligible).toBe(true);
    expect([...plan.ownedSurfaceKeys].sort()).toEqual([
      "discord:luna",
      "discord:sage",
      "mattermost:nova",
      "slack:echo",
    ]);
    expect(plan.gatewayAdapterInstanceIds).toEqual([
      "discord:111111111111111111",
      "discord:222222222222222222",
      "slack:T01234567",
      "mattermost:https://mm.example.com",
    ]);
    expect(plan.outboundStacks).toEqual(["meta-factory", "research", undefined]);
    expect(plan.outboundPrincipalStacks).toEqual([
      { principal: "andreas", stack: "meta-factory" },
      { principal: "robin", stack: "research" },
      { principal: "andreas", stack: undefined },
    ]);
    expect(plan.crossPrincipalBindings).toEqual(["robin/research"]);
  });

  test("same Discord token across two guild bindings plans one token-scoped Gateway id", () => {
    const plan = planSurfaceOwnership({
      surfaces: {
        discord: [
          {
            agent: "juniper",
            stack: "jc/default",
            binding: {
              token: "discord-token",
              guildId: "333333333333333333",
              agentChannelId: "444444444444444444",
              logChannelId: "444444444444444444",
            },
          },
          {
            agent: "juniper",
            stack: "jc/default",
            binding: {
              token: "discord-token",
              guildId: "555555555555555555",
              agentChannelId: "666666666666666666",
              logChannelId: "666666666666666666",
            },
          },
        ],
      },
      gatewayEnabled: true,
      principal: "jc",
    });

    expect(plan.gatewayAdapterInstanceIds).toHaveLength(1);
    expect(plan.gatewayAdapterInstanceIds[0]).toMatch(/^discord:token:[0-9a-f]{12}$/);
    expect([...plan.ownedSurfaceKeys]).toEqual(["discord:juniper"]);
    expect(plan.outboundPrincipalStacks).toEqual([{ principal: "jc", stack: "default" }]);
  });

  test("same Discord token across two stacks keeps separate Gateway ids", () => {
    const plan = planSurfaceOwnership({
      surfaces: {
        discord: [
          {
            agent: "juniper",
            stack: "jc/default",
            binding: {
              token: "discord-token",
              guildId: "333333333333333333",
              agentChannelId: "444444444444444444",
              logChannelId: "444444444444444444",
            },
          },
          {
            agent: "juniper",
            stack: "jc/research",
            binding: {
              token: "discord-token",
              guildId: "555555555555555555",
              agentChannelId: "666666666666666666",
              logChannelId: "666666666666666666",
            },
          },
        ],
      },
      gatewayEnabled: true,
      principal: "jc",
    });

    expect(plan.gatewayAdapterInstanceIds).toEqual([
      "discord:333333333333333333",
      "discord:555555555555555555",
    ]);
    expect(plan.outboundPrincipalStacks).toEqual([
      { principal: "jc", stack: "default" },
      { principal: "jc", stack: "research" },
    ]);
  });
});

describe("gatewayAdapterInstanceCollisions", () => {
  test("reports Gateway adapter ids that collide with per-stack adapter ids", () => {
    const collisions = gatewayAdapterInstanceCollisions(
      [
        { instanceId: "discord:111111111111111111" },
        { instanceId: "slack-stack" },
      ],
      [
        { instanceId: "discord:111111111111111111" },
        { instanceId: "slack:T01234567" },
      ],
    );

    expect(collisions).toEqual(["discord:111111111111111111"]);
  });

  test("returns an empty list when instance id sets are disjoint", () => {
    const collisions = gatewayAdapterInstanceCollisions(
      [{ instanceId: "discord-stack" }],
      [{ instanceId: "discord:111111111111111111" }],
    );

    expect(collisions).toEqual([]);
  });
});

// ─── Web platform coverage (C-110 / WEB-1 gateway routing fix) ───────────────
//
// WEB-1 added the web adapter but countSurfaceBindings / ownedKeys /
// gatewayInstanceIds previously excluded `surfaces.web`, so a web-only stack
// was invisible to the ownership plan (0 bindings → gateway never started).
// These tests pin the corrected paths.

/** Web-only surfaces — one binding, instanceId "acme", agent "pylon". */
const WEB_SURFACES: Surfaces = {
  web: [
    {
      agent: "pylon",
      stack: "andreas/acme",
      binding: {
        host: "127.0.0.1",
        instanceId: "acme",
        port: 8090,
        broadcastUrl: "http://localhost:9090/broadcast",
        transport: "ws",
        authScheme: "cf-access",
      },
    },
  ],
};

describe("planSurfaceOwnership — web surfaces", () => {
  test("countSurfaceBindings includes web — web-only surfaces make the plan start-eligible", () => {
    const plan = planSurfaceOwnership({
      surfaces: WEB_SURFACES,
      gatewayEnabled: true,
      principal: "andreas",
    });
    expect(plan.hasSurfaceBindings).toBe(true);
    expect(plan.gatewayStartEligible).toBe(true);
  });

  test("ownedKeys includes the web binding's '{platform}:{agent}' key", () => {
    const plan = planSurfaceOwnership({
      surfaces: WEB_SURFACES,
      gatewayEnabled: true,
      principal: "andreas",
    });
    expect([...plan.ownedSurfaceKeys]).toContain("web:pylon");
  });

  test("gatewayAdapterInstanceIds includes the web binding's 'web:{instanceId}'", () => {
    const plan = planSurfaceOwnership({
      surfaces: WEB_SURFACES,
      gatewayEnabled: true,
      principal: "andreas",
    });
    expect(plan.gatewayAdapterInstanceIds).toContain("web:acme");
  });

  test("outboundStacks includes the web binding's stack leaf", () => {
    const plan = planSurfaceOwnership({
      surfaces: WEB_SURFACES,
      gatewayEnabled: true,
      principal: "andreas",
    });
    expect(plan.outboundStacks).toContain("acme");
  });

  test("flag off with web-only surfaces keeps the inactive plan (gateway never starts)", () => {
    const plan = planSurfaceOwnership({
      surfaces: WEB_SURFACES,
      gatewayEnabled: false,
      principal: "andreas",
    });
    expect(plan.hasSurfaceBindings).toBe(true); // bindings exist…
    expect(plan.gatewayStartEligible).toBe(false); // …but flag is off
    expect([...plan.ownedSurfaceKeys]).toEqual([]);
  });
});
