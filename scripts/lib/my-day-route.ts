import assert from "node:assert/strict";
import type { Server } from "bun";
import type { MyDayView } from "../../src/surface/mc/desk/my-day";

export function serveMyDayRoute(readRoute: () => Promise<Response>): { server: Server<undefined>; get: () => Promise<MyDayView> } {
  const server: Server<undefined> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: readRoute });
  const get = async (): Promise<MyDayView> => {
    const response = await fetch(new URL("/api/desk/my-day", server.url));
    assert.equal(response.status, 200);
    return response.json() as Promise<MyDayView>;
  };
  return { server, get };
}
