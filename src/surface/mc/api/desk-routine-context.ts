import type { DeskRuntime } from "../desk/compose";

export const routineReadHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export function routineReadContext(req: Request, runtime: DeskRuntime | undefined) {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { ...routineReadHeaders, Allow: "GET" } });
  const options = runtime?.options?.enabled ? runtime.options.routines : undefined;
  const scope = runtime?.options?.routineScope;
  if (!options || !scope) return Response.json({ error: "Routines are not set up on this stack." }, { status: 409, headers: routineReadHeaders });
  return { options, scope };
}
