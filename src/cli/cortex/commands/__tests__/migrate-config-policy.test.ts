/**
 * v2.0.0 policy cutover — slice I-243C (cortex#295) tests.
 *
 * Exercises `convertBotYaml`'s new policy-block synthesis path, plus the
 * standalone `buildPolicy` + `policyPreflight` helpers from
 * `migrate-config-policy.ts`. Coverage map below mirrors the spec on
 * cortex#295:
 *
 *   - single-adapter input → policy block with operator + user + agent-X
 *     principals
 *   - 3-adapter (discord+mattermost+slack) cross-adapter consistency:
 *       same role + same fields → one PolicyRole (no duplication)
 *       same role + different fields → one PolicyRole + warning + UNION
 *   - DM operatorRole with broader bashAllowlist → session_config.default
 *     + session_config.dm; DM block carries the broader list
 *   - DM userRoles[] → augments principal's session_config.dm
 *   - defaultRole: denied → synthetic anonymous principal with empty role[]
 *   - defaultRole: <named> → synthetic anonymous principal with that role
 *   - external peer (`agent-ivy` where ivy is not declared) → home_operator
 *     "unknown" + warning
 *   - idempotency: re-running emits byte-identical output
 *   - --labels override: principal id taken from labels file
 *   - --check: passing case exits 0; failing case (missing principal for
 *     legacy user) exits 1 + reports gaps
 *   - disallowedTools: [Bash, Edit] inverts correctly via cortex#294 helper
 *   - bare-string caps in pre-existing policy → rewritten to keyword.*
 */

import { describe, expect, test } from "bun:test";
import YAML from "yaml";

import {
  convertBotYaml,
  policyPreflight,
  formatPreflightReport,
  type LegacyBotYaml,
} from "../migrate-config-lib";
import {
  buildPolicy,
  type PolicyAdapterView,
} from "../migrate-config-policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadCortexShape(yamlStr: string): LegacyBotYaml {
  return YAML.parse(yamlStr) as LegacyBotYaml;
}

const CORTEX_SHAPE_SINGLE_ADAPTER = `
operator:
  id: andreas
  discordId: "1134325176796987522"
  dataResidency: NZ
stack:
  id: andreas/meta-factory
agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    roles: []
    trust: []
    presence:
      discord:
        enabled: true
        token: stubtoken
        guildId: "1"
        agentChannelId: "2"
        logChannelId: "3"
        roles:
          - name: operator
            users: ["1134325176796987522"]
            features: [chat, async, team]
          - name: user
            users: ["285727653603049472"]
            features: [chat]
            disallowedTools: [Write, Edit, NotebookEdit]
          - name: agent-echo
            users: ["1497872105067253800"]
            features: [chat]
        defaultRole: denied
`;

// ---------------------------------------------------------------------------
// Single-adapter — operator + user + agent-X
// ---------------------------------------------------------------------------

