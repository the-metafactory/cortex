import type { TypedResponse } from "../../../desk-api";

export function typedJson<Body>(body: Body, init?: ResponseInit): TypedResponse<Body> {
  return Response.json(body, init) as TypedResponse<Body>;
}
