/**
 * F-17 — pure tests for the GitHub iteration auto-import module.
 *
 * Exercises `api/iteration-import.ts` against an in-memory SQLite
 * harness (same shape as `iterations.test.ts`). No HTTP, no gh CLI,
 * no WebSocket — just the import logic + the schema columns it
 * touches (`imported_body`, `imported_at`, `source_parent_ref`).
 *
 * Decision references (see docs/design-mc-iteration-planning.md):
 *   D1  — Grove owns the lifecycle. Source is import-only.
 *   D2  — GitHub parent-issue + sub-issues IS the iteration.
 *   D5  — Principal-driven promotion only (auto-import lands in inbox).
 *   D9  — No write-back; subsequent principal edits never overwritten.
 *   D10 Q6 — explicit `iteration` label (configurable per-network).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../db/init";
import {
  findIterationBySourceParentRef,
  getIteration,
  updateIteration,
  type IterationRow,
} from "../db/iterations";
import {
  DEFAULT_ITERATION_LABEL,
  IMPORTED_BODY_MAX_BYTES,
  hasIterationLabel,
  importIterationFromMetadata,
  importSubIssueFromMetadata,
  parentRef,
  truncateToBytes,
  type ParentIssueMetadata,
  type SubIssueMetadata,
} from "../api/iteration-import";
// D.7b — GitHub payload parsers moved behind the adapter boundary.
import {
  parentMetadataFromGhResponse,
  parentMetadataFromWebhook,
  subIssueRefsFromWebhook,
} from "../adapters/github";

interface H {
  db: Database;
  tmpDir: string;
}

function mkdb(): H {
  const tmpDir = join(tmpdir(), `mc-import-test-${Date.now()}-${Math.random()}`);
  const db = initDatabase(join(tmpDir, "test.db"));
  return { db, tmpDir };
}

function teardown(h: H): void {
  h.db.close();
  rmSync(h.tmpDir, { recursive: true, force: true });
}

function makeMeta(over: Partial<ParentIssueMetadata> = {}): ParentIssueMetadata {
  return {
    owner: "the-metafactory",
    repo: "grove-v2",
    number: 42,
    title: "Phase G — PM agent role",
    body: "We want a long-running head agent that drafts iterations.",
    htmlUrl: "https://github.com/the-metafactory/grove-v2/issues/42",
    labels: ["iteration", "feature"],
    ...over,
  };
}

function makeSub(over: Partial<SubIssueMetadata> = {}): SubIssueMetadata {
  return {
    owner: "the-metafactory",
    repo: "grove-v2",
    number: 100,
    title: "Sub: define PM assistant",
    state: "open",
    htmlUrl: "https://github.com/the-metafactory/grove-v2/issues/100",
    ...over,
  };
}

// =============================================================================
// hasIterationLabel + parentRef + truncateToBytes
// =============================================================================

describe("hasIterationLabel", () => {
  it("returns true when the default label is present", () => {
    expect(hasIterationLabel(["iteration", "bug"])).toBe(true);
  });

  it("returns false when only other labels are present", () => {
    expect(hasIterationLabel(["bug", "feature"])).toBe(false);
  });

  it("respects a per-call override", () => {
    expect(hasIterationLabel(["epic"], "epic")).toBe(true);
    expect(hasIterationLabel(["iteration"], "epic")).toBe(false);
  });

  it("is case-sensitive (Iteration ≠ iteration)", () => {
    // Intentional — GitHub labels are case-preserving and the principal
    // must apply the exact label string they configured.
    expect(hasIterationLabel(["Iteration"])).toBe(false);
  });
});

describe("parentRef", () => {
  it("emits the canonical owner/repo#N form", () => {
    expect(parentRef({ owner: "x", repo: "y", number: 42 })).toBe("x/y#42");
  });
});

describe("truncateToBytes", () => {
  it("returns the input unchanged when within the cap", () => {
    expect(truncateToBytes("hello", 100)).toBe("hello");
  });

  it("truncates to the byte cap when oversized", () => {
    const big = "x".repeat(60_000);
    const out = truncateToBytes(big, 1024);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024);
  });

  it("does not emit a partial multi-byte UTF-8 sequence at the boundary", () => {
    // U+1F4A9 (💩) is 4 bytes. A 5-byte cap should yield a string that
    // either contains the full glyph or stops cleanly before it.
    const input = "ab💩cd";
    const out = truncateToBytes(input, 5);
    // No replacement char from a torn surrogate.
    expect(out.endsWith("�")).toBe(false);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(5);
  });
});

// =============================================================================
// importIterationFromMetadata — fresh, idempotent, label-gated
// =============================================================================

describe("importIterationFromMetadata", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("creates a new iteration row on a fresh import", () => {
    const result = importIterationFromMetadata(h.db, makeMeta());
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.iteration.title).toBe("Phase G — PM agent role");
    expect(result.iteration.state).toBe("inbox");
    expect(result.iteration.priority).toBe(2);
    expect(result.iteration.source_system).toBe("github");
    expect(result.iteration.source_parent_ref).toBe(
      "the-metafactory/grove-v2#42"
    );
    expect(result.iteration.source_url).toBe(
      "https://github.com/the-metafactory/grove-v2/issues/42"
    );
    expect(result.iteration.imported_at).not.toBeNull();
  });

  it("seeds both `body` and `imported_body` to the upstream body on fresh import", () => {
    const result = importIterationFromMetadata(h.db, makeMeta());
    if (result.kind !== "created") throw new Error("expected created");
    expect(result.iteration.body).toBe(
      "We want a long-running head agent that drafts iterations."
    );
    expect(result.iteration.imported_body).toBe(result.iteration.body);
  });

  it("returns 'exists' on idempotent re-import with unchanged body", () => {
    const first = importIterationFromMetadata(h.db, makeMeta());
    if (first.kind !== "created") throw new Error("expected created");
    const second = importIterationFromMetadata(h.db, makeMeta());
    expect(second.kind).toBe("exists");
    if (second.kind !== "exists") return;
    expect(second.bodyRefreshed).toBe(false);
    expect(second.iteration.id).toBe(first.iteration.id);
  });

  it("only one iteration row exists after repeated re-imports", () => {
    importIterationFromMetadata(h.db, makeMeta());
    importIterationFromMetadata(h.db, makeMeta());
    importIterationFromMetadata(h.db, makeMeta());
    const count = (h.db
      .query(`SELECT COUNT(*) AS c FROM iterations`)
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("rejects non-iteration-labelled metadata", () => {
    const result = importIterationFromMetadata(
      h.db,
      makeMeta({ labels: ["bug", "feature"] })
    );
    expect(result.kind).toBe("not_iteration_labelled");
    if (result.kind !== "not_iteration_labelled") return;
    expect(result.canonical).toBe("the-metafactory/grove-v2#42");
    // No row should have been written.
    const count = (h.db
      .query(`SELECT COUNT(*) AS c FROM iterations`)
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("honours a custom iterationLabel option", () => {
    const result = importIterationFromMetadata(
      h.db,
      makeMeta({ labels: ["epic"] }),
      { iterationLabel: "epic" }
    );
    expect(result.kind).toBe("created");
  });

  it("refreshes imported_body but NOT body when upstream body changes (Decision 9)", () => {
    const first = importIterationFromMetadata(h.db, makeMeta());
    if (first.kind !== "created") throw new Error("expected created");

    // Principal edits the live body — Decision 9 says this MUST NOT be
    // clobbered by subsequent upstream changes.
    updateIteration(h.db, first.iteration.id, { body: "principal's notes" });

    // Upstream issue body is rewritten on GitHub. Webhook fires → re-import.
    const second = importIterationFromMetadata(
      h.db,
      makeMeta({ body: "totally rewritten upstream" })
    );
    expect(second.kind).toBe("exists");
    if (second.kind !== "exists") return;
    expect(second.bodyRefreshed).toBe(true);

    // Audit-only `imported_body` follows upstream; live `body` stays
    // principal-sovereign.
    const detail = getIteration(h.db, first.iteration.id);
    expect(detail).not.toBeNull();
    expect(detail!.imported_body).toBe("totally rewritten upstream");
    expect(detail!.body).toBe("principal's notes");
  });

  it("does NOT touch updated_at on a true no-op re-import", () => {
    const first = importIterationFromMetadata(h.db, makeMeta());
    if (first.kind !== "created") throw new Error("expected created");
    const before = first.iteration.updated_at;

    // Spin briefly so any wall-clock-second tick would surface.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    return sleep(1100).then(() => {
      const second = importIterationFromMetadata(h.db, makeMeta());
      expect(second.kind).toBe("exists");
      if (second.kind !== "exists") return;
      expect(second.iteration.updated_at).toBe(before);
    });
  });

  it("clamps an oversized upstream body to IMPORTED_BODY_MAX_BYTES", () => {
    const huge = "x".repeat(IMPORTED_BODY_MAX_BYTES * 2);
    const result = importIterationFromMetadata(
      h.db,
      makeMeta({ body: huge })
    );
    if (result.kind !== "created") throw new Error("expected created");
    const stored = result.iteration.imported_body ?? "";
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      IMPORTED_BODY_MAX_BYTES
    );
  });

  it("persists null body when the upstream body is null", () => {
    const result = importIterationFromMetadata(h.db, makeMeta({ body: null }));
    if (result.kind !== "created") throw new Error("expected created");
    expect(result.iteration.body).toBeNull();
    expect(result.iteration.imported_body).toBeNull();
  });

  it("rejects malformed metadata (negative number)", () => {
    const result = importIterationFromMetadata(h.db, makeMeta({ number: -1 }));
    expect(result.kind).toBe("invalid_metadata");
  });

  it("rejects malformed metadata (non-array labels)", () => {
    // @ts-expect-error - intentional malformed input
    const result = importIterationFromMetadata(h.db, makeMeta({ labels: "iteration" }));
    expect(result.kind).toBe("invalid_metadata");
  });
});

// =============================================================================
// importSubIssueFromMetadata
// =============================================================================

describe("importSubIssueFromMetadata", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  function seedParent(): IterationRow {
    const r = importIterationFromMetadata(h.db, makeMeta());
    if (r.kind !== "created") throw new Error("expected created");
    return r.iteration;
  }

  it("attaches a fresh task to a tracked iteration parent", () => {
    seedParent();
    const result = importSubIssueFromMetadata(
      h.db,
      { owner: "the-metafactory", repo: "grove-v2", number: 42 },
      makeSub()
    );
    expect(result.kind).toBe("attached");
    if (result.kind !== "attached") return;

    const task = h.db
      .query(
        `SELECT title, status, source_system, source_external_id, iteration_id
         FROM tasks WHERE id = ?`
      )
      .get(result.taskId) as Record<string, unknown>;
    expect(task.title).toBe("Sub: define PM assistant");
    expect(task.status).toBe("open");
    expect(task.source_system).toBe("github");
    expect(task.source_external_id).toBe("the-metafactory/grove-v2#100");
    expect(task.iteration_id).toBe(result.iterationId);
  });

  it("is idempotent — re-importing the same sub-issue does not duplicate", () => {
    seedParent();
    const first = importSubIssueFromMetadata(
      h.db,
      { owner: "the-metafactory", repo: "grove-v2", number: 42 },
      makeSub()
    );
    const second = importSubIssueFromMetadata(
      h.db,
      { owner: "the-metafactory", repo: "grove-v2", number: 42 },
      makeSub()
    );
    expect(first.kind).toBe("attached");
    expect(second.kind).toBe("exists");
    if (second.kind !== "exists") return;
    if (first.kind !== "attached") return;
    expect(second.taskId).toBe(first.taskId);
    const count = (h.db
      .query(`SELECT COUNT(*) AS c FROM tasks WHERE source_external_id = ?`)
      .get("the-metafactory/grove-v2#100") as { c: number }).c;
    expect(count).toBe(1);
  });

  it("refreshes the task title and status when the upstream changes", () => {
    seedParent();
    const first = importSubIssueFromMetadata(
      h.db,
      { owner: "the-metafactory", repo: "grove-v2", number: 42 },
      makeSub()
    );
    if (first.kind !== "attached") throw new Error("expected attached");

    importSubIssueFromMetadata(
      h.db,
      { owner: "the-metafactory", repo: "grove-v2", number: 42 },
      makeSub({ title: "Sub: REVISED", state: "closed" })
    );

    const task = h.db
      .query(`SELECT title, status FROM tasks WHERE id = ?`)
      .get(first.taskId) as { title: string; status: string };
    expect(task.title).toBe("Sub: REVISED");
    expect(task.status).toBe("done");
  });

  it("returns 'parent_not_tracked' when no Grove iteration matches the parent ref", () => {
    // No seed.
    const result = importSubIssueFromMetadata(
      h.db,
      { owner: "ghost", repo: "repo", number: 1 },
      makeSub()
    );
    expect(result.kind).toBe("parent_not_tracked");
    if (result.kind !== "parent_not_tracked") return;
    expect(result.parentRef).toBe("ghost/repo#1");

    // No task row should have landed.
    const count = (h.db
      .query(`SELECT COUNT(*) AS c FROM tasks WHERE source_external_id = ?`)
      .get("the-metafactory/grove-v2#100") as { c: number }).c;
    expect(count).toBe(0);
  });

  it("attaches a sub-issue to a different iteration when the parent ref shifts", () => {
    // Two iteration parents.
    seedParent(); // grove-v2#42
    const second = importIterationFromMetadata(
      h.db,
      makeMeta({ number: 99 })
    );
    if (second.kind !== "created") throw new Error("expected created");

    // First import attaches to parent #42.
    const a = importSubIssueFromMetadata(
      h.db,
      { owner: "the-metafactory", repo: "grove-v2", number: 42 },
      makeSub()
    );
    if (a.kind !== "attached") throw new Error("expected attached");
    expect(a.iterationId).not.toBe(second.iteration.id);

    // Re-import shifts the same task under parent #99 (principal
    // re-parented on GitHub; we follow).
    const b = importSubIssueFromMetadata(
      h.db,
      { owner: "the-metafactory", repo: "grove-v2", number: 99 },
      makeSub()
    );
    expect(b.kind).toBe("exists");
    if (b.kind !== "exists") return;
    expect(b.iterationId).toBe(second.iteration.id);
  });
});

// =============================================================================
// findIterationBySourceParentRef + DB sanity
// =============================================================================

describe("findIterationBySourceParentRef", () => {
  let h: H;
  beforeEach(() => {
    h = mkdb();
  });
  afterEach(() => {
    teardown(h);
  });

  it("returns null when no row matches", () => {
    expect(findIterationBySourceParentRef(h.db, "github", "x/y#1")).toBeNull();
  });

  it("returns the row for a matching (system, ref) pair", () => {
    const r = importIterationFromMetadata(h.db, makeMeta());
    if (r.kind !== "created") throw new Error("expected created");
    const found = findIterationBySourceParentRef(
      h.db,
      "github",
      "the-metafactory/grove-v2#42"
    );
    expect(found?.id).toBe(r.iteration.id);
  });

  it("does not match on a different source_system", () => {
    importIterationFromMetadata(h.db, makeMeta());
    expect(
      findIterationBySourceParentRef(
        h.db,
        "jira",
        "the-metafactory/grove-v2#42"
      )
    ).toBeNull();
  });
});

// =============================================================================
// Webhook payload extractors
// =============================================================================

describe("parentMetadataFromWebhook", () => {
  it("extracts a well-formed parent issue payload", () => {
    const meta = parentMetadataFromWebhook({
      action: "labeled",
      issue: {
        number: 42,
        title: "T",
        body: "b",
        html_url: "https://github.com/x/y/issues/42",
        labels: [{ name: "iteration" }, { name: "bug" }],
      },
      repository: {
        full_name: "x/y",
        name: "y",
        owner: { login: "x" },
      },
      label: { name: "iteration" },
    });
    expect(meta).not.toBeNull();
    expect(meta!.owner).toBe("x");
    expect(meta!.repo).toBe("y");
    expect(meta!.number).toBe(42);
    expect(meta!.labels).toEqual(["iteration", "bug"]);
  });

  it("returns null for missing repository.owner", () => {
    expect(
      parentMetadataFromWebhook({
        action: "labeled",
        issue: { number: 1, title: "T", body: null, html_url: "https://x" },
        repository: { full_name: "x/y", name: "y" },
      })
    ).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parentMetadataFromWebhook(null)).toBeNull();
    expect(parentMetadataFromWebhook("nope")).toBeNull();
    expect(parentMetadataFromWebhook(42)).toBeNull();
  });

  it("tolerates string labels alongside object labels", () => {
    const meta = parentMetadataFromWebhook({
      action: "labeled",
      issue: {
        number: 1,
        title: "T",
        body: null,
        html_url: "https://github.com/x/y/issues/1",
        labels: ["iteration", { name: "bug" }, { /* missing name */ }],
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });
    expect(meta?.labels).toEqual(["iteration", "bug"]);
  });
});

