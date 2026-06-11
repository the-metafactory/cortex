/**
 * ST-P4 — shared-fixture parity test for the two PURE session-tree assemblers.
 *
 * `lib/session-tree.ts` (local) and `worker/src/lib/session-tree.ts` (cloud) are
 * a deliberate byte-for-byte DUPLICATE (scope #3: the worker is a separate
 * package; importing across the bundle boundary is awkward). This test is the
 * guard that keeps them honest: it runs the SAME fixture set through BOTH copies
 * and asserts identical output. If a future edit lands in one copy but not the
 * other, the trees diverge and this fails CI.
 */

import { describe, it, expect } from "bun:test";
import {
  assembleSessionTree as assembleLocal,
  type FlatSessionRow,
} from "../lib/session-tree";
import { assembleSessionTree as assembleWorker } from "../worker/src/lib/session-tree";

const FIXTURES: { name: string; rows: FlatSessionRow[] }[] = [
  { name: "empty", rows: [] },
  {
    name: "single agent-rooted",
    rows: [r("s1", null)],
  },
  {
    name: "multi-level nesting",
    rows: [r("root", null), r("child", "root"), r("grandchild", "child")],
  },
  {
    name: "orphaned parent → root",
    rows: [r("child", "gone"), r("sibling", null)],
  },
  {
    name: "self-edge cycle",
    rows: [r("loner", "loner")],
  },
  {
    name: "2-node loop",
    rows: [r("a", "b"), r("b", "a")],
  },
  {
    name: "wide + deep mixed",
    rows: [
      r("p", null),
      r("c1", "p"),
      r("c2", "p"),
      r("gc", "c1"),
      r("orphan", "missing"),
      r("solo", null),
    ],
  },
];

function r(
  session_id: string,
  parent_session_id: string | null
): FlatSessionRow {
  return {
    session_id,
    parent_session_id,
    substrate: "claude-code",
    state: "running",
    started_at: "2026-06-11T00:00:00.000Z",
    ended_at: null,
    agent_name: "luna",
    task_title: "t",
  };
}

describe("session-tree local/worker parity", () => {
  for (const { name, rows } of FIXTURES) {
    it(`local and worker assemble identical trees: ${name}`, () => {
      const local = assembleLocal(structuredClone(rows));
      const worker = assembleWorker(structuredClone(rows));
      expect(worker).toEqual(local);
    });
  }
});
