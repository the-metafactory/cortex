/**
 * IAW CFG.a — multi-file config composer tests.
 *
 * CFG.a is a config-INGESTION refactor: a directory layout
 * (`system/system.yaml` + optional `network/*.yaml`, `surfaces/surfaces.yaml`,
 * `stacks/*.yaml`) must compose to the SAME `LoadedConfig` the equivalent
 * single `cortex.yaml` produces. These tests prove:
 *
 *   (a) round-trip identity — a split layout and the equivalent single file
 *       yield deep-equal `LoadedConfig` (CFG.a.4 primary);
 *   (b) the single-file fallback path is byte-identical to pre-CFG.a
 *       (CFG.a.2);
 *   (c) precedence/merge-order — later layers win on leaf keys, deep-merge of
 *       nested objects, array-replace semantics (CFG.a.3);
 *   (d) determinism + idempotency — composing twice yields the same object.
 *
 * Fixtures are small synthetic configs built in a tmp dir, NOT the real
 * cortex.yaml — CFG.a only proves the composer *capability*; moving the real
 * config into the layers is CFG.b/CFG.c.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
import { composeRawConfig, loadConfigWithAgents } from "../loader";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `cortex-composer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

/**
 * A complete, valid cortex-shape config object. This is the single-file
 * baseline; the split-layout fixtures below carve THIS object across the
 * directory layers so the composed result must equal it exactly.
 */
function fullCortexConfig(): Record<string, unknown> {
  return {
    principal: {
      id: "jc",
      displayName: "Jens-Christian",
      discordId: "285727653603049472",
    },
    claude: { timeoutMs: 300000 },
    nats: {
      url: "nats://127.0.0.1:4222",
      identity: {
        seedPath: "/tmp/cortex.nk",
        publicKey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    },
    agents: [
      {
        id: "ivy",
        displayName: "Ivy",
        persona: "./personas/ivy.md",
        roles: [],
        trust: ["luna"],
        presence: {
          discord: {
            token: "fake-token-ivy",
            guildId: "1487023327791808592",
            agentChannelId: "1487029848164536361",
            logChannelId: "1487029942129524786",
          },
        },
      },
    ],
  };
}

/** Write a single-file `cortex.yaml` in `dir`, return its path. */
function writeSingleFile(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, "cortex.yaml");
  writeFileSync(path, stringify(config));
  return path;
}

/**
 * Write a directory layout under `dir` carving `config` across layers, then
 * return the conventional `cortex.yaml` path the caller passes (the marker
 * file `system/system.yaml` is what actually selects the layout — the
 * `cortex.yaml` path need not even exist).
 */
function writeLayout(dir: string, layers: {
  system: Record<string, unknown>;
  network?: Record<string, Record<string, unknown>>;
  surfaces?: Record<string, unknown>;
  stacks?: Record<string, Record<string, unknown>>;
}): string {
  mkdirSync(join(dir, "system"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), stringify(layers.system));

  if (layers.network) {
    mkdirSync(join(dir, "network"), { recursive: true });
    for (const [name, body] of Object.entries(layers.network)) {
      writeFileSync(join(dir, "network", name), stringify(body));
    }
  }
  if (layers.surfaces) {
    mkdirSync(join(dir, "surfaces"), { recursive: true });
    writeFileSync(join(dir, "surfaces", "surfaces.yaml"), stringify(layers.surfaces));
  }
  if (layers.stacks) {
    mkdirSync(join(dir, "stacks"), { recursive: true });
    for (const [name, body] of Object.entries(layers.stacks)) {
      writeFileSync(join(dir, "stacks", name), stringify(body));
    }
  }
  return join(dir, "cortex.yaml");
}

// ---------------------------------------------------------------------------
// CFG.a.4 (a) — round-trip identity: split layout == single file
// ---------------------------------------------------------------------------

describe("CFG.a.4 — round-trip identity (split layout composes to single-file LoadedConfig)", () => {
  test("split layout and equivalent single file yield deep-equal LoadedConfig", () => {
    const full = fullCortexConfig();

    // Single-file baseline.
    const singleDir = join(testDir, "single");
    mkdirSync(singleDir, { recursive: true });
    const singlePath = writeSingleFile(singleDir, full);

    // Equivalent split layout: carve `full` across system + stacks. The
    // principal + machine config live in system.yaml; the agents[] live in a
    // stack file. Composed deep-merge must reconstruct `full` exactly.
    const splitDir = join(testDir, "split");
    mkdirSync(splitDir, { recursive: true });
    const splitPath = writeLayout(splitDir, {
      system: {
        principal: full.principal,
        claude: full.claude,
        nats: full.nats,
      },
      stacks: {
        "research.yaml": { agents: full.agents },
      },
    });

    const single = loadConfigWithAgents(singlePath);
    const split = loadConfigWithAgents(splitPath);

    expect(split).toEqual(single);
  });

  test("composed raw object equals parsed single-file raw object", () => {
    const full = fullCortexConfig();
    const singleDir = join(testDir, "single");
    mkdirSync(singleDir, { recursive: true });
    const singlePath = writeSingleFile(singleDir, full);

    const splitDir = join(testDir, "split");
    mkdirSync(splitDir, { recursive: true });
    const splitPath = writeLayout(splitDir, {
      system: { principal: full.principal, claude: full.claude, nats: full.nats },
      stacks: { "research.yaml": { agents: full.agents } },
    });

    expect(composeRawConfig(splitPath)).toEqual(composeRawConfig(singlePath));
  });
});

