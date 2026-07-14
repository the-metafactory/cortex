/**
 * cortex#1935 — REGRESSION GATE: no underscore in a bus-envelope `type` literal.
 *
 * ## The bug this locks out
 *
 * The vendored myelin envelope schema (`src/bus/myelin/vendor/envelope.schema.json`)
 * pins `/type` to `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$` — HYPHENS only, no
 * underscores. `validateEnvelope` runs on the SUBSCRIBER (delivery) side, so an
 * underscore-typed `system.*` envelope PUBLISHES without error and is then
 * **silently dropped** by every standard push-mode subscriber. A publisher that
 * emits `system.bus.peer_dispatch_received` looks healthy in isolation and never
 * reaches a soul. That is exactly how the F-6 / gateway-observability visibility
 * events shipped dark until #1935, and how signal's U2.x overlay shipped dead
 * (cortex#1467). Unit fakes never touch AJV, so nothing catches it.
 *
 * ## What this gate scans
 *
 * Every NON-TEST source file under `src/`, for string literals that occupy a
 * `type:` construction slot or a `.type ===` / `.type !==` matcher slot AND look
 * like a dotted bus-envelope type (`root.segment[.segment…]`). Each such literal
 * MUST satisfy the vendored schema's `/type` pattern (loaded from the schema file
 * itself, so the gate can never drift from the real contract).
 *
 * ## Why it does not false-positive on non-envelope `type:` fields
 *
 *   - Single-token discriminated-union tags (`task_started`, `gate_verdict`,
 *     `user_message`, `tool_use`, `principal_requeue`, …) have NO `.`, so they
 *     never match the dotted-literal regex. These are internal runner / brain /
 *     event-processor / websocket union tags — deliberately underscore-cased and
 *     out of scope (they never become a bus envelope `type`).
 *   - `iteration.*` (`iteration.detail_updated`, `iteration.state_changed`) is
 *     the Mission-Control WebSocket NOTIFICATION namespace — broadcast via
 *     `wsRegistry.broadcast(...)` in `src/surface/mc/notifications.ts`, never
 *     `buildBaseEnvelope` / the myelin bus. It is the ONE dotted, underscore-
 *     bearing namespace that is legitimately non-envelope, so it is the sole
 *     documented exclusion below. Adding a namespace here is a conscious,
 *     reviewable act — the safe direction (a real bus family is never silently
 *     skipped).
 *   - TEST files are excluded: negative tests intentionally construct
 *     underscore-typed envelopes to prove `validateEnvelope` REJECTS them
 *     (e.g. `signal-transport-envelopes.test.ts`, the `toUnderscoreType` flip).
 *     Enforcing the pattern there would flag the very assertions that protect us.
 *
 * If this test fails, a publisher (or a subscriber matcher) is using an
 * underscore in a bus-envelope type. Rename the leaf to hyphens at EVERY
 * publisher AND matcher (a publisher-only rename just relocates the silent drop),
 * or — if the literal is genuinely a non-envelope internal `type` — add its
 * dotted namespace to `NON_ENVELOPE_DOTTED_NAMESPACES` with a one-line rationale.
 */

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..");
const SCHEMA_PATH = join(
  SRC_ROOT,
  "bus",
  "myelin",
  "vendor",
  "envelope.schema.json",
);

/**
 * Dotted `type:` namespaces that are NOT bus envelopes and may legitimately
 * carry underscores. Keep this list minimal + rationale'd — every entry is an
 * exemption from the silent-drop gate.
 */
const NON_ENVELOPE_DOTTED_NAMESPACES: readonly {
  prefix: string;
  why: string;
}[] = [
  {
    prefix: "iteration.",
    why: "Mission-Control WebSocket notification tags (wsRegistry.broadcast in src/surface/mc/notifications.ts) — never buildBaseEnvelope / the myelin bus.",
  },
];

/** The vendored schema's `/type` pattern — the single source of truth. */
function loadSchemaTypePattern(): RegExp {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
    properties?: { type?: { pattern?: string } };
  };
  const pattern = schema.properties?.type?.pattern;
  if (!pattern) {
    throw new Error(
      `envelope.schema.json has no properties.type.pattern — cannot anchor the gate`,
    );
  }
  return new RegExp(pattern);
}

/**
 * Matches a dotted lowercase string literal in a `type:` construction slot or a
 * `.type ===` / `.type !==` matcher slot. Requires at least one `.` so single-
 * token union tags are excluded. Segments may contain `_`/`-` so we still SEE an
 * underscore-typed literal (and then reject it against the schema pattern).
 */
const DOTTED_TYPE_LITERAL =
  /(?:\btype:\s*|\.type\s*[!=]==?\s*)"([a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+)"/g;

function isExcluded(literal: string): boolean {
  return NON_ENVELOPE_DOTTED_NAMESPACES.some((n) => literal.startsWith(n.prefix));
}

function collectSources(): string[] {
  const glob = new Glob("**/*.ts");
  const files: string[] = [];
  for (const rel of glob.scanSync({ cwd: SRC_ROOT })) {
    // Exclude test files + fixtures: negative tests intentionally use bad types.
    if (rel.includes("__tests__/")) continue;
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
    files.push(rel);
  }
  return files.sort();
}

describe("cortex#1935 — no underscore in a bus-envelope type literal", () => {
  const typePattern = loadSchemaTypePattern();

  it("the vendored schema still forbids underscores in a type segment", () => {
    // Guards the guard: if the schema is ever relaxed to allow `_`, this gate
    // silently becomes a no-op. Pin the property we depend on.
    expect(typePattern.test("system.bus.peer-dispatch-received")).toBe(true);
    expect(typePattern.test("system.bus.peer_dispatch_received")).toBe(false);
  });

  it("every dotted `type:` / `.type ===` literal in non-test src is schema-valid", () => {
    const offenders: string[] = [];

    for (const rel of collectSources()) {
      const text = readFileSync(join(SRC_ROOT, rel), "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(DOTTED_TYPE_LITERAL)) {
          const literal = m[1]!;
          if (isExcluded(literal)) continue;
          if (!typePattern.test(literal)) {
            offenders.push(`  ${rel}:${i + 1}  "${literal}"`);
          }
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `Found ${offenders.length} envelope-type literal(s) violating the vendored ` +
          `schema /type pattern (underscores are silently dropped on delivery — ` +
          `cortex#1935). Rename the leaf to hyphens at EVERY publisher AND matcher, ` +
          `or exempt a genuinely non-envelope namespace in ` +
          `NON_ENVELOPE_DOTTED_NAMESPACES:\n${offenders.join("\n")}`,
      );
    }
    expect(offenders.length).toBe(0);
  });
});
