/**
 * IAW CFG.b — `system.yaml` substrate layer + the `nats.subjects` landmine.
 *
 * CFG.b makes the composer's base layer real: the cross-cutting machine config
 * (`claude`, `execution`, `attachments`, `paths`, `nats`, `bus`) can live in
 * `system/system.yaml`, and `nats.subjects` is isolated there as the single
 * place subject overrides live. These tests prove:
 *
 *   (CFG.b.3a) a layout with `system.yaml` present resolves
 *     `nats` / `bus` / `paths` / `claude` / `execution` IDENTICALLY to the
 *     equivalent pre-split single file (round-trip fidelity of the substrate
 *     slots — not just structural composition but the loaded `LoadedConfig`
 *     view consumers read);
 *
 *   (CFG.b.3b) a malformed `nats.subjects` block fails LOUDLY at load — a clear
 *     error, not a silent partial config that would double-publish. "Malformed"
 *     covers both a syntactically-invalid pattern AND a duplicate pattern (the
 *     double-bind footgun behind the double-message problem).
 *
 * Fixtures are small synthetic configs in a tmp dir; the repo's documented
 * reference layout (docs/config-layout/) is loaded separately to prove it is a
 * valid, composable example.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
import { loadConfigWithAgents } from "../loader";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `cortex-systemlayer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

/** The substrate blocks CFG.b.1 moves into system.yaml. */
function systemBlocks(overrides?: { subjects?: unknown }): Record<string, unknown> {
  return {
    claude: {
      timeoutMs: 300000,
      asyncTimeoutMs: 900000,
      disallowedTools: ["Write"],
    },
    execution: { default: "local", backends: [] },
    attachments: {
      enabled: true,
      maxFileSizeBytes: 10485760,
      maxTotalSizeBytes: 26214400,
      maxAttachmentsPerMessage: 10,
    },
    paths: {
      publishedEventsDir: "/tmp/events/published",
      logDir: "/tmp/cortex/logs",
    },
    nats: {
      url: "nats://127.0.0.1:4222",
      name: "cortex",
      subjects: overrides?.subjects ?? [],
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

/** The per-stack blocks (principal + agents) that live in stacks/*.yaml. */
function stackBlocks(): Record<string, unknown> {
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
          discord: {
            token: "fake-token-ivy",
            guildId: "111111111111111111",
            agentChannelId: "999999999999999999",
            logChannelId: "1111111111111111111",
          },
        },
      },
    ],
  };
}

function writeSingleFile(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, "cortex.yaml");
  // TC-4a (cortex#636): single-file config read enforces chmod 600 (it
  // carries platform bot tokens). Write 0600 so the gate passes.
  writeFileSync(path, stringify(config), { mode: 0o600 });
  return path;
}

/** Write a `system/` + `stacks/` layout and return the conventional path. */
function writeSystemLayout(
  dir: string,
  system: Record<string, unknown>,
  stack: Record<string, unknown>,
): string {
  mkdirSync(join(dir, "system"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), stringify(system));
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "stacks", "research.yaml"), stringify(stack));
  return join(dir, "cortex.yaml");
}

// ---------------------------------------------------------------------------
// CFG.b.3 (a) — split with system.yaml resolves substrate slots identically
// ---------------------------------------------------------------------------

