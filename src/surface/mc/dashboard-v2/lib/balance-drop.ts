import type { OutlineNode } from "../../../../balance";

export type DropZone = "before" | "inside" | "after";
export interface DropTarget { parent: string; index?: number }

function containing(root: OutlineNode, id: string): { node: OutlineNode; parent: OutlineNode } | null {
  for (const child of root.children) {
    if (child.id === id) return { node: child, parent: root };
    const found = containing(child, id);
    if (found) return found;
  }
  return null;
}
const contains = (node: OutlineNode, id: string): boolean => node.id === id || node.children.some(child => contains(child, id));

/** Whether the principal can move this Balance row: not a configured area, and not a row whose place Studio owns. */
export function balanceMovable(outline: OutlineNode, id: string, studioProjects: ReadonlySet<string>): boolean {
  return !outline.children.some(area => area.id === id) && containing(outline, id) !== null && !studioProjects.has(id) && !id.startsWith("studio-response:");
}

/** Where an `outline-move` puts the dragged item when it is dropped on a zone of the target row, or null when the drop is not allowed. */
export function balanceDrop(outline: OutlineNode, dragged: string, target: string, zone: DropZone, studioProjects: ReadonlySet<string>): DropTarget | null {
  const source = containing(outline, dragged);
  const onto = containing(outline, target);
  if (!source || !onto || !balanceMovable(outline, dragged, studioProjects) || contains(source.node, target)) return null;
  if (zone === "inside") return { parent: target };
  if (onto.parent === outline) return null;
  const siblings = onto.parent.children.filter(child => child.id !== dragged);
  const index = siblings.findIndex(child => child.id === target) + (zone === "after" ? 1 : 0);
  return { parent: onto.parent.id, index };
}

export function dropZone(offset: number, height: number): DropZone {
  if (offset < height / 4) return "before";
  return offset > (height * 3) / 4 ? "after" : "inside";
}

export function positionChoices(outline: OutlineNode, moving: string, parent: string): { index: number; title: string }[] {
  return (containing(outline, parent)?.node.children ?? []).filter(child => child.id !== moving).map((child, index) => ({ index, title: child.title }));
}
