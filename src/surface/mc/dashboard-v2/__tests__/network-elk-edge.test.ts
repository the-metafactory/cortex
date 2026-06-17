/**
 * #1008 (network-graph-rendering) — pure ELK-edge geometry tests.
 *
 * The SVG edge component (`NetworkElkEdge`) imports `@xyflow/react` and can't
 * mount under `renderToStaticMarkup` (no provider), so we unit-test the PURE
 * geometry helpers it delegates to: `elkPointsToPath` (bend points → rounded SVG
 * path) and `clampElkPointsToFaces` (snap endpoints to the node faces). The
 * runtime render is covered by the build gate + manual dashboard QA.
 */

import { describe, it, expect } from "bun:test";
import {
  elkPointsToPath,
  clampElkPointsToFaces,
} from "../components/network-elk-edge";

describe("elkPointsToPath (#1008)", () => {
  it("returns an empty path for fewer than two points", () => {
    expect(elkPointsToPath([])).toBe("");
    expect(elkPointsToPath([{ x: 1, y: 2 }])).toBe("");
  });

  it("draws a straight line for exactly two points", () => {
    expect(elkPointsToPath([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toBe(
      "M 0 0 L 10 20",
    );
  });

  it("rounds an interior corner with a quadratic bezier through the bend", () => {
    // An L-shaped route: down then right. The middle bend should round.
    const path = elkPointsToPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 100, y: 100 },
      ],
      8,
    );
    expect(path.startsWith("M 0 0")).toBe(true);
    // a quadratic (rounded corner) is emitted through the bend point (0,100)
    expect(path).toContain("Q 0 100");
    // and it terminates at the endpoint
    expect(path.endsWith("L 100 100")).toBe(true);
  });

  it("falls back to a sharp corner when a segment is too short to round", () => {
    // The second segment (1px) is shorter than 2*radius → no arc, a plain L.
    const path = elkPointsToPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 100 },
        { x: 0, y: 101 },
      ],
      8,
    );
    expect(path).toContain("L 0 100");
    expect(path).not.toContain("Q");
  });
});

describe("clampElkPointsToFaces (#1008)", () => {
  it("snaps a downward-exiting start to the source handle Y (bottom face)", () => {
    const out = clampElkPointsToFaces(
      [
        { x: 5, y: 10 }, // ELK start (slightly off the real face)
        { x: 5, y: 50 }, // next is below → exits downward
        { x: 5, y: 90 },
      ],
      { sourceY: 12, targetY: 88 },
    );
    expect(out[0]).toEqual({ x: 5, y: 12 }); // snapped to sourceY
  });

  it("snaps a from-above entry to the target handle Y (top face)", () => {
    const out = clampElkPointsToFaces(
      [
        { x: 5, y: 10 },
        { x: 5, y: 50 },
        { x: 5, y: 90 }, // prev is above → enters from above
      ],
      { sourceY: 10, targetY: 88 },
    );
    expect(out[out.length - 1]).toEqual({ x: 5, y: 88 }); // snapped to targetY
  });

  it("returns the points unchanged for a degenerate (<2) route", () => {
    const pts = [{ x: 0, y: 0 }];
    expect(clampElkPointsToFaces(pts, { sourceY: 0, targetY: 0 })).toBe(pts);
  });
});
