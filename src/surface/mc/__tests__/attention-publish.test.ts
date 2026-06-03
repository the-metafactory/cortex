/**
 * ML.3 — reconcile delta (opened/resolved) + publishReconcileDelta + the
 * refreshCockpit publish step.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { reconcileAttention } from "../db/attention-sources";
import { publishReconcileDelta } from "../attention-notify";
import { refreshCockpit } from "../refresh";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { AttentionItem } from "../types";

const NOW = 1_900_000_000;
const DAY = 24 * 60 * 60;

function freshDb(paths: string[]) {
  const p = join(tmpdir(), `attpub-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(p);
  return initDatabase(p);
}

describe("reconcileAttention delta (ML.3)", () => {
  const paths: string[] = [];
  afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });

  it("reports newly-opened on first sight, then nothing on a no-change re-run, then resolved when cleared", () => {
    const db = freshDb(paths);
    db.query(`INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES ('wi', 'x', 'open', '', 'github', ?)`).run(NOW - 30 * DAY);
    const opts = { stackId: "laptop", nowEpochSec: NOW };

    const r1 = reconcileAttention(db, opts);
    expect(r1.opened.map((i) => i.id)).toEqual(["att:stale:wi"]); // first sight → opened
    expect(r1.resolved).toEqual([]);

    const r2 = reconcileAttention(db, opts);
    expect(r2.opened).toEqual([]); // already open → not re-reported
    expect(r2.resolved).toEqual([]);

    // Touch the work item → no longer stale → resolved delta.
    db.query(`UPDATE work_items SET updated_at = ? WHERE id = 'wi'`).run(NOW);
    const r3 = reconcileAttention(db, opts);
    expect(r3.opened).toEqual([]);
    expect(r3.resolved.map((i) => i.id)).toEqual(["att:stale:wi"]);
  });

  it("respects dismiss: a dismissed-but-still-stale item is NOT reopened or re-notified", () => {
    const db = freshDb(paths);
    db.query(`INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES ('wi', 'x', 'open', '', 'github', ?)`).run(NOW - 30 * DAY);
    const opts = { stackId: "laptop", nowEpochSec: NOW };
    reconcileAttention(db, opts); // opens att:stale:wi
    // Principal dismisses it (still stale).
    db.query(`UPDATE attention_items SET status = 'dismissed' WHERE id = 'att:stale:wi'`).run();
    const r = reconcileAttention(db, opts);
    expect(r.opened).toEqual([]); // not re-notified
    // And the row stays dismissed (not clobbered back to open).
    const row = db.query(`SELECT status FROM attention_items WHERE id = 'att:stale:wi'`).get() as { status: string };
    expect(row.status).toBe("dismissed");
    expect(r.open.some((i) => i.id === "att:stale:wi")).toBe(false);
  });

  it("re-notifies after RESOLVE (not dismiss): a recurring condition opens again", () => {
    const db = freshDb(paths);
    db.query(`INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES ('wi', 'x', 'open', '', 'github', ?)`).run(NOW - 30 * DAY);
    const opts = { stackId: "laptop", nowEpochSec: NOW };
    reconcileAttention(db, opts); // opened
    db.query(`UPDATE work_items SET updated_at = ? WHERE id = 'wi'`).run(NOW); // touch → resolved next run
    reconcileAttention(db, opts);
    // Re-age it → recurs → should re-open + re-notify (resolved≠dismissed).
    db.query(`UPDATE work_items SET updated_at = ? WHERE id = 'wi'`).run(NOW - 30 * DAY);
    const r = reconcileAttention(db, opts);
    expect(r.opened.map((i) => i.id)).toEqual(["att:stale:wi"]);
  });
});

describe("publishReconcileDelta (ML.3)", () => {
  it("publishes opened → system.attention.opened and resolved → system.attention.resolved", async () => {
    const published: Envelope[] = [];
    const item = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
      id, stackId: "laptop", workItemId: "wi-1", sessionId: null, kind: "stale", severity: "low", status: "open", ...over,
    });
    const n = await publishReconcileDelta(
      { opened: [item("a-1")], resolved: [item("a-2", { status: "resolved" })] },
      { source: { principal: "metafactory" }, deepLinkFor: (it) => `https://x/${it.id}` },
      (env) => { published.push(env); }
    );
    expect(n).toEqual({ opened: 1, resolved: 1 });
    expect(published.map((e) => e.type)).toEqual(["system.attention.opened", "system.attention.resolved"]);
    expect((published[0]?.payload as { deep_link_url: string }).deep_link_url).toBe("https://x/a-1");
  });
});

describe("refreshCockpit publish step (ML.3)", () => {
  const paths: string[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    paths.length = 0; dirs.length = 0;
  });

  it("publishes the reconcile delta when a publisher + source are supplied", async () => {
    const db = freshDb(paths);
    const dir = mkdtempSync(join(tmpdir(), "attpub-docs-"));
    dirs.push(dir);
    writeFileSync(join(dir, "plan-x.md"), "# P\n\n**Status:** active\n\n## Phase A — X\n");
    // A stale work item → reconcile opens one attention item to notify on.
    db.query(`INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES ('wi', 'x', 'open', '', 'github', ?)`).run(NOW - 30 * DAY);

    const published: Envelope[] = [];
    const res = await refreshCockpit(db, {
      docsDir: dir,
      stackId: "laptop",
      nowEpochSec: NOW,
      workItemSourceFor: () => null, // no work-item ingestion needed here
      publish: (env) => { published.push(env); },
      notifySource: { principal: "metafactory" },
      deepLinkFor: (it) => `https://x/${it.id}`,
    });
    expect(res.notifiedOpened).toBe(1);
    expect(res.notifiedResolved).toBe(0);
    expect(published.map((e) => e.type)).toEqual(["system.attention.opened"]);
  });

  it("publishes nothing when no publisher is wired (the DB-only CLI path)", async () => {
    const db = freshDb(paths);
    const dir = mkdtempSync(join(tmpdir(), "attpub-docs-"));
    dirs.push(dir);
    writeFileSync(join(dir, "plan-x.md"), "# P\n\n**Status:** active\n\n## Phase A — X\n");
    db.query(`INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES ('wi', 'x', 'open', '', 'github', ?)`).run(NOW - 30 * DAY);
    const res = await refreshCockpit(db, { docsDir: dir, stackId: "laptop", nowEpochSec: NOW, workItemSourceFor: () => null });
    expect(res.notifiedOpened).toBe(0);
    expect(res.notifiedResolved).toBe(0);
    expect(res.attentionOpen).toBeGreaterThanOrEqual(1); // reconcile still ran
  });
});