describe("subIssueRefsFromWebhook", () => {
  it("extracts parent + child refs from a sub-issue payload", () => {
    const refs = subIssueRefsFromWebhook({
      action: "opened",
      issue: {
        number: 100,
        title: "Sub",
        body: null,
        html_url: "https://github.com/x/y/issues/100",
        state: "open",
        labels: [],
        parent: {
          number: 42,
          html_url: "https://github.com/x/y/issues/42",
          repository: { full_name: "x/y" },
        },
      },
      repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
    });
    expect(refs).not.toBeNull();
    expect(refs!.parent).toEqual({ owner: "x", repo: "y", number: 42 });
    expect(refs!.child.number).toBe(100);
    expect(refs!.child.state).toBe("open");
  });

  it("falls back to parent.html_url parsing when full_name is absent", () => {
    const refs = subIssueRefsFromWebhook({
      action: "opened",
      issue: {
        number: 7,
        title: "Sub",
        body: null,
        html_url: "https://github.com/a/b/issues/7",
        state: "open",
        labels: [],
        parent: {
          number: 3,
          html_url: "https://github.com/a/b/issues/3",
        },
      },
      repository: { full_name: "a/b", name: "b", owner: { login: "a" } },
    });
    expect(refs?.parent).toEqual({ owner: "a", repo: "b", number: 3 });
  });

  it("returns null when the issue has no parent (not a sub-issue)", () => {
    expect(
      subIssueRefsFromWebhook({
        action: "opened",
        issue: {
          number: 1,
          title: "T",
          body: null,
          html_url: "https://github.com/x/y/issues/1",
          state: "open",
        },
        repository: { full_name: "x/y", name: "y", owner: { login: "x" } },
      })
    ).toBeNull();
  });
});

// =============================================================================
// parentMetadataFromGhResponse
// =============================================================================

describe("parentMetadataFromGhResponse", () => {
  it("threads owner/repo/number through from the GitHubRef", () => {
    const meta = parentMetadataFromGhResponse(
      { owner: "x", repo: "y", number: 7, kind: "issue" },
      {
        title: "T",
        body: "b",
        labels: ["iteration"],
        html_url: "https://github.com/x/y/issues/7",
      }
    );
    expect(meta.owner).toBe("x");
    expect(meta.repo).toBe("y");
    expect(meta.number).toBe(7);
    expect(meta.labels).toEqual(["iteration"]);
  });
});

// =============================================================================
// DEFAULT_ITERATION_LABEL — pin the default so a future change is caught
// =============================================================================

describe("DEFAULT_ITERATION_LABEL", () => {
  it("is the literal 'iteration'", () => {
    expect(DEFAULT_ITERATION_LABEL).toBe("iteration");
  });
});
