/**
 * IAW CFG.c — `surfaces.yaml` layer + the binding fold.
 *
 * CFG.c moves the per-platform surface bindings (Discord/Slack/Mattermost
 * `token`, `guild`, channel/instance bindings) out of each stack's
 * `agents[*].presence.{platform}` block into a top-level `surfaces.yaml` layer
 * — the file the shared surface gateway (GW) consumes. It is a source-layout
 * change, not a runtime-shape change: `LoadedConfig` is byte-identical and the
 * per-stack adapters keep working unchanged.
 *
 * These tests prove:
 *
 *   (CFG.c.4 round-trip) bindings-in-surfaces.yaml resolve to the SAME
 *     effective `LoadedConfig` (presence/binding view) as bindings-in-per-stack
 *     presence — same tokens/guilds/channels resolved, for all three platforms;
 *
 *   (CFG.c.4 schema) `surfaces.yaml` validates required binding fields — a
 *     binding missing `token` (Discord) / `botToken` (Slack) / `apiToken`
 *     (Mattermost) fails loudly at load;
 *
 *   (CFG.c.2 fallback) a config with NO surfaces.yaml (per-stack presence only
 *     — the three live-deployment shape) loads unchanged, fold is a no-op;
 *
 *   (design fork) when BOTH surfaces.yaml AND inline per-stack presence carry
 *     the same platform, the surfaces.yaml binding wins on leaf keys (it is the
 *     credential surface-of-truth) while inline non-binding knobs survive;
 *
 *   (loud failure) a binding naming an unknown agent fails loudly rather than
 *     silently dropping a credential.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
import { z } from "zod/v4";
import { loadConfigWithAgents } from "../loader";
import { foldSurfaceBindings, SurfacesSchema } from "../../types/surfaces";
import {
  createDefaultSurfacePluginRegistry,
  validateSurfacesAgainstRegistry,
  type AdapterPlugin,
} from "../../../adapters/registry";
import { stringBindingField } from "../../../adapters/plugin-support";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `cortex-surfaces-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** The substrate blocks (system.yaml layer — needed for the directory layout). */
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

const DISCORD_BINDING = {
  token: "fake-token-ivy",
  guildId: "111111111111111111",
  agentChannelId: "999999999999999999",
  logChannelId: "1111111111111111111",
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

/**
 * cortex#1795 (S10 MOVE) — slack's `bindingSchema` extracted to the
 * `metafactory-cortex-adapter-slack` bundle's `src/schema.ts`
 * (`SlackBindingSchema`); it's no longer importable here. Reproduced
 * field-for-field/regex-for-regex so `validateSurfacesAgainstRegistry`
 * (the REGISTRY pass a `surfaces.slack[]` binding validates through
 * post-extraction — see `common/types/surfaces.ts`'s module doc) still
 * catches a malformed token in THIS test suite, exactly as the in-tree
 * plugin did before the move.
 */
const testSlackBindingSchema = z
  .object({
    botToken: z.string().regex(/^xoxb-/, "surfaces.slack[].binding.botToken must be a bot user OAuth token (xoxb-...)"),
    appToken: z.string().regex(/^xapp-/, "surfaces.slack[].binding.appToken must be an app-level token (xapp-...)"),
    workspaceId: z.coerce.string().regex(/^T[A-Z0-9]{8,16}$/, "surfaces.slack[].binding.workspaceId must be a Slack team id"),
  })
  .catchall(z.unknown());

const testSlackAdapterPluginStub: AdapterPlugin = {
  kind: "adapter",
  id: "slack",
  platform: "slack",
  bindingSchema: testSlackBindingSchema,
  foldsIntoPresence: true,
  secretFields: ["botToken", "appToken"],
  demuxKey: (binding) => stringBindingField(binding, "workspaceId"),
  buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
  createAdapter: () => {
    throw new Error("testSlackAdapterPluginStub — never constructed in loader tests");
  },
};

/** In-tree default (discord/mattermost) plus a slack stub, for tests that
 *  exercise `surfaces.slack[]` post-cortex#1795 (S10 MOVE). */
function testRegistryWithSlack() {
  const registry = createDefaultSurfacePluginRegistry();
  registry.registerAdapter(testSlackAdapterPluginStub);
  return registry;
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

/** Stack with NO bindings in presence — they live in surfaces.yaml instead. */
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

/** surfaces.yaml carrying the same bindings the inline stack carried. */
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

function writeSingleFile(dir: string, config: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cortex.yaml");
  // TC-4a (cortex#636): single-file config read enforces chmod 600 (it
  // carries platform bot tokens). Write 0600 so the gate passes.
  writeFileSync(path, stringify(config), { mode: 0o600 });
  return path;
}

/** Write system/ + surfaces/ + stacks/ layout; return the conventional path. */
function writeSurfacesLayout(
  dir: string,
  system: Record<string, unknown>,
  surfaces: Record<string, unknown>,
  stack: Record<string, unknown>,
): string {
  mkdirSync(join(dir, "system"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), stringify(system));
  mkdirSync(join(dir, "surfaces"), { recursive: true });
  // surfaces.yaml's top-level key is `surfaces:` — write the block verbatim.
  writeFileSync(join(dir, "surfaces", "surfaces.yaml"), stringify(surfaces));
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "stacks", "research.yaml"), stringify(stack));
  return join(dir, "cortex.yaml");
}

