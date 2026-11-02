import { describe, expect, it } from "bun:test";
import { noteMailOpened } from "../lib/desk-action";

describe("noting a mail opened on the Desk", () => {
  it("sends one keepalive POST without waiting for it, and skips keys that are not a listed mail", () => {
    const calls: { path: string; body: unknown; keepalive: boolean | undefined }[] = [];
    const pending = (path: string, init: RequestInit): Promise<Response> => {
      calls.push({ path, body: JSON.parse(String(init.body)), keepalive: init.keepalive });
      return new Promise<Response>(() => undefined);
    };
    expect(noteMailOpened("mail:a@x", pending)).toBeUndefined();
    noteMailOpened("handoff:1", pending);
    expect(calls).toEqual([{ path: "/api/desk/mail", body: { action: "opened", key: "mail:a@x" }, keepalive: true }]);
  });

  it("never throws when the request fails or the fetch itself throws", async () => {
    let rejected = false;
    noteMailOpened("mail:a@x", () => { rejected = true; return Promise.reject(new Error("offline")); });
    expect(() => noteMailOpened("mail:a@x", () => { throw new Error("no fetch"); })).not.toThrow();
    await Promise.resolve();
    expect(rejected).toBe(true);
  });
});
