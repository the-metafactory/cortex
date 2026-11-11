import { BALANCE_SURFACES_DESTINATIONS, balanceSurfaceTaskPath, type BalanceSurfaceDestinations, type BalanceSurfaceTask } from "../../desk/balance-surface-schema";
import { getJson } from "./api";

export type { BalanceSurfaceDestinations, BalanceSurfaceTask };

export const readBalanceSurfaceDestinations = (signal?: AbortSignal): Promise<BalanceSurfaceDestinations> => getJson(BALANCE_SURFACES_DESTINATIONS, signal ? { signal } : {});
export const readBalanceSurfaceTask = (ref: string, area: string, signal?: AbortSignal): Promise<BalanceSurfaceTask> => getJson(balanceSurfaceTaskPath(ref, area), signal ? { signal } : {});
