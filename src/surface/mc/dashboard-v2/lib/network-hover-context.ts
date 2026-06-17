/**
 * G-1114.F.2 — cross-component hover-highlight React context.
 *
 * The hover state is OWNED by the Network view (which builds the capability
 * match index off the live snapshot). It's broadcast through this context so
 * the cross-component highlight reaches BOTH the detail panel (main bundle) and
 * the graph nodes (the lazy network-canvas chunk) without prop-drilling through
 * xyflow's node-renderer boundary — xyflow constructs node components itself, so
 * a node card can't receive highlight via props; it reads context instead.
 *
 * The context lives in the MAIN bundle (this module imports only React + the
 * pure highlight lib — never xyflow/elk), so both the main-bundle consumers and
 * the lazy-chunk consumers share ONE context instance.
 *
 * Default value is INERT: an empty highlight + a no-op setter. So a node card
 * rendered outside a provider (e.g. in isolation tests) reads "nothing
 * highlighted" and reports hovers to a no-op — never throws, never highlights.
 */

import { createContext, useContext } from "react";
import { EMPTY_HIGHLIGHT, type HighlightSet, type HoverTarget } from "./capability-highlight";
import {
  EMPTY_SUBTREE_SELECTION,
  type SubtreeSelection,
} from "./network-subtree-highlight";

export interface NetworkHoverContextValue {
  /** The currently-active highlight set (derived from the hover target). */
  highlight: HighlightSet;
  /** Report a new hover target (or `null` on mouse-leave). */
  setHoverTarget: (target: HoverTarget) => void;
  /**
   * #1068 — the STICKY hub-subtree selection (the selected hub id + the set of
   * hub/agent/edge ids to emphasize; everything else dims). A sibling of `hover`
   * that persists until the principal re-clicks the hub or clicks empty canvas.
   * Inert default → nothing selected (no dimming). Read by the node cards (to
   * emphasize/dim + stamp `aria-pressed`/`data-selected`) and the custom edge
   * (to emphasize/dim its connector).
   */
  selection: SubtreeSelection;
  /**
   * #1068 — TOGGLE the hub selection for a clicked hub id (or clear on `null`).
   * The view owns the graph, so it computes the next selection; the canvas just
   * reports the clicked hub up through this setter.
   */
  toggleHubSelection: (clickedHubId: string | null) => void;
}

const INERT: NetworkHoverContextValue = {
  highlight: EMPTY_HIGHLIGHT,
  setHoverTarget: () => {},
  selection: EMPTY_SUBTREE_SELECTION,
  toggleHubSelection: () => {},
};

export const NetworkHoverContext =
  createContext<NetworkHoverContextValue>(INERT);

/** Read the hover-highlight context (inert default outside a provider). */
export function useNetworkHover(): NetworkHoverContextValue {
  return useContext(NetworkHoverContext);
}