// ---------------------------------------------------------------------------
// CFG.c.4 — round-trip: surfaces.yaml resolves to the SAME effective view as
// inline per-stack presence (same tokens/guilds/channels for all 3 platforms)
// ---------------------------------------------------------------------------

describe("CFG.c.4 — surfaces.yaml round-trips to the same effective presence/binding view", () => {
  test("split layout (system + surfaces + stack) == inline single-file LoadedConfig", () => {
    // Inline baseline: single file with bindings in per-stack presence.
    const inlineFull = { ...systemBlocks(), ...stackInline() };
    const inlinePath = writeSingleFile(join(testDir, "inline"), inlineFull);

    // surfaces.yaml form: bindings live in surfaces.yaml, presence is empty.
    const splitPath = writeSurfacesLayout(
      join(testDir, "split"),
      systemBlocks(),
      surfacesBlock(),
      stackNoBindings(),
    );

    // cortex#1795/#1796 (S10/S11 MOVE) — splitPath's surfaces.yaml carries
    // slack[] and mattermost[] bindings; neither is in the in-tree default
    // registry any more, but `loadConfigWithAgents` no longer needs a
    // caller-supplied registry to admit them — `parseSurfaces`'s internal
    // `surfacesParseRegistry()` (loader.ts) structurally admits every
    // `EXTRACTED_ADAPTER_PLATFORMS` entry at load time (see that function's
    // doc — this is the cortex#1796 review-fix generalized to cover slack
    // too).
    const inline = loadConfigWithAgents(inlinePath);
    const split = loadConfigWithAgents(splitPath);

    // Fold-output identity — the move is a source-layout change, not a
    // runtime-shape change. The split config additionally carries `surfaces`
    // (the validated binding map captured before foldSurfaceBindings drops the
    // top-level key — GW.a.3b.2a, cortex#524); the inline config does not have
    // a `surfaces:` key in its input, so `inline.surfaces` is undefined. The
    // fold output (agents presence + flattened adapter arrays) is unchanged.
    expect(split.config).toEqual(inline.config);
    expect(split.inlineAgents).toEqual(inline.inlineAgents);
    expect(split.principal).toEqual(inline.principal);
    expect(split.stack).toEqual(inline.stack);
    expect(split.policy).toEqual(inline.policy);
    expect(split.bus).toEqual(inline.bus);

    // Spell out the resolved binding view per platform so a regression names
    // the exact platform that drifted. The effective view consumers read is
    // (a) inlineAgents[*].presence (cortex.ts per-presence-token wiring) and
    // (b) the flattened config.{discord,slack,mattermost} arrays (adapters).
    const ivy = split.inlineAgents[0]!;
    expect(ivy.presence.discord?.token).toBe(DISCORD_BINDING.token);
    expect(ivy.presence.discord?.guildId).toBe(DISCORD_BINDING.guildId);
    expect(ivy.presence.slack?.botToken).toBe(SLACK_BINDING.botToken);
    expect(ivy.presence.slack?.workspaceId).toBe(SLACK_BINDING.workspaceId);
    expect(ivy.presence.mattermost?.apiToken).toBe(MATTERMOST_BINDING.apiToken);

    // Flattened adapter arrays — same tokens/guilds resolved.
    expect(split.config.discord[0]?.token).toBe(DISCORD_BINDING.token);
    expect(split.config.discord[0]?.guildId).toBe(DISCORD_BINDING.guildId);
    expect(split.config.slack[0]?.botToken).toBe(SLACK_BINDING.botToken);
    expect(split.config.mattermost[0]?.apiToken).toBe(MATTERMOST_BINDING.apiToken);
  });

  test("inline-single-file baseline and split agree on the flattened instanceIds", () => {
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
    // cortex#1795/#1796 (S10/S11 MOVE) — splitPath's surfaces.yaml carries
    // slack[] and mattermost[] bindings; neither is in the in-tree default
    // registry any more, but `loadConfigWithAgents` no longer needs a
    // caller-supplied registry to admit them — `parseSurfaces`'s internal
    // `surfacesParseRegistry()` (loader.ts) structurally admits every
    // `EXTRACTED_ADAPTER_PLATFORMS` entry at load time (see that function's
    // doc — this is the cortex#1796 review-fix generalized to cover slack
    // too).
    const inline = loadConfigWithAgents(inlinePath);
    const split = loadConfigWithAgents(splitPath);
    expect(split.config.discord.map((d) => d.instanceId)).toEqual(
      inline.config.discord.map((d) => d.instanceId),
    );
  });
});

