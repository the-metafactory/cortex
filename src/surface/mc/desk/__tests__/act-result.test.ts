import { describe, expect, test } from "bun:test";
import { withActPhrase } from "../act-result";

const post = new Request("http://localhost/api/desk/links", { method: "POST" });
const json = (body: unknown, status = 200): Response => Response.json(body, { status });

describe("withActPhrase", () => {
  test("an ok act answer gains act.done and keeps its message", async () => {
    const out = await (await withActPhrase(post, "/api/desk/links", json({ ok: true, message: "Linked." }))).json();
    expect(out).toEqual({ ok: true, message: "Linked.", messagePhrase: { code: "act.done" } });
  });

  test("a refusal Cortex decides gets its own code, not act.refused", async () => {
    const out = await (await withActPhrase(post, "/api/desk/links", json({ ok: false, error: "No such task." }, 404))).json();
    expect(out.messagePhrase).toEqual({ code: "act.unknown-target" });
    expect(out.error).toBe("No such task.");
  });

  test("a closed item and a missing grant have codes", async () => {
    expect((await (await withActPhrase(post, "/api/desk/links", json({ ok: false, error: "x" }, 409))).json()).messagePhrase.code).toBe("act.closed-item");
    expect((await (await withActPhrase(post, "/api/desk/links", json({ ok: false, error: "x" }, 403))).json()).messagePhrase.code).toBe("act.forbidden");
  });

  test("a command failure is act.failed with its text in detail, never in params", async () => {
    const out = await (await withActPhrase(post, "/api/desk/mail", json({ ok: false, error: "The draft was not saved: boom" }, 502))).json();
    expect(out.messagePhrase).toEqual({ code: "act.failed" });
    expect(out.detail).toBe("The draft was not saved: boom");
  });

  test("an answer that already carries a phrase is left alone", async () => {
    const body = { ok: true, message: "m", messagePhrase: { code: "mail.hidden" } };
    expect(await (await withActPhrase(post, "/api/desk/mail", json(body))).json()).toEqual(body);
  });

  test("reads and routes outside /api/desk are untouched", async () => {
    const get = new Request("http://localhost/api/desk/links");
    expect(await (await withActPhrase(get, "/api/desk/links", json({ ok: true, message: "m" }))).json()).toEqual({ ok: true, message: "m" });
    expect(await (await withActPhrase(post, "/api/other", json({ ok: true, message: "m" }))).json()).toEqual({ ok: true, message: "m" });
  });
});
