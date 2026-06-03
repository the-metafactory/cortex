/**
 * G-1113.D.2 — Plan-doc ingestion: parser purity + round-trip persistence.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { getPlan, listPlans, listPhasesForPlan } from "../db/plans";
import {
  parsePlanDoc,
  ingestPlanDoc,
  ingestPlanDocsFromDir,
} from "../ingest/plan-docs";
import { parseGitHubRef, isParseError, canonicalRef } from "../adapters/github";

// Cockpit-plan shape: H1 title, **Status:** line, numbered phase headings with id suffix.
const COCKPIT = `# Plan — Mission Control Cortex Cockpit (G-1113)

**Status:** draft for review

## 5. Phases

### 5.1 Phase A — Grounding (G-1113.A)
- [ ] something
### 5.2 Phase B — Provider-Neutral Source Refs (G-1113.B)
### 5.3 Phase C — Software Mode Domain Model (G-1113.C)
### 5.4 Phase D — Plan Lineage UI (G-1113.D)
### 5.5 Phase E — Attention + Notifications (G-1113.E)
`;

// Iteration shape: bare `## Phase X — Title` headings, no numeric prefix, no Status line.
const ITERATION = `# Mission Control v2 — Iteration plan

## Phase A — Data foundation + local bot scaffold
## Phase B — Dashboard attention core
`;

describe("parsePlanDoc (D.2, pure)", () => {
  it("parses cockpit-shaped doc: title, kind, status, 5 ordered phases", () => {
    const { plan, phases } = parsePlanDoc({
      content: COCKPIT,
      path: "docs/plan-mission-control-cockpit.md",
      sourceDocumentUrl: "https://example/blob/docs/plan-mission-control-cockpit.md",
    });
    expect(plan.id).toBe("plan-mission-control-cockpit");
    expect(plan.title).toBe("Plan — Mission Control Cortex Cockpit (G-1113)");
    expect(plan.kind).toBe("design"); // generic plan default
    expect(plan.status).toBe("draft"); // from "**Status:** draft for review"
    expect(plan.provider).toBe("internal"); // repo-local doc default
    expect(plan.externalId).toBeNull();
    expect(plan.umbrellaWorkItemId).toBeNull();
    expect(plan.sourceDocumentUrl).toBe(
      "https://example/blob/docs/plan-mission-control-cockpit.md"
    );
    // 5 phases A–E, document order, trailing "(G-1113.x)" stripped, default not_started.
    expect(phases.map((p) => [p.id, p.title, p.order, p.status])).toEqual([
      ["plan-mission-control-cockpit-phase-a", "Grounding", 0, "not_started"],
      ["plan-mission-control-cockpit-phase-b", "Provider-Neutral Source Refs", 1, "not_started"],
      ["plan-mission-control-cockpit-phase-c", "Software Mode Domain Model", 2, "not_started"],
      ["plan-mission-control-cockpit-phase-d", "Plan Lineage UI", 3, "not_started"],
      ["plan-mission-control-cockpit-phase-e", "Attention + Notifications", 4, "not_started"],
    ]);
    expect(phases.every((p) => p.planId === plan.id)).toBe(true);
  });

  it("parses iteration-shaped doc: kind=iteration, bare phase headings, status defaults active", () => {
    const { plan, phases } = parsePlanDoc({
      content: ITERATION,
      path: "docs/iteration-mission-control.md",
    });
    expect(plan.kind).toBe("iteration");
    expect(plan.status).toBe("active"); // no **Status:** line → active default
    expect(plan.sourceDocumentUrl).toBeNull();
    expect(phases.map((p) => p.title)).toEqual([
      "Data foundation + local bot scaffold",
      "Dashboard attention core",
    ]);
  });

  it("infers kind from filename / title keywords", () => {
    const k = (path: string, content = "# T\n") => parsePlanDoc({ content, path }).plan.kind;
    expect(k("docs/iteration-x.md")).toBe("iteration");
    expect(k("docs/plan-cortex-migration.md")).toBe("migration");
    expect(k("docs/plan-prod-rollout.md")).toBe("rollout");
    expect(k("docs/plan-v3-release.md")).toBe("release");
    expect(k("docs/plan-incident-2026.md")).toBe("incident");
    expect(k("docs/plan-research-spike.md")).toBe("research");
    expect(k("docs/plan-collaboration-surface.md")).toBe("design"); // default
  });

  it("does not false-match separator-less headings (corpus near-misses)", () => {
    const { phases } = parsePlanDoc({
      content: [
        "# T",
        "## 4. Phase sequencing", // no separator
        "## 4. Phase-by-phase plan", // hyphen-joined, not 'Phase <label>'
        "### Phase A acceptance criteria — ✅ all met (2026-05-15)", // IoAW:149 — words before dash
        "### Cross-phase parallelism during Phase B", // 'Phase' not at heading start
      ].join("\n"),
      path: "docs/plan-x.md",
    });
    expect(phases).toHaveLength(0);
  });

  it("preserves descriptive trailing parens; strips only id-shaped ones (IoAW corpus)", () => {
    const { phases } = parsePlanDoc({
      content: [
        "# Internet of Agentic Work",
        "## 2. Phase A — Foundation (substrate harness + visibility consumption + stack identity)",
        "## 3. Phase B — Identity (NKey-signed bot↔bot)",
        "## 4. Phase C — Policy + schema flip (PolicyEngine at M6)",
        "### 5.4 Phase D — Plan Lineage UI (G-1113.D)", // id-shaped → stripped
      ].join("\n"),
      path: "docs/plan-internet-of-agentic-work.md",
    });
    expect(phases.map((p) => p.title)).toEqual([
      "Foundation (substrate harness + visibility consumption + stack identity)",
      "Identity (NKey-signed bot↔bot)",
      "Policy + schema flip (PolicyEngine at M6)",
      "Plan Lineage UI", // (G-1113.D) stripped
    ]);
  });

  it("parses colon-delimited phase headings; preserves non-id '(Future)' (licensing corpus)", () => {
    const { phases } = parsePlanDoc({
      content: [
        "# Licensing",
        "## Phase 2A: License Foundation",
        "## Phase 2B: Attribution and Documentation",
        "## Phase 2D: Brand Protection (Future)",
      ].join("\n"),
      path: "docs/iteration-licensing.md",
    });
    expect(phases.map((p) => [p.id, p.title])).toEqual([
      ["iteration-licensing-phase-2a", "License Foundation"],
      ["iteration-licensing-phase-2b", "Attribution and Documentation"],
      ["iteration-licensing-phase-2d", "Brand Protection (Future)"],
    ]);
  });

  it("status: leading clause wins over narrative prose; word-boundaried (corpus)", () => {
    const status = (line: string) =>
      parsePlanDoc({ content: `# T\n\n**Status:** ${line}\n`, path: "docs/plan-x.md" }).plan.status;
    // direction-a: "Active campaign … ~75% done already" → active, not done
    expect(status("Active campaign. Re-grounded after audit revealed ~75% done already")).toBe("active");
    expect(status("disclosed scope")).not.toBe("done"); // 'closed' ⊄ 'disclosed'
    expect(status("Planned")).toBe("draft"); // licensing
    expect(status("draft for review")).toBe("draft"); // cockpit
    expect(status("Blocked on cortex#535")).toBe("blocked");
  });

  it("doc with no phase headings → plan with zero phases (still valid)", () => {
    const { plan, phases } = parsePlanDoc({
      content: "# Just a plan\n\nProse only.\n",
      path: "docs/plan-prose.md",
    });
    expect(plan.id).toBe("plan-prose");
    expect(phases).toEqual([]);
  });
});

describe("ingestPlanDoc / ingestPlanDocsFromDir (D.2, persistence)", () => {
  const dbPaths: string[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const p of dbPaths) if (existsSync(p)) rmSync(p);
    for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    dbPaths.length = 0;
    dirs.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `plandocs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbPaths.push(p);
    return initDatabase(p);
  }

  it("round-trips a doc into plan + phase rows; idempotent re-ingest", () => {
    const db = freshDb();
    const src = { content: COCKPIT, path: "docs/plan-mission-control-cockpit.md" };
    ingestPlanDoc(db, src);
    const plan = getPlan(db, "plan-mission-control-cockpit");
    expect(plan?.kind).toBe("design");
    expect(listPhasesForPlan(db, "plan-mission-control-cockpit")).toHaveLength(5);
    // Re-ingesting the same doc updates in place — no duplicate plan or phase rows.
    ingestPlanDoc(db, src);
    expect(listPlans(db)).toHaveLength(1);
    expect(listPhasesForPlan(db, "plan-mission-control-cockpit")).toHaveLength(5);
  });

  it("scans a dir for plan-*/iteration-* docs only, building source URLs", () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "plandocs-dir-"));
    dirs.push(dir);
    writeFileSync(join(dir, "plan-mission-control-cockpit.md"), COCKPIT);
    writeFileSync(join(dir, "iteration-mission-control.md"), ITERATION);
    writeFileSync(join(dir, "architecture.md"), "# Not a plan\n## Phase A — nope\n"); // ignored

    const ingested = ingestPlanDocsFromDir(db, {
      docsDir: dir,
      urlForPath: (rel) => `https://example/blob/${rel}`,
    });

    expect(ingested.map((p) => p.plan.id).sort()).toEqual([
      "iteration-mission-control",
      "plan-mission-control-cockpit",
    ]);
    expect(listPlans(db)).toHaveLength(2); // architecture.md skipped
    expect(getPlan(db, "plan-mission-control-cockpit")?.sourceDocumentUrl).toBe(
      "https://example/blob/docs/plan-mission-control-cockpit.md"
    );
    expect(getPlan(db, "architecture")).toBeNull();
  });
});

