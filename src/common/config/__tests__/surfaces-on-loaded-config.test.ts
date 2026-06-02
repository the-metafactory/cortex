/**
 * GW.a.3b.2a — `LoadedConfig.surfaces` exposure (cortex#524).
 *
 * `loadConfigWithAgents` must now populate `LoadedConfig.surfaces` with the
 * validated `Surfaces` binding map when the input declared a `surfaces:` block
 * (via `surfaces/surfaces.yaml` in a directory layout, or inline in a single
 * file). Configs with NO surfaces yield `surfaces: undefined`.
 *
 * These tests prove:
 *
 *   (GW.3b.2a.1) a directory layout WITH surfaces.yaml → `LoadedConfig.surfaces`
 *     carries the validated `Surfaces` object (binding contents correct); AND the
 *     folded `agents[*].presence` shape is still correct (byte-identical fold —
 *     the same tokens/guilds/channels are present as when the bindings lived
 *     inline in per-stack presence).
 *
 *   (GW.3b.2a.2) a config WITHOUT surfaces (neither surfaces.yaml nor an inline
 *     `surfaces:` key) → `LoadedConfig.surfaces === undefined` AND the
 *     existing agents presence shape is unchanged.
 *
 *   (GW.3b.2a.3) a single-file cortex.yaml WITH an inline `surfaces:` block →
 *     `LoadedConfig.surfaces` is populated (single-file path is symmetric with
 *     the directory-layout path per CFG.a / CFG.c design).
 *
 *   (GW.3b.2a.4) the fold output is byte-identical regardless of whether
 *     surfaces arrive via directory layout or inline. The presence/binding view
 *     every existing consumer sees must not change.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
import { loadConfigWithAgents } from "../loader";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `cortex-surfaces-loadedconfig-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const DISCORD_BINDING = {
  token: "fake-token-ivy",
  guildId: "1487023327791808592",
  agentChannelId: "1487029848164536361",
  logChannelId: "1487029942129524786",
};

const SLACK_BINDING = {
  botToken: "xoxb-fake-bot-token",
  appToken: "xapp-fake-app-token",
  workspaceId: "T0123456789",
};

const MATTERMOST_BINDING = {
  apiUrl: "https://mm.example.com",
  apiToken: "fake-mm-token",
};

/** The substrate blocks needed by cortex-shape loader (system.yaml layer). */
function systemBlocks(): Record<string, unknown> {
  return {
    claude: { timeoutMs: 300000, asyncTimeoutMs: 900000, disallowedTools: ["Write"] },
    execution: { default: "local", backends: [] },
    attachments: {
      enabled: true,
      maxFileSizeBytes: 10485760,
      maxTotalSizeBytes: 26214400,
      maxAttachmentsPerMessage: 10,
    },
    paths: { publishedEventsDir: "/tmp/events/published", logDir: "/tmp/cortex/logs" },
    nats: {
      url: "nats://127.0.0.1:4222",
      name: "cortex",
      subjects: [],
      identity: {
        seedPath: "/tmp/cortex.nk",
        publicKey: "UD7OGEVBNJAUQ57H5NHSPJZOKKOXOZ4DEUJVAO5URHBIUAVSVTJGL4QV",
      },
    },
    bus: {
      review: {
        stream: { name: "CODE_REVIEW", maxAgeSeconds: 86400, maxBytes: 536870912 },
        consumer: { maxDeliver: 5 },
      },
    },
  };
}

/** Stack with NO surface bindings in per-stack presence (bindings live in surfaces.yaml). */
function stackNoBindings(): Record<string, unknown> {
  return {
    principal: { id: "andreas", displayName: "Andreas" },
    agents: [
      {
        id: "ivy",
        displayName: "Ivy",
        persona: "./personas/ivy.md",
        roles: [],
        trust: [],
        presence: {},
      },
    ],
  };
}

/** Stack with bindings INLINE in per-stack presence (the pre-CFG.c shape). */
function stackInline(): Record<string, unknown> {
  return {
    principal: { id: "andreas", displayName: "Andreas" },
    agents: [
      {
        id: "ivy",
        displayName: "Ivy",
        persona: "./personas/ivy.md",
        roles: [],
        trust: [],
        presence: {
          discord: { ...DISCORD_BINDING },
          slack: { ...SLACK_BINDING },
          mattermost: { ...MATTERMOST_BINDING },
        },
      },
    ],
  };
}

/** The `surfaces:` block carrying all three platform bindings. */
function surfacesBlock(): Record<string, unknown> {
  return {
    surfaces: {
      discord: [{ agent: "ivy", stack: "andreas/research", binding: { ...DISCORD_BINDING } }],
      slack: [{ agent: "ivy", stack: "andreas/research", binding: { ...SLACK_BINDING } }],
      mattermost: [
        { agent: "ivy", stack: "andreas/research", binding: { ...MATTERMOST_BINDING } },
      ],
    },
  };
}