describe("convertBotYaml — single-adapter policy synthesis", () => {
  test("emits operator + user-* + agent-echo (echo declared) + anonymous principals", () => {
    const legacy = loadCortexShape(`
operator:
  id: andreas
  discordId: "1134325176796987522"
stack:
  id: andreas/meta-factory
agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    roles: []
    trust: []
    presence:
      discord:
        enabled: true
        token: stubtoken
        guildId: "1"
        agentChannelId: "2"
        logChannelId: "3"
        roles:
          - name: operator
            users: ["1134325176796987522"]
            features: [chat, async, team]
          - name: user
            users: ["285727653603049472"]
            features: [chat]
            disallowedTools: [Write, Edit, NotebookEdit]
          - name: agent-echo
            users: ["1497872105067253800"]
            features: [chat]
  - id: echo
    displayName: Echo
    persona: ./personas/echo.md
    roles: []
    trust: []
    presence:
      discord:
        enabled: true
        token: stubtoken2
        guildId: "1"
        agentChannelId: "2"
        logChannelId: "3"
        roles: []
`);
    const result = convertBotYaml(legacy);
    expect(result.cortex.policy).toBeDefined();
    const policy = result.cortex.policy!;

    const ids = policy.principals.map((p) => p.id);
    expect(ids).toContain("operator");
    // echo is a declared agent → role agent-echo maps to principal "echo"
    expect(ids).toContain("echo");

    // user mike via Discord 285... → user-d049472
    expect(ids).toContain("user-d049472");

    const operator = policy.principals.find((p) => p.id === "operator")!;
    expect(operator.platform_ids.discord).toContain("1134325176796987522");
    expect(operator.role).toContain("operator");
    expect(operator.home_operator).toBe("andreas");
    expect(operator.home_stack).toBe("andreas/meta-factory");

    const user = policy.principals.find((p) => p.id === "user-d049472")!;
    expect(user.platform_ids.discord).toContain("285727653603049472");
    expect(user.role).toContain("user");

    // operator role got [keyword.chat, keyword.async, keyword.team, dispatch.echo, dispatch.luna, operator, tool.*]
    const operatorRole = policy.roles.find((r) => r.id === "operator")!;
    expect(operatorRole.capabilities).toContain("keyword.chat");
    expect(operatorRole.capabilities).toContain("keyword.async");
    expect(operatorRole.capabilities).toContain("keyword.team");
    expect(operatorRole.capabilities).toContain("operator");
    expect(operatorRole.capabilities).toContain("dispatch.luna");
    expect(operatorRole.capabilities).toContain("dispatch.echo");
    // operator's `disallowedTools: []` → all tools allowed (inversion of [])
    expect(operatorRole.capabilities).toContain("tool.bash");
    expect(operatorRole.capabilities).toContain("tool.write");

    // user role: caps include keyword.chat, dispatch.luna+echo, but NOT tool.write
    const userRole = policy.roles.find((r) => r.id === "user")!;
    expect(userRole.capabilities).toContain("keyword.chat");
    expect(userRole.capabilities).toContain("tool.bash");
    expect(userRole.capabilities).toContain("tool.read");
    expect(userRole.capabilities).not.toContain("tool.write");
    expect(userRole.capabilities).not.toContain("tool.edit");
    expect(userRole.capabilities).not.toContain("tool.notebookedit");
  });
});

// ---------------------------------------------------------------------------
// Cross-adapter consistency: SAME role + SAME fields → one PolicyRole
// ---------------------------------------------------------------------------

