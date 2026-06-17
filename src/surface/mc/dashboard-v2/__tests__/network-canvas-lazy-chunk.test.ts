/**
 * #1008 (network-graph-rendering) — the network-canvas chunk must stay LAZY.
 *
 * The graph engine (`@xyflow/react` + `elkjs`) lives behind a `React.lazy`
 * boundary so it never bloats the entry bundle (the established precedent). The
 * #1008 custom ELK edge (`network-elk-edge.tsx`) ALSO imports `@xyflow/react`,
 * so it must be reachable ONLY through the lazy canvas, never statically from the
 * entry-reachable view.
 *
 * Asserted STRUCTURALLY (no build needed): `network-view` references the canvas
 * ONLY via `React.lazy(() => import("./network-canvas"))`, and the custom edge is
 * imported ONLY by the canvas. `bun run build:dashboard` is the runtime oracle
 * that confirms the actual split (checked in gates).
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..");

function read(rel: string): string {
  return readFileSync(join(DIR, rel), "utf8");
}

describe("network-canvas lazy-chunk boundary (#1008)", () => {
  it("network-view loads the canvas via React.lazy(() => import(...)), not a static import", () => {
    const src = read("components/network-view.tsx");
    expect(src).toMatch(
      /lazy\(\s*\(\)\s*=>\s*import\(["']\.\/network-canvas["']\)\s*\)/,
    );
    // No static top-level import of the canvas (which would fold it into entry).
    expect(src).not.toMatch(
      /^\s*import\s+.*from\s+["']\.\/network-canvas["']/m,
    );
  });

  it("the custom ELK edge is imported ONLY by the lazy canvas, not the entry-reachable view", () => {
    // The view (entry-reachable) must never statically import the edge.
    const view = read("components/network-view.tsx");
    expect(view).not.toMatch(/from\s+["']\.\/network-elk-edge["']/);
    // The canvas (lazy) is the one place it's imported.
    const canvas = read("components/network-canvas.tsx");
    expect(canvas).toMatch(/from\s+["']\.\/network-elk-edge["']/);
  });

  it("the custom ELK edge imports the heavy graph lib (@xyflow/react) — confirming it belongs lazy", () => {
    const edge = read("components/network-elk-edge.tsx");
    expect(edge).toMatch(/from\s+["']@xyflow\/react["']/);
  });
});
