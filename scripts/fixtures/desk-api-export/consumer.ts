import type { DeskApiRouteTypes, DeskView, TypedResponse } from "@the-metafactory/cortex/desk-api";

type DeskResponse = DeskApiRouteTypes["GET /api/desk"]["response"];

export function itemCount(response: DeskResponse): number {
  return "items" in response ? (response as DeskView).items.length : 0;
}

export type Served = TypedResponse<DeskResponse>;

export function nextTaskCode(response: DeskApiRouteTypes["GET /api/desk/my-day"]["response"]): string {
  const { at, gap, next } = response.now;
  const timestamp: number = at;
  const reason: string = next.reason.code;
  return `${timestamp}:${gap.kind}:${reason}`;
}