describe("CFG.b.3a — system.yaml split resolves substrate slots identically to single file", () => {
  test("nats / bus / paths / claude / execution match the equivalent single file", () => {
    const full = { ...systemBlocks(), ...stackBlocks() };

    const singleDir = join(testDir, "single");
    mkdirSync(singleDir, { recursive: true });
    const singlePath = writeSingleFile(singleDir, full);

    const splitDir = join(testDir, "split");
    mkdirSync(splitDir, { recursive: true });
    const splitPath = writeSystemLayout(splitDir, systemBlocks(), stackBlocks());

    const single = loadConfigWithAgents(singlePath);
    const split = loadConfigWithAgents(splitPath);

    // Whole-LoadedConfig identity is the strongest assertion.
    expect(split).toEqual(single);

    // Spell out each substrate slot CFG.b.1 moved into system.yaml so a
    // regression names the exact slot that drifted.
    expect(split.config.nats).toEqual(single.config.nats);
    expect(split.config.paths).toEqual(single.config.paths);
    expect(split.config.claude).toEqual(single.config.claude);
    expect(split.config.execution).toEqual(single.config.execution);
    expect(split.config.attachments).toEqual(single.config.attachments);
    expect(split.bus).toEqual(single.bus);

    // And confirm the values actually came through (not both-undefined).
    expect(split.config.nats?.url).toBe("nats://127.0.0.1:4222");
    expect(split.config.paths?.publishedEventsDir).toBe("/tmp/events/published");
    expect(split.bus?.review.consumer.maxDeliver).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// CFG.b.3 (b) — malformed nats.subjects fails LOUDLY at load
// ---------------------------------------------------------------------------

describe("CFG.b.3b — malformed nats.subjects fails loudly at load", () => {
  test("a duplicate subject pattern is rejected (double-bind footgun)", () => {
    const system = systemBlocks({
      subjects: ["local.{principal}.{stack}.tasks.*.>", "local.{principal}.{stack}.tasks.*.>"],
    });
    const path = writeSystemLayout(testDir, system, stackBlocks());
    expect(() => loadConfigWithAgents(path)).toThrow(/duplicate subject pattern/i);
  });

  test("a syntactically-malformed pattern is rejected with a clear error", () => {
    const system = systemBlocks({ subjects: ["local. bad .subject"] });
    const path = writeSystemLayout(testDir, system, stackBlocks());
    expect(() => loadConfigWithAgents(path)).toThrow(/not a valid NATS subscribe pattern/i);
  });

  test("a non-array nats.subjects is rejected", () => {
    const system = systemBlocks({ subjects: "local.{principal}.>" });
    const path = writeSystemLayout(testDir, system, stackBlocks());
    expect(() => loadConfigWithAgents(path)).toThrow();
  });

  test("`>` not in final segment is rejected", () => {
    const system = systemBlocks({ subjects: ["local.>.tasks"] });
    const path = writeSystemLayout(testDir, system, stackBlocks());
    expect(() => loadConfigWithAgents(path)).toThrow(/not a valid NATS subscribe pattern/i);
  });

  test("a valid placeholder + wildcard pattern parses (no false positive)", () => {
    const system = systemBlocks({
      subjects: ["local.{principal}.{stack}.tasks.*.>", "local.{principal}.system.>"],
    });
    const path = writeSystemLayout(testDir, system, stackBlocks());
    const loaded = loadConfigWithAgents(path);
    expect(loaded.config.nats?.subjects).toEqual([
      "local.{principal}.{stack}.tasks.*.>",
      "local.{principal}.system.>",
    ]);
  });

  test("the failure-loud check is identical on the single-file fallback path", () => {
    // The same malformed block in a single cortex.yaml must fail the same way —
    // the validation lives on the schema, not the composer, so neither
    // ingestion path can sneak a double-publishing config through.
    const full = {
      ...systemBlocks({ subjects: ["dup.pattern", "dup.pattern"] }),
      ...stackBlocks(),
    };
    const path = writeSingleFile(testDir, full);
    expect(() => loadConfigWithAgents(path)).toThrow(/duplicate subject pattern/i);
  });
});

// ---------------------------------------------------------------------------
// CFG.b.1/CFG.b.2 — the documented reference layout is a valid example
// ---------------------------------------------------------------------------

describe("CFG.b — docs/config-layout reference example composes", () => {
  test("the reference system/system.yaml + stacks/research.yaml load cleanly", () => {
    const refDir = join(import.meta.dir, "..", "..", "..", "..", "docs", "config-layout");
    // The reference stack persona path won't exist, but loadConfigWithAgents
    // does not resolve agent personas (that's the agents.d fragment loader);
    // it only validates schema + composes. So this proves the reference layout
    // is structurally valid and composes via the system.yaml marker.
    const loaded = loadConfigWithAgents(join(refDir, "cortex.yaml"));
    expect(loaded.principal?.id).toBe("andreas");
    expect(loaded.config.nats?.subjects).toEqual([]); // landmine kept safe-default
    expect(loaded.config.claude?.timeoutMs).toBe(300000);
    expect(loaded.bus?.review.stream.name).toBe("CODE_REVIEW");
  });
});