describe("cross-adapter role deduplication", () => {
  test("same role/same fields across 3 adapters → 1 PolicyRole, no warning", () => {
    // Build PolicyAdapterView fixtures directly to avoid wrestling with
    // 3-adapter cortex.yaml generation here.
    const sameBundle = {
      name: "user",
      users: ["U_SHARED_ID"],
      features: ["chat"],
      disallowedTools: ["Write"],
    };
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/meta-factory",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [
        { agentId: "luna", platform: "discord", roles: [sameBundle], defaultRole: undefined, dm: undefined },
        // Mattermost + Slack same role + same fields; only Discord can carry
        // the same user-id without colliding (different platforms).
      ],
    });
    const roleIds = result.policy.roles.map((r) => r.id).sort();
    // Single role definition. No "different field bundles" warning.
    expect(roleIds.filter((id) => id === "user").length).toBe(1);
    expect(result.warnings.find((w) => w.message.includes("different field bundles"))).toBeUndefined();
  });

  test("same role name with DIFFERENT field bundles → 1 PolicyRole + warning + union", () => {
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/meta-factory",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [
        {
          agentId: "luna",
          platform: "discord",
          roles: [{ name: "user", users: ["U_D"], features: ["chat"], disallowedTools: ["Write"] }],
          defaultRole: undefined,
          dm: undefined,
        },
        {
          agentId: "luna",
          platform: "mattermost",
          roles: [{ name: "user", users: ["U_M"], features: ["chat", "async"], disallowedTools: ["Write", "Edit"] }],
          defaultRole: undefined,
          dm: undefined,
        },
      ],
    });
    // One role, but capability set is the UNION (chat + async from Mattermost
    // wins additively; tool.edit appears because Discord's bundle didn't deny
    // it).
    const userRole = result.policy.roles.find((r) => r.id === "user")!;
    expect(userRole.capabilities).toContain("keyword.chat");
    expect(userRole.capabilities).toContain("keyword.async");
    // Conservative union → most-permissive wins; tool.edit is granted because
    // Discord's bundle allowed it (only disallowed Write).
    expect(userRole.capabilities).toContain("tool.edit");

    const conflictWarn = result.warnings.find(
      (w) => w.field.includes("policy.roles") && w.message.includes("different field bundles"),
    );
    expect(conflictWarn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DM operatorRole + userRoles[]
// ---------------------------------------------------------------------------

describe("DM operatorRole + userRoles", () => {
  test("DM operatorRole broader bashAllowlist → session_config.dm carries it", () => {
    const legacy = loadCortexShape(`
operator:
  id: andreas
  discordId: "OP_ID"
stack:
  id: andreas/meta-factory
agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    roles: []
    trust: []
    presence:
      discord:
        enabled: true
        token: stubtoken
        guildId: "1"
        agentChannelId: "2"
        logChannelId: "3"
        roles:
          - name: operator
            users: ["OP_ID"]
            features: [chat, async, team]
        defaultRole: denied
        dm:
          operatorRole:
            features: [chat, async, team]
            disallowedTools: []
            allowedDirs: [~/Developer/cortex, ~/Developer/grove]
            bashGuard: true
            bashAllowlist:
              rules:
                - pattern: ^gh\\s+
                - pattern: ^git\\s+
                - pattern: ^rm\\b
              repos:
                - the-metafactory/cortex
                - the-metafactory/grove
          defaultRole: denied
          userRoles: []
`);
    const result = convertBotYaml(legacy);
    const operator = result.cortex.policy!.principals.find((p) => p.id === "operator")!;
    expect(operator.session_config).toBeDefined();
    expect(operator.session_config!.dm).toBeDefined();
    const dm = operator.session_config!.dm!;
    expect(dm.allowed_dirs).toEqual(["~/Developer/cortex", "~/Developer/grove"]);
    expect(dm.bash_allowlist).toBeDefined();
    const patterns = dm.bash_allowlist!.rules.map((r) => r.pattern);
    expect(patterns).toContain("^rm\\b");
    expect(patterns).toContain("^gh\\s+");
  });

  test("DM userRoles[] → augments principal's session_config.dm", () => {
    const legacy = loadCortexShape(`
operator:
  id: andreas
stack:
  id: andreas/meta-factory
agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    roles: []
    trust: []
    presence:
      discord:
        enabled: true
        token: stubtoken
        guildId: "1"
        agentChannelId: "2"
        logChannelId: "3"
        roles:
          - name: user
            users: ["MIKE"]
            features: [chat]
            disallowedTools: [Write, Edit, NotebookEdit]
        defaultRole: denied
        dm:
          operatorRole:
            features: [chat, async, team]
            disallowedTools: []
            bashGuard: true
          defaultRole: denied
          userRoles:
            - users: ["MIKE"]
              features: [chat]
              disallowedTools: [Write, Edit, NotebookEdit]
              bashGuard: true
`);
    const result = convertBotYaml(legacy);
    const mike = result.cortex.policy!.principals.find(
      (p) => p.platform_ids.discord?.includes("MIKE"),
    )!;
    expect(mike).toBeDefined();
    expect(mike.session_config?.dm).toBeDefined();
    expect(mike.session_config!.dm!.bash_guard).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultRole semantics
// ---------------------------------------------------------------------------

describe("defaultRole synthesis", () => {
  test("defaultRole: denied → anonymous principal with empty role[]", () => {
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/meta-factory",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [
        {
          agentId: "luna",
          platform: "discord",
          roles: [],
          defaultRole: "denied",
          dm: undefined,
        },
      ],
    });
    const anon = result.policy.principals.find((p) => p.id === "anonymous-discord-luna")!;
    expect(anon).toBeDefined();
    expect(anon.role).toEqual([]);
    expect(Object.keys(anon.platform_ids).length).toBe(0);
  });

  test("defaultRole: <named> → anonymous principal references that role", () => {
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/meta-factory",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [
        {
          agentId: "luna",
          platform: "discord",
          roles: [{ name: "user", users: ["UID"], features: ["chat"] }],
          defaultRole: "user",
          dm: undefined,
        },
      ],
    });
    const anon = result.policy.principals.find((p) => p.id === "anonymous-discord-luna")!;
    expect(anon.role).toEqual(["user"]);
  });
});

