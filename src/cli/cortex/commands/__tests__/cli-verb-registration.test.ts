/**
 * #1352 — regression guard against CLI verb drift.
 *
 * Three complete command modules (`agents`, `cloud`, `migrate-config`) shipped
 * as standalone `import.meta.main` scripts that were never registered as
 * commander verbs — while docs and cortex.ts:682 told users to run them as
 * `cortex agents …` / `cortex migrate-config …`. Users following those hints hit
 * "unknown command".
 *
 * This is a cheap, string-level guard for that whole class of drift: every
 * command that cortex.ts's OWN user-facing strings promise (the fully
 * backtick-quoted `cortex <verb>` form, e.g. the cortex.ts:682 upgrade hint
 * `run \`cortex migrate-config\``) MUST be a registered commander command. If a
 * future edit references `cortex <verb>` in a message without registering the
 * verb, this fails.
 *
 * Deliberately strict on the reference pattern — a FULLY backtick-wrapped
 * `cortex <verb>` — so prose/log phrases like "cortex config validation OK"
 * (where `config` is a noun, not a subcommand) are not mistaken for command
 * references.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// __tests__ → commands → cortex → cli → src → cortex.ts
const CORTEX_TS_PATH = join(import.meta.dir, "../../../../cortex.ts");
const source = readFileSync(CORTEX_TS_PATH, "utf-8");

/** Command names registered via commander: `.command("<name>")`. */
function registeredCommands(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\.command\("([a-z][a-z-]*)"\)/g)) {
    out.add(m[1]!);
  }
  return out;
}

/**
 * Verbs referenced in a FULLY backtick-wrapped `cortex <verb>` form — the
 * canonical "run this command" convention (cortex.ts:682). Only the leading
 * verb token is captured; a trailing backtick right after it is required so
 * `cortex config validation …` (not backtick-closed after the verb) is
 * excluded.
 */
function referencedVerbs(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/`cortex ([a-z][a-z-]+)`/g)) {
    out.add(m[1]!);
  }
  return out;
}

describe("#1352 — cortex CLI verb registration guard", () => {
  const registered = registeredCommands(source);
  const referenced = referencedVerbs(source);

  test("cortex.ts registers the expected core verbs", () => {
    // Sanity floor — if the registration table is refactored away, catch it here
    // rather than letting the drift check pass vacuously.
    for (const verb of ["start", "stop", "status", "network", "stack"]) {
      expect(registered.has(verb)).toBe(true);
    }
  });

  test("the two #1352 verbs are now registered", () => {
    expect(registered.has("agents")).toBe(true);
    expect(registered.has("migrate-config")).toBe(true);
  });

  test("the reference scanner actually found command references (not vacuous)", () => {
    // The whole test is meaningless if the regex silently matches nothing after a
    // future quoting-style change. Pin the canonical cortex.ts:682 reference.
    expect(referenced.size).toBeGreaterThan(0);
    expect(referenced.has("migrate-config")).toBe(true);
  });

  test("every `cortex <verb>` cortex.ts promises is a registered command", () => {
    const missing = [...referenced].filter((verb) => !registered.has(verb));
    expect(missing).toEqual([]);
  });
});
