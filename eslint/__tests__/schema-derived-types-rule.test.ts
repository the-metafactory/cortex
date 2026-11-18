import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { cortex } from "../plugin.ts";

const linter = new Linter({ configType: "flat" });
const config: Linter.Config[] = [
  { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, plugins: { cortex }, rules: { "cortex/schema-derived-types": "error" } },
];
const flagged = (code: string) =>
  linter
    .verify(code, config, "x.ts")
    .filter((m) => m.ruleId === "cortex/schema-derived-types")
    .map((m) => `${m.line}:${m.messageId ?? ""}`);

describe("cortex/schema-derived-types", () => {
  test("flags a hand-written type that repeats a schema's fields (#2996, #3005)", () => {
    const code = [
      "const MailHeadersSchema = z.object({ from: z.string(), subject: z.string() });",
      "interface MailHeaders { from: string; subject: string }",
      "const Req = z.union([z.object({ action: z.literal('sweep'), sweep: z.string() }), z.object({ action: z.literal('undo') })]);",
      "type SweepBody = { sweep: string; action: 'sweep' } | { action: 'other'; x: 1 };",
    ].join("\n");
    expect(flagged(code)).toEqual(["2:copied", "4:copied"]);
  });

  test("flags a cast on a schema's parse result (#3015)", () => {
    expect(flagged("const op = OperationSchema.parse(raw) as OperationRecord;")).toEqual(["1:castParse"]);
  });

  test("accepts derived types, differing fields and unrelated casts", () => {
    const code = [
      "const PageSchema = z.object({ items: z.array(z.string()), next: z.string() });",
      "type Page = z.infer<typeof PageSchema>;",
      "interface PageView { items: string[]; next: string; total: number }",
      "type One = { items: string[] };",
      "const page = PageSchema.parse(raw);",
      "const text = JSON.parse(raw) as Page;",
    ].join("\n");
    expect(flagged(code)).toEqual([]);
  });
});
