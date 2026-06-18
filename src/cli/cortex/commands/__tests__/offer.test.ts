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
 *   Pure — buildOffering single-segment pre-flight (PR #967 BLOCKER 2)
 *     - single-segment OK for local; REJECTED for federated/public (clear msg)
 *   Pure — applySet / applyRevoke
 *     applySet — add / widen / idempotent / no-mutate
 *     applyRevoke — whole-offering removed; absent capability no-op; drop the
 *       only widened scope (reported narrowed); revoke an ABSENT scope = no-op,
 *       offering UNTOUCHED, action 'absent' (PR #967 MAJOR)
 *   Pure — buildListRows (default-deny local; resolved offering + providers)
 *   Pure — reconcileLayer
 *     writes offerings + regenerates network projection; empty → deletes key;
 *     cross-principal stack.id override uses principal.id for the wire prefix,
 *     NOT stack.id's principal half (PR #967 BLOCKER 1)
 *   CLI (file I/O) — help/usage, dry-run-by-default, --apply writes + backup +
 *     generates projection, --apply+--dry-run usage error, revoke idempotent,
 *     list, --stack ambiguity, unknown-capability exit 1, --json envelope,
 *     single-segment federated → exit 2 clear msg + dotted federated happy path
 *     (PR #967 BLOCKER 2)
 *   resolveTarget — single-file + ambiguity
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
  mergeOfferAcceptSubjects,
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
// Dotted capability id (PR #967 NIT 2): announce_capabilities[] requires >=2
// segments, so the projection fixtures use dotted ids — single-segment ids are
// rejected for federated/public at buildOffering (see the BLOCKER-2 tests).
const OFFER_FED_PRINCIPALS: Offering = {
  capability: "research.medline",
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
    expect(proj.find((p) => p.networkId === "net-a")?.announce_capabilities).toEqual(["research.medline"]);
    expect(proj.find((p) => p.networkId === "net-b")?.announce_capabilities).toEqual(["research.medline"]);
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
    const r = buildOffering({ capability: "code-review.typescript", scope: "federated", network: "metafactory-net" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.offering.accept).toEqual({ kind: "network", network: "metafactory-net" });
      expect(r.offering.network).toBe("metafactory-net");
    }
  });

  test("federated principals accept", () => {
    const r = buildOffering({ capability: "research.medline", scope: "federated", accept: "principals:jcfischer,holly" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.offering.accept).toEqual({ kind: "principals", principals: ["jcfischer", "holly"] });
  });

  test("federated with no accept → error (default-deny)", () => {
    const r = buildOffering({ capability: "research.medline", scope: "federated" });
    expect(r.ok).toBe(false);
  });

  test("public surface/repo predicate", () => {
    const r = buildOffering({ capability: "code-review.public", scope: "public", accept: "surface:github/repo:the-metafactory/*" });
    expect(r.ok).toBe(true);
    if (r.ok && r.offering.accept?.kind === "surface") {
      expect(r.offering.accept.surface).toBe("github");
      expect(r.offering.accept.predicate).toEqual({ kind: "repo-membership", repos: ["the-metafactory/*"] });
    }
  });

  test("public content-dependent predicate → rejected (ADR-0010)", () => {
    const r = buildOffering({ capability: "code-review.public", scope: "public", accept: "surface:github/description-contains:urgent" });
    expect(r.ok).toBe(false);
  });

  test("local scope + --accept → error", () => {
    const r = buildOffering({ capability: "chat", scope: "local", accept: "network:x" });
    expect(r.ok).toBe(false);
  });

  test("single-segment capability is fine for local scope", () => {
    const r = buildOffering({ capability: "chat", scope: "local" });
    expect(r.ok).toBe(true);
  });

  test("single-segment capability rejected for federated scope with clear message (PR #967 BLOCKER 2)", () => {
    const r = buildOffering({ capability: "chat", scope: "federated", network: "metafactory-net" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("single-segment");
  });

  test("single-segment capability rejected for public scope (PR #967 BLOCKER 2)", () => {
    const r = buildOffering({ capability: "research", scope: "public", accept: "surface:github/repo:the-metafactory/*" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("announce_capabilities");
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

  test("dropping the only widened scope removes the offering, reported narrowed", () => {
    const r = applyRevoke([OFFER_FED_NET], "code-review.typescript", "federated");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.offerings).toHaveLength(0);
      // The scope WAS present → narrowed (the entry-removal is the consequence).
      expect(r.result.note.action).toBe("narrowed");
    }
  });

  test("revoking a scope NOT on the offering is a no-op (action: absent), offering untouched (PR #967 MAJOR)", () => {
    // OFFER_FED_NET has scopes ["federated"]. Revoking --scope public must NOT
    // splice it out and must NOT report narrowed — it reports absent + leaves
    // the federated offering intact.
    const r = applyRevoke([OFFER_FED_NET], "code-review.typescript", "public");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.note.action).toBe("absent");
      expect(r.result.offerings).toHaveLength(1);
      expect(r.result.offerings[0]?.scopes).toEqual(["federated"]);
    }
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

  test("cross-principal stack.id override: accept_subjects use principal.id (wire source), not stack.id's principal half (PR #967 BLOCKER 1)", () => {
    // principal.id: andreas running stack.id: jcfischer/sage-host. The runtime
    // subscribes on federated.ANDREAS.sage-host.* (principal.id is the wire
    // source), so the generated accept_subjects MUST carry `andreas`, not the
    // `jcfischer` half of stack.id (which deriveStackId().principal would yield).
    const layer: Rec = {
      principal: { id: "andreas" },
      stack: { id: "jcfischer/sage-host" },
      policy: {
        federated: {
          networks: [{ id: "metafactory-net", leaf_node: "leaf", max_hop: 1, peers: [] }],
          registry: { url: "https://registry.example" },
        },
      },
    };
    const { layer: out } = reconcileLayer(layer, [OFFER_FED_NET]);
    const net = ((out.policy as Rec).federated as Rec).networks as Rec[];
    expect(net[0]?.accept_subjects).toEqual([
      "federated.andreas.sage-host.tasks.code-review.typescript.>",
    ]);
    // Defensive: the stack.id principal half must NOT leak onto the wire.
    expect((net[0]?.accept_subjects as string[])[0]).not.toContain("jcfischer");
  });
});

// ===========================================================================
// mergeOfferAcceptSubjects — the pure least-privilege preserve-merge (#1097)
// ===========================================================================

describe("mergeOfferAcceptSubjects", () => {
  test("preserves non-offer rows (OWN `.>`, peer `.agent.>`), appends capability rows", () => {
    const prior = [
      "federated.andreas.work.>",
      "federated.jc.sage-host.agent.>",
    ];
    const caps = ["federated.andreas.work.tasks.code-review.typescript.>"];
    expect(mergeOfferAcceptSubjects(prior, caps, "andreas", "work")).toEqual([
      "federated.andreas.work.>",
      "federated.jc.sage-host.agent.>",
      "federated.andreas.work.tasks.code-review.typescript.>",
    ]);
  });

  test("regenerates own `…tasks.*.>` rows — a stale capability row is dropped", () => {
    const prior = [
      "federated.andreas.work.>",
      "federated.andreas.work.tasks.old-cap.>", // stale — offer-owned, not in caps
    ];
    const caps = ["federated.andreas.work.tasks.new-cap.>"];
    expect(mergeOfferAcceptSubjects(prior, caps, "andreas", "work")).toEqual([
      "federated.andreas.work.>",
      "federated.andreas.work.tasks.new-cap.>",
    ]);
  });

  test("does not duplicate a capability row already hand-pinned in prior", () => {
    const cap = "federated.andreas.work.tasks.code-review.typescript.>";
    // The hand-pin is an own-`…tasks.` row → the offer writer OWNS it, so it is
    // dropped from `preserved` and re-added once from caps (no duplicate).
    expect(mergeOfferAcceptSubjects([cap], [cap], "andreas", "work")).toEqual([cap]);
  });

  test("empty caps + only presence rows → presence rows survive, no dispatch rows", () => {
    const prior = ["federated.andreas.work.>", "federated.jc.sage-host.agent.>"];
    expect(mergeOfferAcceptSubjects(prior, [], "andreas", "work")).toEqual(prior);
  });

  test("a DIFFERENT principal's `…tasks.` row is NOT offer-owned → preserved", () => {
    // Defensive: the own-prefix is identity-scoped. A peer's tasks row (should
    // never appear, but if it does) is not this writer's to regenerate.
    const prior = ["federated.jc.sage-host.tasks.code-review.>"];
    const caps = ["federated.andreas.work.tasks.chat.>"];
    expect(mergeOfferAcceptSubjects(prior, caps, "andreas", "work")).toEqual([
      "federated.jc.sage-host.tasks.code-review.>",
      "federated.andreas.work.tasks.chat.>",
    ]);
  });
});

// ===========================================================================
// reconcileLayer — co-existence with the PRESENCE-wiring accept-list writer
// (cortex#1097, umbrella #1084 P2.1; least-privilege per #1105)
//
// `policy.federated.networks[].accept_subjects` has TWO writers:
//   - the PRESENCE path (`network join` / reconciler, via `deriveAcceptSubjects`)
//     writes the OWN `.>` subtree ∪ each roster peer's `.agent.>` presence subtree.
//   - this offer-mode DISPATCH writer regenerates the capability-dispatch rows
//     `federated.{me}.{stack}.tasks.{cap}.>` from the offerings.
// They share ONE array. The offer writer must own ONLY its own-identity
// `…tasks.*.>` dispatch rows and PRESERVE everything else, or an `offer --apply`
// silently clobbers the peer presence subtrees and regresses P2/#1105.
// ===========================================================================

describe("reconcileLayer — preserves presence-wiring accept-subjects (#1097)", () => {
  const OWN_SUBTREE = "federated.andreas.work.>";
  const PEER_PRESENCE_JC = "federated.jc.sage-host.agent.>";
  const PEER_PRESENCE_KZ = "federated.kz.research.agent.>";
  const CAP_DISPATCH = "federated.andreas.work.tasks.code-review.typescript.>";

  /** A layer whose network already carries the presence-wiring accept-list
   *  (OWN `.>` ∪ two peer `.agent.>` subtrees), as `network join` would write. */
  const layerWithPresence = (extraAccept: string[] = []): Rec => ({
    principal: { id: "andreas" },
    stack: { id: "andreas/work" },
    policy: {
      federated: {
        networks: [
          {
            id: "metafactory-net",
            leaf_node: "leaf",
            max_hop: 1,
            peers: [
              { principal: "jc", stack: "sage-host" },
              { principal: "kz", stack: "research" },
            ],
            accept_subjects: [OWN_SUBTREE, PEER_PRESENCE_JC, PEER_PRESENCE_KZ, ...extraAccept],
            announce_capabilities: [],
          },
        ],
        registry: { url: "https://registry.example" },
      },
    },
  });

  test("adding a federated offering PRESERVES the OWN `.>` + peer `.agent.>` presence rows", () => {
    const { layer } = reconcileLayer(layerWithPresence(), [OFFER_FED_NET]);
    const net = ((layer.policy as Rec).federated as Rec).networks as Rec[];
    const accept = net[0]?.accept_subjects as string[];
    // Presence-wiring rows survive untouched.
    expect(accept).toContain(OWN_SUBTREE);
    expect(accept).toContain(PEER_PRESENCE_JC);
    expect(accept).toContain(PEER_PRESENCE_KZ);
    // The capability-dispatch row is added alongside them.
    expect(accept).toContain(CAP_DISPATCH);
  });

  test("the offer writer never widens to a peer's FULL `.>` subtree (least-privilege #1105)", () => {
    const { layer } = reconcileLayer(layerWithPresence(), [OFFER_FED_NET]);
    const net = ((layer.policy as Rec).federated as Rec).networks as Rec[];
    const accept = net[0]?.accept_subjects as string[];
    // A peer's full subtree (which would admit peer-DESTINED dispatch) must NOT appear.
    expect(accept).not.toContain("federated.jc.sage-host.>");
    expect(accept).not.toContain("federated.kz.research.>");
  });

  test("revoking the last federated offering drops the stale capability row but KEEPS presence rows", () => {
    // Seed: presence rows + a stale capability-dispatch row, plus the offering.
    const seeded = layerWithPresence([CAP_DISPATCH]);
    (seeded.policy as Rec).offerings = [OFFER_FED_NET];
    const { layer } = reconcileLayer(seeded, []); // all offerings revoked
    const net = ((layer.policy as Rec).federated as Rec).networks as Rec[];
    const accept = net[0]?.accept_subjects as string[];
    // The offer writer's own stale dispatch row is gone…
    expect(accept).not.toContain(CAP_DISPATCH);
    // …but the presence-wiring rows it does NOT own are preserved.
    expect(accept).toContain(OWN_SUBTREE);
    expect(accept).toContain(PEER_PRESENCE_JC);
    expect(accept).toContain(PEER_PRESENCE_KZ);
  });

  test("regenerating is idempotent — re-running with the same offering does not duplicate rows", () => {
    const first = reconcileLayer(layerWithPresence(), [OFFER_FED_NET]).layer;
    const firstNet = ((first.policy as Rec).federated as Rec).networks as Rec[];
    const second = reconcileLayer(first, [OFFER_FED_NET]).layer;
    const secondNet = ((second.policy as Rec).federated as Rec).networks as Rec[];
    expect(secondNet[0]?.accept_subjects).toEqual(firstNet[0]?.accept_subjects);
    // And exactly one capability-dispatch row.
    const dispatchRows = (secondNet[0]?.accept_subjects as string[]).filter((s) => s === CAP_DISPATCH);
    expect(dispatchRows).toHaveLength(1);
  });

  test("a network with NO prior accept-list (greenfield) still gets the capability dispatch row", () => {
    // Regression guard: the preserve-merge must not break the empty-prior case
    // (the existing `reconcileLayer` happy path).
    const greenfield: Rec = {
      principal: { id: "andreas" },
      stack: { id: "andreas/work" },
      policy: {
        federated: {
          networks: [{ id: "metafactory-net", leaf_node: "leaf", max_hop: 1, peers: [] }],
          registry: { url: "https://registry.example" },
        },
      },
    };
    const { layer } = reconcileLayer(greenfield, [OFFER_FED_NET]);
    const net = ((layer.policy as Rec).federated as Rec).networks as Rec[];
    expect(net[0]?.accept_subjects).toEqual([CAP_DISPATCH]);
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

function makeSplitDir(
  stacks: Record<string, Rec>,
  slug = "offer-test-cfg",
  agentsd: Record<string, Rec> = {},
): string {
  const dir = join(tmpDir, slug);
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), SYSTEM_YAML, "utf-8");
  for (const [name, content] of Object.entries(stacks)) {
    writeFileSync(join(dir, "stacks", `${name}.yaml`), YAML.stringify(content, { indent: 2, lineWidth: 0 }), "utf-8");
  }
  // Optional bot-pack agents under `agents.d/<id>.yaml`, each with a sibling
  // persona file (loadAgentsDirectory rejects a fragment whose persona path
  // does not resolve). Mirrors the daemon-boot fragment layout (cortex#1071).
  const entries = Object.entries(agentsd);
  if (entries.length > 0) {
    const agentsDir = join(dir, "agents.d");
    mkdirSync(agentsDir, { recursive: true });
    for (const [id, fragment] of entries) {
      writeFileSync(join(agentsDir, `${id}.md`), `# ${id} persona\n`, "utf-8");
      writeFileSync(
        join(agentsDir, `${id}.yaml`),
        YAML.stringify({ persona: `./${id}.md`, ...fragment }, { indent: 2, lineWidth: 0 }),
        "utf-8",
      );
    }
  }
  return dir;
}

/**
 * A bot-pack agent fragment (the `agents.d/<id>.yaml` shape) declaring a
 * capability via `runtime.capabilities[]` — e.g. the dev-loop `dev` agent
 * providing `dev.implement` (cortex#1071). There is deliberately NO top-level
 * `capabilities[]` catalog entry for it on the stack; the catalog the offer
 * command validates against must be DERIVED from this fragment, mirroring what
 * the daemon trusts at boot.
 */
function botPackAgent(id: string, capabilities: string[]): Rec {
  return {
    id,
    displayName: id,
    presence: {},
    runtime: { substrate: "claude-code", mode: "in-process", capabilities },
  };
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

  test("set single-segment capability federated → exit 2 (usage) with clear message, no write (PR #967 BLOCKER 2)", async () => {
    // `chat` is a single-segment capability in the catalog. Offering it
    // federated must fail at the buildOffering pre-flight (usage error, exit 2)
    // with a CLEAR message — NOT an opaque validateComposed schema failure.
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
    const before = readFileSync(join(dir, "stacks", "work.yaml"), "utf-8");
    const r = await run(["chat", "--scope", "federated", "--network", "metafactory-net", "--config", dir, "--apply"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("single-segment");
    const after = readFileSync(join(dir, "stacks", "work.yaml"), "utf-8");
    expect(after).toBe(before); // disk untouched
  });

  test("set dotted capability federated --apply succeeds (the BLOCKER-2 happy path)", async () => {
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
    const r = await run(["code-review.typescript", "--scope", "federated", "--network", "metafactory-net", "--config", dir, "--apply"]);
    expect(r.code).toBe(0);
    const written = YAML.parse(readFileSync(join(dir, "stacks", "work.yaml"), "utf-8")) as Rec;
    const net = ((written.policy as Rec).federated as Rec).networks as Rec[];
    expect(net[0]?.announce_capabilities).toEqual(["code-review.typescript"]);
  });

  // =========================================================================
  // cortex#1071 — offer set/list folds agents.d (bot-pack-provided caps).
  //
  // A capability declared ONLY in a bot-pack fragment's
  // `agents.d/<id>.yaml` `runtime.capabilities[]` (no top-level
  // `capabilities[]` catalog entry on the stack) must be offerable: the
  // offer-validation path derives the effective catalog the same way the
  // daemon trusts merged agents at boot. Mirrors the dev-loop case
  // (`dev.implement` provided by the `dev` bot-pack agent).
  // =========================================================================

  test("set federated for a bot-pack (agents.d) capability validates + writes (cortex#1071)", async () => {
    const dir = makeSplitDir(
      {
        // Stack offers dev.implement but declares NO catalog entry for it —
        // only the inline echo agent's code-review.typescript / chat exist.
        work: stackLayer({
          policy: {
            federated: {
              networks: [{ id: "metafactory-net", leaf_node: "leaf", max_hop: 1, peers: [] }],
              registry: { url: "https://registry.example" },
            },
          },
        }),
      },
      "offer-test-cfg",
      { dev: botPackAgent("dev", ["dev.implement"]) },
    );
    // Pre-fix this fails: the composed config has no `dev.implement` in
    // capabilities[] (composeRawConfig doesn't fold agents.d), so
    // CortexConfigSchema rejects the offering. Post-fix the derived catalog
    // carries it (provided_by:[dev]) and validation passes.
    const r = await run([
      "dev.implement", "--scope", "federated", "--network", "metafactory-net",
      "--config", dir, "--apply",
    ]);
    expect(r.code).toBe(0);
    const written = YAML.parse(readFileSync(join(dir, "stacks", "work.yaml"), "utf-8")) as Rec;
    const policy = written.policy as Rec;
    expect((policy.offerings as Rec[])[0]?.capability).toBe("dev.implement");
    const net = (policy.federated as Rec).networks as Rec[];
    expect(net[0]?.announce_capabilities).toEqual(["dev.implement"]);
    expect(net[0]?.accept_subjects).toEqual([
      "federated.andreas.work.tasks.dev.implement.>",
    ]);
  });

  test("set local for a bot-pack capability validates (no catalog entry needed) (cortex#1071)", async () => {
    const dir = makeSplitDir(
      { work: stackLayer() },
      "offer-test-cfg",
      { dev: botPackAgent("dev", ["dev.implement"]) },
    );
    const r = await run(["dev.implement", "--scope", "local", "--config", dir, "--apply"]);
    expect(r.code).toBe(0);
    const written = YAML.parse(readFileSync(join(dir, "stacks", "work.yaml"), "utf-8")) as Rec;
    expect(((written.policy as Rec).offerings as Rec[])[0]?.capability).toBe("dev.implement");
  });

  test("list surfaces a bot-pack capability with its provider agent (cortex#1071)", async () => {
    const dir = makeSplitDir(
      {
        work: stackLayer({
          policy: {
            offerings: [{ capability: "dev.implement", scopes: ["local"] }],
          },
        }),
      },
      "offer-test-cfg",
      { dev: botPackAgent("dev", ["dev.implement"]) },
    );
    const r = await run(["list", "--config", dir]);
    expect(r.code).toBe(0);
    // The derived catalog makes the bot-pack capability visible in list,
    // attributed to its providing agent.
    expect(r.stdout).toContain("dev.implement");
    expect(r.stdout).toContain("dev");
  });

  test("a still-unknown capability (no catalog entry, no agents.d provider) → exit 1 (cortex#1071 guard)", async () => {
    // The fold must not turn the catalog into a free-for-all: a capability
    // that no inline catalog entry AND no agents.d agent provides still fails.
    const dir = makeSplitDir(
      { work: stackLayer() },
      "offer-test-cfg",
      { dev: botPackAgent("dev", ["dev.implement"]) },
    );
    const before = readFileSync(join(dir, "stacks", "work.yaml"), "utf-8");
    const r = await run(["ghost.capability", "--scope", "local", "--config", dir, "--apply"]);
    expect(r.code).toBe(1);
    expect(readFileSync(join(dir, "stacks", "work.yaml"), "utf-8")).toBe(before);
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
