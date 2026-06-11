/**
 * U1.1 item 4 — the sideband source must live behind a LAZY chunk boundary so
 * its fetch path + the `timelineToRows` mapper never bloat the entry bundle
 * (#933 item 4; the network-canvas chunk precedent).
 *
 * We assert the boundary STRUCTURALLY (no build needed in unit tests): the
 * drill-down references the sideband source ONLY through a dynamic `import()`
 * inside a `React.lazy(...)`, never as a static top-level import — and nothing
 * in the statically-reachable drill-down graph (drill-down, drill-log,
 * event-rows, source-merge) statically imports `sideband-timeline`. If a future
 * edit converts the lazy import to a static one, the chunk would fold into the
 * entry and this test fails. (`bun run build:dashboard` is the runtime oracle
 * that confirms the actual split — checked in CI/gates.)
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..");

function read(rel: string): string {
  return readFileSync(join(DIR, rel), "utf8");
}

describe("sideband lazy-chunk boundary (U1.1 item 4)", () => {
  it("drill-down loads the sideband source via React.lazy(() => import(...)), not a static import", () => {
    const src = read("components/drill-down.tsx");
    // The dynamic import exists.
    expect(src).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(["']\.\/sideband-source["']\)\s*\)/);
    // And there is NO static top-level import of the sideband source.
    expect(src).not.toMatch(/^\s*import\s+SidebandSource\s+from\s+["']\.\/sideband-source["']/m);
    expect(src).not.toMatch(/^\s*import\s+.*from\s+["']\.\/sideband-source["']/m);
  });

  it("the statically-reachable drill-down graph never imports sideband-timeline", () => {
    // These are all reachable from the entry bundle (drill-down is static).
    for (const f of [
      "components/drill-down.tsx",
      "components/drill-log.tsx",
      "lib/event-rows.ts",
      "lib/source-merge.ts",
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/from\s+["'].*sideband-timeline["']/);
    }
  });

  it("only the lazy sideband-source component imports the timeline mapper", () => {
    const src = read("components/sideband-source.tsx");
    expect(src).toMatch(/from\s+["']\.\.\/lib\/sideband-timeline["']/);
  });

  it("source-merge (entry-reachable) stays a pure module — no React, no fetch", () => {
    const src = read("lib/source-merge.ts");
    expect(src).not.toMatch(/from\s+["']react["']/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
