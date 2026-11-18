import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { cortex } from "../plugin.ts";

const linter = new Linter({ configType: "flat" });
const config: Linter.Config[] = [
  { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, plugins: { cortex }, rules: { "cortex/no-ignored-error": "error" } },
];
const flagged = (code: string) =>
  linter
    .verify(code, config, "x.ts")
    .filter((m) => m.ruleId === "cortex/no-ignored-error")
    .map((m) => m.line);

describe("cortex/no-ignored-error", () => {
  test("flags handlers that drop the error (#3078, #2998, #2847)", () => {
    const code = [
      "async function a() { await write().catch(() => 0); }",
      "function b() { try { write(); } catch { return; } }",
      "void runMailRules().catch(() => undefined);",
      "function c() { try { show(); } catch {} }",
      "function d() { try { return parse(); } catch { return null; } }",
      "void load().catch(() => {});",
      "function e() { try { parse(); } catch { ok = false; } }",
      "void load().catch(function () { return false; });",
      "function f() { try { parse(); } catch { return () => report(); } }",
    ].join("\n");
    expect(flagged(code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("accepts handlers that bind, log, rethrow or return a named fallback", () => {
    const code = [
      "function a() { try { parse(); } catch (err) { process.stderr.write(String(err)); } }",
      "function b() { try { parse(); } catch { throw new Error('parse failed'); } }",
      "function c() { try { return parse(); } catch { return NOT_INSTALLED; } }",
      "void load().catch(() => EMPTY_PAGE);",
      "void load().catch(() => setError(LOAD_FAILED));",
      "void load().catch((err: unknown) => { log(err); });",
      "function d() { try { parse(); } catch (_err) { return; } }",
      "function e() { try { return parse(); } catch { return Fallback.none; } }",
      "void load().then(() => 0);",
    ].join("\n");
    expect(flagged(code)).toEqual([]);
  });
});
