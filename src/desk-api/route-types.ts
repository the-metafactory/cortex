import type { DeskView, MyDayResponse, DeskStudioResponse, DeskStudioDraftWrite, DeskStudioDraftResponse } from "./wire";

declare const BODY: unique symbol;

/** A `Response` that carries the JSON body type it was built from, so a handler that declares it as its return type cannot send another shape. */
export interface TypedResponse<Body> extends Response {
  readonly [BODY]: Body;
}

export interface DeskDisabled {
  enabled: false;
}

export interface DeskErrorBody {
  error: string;
}

/** The request and response types of the pinned Desk routes, keyed `METHOD /path` as in DESK_API_ROUTES. */
export interface DeskApiRouteTypes {
  "GET /api/desk": { response: DeskView | DeskDisabled };
  "GET /api/desk/studio": { response: DeskStudioResponse };
  "GET /api/desk/studio/{thread}/draft": { response: DeskStudioDraftResponse };
  "PUT /api/desk/studio/{thread}/draft": { request: DeskStudioDraftWrite; response: DeskStudioDraftResponse };
  "GET /api/desk/my-day": { response: MyDayResponse };
}

export type DeskApiRouteKey = keyof DeskApiRouteTypes;
