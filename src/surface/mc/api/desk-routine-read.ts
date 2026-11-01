import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineOptions } from "../desk/routine-command";

const headers = { "Cache-Control": "no-store" };
export async function handleRoutineRead<T>(req: Request, runtime: DeskRuntime | undefined, contract: {
  request: z.ZodType<T>; id: z.ZodString; description: string;
  inspect: (options: RoutineOptions, id: string) => Promise<unknown>;
  preview: (options: RoutineOptions, input: T) => Promise<unknown>;
}): Promise<Response> {
  const options = runtime?.options?.enabled ? runtime.options.routines : undefined;
  if (!options) return Response.json({ error: "Routines are not set up on this stack." }, { status: 409, headers });
  try {
    if (req.method === "GET") {
      const input = z.object({ id: contract.id }).strict().safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!input.success) return Response.json({ error: "Choose an exact installed routine." }, { status: 400, headers });
      return Response.json(await contract.inspect(options, input.data.id), { headers });
    }
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, POST" } });
    const input = contract.request.safeParse(await req.json().catch(() => null));
    if (!input.success) return Response.json({ error: contract.description }, { status: 400, headers });
    return Response.json(await contract.preview(options, input.data), { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "The routine owner could not confirm this preview." }, { status: 409, headers }); }
}
