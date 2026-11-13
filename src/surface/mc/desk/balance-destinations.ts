import type { BalanceDestination } from "../../../balance";

export { balanceDestinations, type BalanceDestination, type DestinationArea } from "../../../balance";

export function areaProjects(destinations: BalanceDestination[], area: string): BalanceDestination[] {
  return destinations.filter(option => option.area === area && option.project);
}
const PROJECT_ID = /^(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$|(?:studio-thread|studio-response|area):)/i;
export const isBalanceProjectId = (value: string): boolean => PROJECT_ID.test(value.trim());
export function balanceProjectsByTitle(projects: BalanceDestination[], value: string): BalanceDestination[] {
  return projects.filter(project => project.title.trim().toLocaleLowerCase() === value.trim().toLocaleLowerCase());
}
export function resolveBalanceProject(projects: BalanceDestination[], value: string): BalanceDestination | undefined {
  const byId = projects.find(project => project.id === value);
  if (byId) return byId;
  if (isBalanceProjectId(value)) return undefined;
  const byTitle = balanceProjectsByTitle(projects, value);
  return byTitle.length === 1 ? byTitle[0] : undefined;
}
