import type { DeskApiRouteTypes, DeskView, TypedResponse } from "@the-metafactory/cortex/desk-api";

type DeskResponse = DeskApiRouteTypes["GET /api/desk"]["response"];

export function itemCount(response: DeskResponse): number {
  return "items" in response ? (response as DeskView).items.length : 0;
}

export type Served = TypedResponse<DeskResponse>;
