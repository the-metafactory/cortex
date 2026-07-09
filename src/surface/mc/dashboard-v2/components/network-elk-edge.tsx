/**
 * #1008 (network-graph-rendering) — custom React Flow edge for the Network graph.
 *
 * MC-D1 (netui-constellation) — the radial constellation layout hands this edge a
 * 2-point centre-to-centre route (`data.elkPoints = [hubCentre, agentCentre]`).
 * The edge draws that as a GENTLY CURVED teal spoke (`radialCurvePath`) from the
 * hub core out to the orbiting agent — the organic star-map connector, not the
 * boxy DAG elbow. For a multi-point route (defensive / legacy) it still renders
 * the rounded-corner polyline (`elkPointsToPath`). No route at all → a straight
 * chord.
 *
 * The pure geometry helpers (`elkPointsToPath`, `clampElkPointsToFaces`,
 * `radialCurvePath`) are exported + unit-tested; the SVG component itself imports
 * `@xyflow/react` so it can't mount under `renderToStaticMarkup`.
 *
 * Lives in the LAZY canvas chunk (it imports `@xyflow/react`), registered on the
 * canvas's `edgeTypes` as `elk`.
 */

import { useMemo, type CSSProperties } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "@xyflow/react";
import { useNetworkHover } from "../lib/network-hover-context";
import {
  hasSubtreeSelection,
  isInSubtreeHighlight,
} from "../lib/network-subtree-highlight";

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
 * MC-D1 — a GENTLY CURVED spoke between two points (hub centre → agent centre),
 * for the radial constellation. Bows the straight chord by offsetting its
 * midpoint PERPENDICULARLY to the chord by `curvature × chordLength`, then draws
 * a single quadratic bezier through the offset control point. The sign of the
 * offset is derived deterministically from the endpoint geometry (so the same
 * edge always bows the same way — no ambient state), giving the star-map its
 * organic, non-straight spokes. A degenerate (<2 point or zero-length) route
 * falls back to a straight line.
 */
export function radialCurvePath(
  from: Point,
  to: Point,
  curvature = 0.12,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  // Unit perpendicular to the chord.
  const px = -dy / len;
  const py = dx / len;
  // Deterministic bow direction: bow "outward" consistently by keying the sign
  // off the chord orientation (dx >= 0), so mirror-image spokes fan apart rather
  // than all bowing the same screen-direction.
  const sign = dx >= 0 ? 1 : -1;
  const mx = (from.x + to.x) / 2 + px * len * curvature * sign;
  const my = (from.y + to.y) / 2 + py * len * curvature * sign;
  return `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;
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
  // #1068 — the hub→agent connector strokes in its stack's deterministic color.
  const stackColor = edgeData?.["stackColor"] as string | undefined;
  // MC-D3 (#1290) — a CROSS-PRINCIPAL federated peer's edge: drawn dashed +
  // flowing to mark the "admitted peer" relationship, and labelled. The
  // constellation skin's `.edge-live--fed` class supplies the dash geometry +
  // `dashFlowFed` animation (reduced-motion-guarded in constellation.css). The
  // flow here is the relationship treatment, not REAL bus traffic — binding the
  // dash-flow to live envelope flow is D5 (#1292).
  const federated = edgeData?.["federated"] === true;
  // CK-5 (#1292) — bind the admitted-peer dash-flow to REAL bus flow. `live` is
  // true only when there IS envelope flow AND liveTraffic is on AND motion is
  // permitted; the canvas threads it through the edge `data`. When false the
  // federated edge draws a STATIC dash (relationship still legible, nothing
  // fabricates motion — truth-not-theater). `edge-live--fed` animates (D1's
  // dashFlowFed, reduced-motion-guarded); `edge-fed-static` holds the dash.
  const live = edgeData?.["live"] === true;
  const layoutSourceX = edgeData?.["layoutSourceX"] as number | undefined;
  const layoutSourceY = edgeData?.["layoutSourceY"] as number | undefined;
  const layoutTargetX = edgeData?.["layoutTargetX"] as number | undefined;
  const layoutTargetY = edgeData?.["layoutTargetY"] as number | undefined;
  const sourceTopY = edgeData?.["sourceTopY"] as number | undefined;
  const targetBottomY = edgeData?.["targetBottomY"] as number | undefined;

  const path = useMemo(() => {
    // MC-D1 — the radial layout emits a 2-point centre-to-centre route; draw it
    // as a gently curved constellation spoke (hub core → orbiting agent). The
    // circle nodes are centred on their position, so centre-to-centre is exact.
    if (elkPoints && elkPoints.length === 2) {
      return radialCurvePath(elkPoints[0]!, elkPoints[1]!);
    }
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

  // #1068 — the stack's color is the edge stroke (additive: any incoming `style`
  // still applies; we only set the stroke when a color is present, so an
  // un-colored edge is unchanged).
  const baseStyle: Record<string, unknown> =
    stackColor !== undefined ? { ...style, stroke: stackColor } : { ...style };

  // #1068 — subtree selection: a hub→agent edge in the SELECTED subtree is
  // EMPHASIZED (thicker, full opacity); when a subtree is selected and this edge
  // is OUTSIDE it, the edge DIMS (opacity — not hue). Resting (no selection):
  // unchanged. Read off the shared hover context like the node cards do.
  const { selection } = useNetworkHover();
  if (hasSubtreeSelection(selection)) {
    if (isInSubtreeHighlight(selection, id)) {
      baseStyle["strokeWidth"] = 2.5;
      baseStyle["opacity"] = 1;
    } else {
      baseStyle["opacity"] = 0.18;
    }
  }

  // MC-D3 — anchor the `federated · admitted peer` label ON the route, not on
  // the straight chord: use the middle vertex of ELK's orthogonal polyline when
  // present (so the pill sits on the connector, not floating off it), falling
  // back to the chord midpoint only when ELK didn't route the edge. The label is
  // a presence-level provenance marker (an admitted cross-principal peer
  // relationship) — never a session affordance.
  const { labelX, labelY } = useMemo(() => {
    if (elkPoints && elkPoints.length >= 2) {
      const mid = elkPoints[Math.floor(elkPoints.length / 2)]!;
      return { labelX: mid.x, labelY: mid.y };
    }
    return { labelX: (sourceX + targetX) / 2, labelY: (sourceY + targetY) / 2 };
  }, [elkPoints, sourceX, sourceY, targetX, targetY]);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={baseStyle as CSSProperties}
        markerEnd={markerEnd}
        // The constellation skin keys the dashed-flow treatment off this class
        // (scoped under `.mc-skin`; inert in the un-skinned legacy render).
        // CK-5: animate ONLY on real flow; otherwise a static dash.
        className={
          federated
            ? live
              ? "edge-live--fed"
              : "edge-fed-static"
            : undefined
        }
      />
      {federated && (
        <EdgeLabelRenderer>
          <div
            className="mc-edge-fed-label"
            data-edge-federated="true"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
            }}
            title="Federated bus relationship — an admitted cross-principal peer"
          >
            <span aria-hidden="true">●</span> federated · admitted peer
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