/** Write a single-file cortex.yaml in `dir`, return its path. */
function writeSingleFile(dir: string, config: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cortex.yaml");
  writeFileSync(path, stringify(config));
  return path;
}

/**
 * Write a directory layout: system/ + surfaces/ + stacks/. Returns the
 * conventional `cortex.yaml` path (the directory marker is what selects the
 * layout — cortex.yaml itself need not exist).
 */
function writeSurfacesLayout(
  dir: string,
  system: Record<string, unknown>,
  surfaces: Record<string, unknown>,
  stack: Record<string, unknown>,
): string {
  mkdirSync(join(dir, "system"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), stringify(system));
  mkdirSync(join(dir, "surfaces"), { recursive: true });
  writeFileSync(join(dir, "surfaces", "surfaces.yaml"), stringify(surfaces));
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "stacks", "research.yaml"), stringify(stack));
  return join(dir, "cortex.yaml");
}

// ---------------------------------------------------------------------------
// GW.3b.2a.1 — directory layout WITH surfaces.yaml: LoadedConfig.surfaces
// is populated AND the fold output is byte-identical
// ---------------------------------------------------------------------------

describe("GW.3b.2a.1 — directory layout with surfaces.yaml populates LoadedConfig.surfaces", () => {
  test("LoadedConfig.surfaces carries the validated binding map (all three platforms)", () => {
    const path = writeSurfacesLayout(
      join(testDir, "layout"),
      systemBlocks(),
      surfacesBlock(),
      stackNoBindings(),
    );
    const loaded = loadConfigWithAgents(path);

    // surfaces must be defined and carry the validated binding map.
    expect(loaded.surfaces).toBeDefined();
    const surfaces = loaded.surfaces!;

    // Discord binding contents correct.
    expect(surfaces.discord).toHaveLength(1);
    expect(surfaces.discord![0]!.agent).toBe("ivy");
    expect(surfaces.discord![0]!.stack).toBe("andreas/research");
    expect(surfaces.discord![0]!.binding.token).toBe(DISCORD_BINDING.token);
    expect(surfaces.discord![0]!.binding.guildId).toBe(DISCORD_BINDING.guildId);
    expect(surfaces.discord![0]!.binding.agentChannelId).toBe(DISCORD_BINDING.agentChannelId);
    expect(surfaces.discord![0]!.binding.logChannelId).toBe(DISCORD_BINDING.logChannelId);

    // Slack binding contents correct.
    expect(surfaces.slack).toHaveLength(1);
    expect(surfaces.slack![0]!.agent).toBe("ivy");
    expect(surfaces.slack![0]!.binding.botToken).toBe(SLACK_BINDING.botToken);
    expect(surfaces.slack![0]!.binding.appToken).toBe(SLACK_BINDING.appToken);
    expect(surfaces.slack![0]!.binding.workspaceId).toBe(SLACK_BINDING.workspaceId);

    // Mattermost binding contents correct.
    expect(surfaces.mattermost).toHaveLength(1);
    expect(surfaces.mattermost![0]!.agent).toBe("ivy");
    expect(surfaces.mattermost![0]!.binding.apiUrl).toBe(MATTERMOST_BINDING.apiUrl);
    expect(surfaces.mattermost![0]!.binding.apiToken).toBe(MATTERMOST_BINDING.apiToken);
  });

  test("fold output is byte-identical: agents[*].presence has the correct bindings", () => {
    // Verify the fold is still correct: inlineAgents[0].presence must carry
    // the bindings that surfaces.yaml declared, after the fold.
    const path = writeSurfacesLayout(
      join(testDir, "fold-check"),
      systemBlocks(),
      surfacesBlock(),
      stackNoBindings(),
    );
    const loaded = loadConfigWithAgents(path);

    // inlineAgents presence shape (the consumer cortex.ts reads).
    const ivy = loaded.inlineAgents[0]!;
    expect(ivy.presence.discord?.token).toBe(DISCORD_BINDING.token);
    expect(ivy.presence.discord?.guildId).toBe(DISCORD_BINDING.guildId);
    expect(ivy.presence.slack?.botToken).toBe(SLACK_BINDING.botToken);
    expect(ivy.presence.mattermost?.apiToken).toBe(MATTERMOST_BINDING.apiToken);

    // Flattened adapter arrays (the shape adapters read).
    expect(loaded.config.discord[0]?.token).toBe(DISCORD_BINDING.token);
    expect(loaded.config.discord[0]?.guildId).toBe(DISCORD_BINDING.guildId);
    expect(loaded.config.slack[0]?.botToken).toBe(SLACK_BINDING.botToken);
    expect(loaded.config.mattermost[0]?.apiToken).toBe(MATTERMOST_BINDING.apiToken);
  });

  test("fold byte-identity: presence/binding view equals the inline (pre-CFG.c) shape", () => {
    // The fold-then-expose path must produce the SAME presence/binding view as
    // a config that carries bindings directly in per-stack presence (inline).
    // This proves byte-identity of the fold output across both ingestion paths.
    const inlinePath = writeSingleFile(join(testDir, "inline"), {
      ...systemBlocks(),
      ...stackInline(),
    });
    const splitPath = writeSurfacesLayout(
      join(testDir, "split"),
      systemBlocks(),
      surfacesBlock(),
      stackNoBindings(),
    );

    const inline = loadConfigWithAgents(inlinePath);
    const split = loadConfigWithAgents(splitPath);

    // The fold-output fields (the only ones downstream consumers read) must
    // be equal. The split config additionally carries `surfaces` (the inline
    // config does not, since it has no `surfaces:` key) — that is the ONLY
    // difference, and it is intentional (GW.a.3b.2a exposes the binding map).
    expect(split.config).toEqual(inline.config);
    expect(split.inlineAgents).toEqual(inline.inlineAgents);
    expect(split.principal).toEqual(inline.principal);
    expect(split.stack).toEqual(inline.stack);
    expect(split.policy).toEqual(inline.policy);
    expect(split.bus).toEqual(inline.bus);

    // The split config has surfaces; the inline config does not.
    expect(split.surfaces).toBeDefined();
    expect(inline.surfaces).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GW.3b.2a.2 — config WITHOUT surfaces: surfaces === undefined, fold unchanged
// ---------------------------------------------------------------------------

describe("GW.3b.2a.2 — config without surfaces: LoadedConfig.surfaces is undefined", () => {
  test("single-file inline config (no surfaces key): surfaces is undefined", () => {
    const path = writeSingleFile(join(testDir, "no-surfaces"), {
      ...systemBlocks(),
      ...stackInline(),
    });
    const loaded = loadConfigWithAgents(path);
    expect(loaded.surfaces).toBeUndefined();
  });

  test("directory layout with no surfaces.yaml: surfaces is undefined", () => {
    // Write a layout without surfaces/ directory.
    const dir = join(testDir, "no-surfaces-layout");
    mkdirSync(join(dir, "system"), { recursive: true });
    writeFileSync(
      join(dir, "system", "system.yaml"),
      stringify({ ...systemBlocks(), ...stackInline() }),
    );
    const loaded = loadConfigWithAgents(join(dir, "cortex.yaml"));
    expect(loaded.surfaces).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GW.3b.2a.3 — single-file cortex.yaml WITH inline surfaces: block:
// LoadedConfig.surfaces is populated (single-file path is symmetric)
// ---------------------------------------------------------------------------

describe("GW.3b.2a.3 — single-file cortex.yaml with inline surfaces: block", () => {
  test("inline surfaces block in single file populates LoadedConfig.surfaces", () => {
    // A single cortex.yaml may carry an inline `surfaces:` block. The
    // single-file fallback path must be symmetric with the directory-layout path.
    const path = writeSingleFile(join(testDir, "inline-surfaces"), {
      ...systemBlocks(),
      ...stackNoBindings(),
      ...surfacesBlock(),
    });
    const loaded = loadConfigWithAgents(path);

    expect(loaded.surfaces).toBeDefined();
    expect(loaded.surfaces!.discord).toHaveLength(1);
    expect(loaded.surfaces!.discord![0]!.binding.token).toBe(DISCORD_BINDING.token);
    expect(loaded.surfaces!.slack).toHaveLength(1);
    expect(loaded.surfaces!.slack![0]!.binding.botToken).toBe(SLACK_BINDING.botToken);
    expect(loaded.surfaces!.mattermost).toHaveLength(1);
    expect(loaded.surfaces!.mattermost![0]!.binding.apiToken).toBe(MATTERMOST_BINDING.apiToken);

    // Fold is still correct: bindings folded into presence.
    expect(loaded.inlineAgents[0]!.presence.discord?.token).toBe(DISCORD_BINDING.token);
    expect(loaded.config.discord[0]?.token).toBe(DISCORD_BINDING.token);
  });
});

// ---------------------------------------------------------------------------
// GW.3b.2a.4 — legacy bot.yaml input: surfaces is undefined (not applicable)
// ---------------------------------------------------------------------------

describe("GW.3b.2a.4 — legacy bot.yaml input: surfaces is always undefined", () => {
  test("legacy bot.yaml (no principal/agents, no surfaces): surfaces is undefined", () => {
    // Legacy input has no principal: / agents: blocks — takes the legacy path.
    // surfaces: would be meaningless on legacy input; must yield undefined.
    const dir = join(testDir, "legacy");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "bot.yaml");
    writeFileSync(
      path,
      stringify({
        agent: { name: "test-bot", displayName: "TestBot" },
        claude: { timeoutMs: 120000 },
        networksDir: "./networks",
      }),
    );
    const loaded = loadConfigWithAgents(path);
    expect(loaded.surfaces).toBeUndefined();
  });
});
