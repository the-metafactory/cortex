/**
 * offer tests (CO-3, cortex#942) — TDD-first, mirroring the config-merge /
 * normalize-config test style: pure command logic (projection + offerings-edit
 * + accept parsing) with fixtures, plus the CLI file-I/O paths (dispatchOffer
 * against a tmp config-split dir).
 *
 * Coverage:
 *   Pure — federation-config projection (the DD-CO-2 unify mechanism)
 *     1. projectFederationConfig — local-only offering → no projection
 *     2. projectFederationConfig — federated network accept → announce + accept_subject
 *     3. projectFederationConfig — accept_subjects carry {principal}.{stack} (ADR-0001)
 *     4. projectFederationConfig — authoritative (removed cap → empty lists)
 *     5. projectFederationConfig — principals-accept (no network) → all networks
 *     6. projectPublicAnnounce — public-scoped caps only
 *     7. danglingNetworks — names a non-declared network
 *   Pure — buildOffering (CO-1 Zod + accept grammar)
 *     8. buildOffering — local scope, no accept
 *     9. buildOffering — federated --network shorthand
 *    10. buildOffering — federated principals accept
 *    11. buildOffering — federated with no accept → error (default-deny)
 *    12. buildOffering — public surface/repo predicate
 *    13. buildOffering — public content-dependent predicate → rejected (ADR-0010)
 *    14. buildOffering — local scope + --accept → error
 *   Pure — applySet / applyRevoke
 *    15. applySet — add new offering
 *    16. applySet — widen (replace) existing
 *    17. applySet — idempotent (unchanged)
 *    18. applyRevoke — whole offering removed → default-deny
 *    19. applyRevoke — absent capability → no-op
 *    20. applyRevoke — drop one scope, keep widened tier
 *   Pure — buildListRows
 *    21. buildListRows — default-deny local for unoffered capability
 *    22. buildListRows — resolved offering with accept + providers
 *   Pure — reconcileLayer
 *    23. reconcileLayer — writes offerings + regenerates network projection
 *    24. reconcileLayer — empty offerings → deletes offerings key
 *   CLI (file I/O)
 *    25. --help exits 0
 *    26. no args → exit 2 (usage)
 *    27. set local --scope, dry-run by default (no write)
 *    28. set federated --apply writes + backup + generates projection
 *    29. set federated with no accept → exit 2 (usage)
 *    30. --apply + --dry-run → exit 2
 *    31. revoke removes the offering (idempotent second run = no-op)
 *    32. list shows capabilities × resolved offering
 *    33. --stack required when >1 stack file
 *    34. set that breaks schema (unknown capability) → exit 1, no write
 *    35. dispatchOffer set --json envelope
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";

import {
  projectFederationConfig,
  projectPublicAnnounce,
  danglingNetworks,
  buildOffering,
  applySet,
  applyRevoke,
  buildListRows,
  reconcileLayer,
  resolveTarget,
  dispatchOffer,
} from "../offer";
import type { Offering } from "../../../../common/types/offering";

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OFFER_LOCAL: Offering = { capability: "chat", scopes: ["local"] };
const OFFER_FED_NET: Offering = {
  capability: "code-review.typescript",
  scopes: ["federated"],
  accept: { kind: "network", network: "metafactory-net" },
  network: "metafactory-net",
};
const OFFER_FED_PRINCIPALS: Offering = {
  capability: "research",
  scopes: ["federated"],
  accept: { kind: "principals", principals: ["jcfischer"] },
};
const OFFER_PUBLIC: Offering = {
  capability: "code-review.public",
  scopes: ["public"],
  accept: {
    kind: "surface",
    surface: "github",
    predicate: { kind: "repo-membership", repos: ["the-metafactory/*"] },
  },
};

// ===========================================================================
// 1–5. projectFederationConfig
// ===========================================================================

describe("projectFederationConfig", () => {
  test("local-only offering contributes no federation projection", () => {
    const proj = projectFederationConfig([OFFER_LOCAL], ["metafactory-net"], "andreas", "work");
    expect(proj).toHaveLength(1);
    expect(proj[0]?.announce_capabilities).toEqual([]);
    expect(proj[0]?.accept_subjects).toEqual([]);
  });

  test("federated {kind:'network'} accept announces + accepts on that network", () => {
    const proj = projectFederationConfig([OFFER_FED_NET], ["metafactory-net"], "andreas", "work");
    expect(proj[0]?.announce_capabilities).toEqual(["code-review.typescript"]);
    expect(proj[0]?.accept_subjects).toEqual([
      "federated.andreas.work.tasks.code-review.typescript.>",
    ]);
  });

  test("accept_subjects carry the RECEIVING stack's {principal}.{stack} (ADR-0001), not the network", () => {
    const proj = projectFederationConfig([OFFER_FED_NET], ["metafactory-net"], "jcfischer", "sage-host");
    expect(proj[0]?.accept_subjects[0]).toBe(
      "federated.jcfischer.sage-host.tasks.code-review.typescript.>",
    );
    // The network id never appears on the wire.
    expect(proj[0]?.accept_subjects[0]).not.toContain("metafactory-net");
  });

  test("projection is authoritative — a removed capability leaves empty lists", () => {
    // Start with a fed offering, then project with NO offerings → network reset.
    const empty = projectFederationConfig([], ["metafactory-net"], "andreas", "work");
    expect(empty[0]?.announce_capabilities).toEqual([]);
    expect(empty[0]?.accept_subjects).toEqual([]);
  });

  test("principals accept with no network reaches every declared network", () => {
    const proj = projectFederationConfig([OFFER_FED_PRINCIPALS], ["net-a", "net-b"], "andreas", "work");
    expect(proj.find((p) => p.networkId === "net-a")?.announce_capabilities).toEqual(["research"]);
    expect(proj.find((p) => p.networkId === "net-b")?.announce_capabilities).toEqual(["research"]);
  });

  test("public offering reaches every declared network too", () => {
    const proj = projectFederationConfig([OFFER_PUBLIC], ["net-a"], "andreas", "work");
    expect(proj[0]?.announce_capabilities).toEqual(["code-review.public"]);
  });
});

// ===========================================================================
// 6–7. projectPublicAnnounce / danglingNetworks
// ===========================================================================

describe("projectPublicAnnounce", () => {
  test("returns only public-scoped capabilities, sorted", () => {
    expect(projectPublicAnnounce([OFFER_LOCAL, OFFER_FED_NET, OFFER_PUBLIC])).toEqual([
      "code-review.public",
    ]);
  });
  test("empty when no public offerings", () => {
    expect(projectPublicAnnounce([OFFER_LOCAL, OFFER_FED_NET])).toEqual([]);
  });
});

describe("danglingNetworks", () => {
  test("flags a network named by an offering but not declared", () => {
    expect(danglingNetworks([OFFER_FED_NET], ["other-net"])).toEqual(["metafactory-net"]);
  });
  test("no dangling when the named network is declared", () => {
    expect(danglingNetworks([OFFER_FED_NET], ["metafactory-net"])).toEqual([]);
  });
});

// ===========================================================================
// 8–14. buildOffering
// ===========================================================================

describe("buildOffering", () => {
  test("local scope, no accept", () => {
    const r = buildOffering({ capability: "chat", scope: "local" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.offering.scopes).toEqual(["local"]);
      expect(r.offering.accept).toBeUndefined();
    }
  });

  test("federated --network shorthand → {kind:'network'}", () => {
    const r = buildOffering({ capability: "code-review", scope: "federated", network: "metafactory-net" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.offering.accept).toEqual({ kind: "network", network: "metafactory-net" });
      expect(r.offering.network).toBe("metafactory-net");
    }
  });

  test("federated principals accept", () => {
    const r = buildOffering({ capability: "research", scope: "federated", accept: "principals:jcfischer,holly" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.offering.accept).toEqual({ kind: "principals", principals: ["jcfischer", "holly"] });
  });

  test("federated with no accept → error (default-deny)", () => {
    const r = buildOffering({ capability: "research", scope: "federated" });
    expect(r.ok).toBe(false);
  });

  test("public surface/repo predicate", () => {
    const r = buildOffering({ capability: "code-review", scope: "public", accept: "surface:github/repo:the-metafactory/*" });
    expect(r.ok).toBe(true);
    if (r.ok && r.offering.accept?.kind === "surface") {
      expect(r.offering.accept.surface).toBe("github");
      expect(r.offering.accept.predicate).toEqual({ kind: "repo-membership", repos: ["the-metafactory/*"] });
    }
  });

  test("public content-dependent predicate → rejected (ADR-0010)", () => {
    const r = buildOffering({ capability: "code-review", scope: "public", accept: "surface:github/description-contains:urgent" });
    expect(r.ok).toBe(false);
  });

  test("local scope + --accept → error", () => {
    const r = buildOffering({ capability: "chat", scope: "local", accept: "network:x" });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// 15–20. applySet / applyRevoke
// ===========================================================================

describe("applySet", () => {
  test("adds a new offering", () => {
    const r = applySet([], OFFER_FED_NET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.offerings).toHaveLength(1);
      expect(r.result.note.action).toBe("added");
    }
  });

  test("widens (replaces) an existing offering", () => {
    const r = applySet([OFFER_LOCAL], { capability: "chat", scopes: ["federated"], accept: { kind: "network", network: "n" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.note.action).toBe("widened");
      expect(r.result.offerings[0]?.scopes).toEqual(["federated"]);
    }
  });

  test("idempotent — re-setting identical offering is unchanged", () => {
    const r = applySet([OFFER_FED_NET], OFFER_FED_NET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.note.action).toBe("unchanged");
  });

  test("does not mutate input", () => {
    const input = [structuredClone(OFFER_LOCAL)];
    applySet(input, OFFER_FED_NET);
    expect(input).toHaveLength(1);
  });
});

describe("applyRevoke", () => {
  test("no --scope removes the whole offering → default-deny", () => {
    const r = applyRevoke([OFFER_FED_NET], "code-review.typescript", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.offerings).toHaveLength(0);
      expect(r.result.note.action).toBe("revoked");
    }
  });

  test("absent capability is a no-op", () => {
    const r = applyRevoke([], "ghost", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.note.action).toBe("absent");
  });

  test("dropping the only widened scope removes the offering", () => {
    const r = applyRevoke([OFFER_FED_NET], "code-review.typescript", "federated");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.offerings).toHaveLength(0);
  });
});

// ===========================================================================
// 21–22. buildListRows
// ===========================================================================

describe("buildListRows", () => {
  test("unoffered capability resolves default-deny local", () => {
    const rows = buildListRows([{ id: "chat", provided_by: ["luna"] }], undefined);
    expect(rows[0]?.scopes).toEqual(["local"]);
    expect(rows[0]?.accept).toBe("—");
    expect(rows[0]?.provided_by).toEqual(["luna"]);
  });

  test("offered capability shows resolved scope + accept", () => {
    const rows = buildListRows(
      [{ id: "code-review.typescript", provided_by: ["echo"] }],
      [OFFER_FED_NET],
    );
    expect(rows[0]?.scopes).toEqual(["federated"]);
    expect(rows[0]?.accept).toBe("network:metafactory-net");
  });
});

// ===========================================================================
// 23–24. reconcileLayer
// ===========================================================================

describe("reconcileLayer", () => {
  const baseLayer = (): Rec => ({
    principal: { id: "andreas" },
    stack: { id: "andreas/work" },
    policy: {
      federated: {
        networks: [{ id: "metafactory-net", leaf_node: "leaf", max_hop: 1, peers: [] }],
        registry: { url: "https://registry.example" },
      },
    },
  });

  test("writes offerings + regenerates the network projection", () => {
    const { layer } = reconcileLayer(baseLayer(), [OFFER_FED_NET]);
    const policy = layer.policy as Rec;
    expect((policy.offerings as Rec[])).toHaveLength(1);
    const net = (policy.federated as Rec).networks as Rec[];
    expect(net[0]?.announce_capabilities).toEqual(["code-review.typescript"]);
    expect(net[0]?.accept_subjects).toEqual(["federated.andreas.work.tasks.code-review.typescript.>"]);
  });

  test("empty offerings deletes the offerings key + clears projection", () => {
    const seeded = baseLayer();
    (seeded.policy as Rec).offerings = [OFFER_FED_NET];
    const { layer } = reconcileLayer(seeded, []);
    const policy = layer.policy as Rec;
    expect(policy.offerings).toBeUndefined();
    const net = (policy.federated as Rec).networks as Rec[];
    expect(net[0]?.announce_capabilities).toEqual([]);
  });
});

// ===========================================================================
// CLI — file I/O
// ===========================================================================

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "offer-test-"));
});

const SYSTEM_YAML = YAML.stringify({
  claude: { model: "claude-opus-4-5", apiKey: "env:ANTHROPIC_API_KEY" },
});

// A complete, valid config-split stack layer. With the system.yaml above it
// composes into a valid CortexConfig.
function stackLayer(extra: Rec = {}): Rec {
  return {
    principal: { id: "andreas", displayName: "Andreas", discordId: "123456789012345678" },
    stack: { id: "andreas/work" },
    agents: [
      {
        id: "echo",
        displayName: "Echo",
        persona: "./personas/echo.md",
        presence: {
          discord: {
            token: "DISCORD_TOKEN",
            guildId: "123456789012345678",
            agentChannelId: "234567890123456789",
            logChannelId: "345678901234567890",
          },
        },
      },
    ],
    capabilities: [
      { id: "code-review.typescript", description: "TS review", tags: ["typescript"], provided_by: ["echo"] },
      { id: "chat", description: "Conversational", tags: [], provided_by: ["echo"] },
    ],
    ...extra,
  };
}

function makeSplitDir(stacks: Record<string, Rec>, slug = "offer-test-cfg"): string {
  const dir = join(tmpDir, slug);
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), SYSTEM_YAML, "utf-8");
  for (const [name, content] of Object.entries(stacks)) {
    writeFileSync(join(dir, "stacks", `${name}.yaml`), YAML.stringify(content, { indent: 2, lineWidth: 0 }), "utf-8");
  }
  return dir;
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await dispatchOffer(argv);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

describe("dispatchOffer — CLI", () => {
  test("--help exits 0", async () => {
    expect((await run(["--help"])).code).toBe(0);
  });

  test("no args → exit 2 (usage)", async () => {
    expect((await run([])).code).toBe(2);
  });

  test("set local --scope is dry-run by default (no write)", async () => {
    const dir = makeSplitDir({ work: stackLayer() });
    const before = readFileSync(join(dir, "stacks", "work.yaml"), "utf-8");
    const r = await run(["chat", "--scope", "local", "--config", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dry-run");
    const after = readFileSync(join(dir, "stacks", "work.yaml"), "utf-8");
    expect(after).toBe(before);
  });

  test("set federated --apply writes + backup + generates projection", async () => {
    const dir = makeSplitDir({
      work: stackLayer({
        policy: {
          federated: {
            networks: [{ id: "metafactory-net", leaf_node: "leaf", max_hop: 1, peers: [] }],
            registry: { url: "https://registry.example" },
          },
        },
      }),
    });
    const r = await run([
      "code-review.typescript", "--scope", "federated", "--network", "metafactory-net",
      "--config", dir, "--apply",
    ]);
    expect(r.code).toBe(0);

    const written = YAML.parse(readFileSync(join(dir, "stacks", "work.yaml"), "utf-8")) as Rec;
    const policy = written.policy as Rec;
    expect((policy.offerings as Rec[])[0]?.capability).toBe("code-review.typescript");
    const net = (policy.federated as Rec).networks as Rec[];
    expect(net[0]?.announce_capabilities).toEqual(["code-review.typescript"]);
    expect(net[0]?.accept_subjects).toEqual(["federated.andreas.work.tasks.code-review.typescript.>"]);

    const backups = readdirSync(join(dir, "stacks")).filter((f) => f.includes(".pre-offer-"));
    expect(backups.length).toBe(1);
    // The registry-push deferral is surfaced.
    expect(r.stdout).toContain("provision-stack register");
  });

  test("set federated with no accept → exit 2 (usage)", async () => {
    const dir = makeSplitDir({ work: stackLayer() });
    const r = await run(["code-review.typescript", "--scope", "federated", "--config", dir]);
    expect(r.code).toBe(2);
  });

  test("--apply + --dry-run → exit 2", async () => {
    const dir = makeSplitDir({ work: stackLayer() });
    const r = await run(["chat", "--scope", "local", "--config", dir, "--apply", "--dry-run"]);
    expect(r.code).toBe(2);
  });

  test("revoke removes the offering; second run is idempotent no-op", async () => {
    const dir = makeSplitDir({
      work: stackLayer({
        policy: {
          offerings: [{ capability: "chat", scopes: ["local"] }],
        },
      }),
    });
    const first = await run(["revoke", "chat", "--config", dir, "--apply"]);
    expect(first.code).toBe(0);
    const written = YAML.parse(readFileSync(join(dir, "stacks", "work.yaml"), "utf-8")) as Rec;
    expect((written.policy as Rec).offerings).toBeUndefined();

    // Second run: capability already absent → no-op (still exit 0, no new backup).
    const second = await run(["revoke", "chat", "--config", dir, "--apply"]);
    expect(second.code).toBe(0);
    const backups = readdirSync(join(dir, "stacks")).filter((f) => f.includes(".pre-offer-"));
    expect(backups.length).toBe(1); // only the first run wrote.
  });

  test("list shows capabilities × resolved offering", async () => {
    const dir = makeSplitDir({
      work: stackLayer({
        policy: {
          offerings: [{ capability: "code-review.typescript", scopes: ["federated"], accept: { kind: "network", network: "metafactory-net" }, network: "metafactory-net" }],
          federated: { networks: [{ id: "metafactory-net", leaf_node: "leaf", max_hop: 1, peers: [], accept_subjects: ["federated.andreas.work.tasks.code-review.typescript.>"], announce_capabilities: ["code-review.typescript"] }], registry: { url: "https://registry.example" } },
        },
      }),
    });
    const r = await run(["list", "--config", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("code-review.typescript");
    expect(r.stdout).toContain("federated");
    expect(r.stdout).toContain("network:metafactory-net");
    // The unoffered `chat` resolves default-deny local.
    expect(r.stdout).toContain("chat");
    expect(r.stdout).toContain("local");
  });

  test("--stack required when >1 stack file", async () => {
    const dir = makeSplitDir({
      work: stackLayer(),
      research: stackLayer({ stack: { id: "andreas/research" } }),
    });
    // No --stack with 2 files → exit 1 (ambiguous target).
    expect((await run(["chat", "--scope", "local", "--config", dir, "--apply"])).code).toBe(1);
    // --stack selects the right one.
    const r = await run(["chat", "--scope", "local", "--config", dir, "--stack", "andreas/research", "--apply"]);
    expect(r.code).toBe(0);
    const research = YAML.parse(readFileSync(join(dir, "stacks", "research.yaml"), "utf-8")) as Rec;
    expect(((research.policy as Rec).offerings as Rec[])[0]?.capability).toBe("chat");
  });

  test("set an unknown capability (not in catalog) → exit 1, no write", async () => {
    const dir = makeSplitDir({ work: stackLayer() });
    const before = readFileSync(join(dir, "stacks", "work.yaml"), "utf-8");
    const r = await run(["ghost.capability", "--scope", "local", "--config", dir, "--apply"]);
    expect(r.code).toBe(1);
    const after = readFileSync(join(dir, "stacks", "work.yaml"), "utf-8");
    expect(after).toBe(before);
  });

  test("set --json emits an envelope", async () => {
    const dir = makeSplitDir({ work: stackLayer() });
    const r = await run(["chat", "--scope", "local", "--config", dir, "--json"]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as Rec;
    expect(env.status).toBe("ok");
    expect((env.items as Rec[])[0]?.capability).toBe("chat");
  });
});

// ===========================================================================
// resolveTarget — single-file + ambiguity
// ===========================================================================

describe("resolveTarget", () => {
  test("config-split single stack → that file", () => {
    const dir = makeSplitDir({ work: stackLayer() });
    const t = resolveTarget(dir, undefined);
    expect(t.singleFile).toBe(false);
    expect(t.filePath.endsWith("work.yaml")).toBe(true);
  });

  test("ambiguous (2 stacks, no --stack) throws", () => {
    const dir = makeSplitDir({ work: stackLayer(), research: stackLayer({ stack: { id: "andreas/research" } }) });
    expect(() => resolveTarget(dir, undefined)).toThrow();
  });
});