// ---------------------------------------------------------------------------
// CFG.a.2 — single-file fallback identity
// ---------------------------------------------------------------------------

describe("CFG.a.2 — single-file fallback", () => {
  test("no directory layout → composeRawConfig reads the single file verbatim", () => {
    const full = fullCortexConfig();
    const path = writeSingleFile(testDir, full);
    // No `system/system.yaml` marker → fallback. Raw equals the parsed file.
    expect(composeRawConfig(path)).toEqual(full);
  });

  test("single-file fallback produces a fully-valid LoadedConfig", () => {
    const full = fullCortexConfig();
    const path = writeSingleFile(testDir, full);
    const loaded = loadConfigWithAgents(path);
    expect(loaded.inlineAgents).toHaveLength(1);
    expect(loaded.inlineAgents[0]!.id).toBe("ivy");
    expect(loaded.principal?.id).toBe("jc");
    expect(loaded.config.nats?.url).toBe("nats://127.0.0.1:4222");
  });

  test("layout marker present → single cortex.yaml is NOT read (layout wins)", () => {
    // Put a DIFFERENT, would-be-invalid single file alongside a valid layout.
    // If the composer wrongly read cortex.yaml, the result would carry the
    // decoy's marker key; the layout path must ignore it entirely.
    writeSingleFile(testDir, { decoy: true });
    const layoutPath = writeLayout(testDir, {
      system: fullCortexConfig(),
    });
    const raw = composeRawConfig(layoutPath);
    expect(raw.decoy).toBeUndefined();
    expect((raw.principal as Record<string, unknown>).id).toBe("jc");
  });
});

// ---------------------------------------------------------------------------
// CFG.a.3 — precedence / merge-order + determinism + idempotency
// ---------------------------------------------------------------------------

describe("CFG.a.3 — precedence + deep-merge semantics", () => {
  test("later layer wins on a scalar leaf key (stacks override system)", () => {
    const path = writeLayout(testDir, {
      system: { claude: { timeoutMs: 100 }, principal: { id: "jc" } },
      stacks: { "z.yaml": { claude: { timeoutMs: 999 } } },
    });
    const raw = composeRawConfig(path);
    // stacks layer is last → its leaf wins.
    expect((raw.claude as Record<string, unknown>).timeoutMs).toBe(999);
    // unmentioned leaf from the base survives the deep-merge.
    expect((raw.principal as Record<string, unknown>).id).toBe("jc");
  });

  test("nested objects deep-merge rather than replace wholesale", () => {
    const path = writeLayout(testDir, {
      system: { nats: { url: "nats://base:4222", identity: { seedPath: "/a" } } },
      stacks: { "s.yaml": { nats: { identity: { publicKey: "PUB" } } } },
    });
    const raw = composeRawConfig(path);
    const nats = raw.nats as Record<string, unknown>;
    const identity = nats.identity as Record<string, unknown>;
    // url survives (only present in base); seedPath survives; publicKey added.
    expect(nats.url).toBe("nats://base:4222");
    expect(identity.seedPath).toBe("/a");
    expect(identity.publicKey).toBe("PUB");
  });

  test("arrays replace wholesale (no element-wise merge)", () => {
    const path = writeLayout(testDir, {
      system: { agents: [{ id: "a" }, { id: "b" }] },
      stacks: { "s.yaml": { agents: [{ id: "c" }] } },
    });
    const raw = composeRawConfig(path);
    // stacks layer's array replaces the base array entirely.
    expect(raw.agents).toEqual([{ id: "c" }]);
  });

  test("network layer sits between system and stacks (filename-sorted, deterministic)", () => {
    const path = writeLayout(testDir, {
      system: { k: "system", principal: { id: "jc" } },
      network: { "01-a.yaml": { k: "net-a" }, "02-b.yaml": { k: "net-b" } },
      stacks: { "s.yaml": {} },
    });
    const raw = composeRawConfig(path);
    // Within the network layer, 02-b sorts after 01-a → net-b wins; no stack
    // override of `k`, so the last network value persists.
    expect(raw.k).toBe("net-b");
  });

  test("surfaces layer sits after network, before stacks", () => {
    const path = writeLayout(testDir, {
      system: { k: "system" },
      network: { "n.yaml": { k: "net" } },
      surfaces: { k: "surfaces" },
      stacks: { "s.yaml": { other: 1 } },
    });
    // network → surfaces (later wins) → stacks doesn't touch `k`.
    expect(composeRawConfig(path).k).toBe("surfaces");
  });

  test("composition is idempotent — composing twice yields an equal object", () => {
    const path = writeLayout(testDir, {
      system: fullCortexConfig(),
      stacks: { "s.yaml": { claude: { timeoutMs: 1 } } },
    });
    const first = composeRawConfig(path);
    const second = composeRawConfig(path);
    expect(second).toEqual(first);
  });

  test("empty layer file contributes nothing to the merge", () => {
    mkdirSync(join(testDir, "system"), { recursive: true });
    writeFileSync(join(testDir, "system", "system.yaml"), stringify(fullCortexConfig()));
    mkdirSync(join(testDir, "stacks"), { recursive: true });
    writeFileSync(join(testDir, "stacks", "empty.yaml"), ""); // empty → {}
    const raw = composeRawConfig(join(testDir, "cortex.yaml"));
    expect((raw.principal as Record<string, unknown>).id).toBe("jc");
  });
});