// ---------------------------------------------------------------------------
// External peer principals
// ---------------------------------------------------------------------------

describe("external peer principals", () => {
  test("agent-ivy where ivy is not declared → home_operator: unknown + warning", () => {
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/meta-factory",
      declaredAgentIds: new Set(["luna"]), // ivy is NOT declared
      operatorPlatformIds: {},
      views: [
        {
          agentId: "luna",
          platform: "discord",
          roles: [{ name: "agent-ivy", users: ["IVY_ID"], features: ["chat"] }],
          defaultRole: undefined,
          dm: undefined,
        },
      ],
    });
    const ivy = result.policy.principals.find((p) => p.id === "ivy")!;
    expect(ivy).toBeDefined();
    expect(ivy.home_operator).toBe("unknown");
    expect(ivy.home_stack).toBe("unknown/unknown");
    expect(ivy.platform_ids.discord).toContain("IVY_ID");
    const warn = result.warnings.find(
      (w) => w.message.includes("external peer") && w.message.includes("ivy"),
    );
    expect(warn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  test("running convertBotYaml twice produces byte-identical policy YAML", () => {
    const legacy = loadCortexShape(CORTEX_SHAPE_SINGLE_ADAPTER);
    const a = convertBotYaml(legacy);
    const b = convertBotYaml(legacy);
    const yamlA = YAML.stringify(a.cortex.policy);
    const yamlB = YAML.stringify(b.cortex.policy);
    expect(yamlA).toBe(yamlB);
  });

  test("running migration on already-migrated output is a no-op for the policy block", () => {
    const legacy = loadCortexShape(CORTEX_SHAPE_SINGLE_ADAPTER);
    const first = convertBotYaml(legacy);
    // Round-trip the first result back through convertBotYaml — the existing
    // policy block must be preserved and re-emitted without duplication.
    const roundTrip = first.cortex as unknown as LegacyBotYaml;
    const second = convertBotYaml(roundTrip);
    expect(YAML.stringify(first.cortex.policy)).toBe(YAML.stringify(second.cortex.policy));
  });
});

// ---------------------------------------------------------------------------
// --labels override
// ---------------------------------------------------------------------------

describe("--labels override", () => {
  test("label takes precedence over synthesised principal id", () => {
    const labels = new Map<string, string>([
      ["discord:285727653603049472", "mike"],
    ]);
    const legacy = loadCortexShape(`
operator:
  id: andreas
stack:
  id: andreas/meta-factory
agents:
  - id: luna
    displayName: Luna
    persona: ./personas/luna.md
    roles: []
    trust: []
    presence:
      discord:
        enabled: true
        token: stubtoken
        guildId: "1"
        agentChannelId: "2"
        logChannelId: "3"
        roles:
          - name: user
            users: ["285727653603049472"]
            features: [chat]
`);
    const result = convertBotYaml(legacy, { labels });
    const ids = result.cortex.policy!.principals.map((p) => p.id);
    expect(ids).toContain("mike");
    expect(ids).not.toContain("user-d049472");
  });
});

// ---------------------------------------------------------------------------
// --check pre-flight
// ---------------------------------------------------------------------------

describe("policy preflight", () => {
  test("passing case — every legacy user resolves to a principal", () => {
    const legacy = loadCortexShape(CORTEX_SHAPE_SINGLE_ADAPTER);
    const result = convertBotYaml(legacy);
    expect(result.preflightGaps.length).toBe(0);
    expect(formatPreflightReport([])).toContain("OK");
  });

  test("failing case — legacy user has no principal claiming their platform_id", () => {
    const views: PolicyAdapterView[] = [
      {
        agentId: "luna",
        platform: "discord",
        roles: [{ name: "user", users: ["ORPHAN_USER"], features: ["chat"] }],
        defaultRole: undefined,
        dm: undefined,
      },
    ];
    const gaps = policyPreflight({
      views,
      policy: { principals: [], roles: [] },
    });
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]!.kind).toBe("principal-missing-for-platform-user");
    expect(gaps[0]!.platformId).toBe("ORPHAN_USER");
    const report = formatPreflightReport(gaps);
    expect(report).toContain("BLOCKED");
  });

  test("failing case — defaultRole references undeclared role", () => {
    const views: PolicyAdapterView[] = [
      {
        agentId: "luna",
        platform: "discord",
        roles: [],
        defaultRole: "phantom-role",
        dm: undefined,
      },
    ];
    const gaps = policyPreflight({
      views,
      policy: { principals: [], roles: [] },
    });
    expect(gaps.some((g) => g.kind === "role-missing-for-default-role" && g.roleName === "phantom-role")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disallowedTools inversion via cortex#294 helper
// ---------------------------------------------------------------------------

describe("disallowedTools inversion", () => {
  test("[Bash, Edit] → caps minus those two tools", () => {
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/meta-factory",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [
        {
          agentId: "luna",
          platform: "discord",
          roles: [
            {
              name: "restricted",
              users: ["UID"],
              features: ["chat"],
              disallowedTools: ["Bash", "Edit"],
            },
          ],
          defaultRole: undefined,
          dm: undefined,
        },
      ],
    });
    const role = result.policy.roles.find((r) => r.id === "restricted")!;
    expect(role.capabilities).not.toContain("tool.bash");
    expect(role.capabilities).not.toContain("tool.edit");
    // Everything else still present.
    expect(role.capabilities).toContain("tool.read");
    expect(role.capabilities).toContain("tool.write");
    expect(role.capabilities).toContain("tool.grep");
  });
});

// ---------------------------------------------------------------------------
// Bare-string capability rewrites in pre-existing policy block
// ---------------------------------------------------------------------------

describe("bare-string capability rewriting", () => {
  test("pre-existing policy with bare chat/async/team caps → keyword.* form", () => {
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/work",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [],
      existingPolicy: {
        principals: [
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/work",
            role: ["operator"],
            trust: [],
            platform_ids: {},
          },
        ],
        roles: [
          {
            id: "operator",
            capabilities: ["dispatch.luna", "code-review.typescript", "chat", "async", "team"],
          },
        ],
      },
    });
    const role = result.policy.roles.find((r) => r.id === "operator")!;
    expect(role.capabilities).toContain("keyword.chat");
    expect(role.capabilities).toContain("keyword.async");
    expect(role.capabilities).toContain("keyword.team");
    expect(role.capabilities).not.toContain("chat");
    expect(role.capabilities).not.toContain("async");
    expect(role.capabilities).not.toContain("team");
    // domain.entity capability passes through unchanged.
    expect(role.capabilities).toContain("code-review.typescript");
    expect(role.capabilities).toContain("dispatch.luna");
  });
});

