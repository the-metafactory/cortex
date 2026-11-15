import type { OutlineNode } from "../../../balance";

export function stampCreated<T extends OutlineNode>(node: T, date: string): T {
  node.createdAt = date;
  node.touchedAt = date;
  return node;
}
export function stampTouched(node: OutlineNode, date: string): void {
  node.touchedAt = date;
}
