#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const WIRE_DIR = "src/desk-api/wire";
const ALLOWED_DIRS = [WIRE_DIR, "src/desk-sdk"];

function moduleSpecifiers(file: string, source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS));
  return found;
}

function insideAllowedDir(root: string, target: string): boolean {
  return ALLOWED_DIRS.some((dir) => {
    const base = join(root, dir);
    return target === base || target.startsWith(base + sep);
  });
}

/** Each import of a Desk wire module that resolves outside the wire modules and `src/desk-sdk/`, named by module and specifier. */
export function wireImportProblems(root: string): string[] {
  const wireDir = join(root, WIRE_DIR);
  const files = readdirSync(wireDir, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts")).sort();
  return files.flatMap((name) => {
    const file = join(wireDir, name);
    const module = relative(root, file);
    return moduleSpecifiers(file, readFileSync(file, "utf8")).flatMap((specifier) => {
      if (!specifier.startsWith(".")) return [`${module} imports the package "${specifier}"; a wire module imports only wire modules and src/desk-sdk/.`];
      const target = resolve(dirname(file), specifier);
      if (insideAllowedDir(root, target)) return [];
      return [`${module} imports "${specifier}" (${relative(root, target)}), which is outside ${ALLOWED_DIRS.join(" and ")}.`];
    });
  });
}

if (import.meta.main) {
  const problems = wireImportProblems(join(import.meta.dir, ".."));
  if (problems.length > 0) {
    process.stderr.write(`\n❌ A Desk wire module reaches server-only code:\n${problems.map((p) => `   ${p}`).join("\n")}\n\n`);
    process.exit(1);
  }
  process.stdout.write(`✅ Desk wire modules import only ${ALLOWED_DIRS.join(" and ")}.\n`);
}
