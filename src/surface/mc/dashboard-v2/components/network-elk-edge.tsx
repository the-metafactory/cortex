/**
 * #1008 (network-graph-rendering) — custom React Flow edge that renders ELK's
 * ORTHOGONAL route as a rounded-corner SVG polyline.
 *
 * Adapted from Strata's `ElkEdge.tsx` (`arc-library/strata/ui/src/components/`):
 * the layout step (`network-graph-layout.ts`) extracts ELK's bend points into
 * `data.elkPoints`; this edge converts them to a path with rounded corners
 * (`elkPointsToPath`) and clamps the endpoints to the source/target node faces
 * so a connector never starts inside a card. This is the key to the
 * non-crossing edges — ELK already routed the right angles; we just draw them.
 *
 * Lives in the LAZY canvas chunk (it imports `@xyflow/react`), registered on the
 * canvas's `edgeTypes` as `elk`. Edges with no `elkPoints` (defensive — ELK
 * didn't route them) fall back to a straight line.
 */

import { useMemo } from "react";
import {
  BaseEdge,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "@xyflow/react";

interface Point {
  x: number;
  y: number;
}

/**
 * Convert ELK orthogonal bend points into an SVG path with rounded corners.
 * Each interior bend becomes a quadratic-bezier arc whose radius is clamped to
 * half the shorter adjacent segment so tight bends never overshoot.
 */
export function elkPointsToPath(points: Point[], radius = 8): string {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  }

  const parts: string[] = [`M ${points[0]!.x} ${points[0]!.y}`];

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;

    const dPrev = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const dNext = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(radius, dPrev / 2, dNext / 2);

    if (r < 1) {
      parts.push(`L ${curr.x} ${curr.y}`);
      continue;
    }

    const dxP = (curr.x - prev.x) / dPrev;
    const dyP = (curr.y - prev.y) / dPrev;
    const dxN = (next.x - curr.x) / dNext;
    const dyN = (next.y - curr.y) / dNext;

    // Line to the start of the rounded corner, then arc through the bend.
    parts.push(`L ${curr.x - dxP * r} ${curr.y - dyP * r}`);
    parts.push(`Q ${curr.x} ${curr.y} ${curr.x + dxN * r} ${curr.y + dyN * r}`);
  }

  const last = points[points.length - 1]!;
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

/**
 * Clamp the polyline's first/last point to the correct node face so an edge
 * never starts/ends inside the box. Pure + exported for unit testing (the SVG
 * edge component itself can't mount under `renderToStaticMarkup`). Returns the
 * adjusted point list. Mirrors Strata's face-clamping.
 */
export function clampElkPointsToFaces(
  elkPoints: Point[],
  faces: {
    sourceY: number;
    targetY: number;
    sourceTopY?: number;
    targetBottomY?: number;
  },
): Point[] {
  if (elkPoints.length < 2) return elkPoints;
  const adjusted = [...elkPoints];
  const first = elkPoints[0]!;
  const firstNext = elkPoints[1]!;
  const lastIdx = elkPoints.length - 1;
  const last = elkPoints[lastIdx]!;
  const lastPrev = elkPoints[lastIdx - 1]!;

  if (firstNext.y >= first.y) {
    // Exits downward → snap to the actual bottom (source handle Y).
    adjusted[0] = { x: first.x, y: faces.sourceY };
  } else if (faces.sourceTopY !== undefined) {
    // Exits upward → snap to the top of the source node.
    adjusted[0] = { x: first.x, y: faces.sourceTopY };
  }

  if (lastPrev.y <= last.y) {
    // Enters from above → snap to the actual top (target handle Y).
    adjusted[lastIdx] = { x: last.x, y: faces.targetY };
  } else if (faces.targetBottomY !== undefined) {
    // Enters from below → snap to the bottom of the target node.
    adjusted[lastIdx] = { x: last.x, y: faces.targetBottomY };
  }

  return adjusted;
}

/**
 * The custom edge. Renders ELK's orthogonal route when present; falls back to a
 * straight line otherwise. If a node is DRAGGED far from its laid-out position
 * (the handles drift past a threshold from the ELK-expected face), we drop the
 * stale ELK route and use a live smoothstep so the edge tracks the moved node —
 * though cortex's nodes are `nodesDraggable={false}`, this keeps the edge robust.
 */
export default function NetworkElkEdge(props: EdgeProps) {
  const { id, data, style, markerEnd, sourceX, sourceY, targetX, targetY } =
    props;

  const edgeData = data as Record<string, unknown> | undefined;
  const elkPoints = edgeData?.["elkPoints"] as Point[] | undefined;
  const layoutSourceX = edgeData?.["layoutSourceX"] as number | undefined;
  const layoutSourceY = edgeData?.["layoutSourceY"] as number | undefined;
  const layoutTargetX = edgeData?.["layoutTargetX"] as number | undefined;
  const layoutTargetY = edgeData?.["layoutTargetY"] as number | undefined;
  const sourceTopY = edgeData?.["sourceTopY"] as number | undefined;
  const targetBottomY = edgeData?.["targetBottomY"] as number | undefined;

  const path = useMemo(() => {
    if (elkPoints && elkPoints.length >= 2) {
      // Detect a dragged node: large drift between the live handle and the
      // ELK-expected face → fall back to a live smoothstep.
      if (layoutSourceX !== undefined && layoutTargetX !== undefined) {
        const srcDrift = Math.hypot(
          sourceX - layoutSourceX,
          sourceY - (layoutSourceY ?? sourceY),
        );
        const tgtDrift = Math.hypot(
          targetX - layoutTargetX,
          targetY - (layoutTargetY ?? targetY),
        );
        if (srcDrift > 20 || tgtDrift > 20) {
          const [p] = getSmoothStepPath({
            sourceX,
            sourceY,
            targetX,
            targetY,
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
          });
          return p;
        }
      }

      const adjusted = clampElkPointsToFaces(elkPoints, {
        sourceY,
        targetY,
        sourceTopY,
        targetBottomY,
      });
      return elkPointsToPath(adjusted);
    }
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }, [
    elkPoints,
    sourceX,
    sourceY,
    targetX,
    targetY,
    layoutSourceX,
    layoutSourceY,
    layoutTargetX,
    layoutTargetY,
    sourceTopY,
    targetBottomY,
  ]);

  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}
