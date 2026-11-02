import type { OutlineNode } from "../../../balance";
import type { DeskArea } from "./types";

export interface BalanceDestination { id: string; label: string; title: string; area: string; project: boolean }
export function balanceDestinations(outline: OutlineNode, areas: DeskArea[], includeTasks = false): BalanceDestination[] {
  const result: BalanceDestination[] = [];
  const visit = (node: OutlineNode, area: string, path: string[], root = false): void => {
    const task = node.children.length === 0 && node.effort !== undefined;
    if (node.id.startsWith("studio-response:") || node.done && (node.children.length > 0 || task)) return;
    const next = [...path, node.title];
    if (root || !task || includeTasks) result.push({ id: node.id, area, title: node.title, label: next.join(" / "), project: !root });
    for (const child of node.children) visit(child, area, next);
  };
  for (const area of areas) {
    const root = outline.children.find(node => node.id === `area:${area.id}`);
    if (root) visit({ ...root, title: area.label }, area.id, [], true);
  }
  return result;
}

export function areaProjects(destinations: BalanceDestination[], area: string): BalanceDestination[] {
  return destinations.filter(option => option.area === area && option.project);
}
const PROJECT_ID = /^(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$|(?:studio-thread|studio-response|area):)/i;
export function resolveBalanceProject(projects: BalanceDestination[], value: string): BalanceDestination | undefined {
  const byId = projects.find(project => project.id === value);
  if (byId) return byId;
  if (PROJECT_ID.exec(value.trim())) return undefined;
  const byTitle = projects.filter(project => project.title.trim().toLocaleLowerCase() === value.trim().toLocaleLowerCase());
  return byTitle.length === 1 ? byTitle[0] : undefined;
}
