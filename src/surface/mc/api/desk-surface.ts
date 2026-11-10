const noStore = { "Cache-Control": "no-store" };

export interface DeskSurfaceRoutes<Reader, Item> {
  readonly label: string;
  readonly destinations: string;
  readonly item: string;
  readonly unknown: string;
  readonly invalid: string;
  readonly failure: string;
  readonly items: (url: URL) => Item | null;
  readonly destinationsOf: (reader: Reader) => Promise<unknown>;
  readonly itemOf: (reader: Reader, input: Item) => Promise<unknown>;
}

export async function handleDeskSurface<Reader, Item>(req: Request, url: URL, access: (() => Reader | null) | undefined, routes: DeskSurfaceRoutes<Reader, Item>): Promise<Response> {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const reader = access?.() ?? null;
  if (reader === null) return Response.json({ enabled: false }, { headers: noStore });
  try {
    if (url.pathname === routes.destinations) return Response.json(await routes.destinationsOf(reader), { headers: noStore });
    if (url.pathname !== routes.item) return Response.json({ error: routes.unknown }, { status: 404, headers: noStore });
    const input = routes.items(url);
    if (input === null) return Response.json({ error: routes.invalid }, { status: 400, headers: noStore });
    return Response.json(await routes.itemOf(reader, input), { headers: noStore });
  } catch (err) {
    process.stderr.write(`${routes.label}: ${err instanceof Error ? err.message : String(err)}\n`);
    return Response.json({ error: routes.failure }, { status: 502, headers: noStore });
  }
}
