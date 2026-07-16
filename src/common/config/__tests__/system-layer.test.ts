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
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify, parse } from "yaml";
import { loadConfigWithAgents } from "../loader";
import { InferenceConfigSchema } from "../../inference/inference-config-schema";
import { createInferenceRegistry } from "../../../substrates/api-agent/provider-factories";

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

  // -------------------------------------------------------------------------
  // #2116 — the documented `inference` example must be VALID, not just prose
  // -------------------------------------------------------------------------
  //
  // The reference `system/system.yaml` ships `inference` empty (opt-in, D3:
  // `claude-code` stays the default) with the real shape documented as a
  // COMMENTED example. Prose rots: a schema change would silently leave a
  // principal copy-pasting a block that no longer loads. These two tests pin
  // both halves — the shipped default is opt-in, and the commented example
  // parses through the REAL `InferenceConfigSchema` once uncommented.
  //
  // Both assert against the TEMPLATE (a docs artifact) rather than the loader,
  // so they test what this branch actually changes. The loader's own handling of
  // `inference` is pinned separately by the #2121 regression tests.

  test("the reference template ships `inference` opt-in (empty maps, claude-code default)", () => {
    const refDir = join(import.meta.dir, "..", "..", "..", "..", "docs", "config-layout");
    const systemYaml = parse(
      readFileSync(join(refDir, "system", "system.yaml"), "utf8"),
    ) as { inference?: { providers?: unknown; profiles?: unknown } };

    // Empty ⇒ a stock stack gets no boot pre-flight output and no api-agent
    // behaviour change. The block is present (so it's discoverable) but inert.
    expect(systemYaml.inference).toBeDefined();
    expect(systemYaml.inference?.providers).toEqual({});
    expect(systemYaml.inference?.profiles).toEqual({});

    // D3: the reference agent stays on the default substrate.
    const loaded = loadConfigWithAgents(join(refDir, "cortex.yaml"));
    expect(loaded.inlineAgents[0]?.runtime?.substrate).toBe("claude-code");
  });

  test("the COMMENTED inference example in system.yaml parses through InferenceConfigSchema", () => {
    const systemYaml = join(
      import.meta.dir, "..", "..", "..", "..",
      "docs", "config-layout", "system", "system.yaml",
    );
    const lines = readFileSync(systemYaml, "utf8").split("\n");
    const begin = lines.findIndex((l) => l.includes("<-- begin inference reference example"));
    const end = lines.findIndex((l) => l.includes("<-- end inference reference example"));
    expect(begin).toBeGreaterThan(-1); // the markers themselves are the contract
    expect(end).toBeGreaterThan(begin);

    // Strip the leading `# ` comment prefix to recover the YAML the principal
    // would uncomment, then validate it exactly as the loader would.
    const uncommented = lines.slice(begin, end + 1).map((l) => l.replace(/^# ?/, "")).join("\n");
    const doc = parse(uncommented) as { inference?: unknown };
    const result = InferenceConfigSchema.safeParse(doc.inference);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Spot-check the load-bearing claims the surrounding docs make.
    const cfg = result.data;
    // Credentials are `env:NAME` REFERENCES, never literals (D6).
    for (const provider of Object.values(cfg.providers)) {
      expect(provider.apiKey).toMatch(/^env:[A-Za-z_][A-Za-z0-9_]*$/);
    }
    // Every profile resolves to a declared provider (the document-level invariant).
    for (const profile of Object.values(cfg.profiles)) {
      expect(Object.keys(cfg.providers)).toContain(profile.provider);
    }
  });
});

// ---------------------------------------------------------------------------
// #2121 — the `inference` block must SURVIVE the loader (regression)
// ---------------------------------------------------------------------------
//
// `loadConfigWithAgents` synthesizes a legacy `AgentConfig` from the parsed
// `CortexConfig`. That synthesis passes `claude`/`execution`/`plugins`/
// `security`/`mc`/`grove`/… through explicitly — and USED TO OMIT `inference`.
// Because `AgentConfigSchema.inference` is `.optional()` with no default, the
// block a principal declared in `system/system.yaml` was silently dropped:
// `config.inference` at the boot path (src/cortex.ts) was ALWAYS `undefined`,
// the InferenceRegistry was ALWAYS built empty, and EVERY
// `substrate: api-agent` dispatch failed closed with `unknown-profile` no matter
// what was configured. Silently, too — with no profiles the boot pre-flight has
// nothing to report.
//
// The gap that let it ship was the absence of a test spanning the WHOLE path:
// the schema tests proved `inference` parses, and the harness tests proved a
// registry resolves — but nothing proved a CONFIGURED block reaches a registry.
// These two tests close exactly that gap, at both ends:
//
//   1. the loader round-trip (config file → `config.inference`), and
//   2. the end-to-end path (config file → registry → resolved provider),
//      which is the assertion that would have caught the bug on its own.
//
// Both fail on the pre-fix loader.

