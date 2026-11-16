import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { wireImportProblems } from "../check-desk-wire-imports";

const ROOT = join(import.meta.dir, "../..");
const BARREL = "src/desk-api/wire/index.ts";
const SERVER_TYPES = "src/surface/mc/desk/types.ts";
const SERVER_OPTION_TYPES = new Set(["StudioOptions"]);
const NAMED_IN_BRIEF = ["DeskView", "DeskItem", "DeskItemKind", "DeskPhrase", "MyDayView", "MailRoundView", "RulingExplanation"];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "desk-wire-imports-"));
  scratch.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

describe("wireImportProblems", () => {
  test("passes the repository's wire modules", () => {
    expect(wireImportProblems(ROOT)).toEqual([]);
  });

  test("passes imports of other wire modules and of src/desk-sdk/", () => {
    const root = fixtureRoot({
      "src/desk-api/wire/a.ts": `import type { B } from "./b";\nimport type { CODES } from "../../desk-sdk/codes";\nexport type A = { b: B; c: typeof CODES };\n`,
      "src/desk-api/wire/b.ts": `export type B = string;\n`,
    });
    expect(wireImportProblems(root)).toEqual([]);
  });

  test.each([
    ["an import declaration", `import type { ClassifierConfig } from "../../surface/mc/desk/classify";\n`, "src/surface/mc/desk/classify"],
    ["a re-export", `export type { AREA_POLICIES } from "../../common/types/config";\n`, "src/common/types/config"],
    ["an inline import type", `export type X = import("../../surface/mc/desk/ruling").RulingExplanation;\n`, "src/surface/mc/desk/ruling"],
  ])("fails a server-only path reached by %s and names the module", (_label, source, target) => {
    const root = fixtureRoot({ "src/desk-api/wire/leak.ts": source });
    const problems = wireImportProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/desk-api/wire/leak.ts");
    expect(problems[0]).toContain(target);
  });

  test("fails a package import", () => {
    const root = fixtureRoot({ "src/desk-api/wire/leak.ts": `import type { z } from "zod";\n` });
    expect(wireImportProblems(root)).toEqual([`src/desk-api/wire/leak.ts imports the package "zod"; a wire module imports only wire modules and src/desk-sdk/.`]);
  });
});

function exportedTypeNames(file: string): string[] {
  const program = ts.createProgram([join(ROOT, file)], { module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ESNext, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(join(ROOT, file))!)!;
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (target.flags & ts.SymbolFlags.Type) !== 0;
    })
    .map((symbol) => symbol.name)
    .sort();
}

describe("the wire barrel", () => {
  test("re-exports every type the server's Desk types module exports, except server option types", () => {
    const barrel = new Set(exportedTypeNames(BARREL));
    const missing = exportedTypeNames(SERVER_TYPES).filter((name) => !SERVER_OPTION_TYPES.has(name) && !barrel.has(name));
    expect(missing).toEqual([]);
    expect(NAMED_IN_BRIEF.filter((name) => !barrel.has(name))).toEqual([]);
  });

  test("dts-bundle-generator emits a self-contained .d.ts for it", () => {
    const out = join(mkdtempSync(join(tmpdir(), "desk-wire-dts-")), "desk-wire.d.ts");
    scratch.push(dirname(out));
    const run = spawnSync("node", [join(ROOT, "node_modules/.bin/dts-bundle-generator"), "--no-check", "--no-banner", "--silent", "-o", out, "--", BARREL], { cwd: ROOT, encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const dts = readFileSync(out, "utf8");
    expect(dts).not.toMatch(/^\s*import\b/m);
    expect(dts).not.toMatch(/@anthropic-ai\/sdk|@earendil-works\/pi-ai|common\/types\/config/);
    for (const name of [...NAMED_IN_BRIEF, ...exportedTypeNames(SERVER_TYPES).filter((n) => !SERVER_OPTION_TYPES.has(n))]) {
      expect(dts).toMatch(new RegExp(`^export (?:declare )?(?:type|interface) ${name}\\b`, "m"));
    }
  }, 120_000);
});
