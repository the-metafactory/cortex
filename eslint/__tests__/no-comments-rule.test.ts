import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { cortex } from "../no-comments.ts";

const linter = new Linter({ configType: "flat" });
const config: Linter.Config[] = [
  { files: ["**/*.ts"], linterOptions: { noInlineConfig: true }, languageOptions: { parser: tseslint.parser }, plugins: { cortex }, rules: { "cortex/no-comments": "error" } },
];
const flagged = (code: string) =>
  linter
    .verify(code, config, "x.ts")
    .filter((m) => m.ruleId === "cortex/no-comments")
    .map((m) => m.line);

describe("cortex/no-comments", () => {
  test("flags narration, banners, corpses and doc comments on private code", () => {
    const code = [
      "// someone said never call this twice",
      "const a = 1; // bump",
      "/* ---- helpers ---- */",
      "// const old = legacy();",
      "/** Adds one. */",
      "function inc(n: number) { return n + a; }",
      "inc(1);",
    ].join("\n");
    expect(flagged(code)).toEqual([1, 2, 3, 4, 5]);
  });

  test("keeps doc comments on exports, URLs, references, prettier-ignore and a license header", () => {
    const code = [
      "// SPDX-License-Identifier: MIT",
      '/// <reference types="bun-types" />',
      "/** Parses a node id. */",
      "export function parse(id: string) { return id; }",
      "/** The default lane. */",
      'export const LANE = "headless";',
      "/** Default export. */",
      "export default LANE;",
      "// git drops the trailer here: https://github.com/git/git/issues/1",
      "// prettier-ignore",
      "const grid = [1,0,",
      "  0,1];",
      "parse(String(grid));",
    ].join("\n");
    expect(flagged(code)).toEqual([]);
  });

  test("a license word after the first comment is still a comment", () => {
    expect(flagged("const a = 1;\n// first\n// copyright check runs below\nvoid a;\n")).toEqual([2, 3]);
  });

  test("ignores comment markers inside strings, templates and regexes", () => {
    const code = ['const s = "// not a comment";', "const t = `/* nope */ ${s} // still no`;", "const r = /\\/\\/x/;", "void [t, r];"].join("\n");
    expect(flagged(code)).toEqual([]);
  });

  test("ignores the shebang and flags a comment after the last statement", () => {
    expect(flagged("#!/usr/bin/env bun\nconst a = 1;\nvoid a;\n// trailing\n")).toEqual([4]);
  });

  test("names the fix for every ts suppression, @ts-expect-error included", () => {
    const code = "// @ts-ignore\nconst a: number = 1;\n// @ts-expect-error wrong on purpose\nconst b: number = 2;\n/* @ts-nocheck */\nvoid [a, b];\n";
    const messages = linter.verify(code, config, "x.ts").map((m) => [m.line, m.message.split(".")[0]]);
    expect(messages).toEqual([1, 3, 5].map((line) => [line, "Type-check suppression"]));
  });

  test("flags eslint directives, which noInlineConfig turns into plain comments", () => {
    expect(flagged("/* eslint-disable */\nconst a = 1;\nvoid a;\n")).toEqual([1]);
  });
});