// ---------------------------------------------------------------------------
// CFG.c.2 — fallback: a config with NO surfaces.yaml loads unchanged
// (the three live-deployment shape; per-stack presence is the fallback)
// ---------------------------------------------------------------------------

describe("CFG.c.2 — no surfaces.yaml → per-stack presence is the fallback (fold is a no-op)", () => {
  test("single-file inline config with no surfaces key loads unchanged", () => {
    const path = writeSingleFile(join(testDir, "live"), {
      ...systemBlocks(),
      ...stackInline(),
    });
    const loaded = loadConfigWithAgents(path);
    expect(loaded.inlineAgents[0]!.presence.discord?.token).toBe(DISCORD_BINDING.token);
    expect(loaded.config.discord[0]?.token).toBe(DISCORD_BINDING.token);
  });

  test("foldSurfaceBindings returns input untouched when no surfaces key present", () => {
    const raw = { ...stackInline() };
    const folded = foldSurfaceBindings(raw);
    // Same effective agents shape (no surfaces key was present to fold).
    expect(folded.agents).toEqual(raw.agents);
    expect("surfaces" in folded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CFG.c.4 — schema validates required binding fields (loud failure)
// ---------------------------------------------------------------------------

describe("CFG.c.4 — surfaces.yaml schema validates required binding fields", () => {
  test("Discord binding missing token fails loudly", () => {
    expect(() =>
      SurfacesSchema.parse({
        discord: [{ agent: "ivy", binding: { guildId: "1", agentChannelId: "2", logChannelId: "3" } }],
      }),
    ).toThrow();
  });

  test("Slack binding with a non-xoxb botToken fails loudly", () => {
    // cortex#1795 (S10 MOVE) — slack's binding SCHEMA is no longer part of
    // the STRUCTURAL pass (`SurfacesSchema` — it fell to the generic
    // catchall, see that schema's module doc); the botToken-prefix
    // enforcement now lives in the REGISTRY pass, against the bundle's own
    // `bindingSchema`. Assert via `validateSurfacesAgainstRegistry` instead
    // of a bare `SurfacesSchema.parse` — same loud-failure contract, correct
    // layer post-extraction.
    const surfaces = SurfacesSchema.parse({
      slack: [{ agent: "ivy", binding: { botToken: "nope", appToken: "xapp-x", workspaceId: "T01234567" } }],
    });
    expect(() => validateSurfacesAgainstRegistry(surfaces, testRegistryWithSlack())).toThrow();
  });

  // cortex#1796 (S11 MOVE) — "Mattermost binding missing apiToken fails
  // loudly" moved: `mattermost` is no longer one of `SurfacesSchema`'s
  // hardcoded per-platform schemas (same as `web`, cortex#1794 S9 MOVE), so
  // `SurfacesSchema.parse` alone (the STRUCTURAL pass) no longer rejects a
  // mattermost binding missing `apiToken` — it validates generically now.
  // The REAL per-field check happens at the REGISTRY pass, against the
  // bundle-loaded plugin's own `bindingSchema` — see
  // `loader.mattermost-bundle.test.ts`'s "validateSurfacesAgainstRegistry
  // accepts a valid surfaces.mattermost[] entry … and rejects an invalid
  // one" for the equivalent (now registry-pass) coverage.

  test("unknown top-level platform key structurally parses (cortex#1789, S4)", () => {
    // cortex#1789 (S4, ADR-0024 D5) — `SurfacesSchema` alone is now only the
    // STRUCTURAL pass; it admits any top-level key shaped like
    // `{agent, stack?, binding}`. The typo guard moved to the REGISTRY pass
    // — see the next test, which drives the SAME input through
    // `loadConfigWithAgents` (the real load path, which runs the registry
    // check via `parseSurfaces`) and confirms it still fails loudly.
    expect(() =>
      SurfacesSchema.parse({
        discrod: [{ agent: "ivy", binding: { ...DISCORD_BINDING } }],
      }),
    ).not.toThrow();
  });

  test("unknown top-level platform key fails loudly at load (typo guard, registry pass)", () => {
    const path = writeSurfacesLayout(
      join(testDir, "typo"),
      systemBlocks(),
      { surfaces: { discrod: [{ agent: "ivy", binding: { ...DISCORD_BINDING } }] } },
      stackNoBindings(),
    );
    expect(() => loadConfigWithAgents(path)).toThrow(/no adapter installed for platform "discrod"/);
  });

  test("malformed surfaces.yaml fails at load via the composer", () => {
    const path = writeSurfacesLayout(
      join(testDir, "bad"),
      systemBlocks(),
      { surfaces: { discord: [{ agent: "ivy", binding: { guildId: "1" } }] } },
      stackNoBindings(),
    );
    expect(() => loadConfigWithAgents(path)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Design fork — surfaces.yaml binding wins over inline presence on leaf keys;
// inline non-binding knobs survive
// ---------------------------------------------------------------------------

describe("CFG.c design fork — surfaces.yaml binding precedence over inline presence", () => {
  test("surfaces.yaml binding wins on leaf keys; inline non-binding knobs survive", () => {
    // Stack carries an inline discord presence with an OLD token + a
    // non-binding knob (contextDepth). surfaces.yaml supplies the NEW token.
    const stack = {
      principal: { id: "andreas", displayName: "Andreas" },
      agents: [
        {
          id: "ivy",
          displayName: "Ivy",
          persona: "./personas/ivy.md",
          roles: [],
          trust: [],
          presence: {
            discord: {
              token: "OLD-inline-token",
              guildId: DISCORD_BINDING.guildId,
              agentChannelId: DISCORD_BINDING.agentChannelId,
              logChannelId: DISCORD_BINDING.logChannelId,
              contextDepth: 42,
            },
          },
        },
      ],
    };
    const surfaces = {
      surfaces: {
        discord: [{ agent: "ivy", binding: { ...DISCORD_BINDING, token: "NEW-surfaces-token" } }],
      },
    };
    const path = writeSurfacesLayout(join(testDir, "fork"), systemBlocks(), surfaces, stack);
    const loaded = loadConfigWithAgents(path);
    // surfaces.yaml token wins.
    expect(loaded.inlineAgents[0]!.presence.discord?.token).toBe("NEW-surfaces-token");
    // inline non-binding knob survives the merge.
    expect(loaded.inlineAgents[0]!.presence.discord?.contextDepth).toBe(42);
  });

  test("binding naming an unknown agent fails loudly", () => {
    const path = writeSurfacesLayout(
      join(testDir, "unknown"),
      systemBlocks(),
      { surfaces: { discord: [{ agent: "ghost", binding: { ...DISCORD_BINDING } }] } },
      stackNoBindings(),
    );
    expect(() => loadConfigWithAgents(path)).toThrow(/names agent "ghost"/);
  });
});

// ---------------------------------------------------------------------------
// Idempotence — folding twice yields the same object
// ---------------------------------------------------------------------------

describe("CFG.c — foldSurfaceBindings is pure + idempotent", () => {
  test("folding the same raw twice yields equal results and does not mutate input", () => {
    const raw = { ...stackNoBindings(), ...surfacesBlock() };
    const snapshot = structuredClone(raw);
    const once = foldSurfaceBindings(raw);
    const twiceInput = { ...stackNoBindings(), ...surfacesBlock() };
    const twice = foldSurfaceBindings(twiceInput);
    expect(once).toEqual(twice);
    // Input not mutated (surfaces key still present on the original).
    expect(raw).toEqual(snapshot);
  });
});
