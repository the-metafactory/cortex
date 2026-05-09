/**
 * F-14 — pure column-grouping tests for the iteration kanban layout.
 *
 * Pins:
 *   - every iteration `state` ends up in the right column
 *   - inbox items always land in `inbox`, in input order (server-sorted)
 *   - all six columns are present in the output even when empty
 *   - `cancelled` iterations are dropped (not rendered as a 7th column)
 *   - mixed inbox + iteration sets compose without cross-contamination
 *
 * Mirrors the cell-by-cell discipline of `iteration-status.test.ts`: a
 * scope-change in the column list cannot land silently.
 */

import { describe, it, expect } from "bun:test";
import {
  buildIterationBoardLayout,
  isBoardColumn,
  ITERATION_BOARD_COLUMNS,
  type IterationBoardColumn,
} from "../lib/iteration-board-layout";
import type {
  InboxItem,
  IterationListItem,
  IterationState,
} from "../../db/iterations";

function iter(over: Partial<IterationListItem> = {}): IterationListItem {
  return {
    id: over.id ?? "i-1",
    title: over.title ?? "Iteration",
    priority: over.priority ?? 2,
    state: over.state ?? "designing",
    source_system: over.source_system ?? null,
    source_url: over.source_url ?? null,
    source_parent_ref: over.source_parent_ref ?? null,
    task_count: over.task_count ?? 0,
    imported_at: over.imported_at ?? null,
    created_at: over.created_at ?? "2026-04-25T00:00:00.000Z",
    updated_at: over.updated_at ?? "2026-04-25T00:00:00.000Z",
  };
}

function inbox(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: over.id ?? "t-1",
    title: over.title ?? "Inbox task",
    priority: over.priority ?? 2,
    status: over.status ?? "open",
    source_system: over.source_system ?? "github",
    source_url: over.source_url ?? "https://github.com/foo/bar/issues/1",
    source_external_id: over.source_external_id ?? "github:foo/bar#1",
    created_at: over.created_at ?? "2026-04-26T00:00:00.000Z",
    updated_at: over.updated_at ?? "2026-04-26T00:00:00.000Z",
  };
}

describe("buildIterationBoardLayout — column shape", () => {
  it("returns all six columns even when both inputs are empty", () => {
    const layout = buildIterationBoardLayout([], []);
    for (const col of ITERATION_BOARD_COLUMNS) {
      expect(layout[col]).toEqual([]);
    }
  });

  it("exposes exactly the six visible Decision-4 columns (no `cancelled`)", () => {
    expect(ITERATION_BOARD_COLUMNS).toEqual([
      "inbox",
      "designing",
      "queued",
      "in_flight",
      "blocked",
      "done",
    ]);
    expect(ITERATION_BOARD_COLUMNS.length).toBe(6);
  });

  it("returned object has only the six visible columns as keys", () => {
    const layout = buildIterationBoardLayout([], []);
    expect(Object.keys(layout).sort()).toEqual([
      "blocked",
      "designing",
      "done",
      "in_flight",
      "inbox",
      "queued",
    ]);
  });
});

describe("buildIterationBoardLayout — inbox items", () => {
  it("places every inbox item into the `inbox` column", () => {
    const items = [inbox({ id: "t-1" }), inbox({ id: "t-2" }), inbox({ id: "t-3" })];
    const layout = buildIterationBoardLayout([], items);
    expect(layout.inbox).toHaveLength(3);
    for (const e of layout.inbox) {
      expect(e.kind).toBe("inbox");
    }
  });

  it("preserves server-side ordering of inbox items (no re-sort)", () => {
    const items = [
      inbox({ id: "t-newer", updated_at: "2026-04-26T05:00:00.000Z" }),
      inbox({ id: "t-older", updated_at: "2026-04-25T00:00:00.000Z" }),
      inbox({ id: "t-mid", updated_at: "2026-04-25T12:00:00.000Z" }),
    ];
    const layout = buildIterationBoardLayout([], items);
    expect(layout.inbox.map((e) => (e as { item: InboxItem }).item.id)).toEqual([
      "t-newer",
      "t-older",
      "t-mid",
    ]);
  });

  it("never places an inbox item into a non-inbox column", () => {
    const items = [inbox({ id: "t-1" })];
    const layout = buildIterationBoardLayout([], items);
    for (const col of ITERATION_BOARD_COLUMNS) {
      if (col === "inbox") continue;
      expect(layout[col]).toEqual([]);
    }
  });
});

