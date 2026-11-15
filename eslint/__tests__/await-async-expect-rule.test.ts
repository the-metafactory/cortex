import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { cortex } from "../plugin.ts";

const linter = new Linter({ configType: "flat" });
const config: Linter.Config[] = [
  { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, plugins: { cortex }, rules: { "cortex/await-async-expect": "error" } },
];
const flagged = (code: string) =>
  linter
    .verify(code, config, "x.test.ts")
    .filter((m) => m.ruleId === "cortex/await-async-expect")
    .map((m) => m.line);

describe("cortex/await-async-expect", () => {
  test("flags rejects and resolves assertions the test does not wait for (#3181)", () => {
    const code = [
      "test('a', () => {",
      "  expect(link()).rejects.toMatchObject({ status: 403 });",
      "  expect(link()).resolves.not.toThrow();",
      "  void expect(link()).rejects.toThrow();",
      "  const pending = expect(link()).rejects.toThrow();",
      "  Promise.all([expect(link()).rejects.toThrow()]);",
      "  await run([expect(link()).resolves.toBe(1)]);",
      "  await [expect(link()).rejects.toThrow()];",
      "  await Promise.all(expect(link()).rejects.toThrow());",
      "});",
      "test('b', () => [expect(link()).rejects.toThrow()]);",
    ].join("\n");
    expect(flagged(code)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11]);
  });

  test("accepts awaited, returned and arrow-bodied assertions and plain expectations", () => {
    const code = [
      "test('a', async () => {",
      "  await expect(link()).rejects.toMatchObject({ status: 403 });",
      "  await expect(link()).resolves.not.toThrow();",
      "  expect(value).toBe(1);",
      "  expect(() => run()).toThrow();",
      "  await Promise.all([expect(a()).rejects.toThrow(), expect(b()).resolves.toBe(1)]);",
      "  await Promise.allSettled([expect(a()).rejects.toThrow()]);",
      "});",
      "test('b', () => { return expect(link()).rejects.toThrow(); });",
      "test('c', () => expect(link()).resolves.toBe(1));",
    ].join("\n");
    expect(flagged(code)).toEqual([]);
  });
});