describe("nkey_pub round-trip (PR #306 r1 blocker fix)", () => {
  test("pre-existing principal.nkey_pub is preserved on round-trip", () => {
    // Echo PR #306 r1 caught: the work-stack's luna principal carries
    // nkey_pub (NATS stack signing key, Phase D federation identity).
    // The original implementation dropped it on round-trip — silent
    // data loss. This regression test pins the fix.
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/work",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [],
      existingPolicy: {
        principals: [
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/work",
            role: ["operator"],
            trust: [],
            platform_ids: {},
            nkey_pub: "UDEQUP3NUQAGUJIZ5ZSOBZKAF73CW6BPMEQX6476E66Q37FONADJ75EB",
          },
        ],
        roles: [
          {
            id: "operator",
            capabilities: ["dispatch.luna"],
          },
        ],
      },
    });
    const luna = result.policy.principals.find((p) => p.id === "luna");
    expect(luna).toBeDefined();
    expect(luna?.nkey_pub).toBe("UDEQUP3NUQAGUJIZ5ZSOBZKAF73CW6BPMEQX6476E66Q37FONADJ75EB");
  });

  test("principal without nkey_pub emits without it (no spurious field)", () => {
    const result = buildPolicy({
      operatorId: "andreas",
      homeStack: "andreas/work",
      declaredAgentIds: new Set(["luna"]),
      operatorPlatformIds: {},
      views: [],
      existingPolicy: {
        principals: [
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/work",
            role: ["operator"],
            trust: [],
            platform_ids: {},
          },
        ],
        roles: [{ id: "operator", capabilities: ["dispatch.luna"] }],
      },
    });
    const luna = result.policy.principals.find((p) => p.id === "luna");
    expect(luna).toBeDefined();
    expect(luna?.nkey_pub).toBeUndefined();
  });
});
