const noStore = { "Cache-Control": "no-store" };

export const reply = (body: object, status = 200): Response => Response.json(body, { status, headers: noStore });
