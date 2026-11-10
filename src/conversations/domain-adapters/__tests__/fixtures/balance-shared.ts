import { DEFAULT_SETTINGS, findNode, type AppState, type OutlineNode } from "../../../../balance";

export const leaf = (id: string, title: string, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children: [], effort: 1, ...extra });

export function outlineState(children: OutlineNode[]): AppState {
  return { outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children }, log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} } };
}

export function savedNode(state: AppState, id: string): OutlineNode {
  const found = findNode(state.outline, id);
  if (!found) throw new Error(`balance fixture node missing: ${id}`);
  return found;
}

export function removeOutlineNode(node: OutlineNode, id: string): boolean {
  const index = node.children.findIndex(child => child.id === id);
  if (index >= 0) { node.children.splice(index, 1); return true; }
  return node.children.some(child => removeOutlineNode(child, id));
}
