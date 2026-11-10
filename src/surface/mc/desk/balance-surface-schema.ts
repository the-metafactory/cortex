export const BALANCE_SURFACES_PATH = "/api/desk/balance-surfaces";
export const BALANCE_SURFACES_DESTINATIONS = `${BALANCE_SURFACES_PATH}/destinations`;
export const BALANCE_SURFACES_TASK = `${BALANCE_SURFACES_PATH}/task`;
export const balanceSurfaceTaskPath = (ref: string, area: string): string =>
  `${BALANCE_SURFACES_TASK}?ref=${encodeURIComponent(ref)}${area ? `&area=${encodeURIComponent(area)}` : ""}`;

export interface BalanceSurfaceArea { ref: string; label: string }
export interface BalanceSurfaceProject { ref: string; label: string; area: string }
export type BalanceSurfaceDestinations = { enabled: false } | { enabled: true; areas: BalanceSurfaceArea[]; projects: BalanceSurfaceProject[] };
export interface BalanceSurfaceFacts { title: string; due: string | null; area: string | null; project: string | null; note: string | null; effort: number | null }
export type BalanceSurfaceTask = { enabled: false } | ({ enabled: true; state: "available" } & BalanceSurfaceFacts) | { enabled: true; state: "unavailable" } | { enabled: true; state: "withheld" };