describe("parsePlanDoc — umbrella linkage (ML.1)", () => {
  const docWith = (umbrellaLine: string) =>
    `# A plan\n\n**Status:** active\n${umbrellaLine}\n\n## Phase A — X\n`;

  it("parses a full owner/repo#N umbrella ref → owner/repo#N + github provider", () => {
    const { plan } = parsePlanDoc({
      content: docWith("**Umbrella issue:** the-metafactory/cortex#354"),
      path: "docs/plan-x.md",
    });
    expect(plan.umbrellaWorkItemId).toBe("the-metafactory/cortex#354");
    expect(plan.provider).toBe("github"); // a github umbrella implies github provider
  });

  it("parses a GitHub issues URL", () => {
    const { plan } = parsePlanDoc({
      content: docWith("**Umbrella:** https://github.com/the-metafactory/cortex/issues/110"),
      path: "docs/plan-x.md",
    });
    expect(plan.umbrellaWorkItemId).toBe("the-metafactory/cortex#110");
  });

  it("qualifies a short ref (#N) via defaultRepo", () => {
    const { plan } = parsePlanDoc({
      content: docWith("**Umbrella issue:** #354"),
      path: "docs/plan-x.md",
      defaultRepo: { owner: "the-metafactory", repo: "cortex" },
    });
    expect(plan.umbrellaWorkItemId).toBe("the-metafactory/cortex#354");
  });

  it("a short ref with NO defaultRepo → null (can't qualify, honest)", () => {
    const { plan } = parsePlanDoc({
      content: docWith("**Umbrella issue:** #354"),
      path: "docs/plan-x.md",
    });
    expect(plan.umbrellaWorkItemId).toBeNull();
    expect(plan.provider).toBe("internal"); // no github umbrella → stays internal
  });

  it("a placeholder umbrella line → null (the cockpit doc's '_(to be filed)_' case)", () => {
    const { plan } = parsePlanDoc({
      content: docWith("**Umbrella issue:** _(to be filed once this plan is agreed)_"),
      path: "docs/plan-x.md",
      defaultRepo: { owner: "the-metafactory", repo: "cortex" },
    });
    expect(plan.umbrellaWorkItemId).toBeNull();
  });

  it("markdown-link form resolves via the URL (not the bracketed label) → correct repo", () => {
    // Real iteration-doc form: `[#59](https://github.com/.../grove-v2/issues/59)`.
    // The URL (grove-v2) must win over the bare `#59` label, even with a
    // cortex defaultRepo present — else D.5b fetches the wrong repo's issue.
    const { plan } = parsePlanDoc({
      content: docWith("**Umbrella issue:** [#59](https://github.com/the-metafactory/grove-v2/issues/59)"),
      path: "docs/iteration-x.md",
      defaultRepo: { owner: "the-metafactory", repo: "cortex" },
    });
    expect(plan.umbrellaWorkItemId).toBe("the-metafactory/grove-v2#59");
  });

  it("repo-shorthand cortex#110: null without defaultRepo, qualified with it", () => {
    const line = "**Umbrella issue:** cortex#110";
    expect(parsePlanDoc({ content: docWith(line), path: "docs/plan-x.md" }).plan.umbrellaWorkItemId).toBeNull();
    const qualified = parsePlanDoc({
      content: docWith(line),
      path: "docs/plan-x.md",
      defaultRepo: { owner: "the-metafactory", repo: "cortex" },
    }).plan.umbrellaWorkItemId;
    expect(qualified).toBe("the-metafactory/cortex#110");
  });

  it("round-trips through D.5b's parser: umbrellaWorkItemId reparses identically (the integration contract)", () => {
    for (const line of [
      "**Umbrella issue:** the-metafactory/cortex#354",
      "**Umbrella:** https://github.com/the-metafactory/cortex/issues/110",
    ]) {
      const id = parsePlanDoc({ content: docWith(line), path: "docs/plan-x.md" }).plan.umbrellaWorkItemId;
      expect(id).not.toBeNull();
      if (id === null) continue; // narrow for the round-trip below
      // GithubWorkItemSource calls parseGitHubRef(plan.umbrellaWorkItemId) with NO defaults.
      const ref = parseGitHubRef(id);
      expect(isParseError(ref)).toBe(false);
      if (!isParseError(ref)) expect(canonicalRef(ref)).toBe(id); // stable round-trip
    }
  });

  it("no umbrella line → null; an explicit provider is not overridden by an umbrella", () => {
    expect(parsePlanDoc({ content: docWith(""), path: "docs/plan-x.md" }).plan.umbrellaWorkItemId).toBeNull();
    const { plan } = parsePlanDoc({
      content: docWith("**Umbrella issue:** the-metafactory/cortex#354"),
      path: "docs/plan-x.md",
      provider: "internal", // explicit wins over the github-umbrella inference
    });
    expect(plan.umbrellaWorkItemId).toBe("the-metafactory/cortex#354");
    expect(plan.provider).toBe("internal");
  });
});