describe("#2121 — a configured `inference` block reaches the boot path", () => {
  /** Write a config-split layout declaring one provider + one profile. */
  function writeLayoutWithInference(dir: string, envVarName: string): string {
    mkdirSync(join(dir, "system"), { recursive: true });
    mkdirSync(join(dir, "stacks"), { recursive: true });
    writeFileSync(
      join(dir, "system", "system.yaml"),
      stringify({
        claude: { timeoutMs: 300000 },
        inference: {
          providers: {
            "local-provider": {
              protocol: "openai-chat-completions",
              // Loopback: constructing the provider performs NO network I/O.
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: `env:${envVarName}`,
            },
          },
          profiles: {
            "local-profile": {
              provider: "local-provider",
              model: "some-model",
              modelClass: "local-only",
            },
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "stacks", "s.yaml"),
      stringify({
        principal: { id: "someone", displayName: "Someone" },
        capabilities: [{ id: "chat", description: "chat", provided_by: ["a1"] }],
        agents: [
          {
            id: "a1",
            displayName: "A1",
            persona: "./personas/a1.md",
            roles: [],
            trust: [],
            runtime: {
              substrate: "api-agent",
              inferenceProfile: "local-profile",
              mode: "in-process",
              capabilities: ["chat"],
            },
            presence: {},
          },
        ],
      }),
    );
    const pointer = join(dir, "cortex.yaml");
    writeFileSync(pointer, "");
    return pointer;
  }

  test("the loader round-trips a declared block onto `config.inference`", () => {
    const dir = join(testDir, "inference-passthrough");
    const pointer = writeLayoutWithInference(dir, "CORTEX_TEST_INFERENCE_REF");

    const loaded = loadConfigWithAgents(pointer);

    // The block reaches `config.inference` — the exact object src/cortex.ts
    // feeds `createInferenceRegistry`. Pre-fix this was `undefined`.
    expect(loaded.config.inference).toBeDefined();
    expect(Object.keys(loaded.config.inference?.providers ?? {})).toEqual(["local-provider"]);
    expect(loaded.config.inference?.profiles?.["local-profile"]?.provider).toBe("local-provider");
    // The credential stays a REFERENCE on the loaded config — never resolved at
    // load, so a config dump/log can't leak a value (D6).
    expect(loaded.config.inference?.providers?.["local-provider"]?.apiKey).toBe(
      "env:CORTEX_TEST_INFERENCE_REF",
    );
    // The agent's opt-in survives too — the other half of the dispatch path.
    expect(loaded.inlineAgents[0]?.runtime?.substrate).toBe("api-agent");
    expect(loaded.inlineAgents[0]?.runtime?.inferenceProfile).toBe("local-profile");
  });

  test("end-to-end: configured profile → non-empty registry → resolveProfile succeeds", () => {
    const envVarName = "CORTEX_TEST_INFERENCE_REF";
    const dir = join(testDir, "inference-e2e");
    const pointer = writeLayoutWithInference(dir, envVarName);

    // The `env:NAME` reference resolves at provider CONSTRUCTION (#2110), so the
    // variable must exist for the factory to build. Set/restore around the
    // assertion; the value is an inert test stand-in, never a real credential.
    const env = process.env as Record<string, string | undefined>;
    const previous = env[envVarName];
    env[envVarName] = "test-placeholder-value";
    try {
      const loaded = loadConfigWithAgents(pointer);

      // Exactly what src/cortex.ts does at boot.
      const registry = createInferenceRegistry(
        loaded.config.inference ?? { providers: {}, profiles: {} },
      );

      // Pre-fix: `[]` — the registry was empty, so every api-agent dispatch
      // failed closed with `unknown-profile` regardless of config.
      expect(registry.profileNames()).toEqual(["local-profile"]);

      // Pre-fix: `{ ok: false, error: unknown-profile }`.
      const resolution = registry.resolveProfile("local-profile");
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.profile.model).toBe("some-model");
      expect(resolution.profile.modelClass).toBe("local-only");
      expect(resolution.profile.provider).toBeDefined();

      // The boot pre-flight is silent for a healthy profile — no dangling
      // provider, no missing factory.
      expect(registry.validateAll()).toEqual([]);
    } finally {
      // Restore exactly. `Reflect.deleteProperty` rather than `delete` (lint:
      // no-dynamic-delete) and rather than assigning `undefined` — some runtimes
      // stringify an assigned `undefined` into the literal "undefined", which
      // would leave a bogus variable behind for every later test in the process.
      if (previous === undefined) Reflect.deleteProperty(env, envVarName);
      else env[envVarName] = previous;
    }
  });
});
