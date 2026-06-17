/**
 * #1068 — per-stack deterministic color-coding for the Network graph.
 *
 * Each stack-hub + its agents + its hub→agent edges get a DISTINCT, stable color
 * so the principal can tell the local stacks apart at a glance (meta-factory,
 * work, halden, community, …). The color is derived PURELY from the agent's
 * VERIFIED origin scope — the same `{principal}/{stack}` (or `"local"`) the
 * adapter groups hubs by (`hubIdForOrigin`) — so:
 *
 *   - the SAME stack always reads the same color (stable across renders + reloads,
 *     since the hash is content-only — no `Math.random`, no allocation order);
 *   - DIFFERENT stacks read different colors (until the palette wraps);
 *   - YOUR own stack (`"local"`) gets a stable DISTINGUISHED signature hue
 *     (`palette[0]`), so the anchor stack is recognisable at a glance.
 *
 * Color is ADDITIVE, never the only signal: the cards keep their text labels and
 * the local/sibling/foreign shape treatments (solid/dashed border, eyebrow). A
 * colorblind principal still reads the graph off shape + label; the hue is a
 * fast-path legibility aid, not load-bearing for correctness (WCAG-ish: the
 * palette hues are chosen to read on the dark canvas without relying on hue
 * discrimination alone).
 *
 * Pure + DOM-free, so it's unit-tested without a browser (the lib/wrapper
 * discipline the rest of the graph follows).
 */

import type { AgentOrigin } from "../hooks/use-agents";

/**
 * The fixed, accessible palette. Muted mid-saturation hues that all read on the
 * dark canvas (background ~`#0f1117`), chosen to be reasonably distinguishable
 * including for the common colorblind types (no pure red/green adjacency that
 * collapses under deuteranopia/protanopia; the order interleaves warm/cool).
 * Index 0 is the SIGNATURE hue reserved for the LOCAL stack (a calm blue — your
 * anchor). The rest cycle for foreign / sibling stacks.
 *
 * Hues borrowed in spirit from Strata's type palette (`arc-library/strata/ui`),
 * which is tuned for the same dark React-Flow canvas, then widened to 10 so 4+
 * local stacks (today) plus federated peers don't collide early.
 */
export const STACK_PALETTE: readonly string[] = [
  "#5b8cd4", // 0 — signature blue (LOCAL/self)
  "#2e8b7a", // 1 — teal
  "#d4915b", // 2 — amber/orange
  "#9b6ccf", // 3 — violet
  "#c26cb0", // 4 — magenta
  "#5ea0a0", // 5 — cyan-grey
  "#c4b257", // 6 — gold
  "#7a9c5e", // 7 — olive
  "#cf6c6c", // 8 — clay red
  "#6c8ccf", // 9 — periwinkle
] as const;

/** The signature color reserved for the LOCAL/self stack (`STACK_PALETTE[0]`). */
export const LOCAL_STACK_COLOR: string = STACK_PALETTE[0]!;

/**
 * The grouping KEY an origin resolves to — the same scope the adapter buckets
 * hubs by. `"local"` for your own stack; `"{principal}/{stack}"` for a peer.
 * Exported so callers (and tests) can assert two origins share a stack.
 */
export function originScopeKey(origin: AgentOrigin): string {
  return origin === "local"
    ? "local"
    : `${origin.principal}/${origin.stack}`;
}

/**
 * A small, well-distributed string hash (FNV-1a, 32-bit). Deterministic and
 * content-only — no global state, no allocation-order dependence — so the same
 * scope key always hashes to the same value across renders, reloads, and
 * processes. (FNV-1a is the standard cheap choice for short keys with good
 * avalanche for our 10-bucket modulo.)
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids float precision loss).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * The deterministic color for a stack origin.
 *
 *   - `"local"` → the reserved {@link LOCAL_STACK_COLOR} (`palette[0]`), ALWAYS —
 *     the self stack's signature hue is never hashed into a different bucket.
 *   - a peer `{principal,stack}` → `palette[1 + (hash(scopeKey) mod (N-1))]` —
 *     hashed into the NON-signature range `[1, N)` so a foreign/sibling stack
 *     never steals the local signature color. Same scope → same index → same
 *     color, every render.
 *
 * Pure: `stackColor(o)` depends only on `o`'s scope key.
 */
export function stackColor(origin: AgentOrigin): string {
  if (origin === "local") return LOCAL_STACK_COLOR;
  const key = originScopeKey(origin);
  const span = STACK_PALETTE.length - 1; // reserve index 0 for local
  const idx = 1 + (fnv1a(key) % span);
  return STACK_PALETTE[idx]!;
}