describe("buildIterationBoardLayout — iteration routing", () => {
  // One iteration per visible column.
  const cells: Array<[IterationBoardColumn, IterationState]> = [
    ["inbox", "inbox"],
    ["designing", "designing"],
    ["queued", "queued"],
    ["in_flight", "in_flight"],
    ["blocked", "blocked"],
    ["done", "done"],
  ];

  for (const [column, state] of cells) {
    it(`routes an iteration with state=${state} into the ${column} column`, () => {
      const it = iter({ id: `i-${state}`, state });
      const layout = buildIterationBoardLayout([it], []);
      expect(layout[column]).toHaveLength(1);
      expect((layout[column][0] as { item: IterationListItem }).item.id).toBe(
        `i-${state}`
      );
      // No leakage to other columns.
      for (const col of ITERATION_BOARD_COLUMNS) {
        if (col === column) continue;
        expect(layout[col]).toEqual([]);
      }
    });
  }

  it("drops `cancelled` iterations (not a visible column)", () => {
    const it = iter({ id: "i-cancelled", state: "cancelled" });
    const layout = buildIterationBoardLayout([it], []);
    for (const col of ITERATION_BOARD_COLUMNS) {
      expect(layout[col]).toEqual([]);
    }
  });

  it("drops iterations with unknown states defensively", () => {
    // Cast to bypass the union — this represents the future-shape case
    // where the server adds a new state before the dashboard knows it.
    const it = iter({ id: "i-future", state: "future_state" as IterationState });
    const layout = buildIterationBoardLayout([it], []);
    for (const col of ITERATION_BOARD_COLUMNS) {
      expect(layout[col]).toEqual([]);
    }
  });

  it("preserves server ordering within a column (no client re-sort)", () => {
    // Server sort is `priority ASC, updated_at DESC, id ASC` — but we do
    // NOT re-apply that here. We just preserve insertion order.
    const its = [
      iter({ id: "i-a", state: "designing" }),
      iter({ id: "i-b", state: "designing" }),
      iter({ id: "i-c", state: "designing" }),
    ];
    const layout = buildIterationBoardLayout(its, []);
    expect(
      layout.designing.map((e) => (e as { item: IterationListItem }).item.id)
    ).toEqual(["i-a", "i-b", "i-c"]);
  });
});

describe("buildIterationBoardLayout — mixed inputs", () => {
  it("composes inbox items and iterations without cross-contamination", () => {
    const inboxes = [inbox({ id: "t-1" }), inbox({ id: "t-2" })];
    const iters = [
      iter({ id: "i-d1", state: "designing" }),
      iter({ id: "i-d2", state: "designing" }),
      iter({ id: "i-q1", state: "queued" }),
      iter({ id: "i-f1", state: "in_flight" }),
      iter({ id: "i-b1", state: "blocked" }),
      iter({ id: "i-done1", state: "done" }),
    ];
    const layout = buildIterationBoardLayout(iters, inboxes);

    expect(layout.inbox).toHaveLength(2);
    expect(layout.designing).toHaveLength(2);
    expect(layout.queued).toHaveLength(1);
    expect(layout.in_flight).toHaveLength(1);
    expect(layout.blocked).toHaveLength(1);
    expect(layout.done).toHaveLength(1);

    // Tag union shape: every entry in `inbox` should be `kind: 'inbox'`,
    // every iteration entry should be `kind: 'iteration'`.
    for (const e of layout.inbox) expect(e.kind).toBe("inbox");
    for (const col of ["designing", "queued", "in_flight", "blocked", "done"] as const) {
      for (const e of layout[col]) expect(e.kind).toBe("iteration");
    }
  });

  it("places an iteration with state=inbox alongside inbox items in the inbox column", () => {
    // Edge case: F-13 schema currently never emits an iteration in
    // `state = 'inbox'` (iterations are created when an inbox item is
    // dragged to designing), but the layout is defensive against future
    // code paths. When this happens, the iteration card should appear
    // in the inbox column alongside any actual inbox items.
    const it = iter({ id: "i-inbox", state: "inbox" });
    const inboxes = [inbox({ id: "t-1" })];
    const layout = buildIterationBoardLayout([it], inboxes);
    expect(layout.inbox).toHaveLength(2);
    // Inbox items render first (they're pushed first), then iterations.
    expect(layout.inbox[0]?.kind).toBe("inbox");
    expect(layout.inbox[1]?.kind).toBe("iteration");
  });
});

describe("isBoardColumn — type guard", () => {
  for (const col of ITERATION_BOARD_COLUMNS) {
    it(`is true for ${col}`, () => {
      expect(isBoardColumn(col)).toBe(true);
    });
  }

  it("is false for `cancelled` (Decision 4 — not a visible column)", () => {
    expect(isBoardColumn("cancelled")).toBe(false);
  });

  it("is false for the empty string", () => {
    expect(isBoardColumn("")).toBe(false);
  });

  it("is false for arbitrary unknown strings", () => {
    expect(isBoardColumn("future_state")).toBe(false);
    expect(isBoardColumn("designing ")).toBe(false); // trailing space
    expect(isBoardColumn("Designing")).toBe(false); // case-sensitive
  });
});
