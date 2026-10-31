import type { NodeId, OutlineNode } from "./types";
import { findNode } from "./scheduler";
export type DropZone = "before" | "into" | "after";
export interface DropTarget {
    parentId: NodeId;
    index?: number;
}
export function findParent(root: OutlineNode, id: NodeId): OutlineNode | null {
    for (const child of root.children) {
        if (child.id === id)
            return root;
        const hit = findParent(child, id);
        if (hit)
            return hit;
    }
    return null;
}
export function computeDrop(outline: OutlineNode, movedId: NodeId, targetId: NodeId, zone: DropZone): DropTarget | null {
    if (movedId === targetId)
        return null;
    const movedNode = findNode(outline, movedId);
    if (movedNode && findNode(movedNode, targetId) !== null)
        return null;
    const draggedParent = findParent(outline, movedId);
    if (!draggedParent)
        return null;
    const fromIdx = draggedParent.children.findIndex((c) => c.id === movedId);
    if (zone === "into") {
        return { parentId: targetId };
    }
    const targetParent = findParent(outline, targetId);
    if (!targetParent)
        return null;
    let insertIdx = targetParent.children.findIndex((c) => c.id === targetId) + (zone === "after" ? 1 : 0);
    if (targetParent.id === draggedParent.id && fromIdx < insertIdx)
        insertIdx -= 1;
    return { parentId: targetParent === outline ? "root" : targetParent.id, index: insertIdx };
}
