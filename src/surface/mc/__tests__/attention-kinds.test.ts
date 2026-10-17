import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initDatabase } from "../db/init";

test("attention type, projection kinds and dashboard labels agree", () => {
  const source = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
  const type = /export type AttentionKind =([\s\S]*?);/.exec(source("types.ts"))![1]!;
  const projection = /const ATTENTION_KINDS = new Set<AttentionKind>\(\[([\s\S]*?)\]\)/.exec(source("projection/attention-projection.ts"))![1]!;
  const labels = /const KIND_LABEL: Record<AttentionKind, string> = \{([\s\S]*?)\};/.exec(source("dashboard-v2/components/attention-view.tsx"))![1]!;
  const literals = (body: string) => Array.from(body.matchAll(/"([a-z_]+)"/g), (match) => match[1]!).sort();
  const kinds = literals(type);
  expect(kinds).toContain("proposal");
  expect(literals(projection)).toEqual(kinds);
  expect(Array.from(labels.matchAll(/^\s*([a-z_]+):/gm), (match) => match[1]!).sort()).toEqual(kinds);
  const db = initDatabase(":memory:");
  try {
    for (const kind of kinds) {
      expect(() => db.query("INSERT INTO attention_items (id, stack_id, kind) VALUES (?, 'default', ?)").run(kind, kind)).not.toThrow();
    }
  } finally {
    db.close();
  }
});
