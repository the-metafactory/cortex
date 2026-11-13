import type { OutlineNode } from "./types";

export interface DestinationArea {
    readonly id: string;
    readonly label: string;
}

export interface BalanceDestination {
    id: string;
    label: string;
    title: string;
    area: string;
    project: boolean;
}

export function isBalanceTask(node: OutlineNode): boolean {
    return node.children.length === 0 && node.effort !== undefined;
}

export function areaRoot(outline: OutlineNode, areaId: string): OutlineNode | undefined {
    return outline.children.find(node => node.id === `area:${areaId}`);
}

export function balanceDestinations(outline: OutlineNode, areas: readonly DestinationArea[], includeTasks = false): BalanceDestination[] {
    const result: BalanceDestination[] = [];
    const visit = (node: OutlineNode, area: string, path: string[], root = false): void => {
        const task = isBalanceTask(node);
        if (node.id.startsWith("studio-response:") || node.done && (node.children.length > 0 || task))
            return;
        const next = [...path, node.title];
        if (root || !task || includeTasks)
            result.push({ id: node.id, area, title: node.title, label: next.join(" / "), project: !root });
        for (const child of node.children)
            visit(child, area, next);
    };
    for (const area of areas) {
        const root = areaRoot(outline, area.id);
        if (root)
            visit({ ...root, title: area.label }, area.id, [], true);
    }
    return result;
}
