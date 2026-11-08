import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initDatabase } from "../db/init";
import { ATTENTION_KINDS } from "../types";

test("attention kinds, dashboard labels and the stored CHECK agree", () => {
  const labelSource = readFileSync(join(import.meta.dir, "..", "dashboard-v2/components/attention-view.tsx"), "utf8");
  const labels = /const KIND_LABEL: Record<AttentionKind, string> = \{([\s\S]*?)\};/.exec(labelSource)![1]!;
  const kinds = [...ATTENTION_KINDS].sort();
  expect(kinds).toContain("proposal");
  expect(kinds).toContain("result");
  expect(Array.from(labels.matchAll(/^\s*([a-z_]+):/gm), (match) => match[1]!).sort()).toEqual(kinds);
  const db = initDatabase(":memory:");
  try {
    for (const kind of kinds) {
      expect(() => db.query("INSERT INTO attention_items (id, stack_id, kind) VALUES (?, 'default', ?)").run(kind, kind)).not.toThrow();
    }
    expect(() => db.query("INSERT INTO attention_items (id, stack_id, kind) VALUES ('x', 'default', 'bogus')").run()).toThrow();
  } finally {
    db.close();
  }
});
