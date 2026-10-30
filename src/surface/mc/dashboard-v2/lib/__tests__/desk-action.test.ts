import { describe, expect, it } from "bun:test";
import { DESK_ACTION_PATH, submitDeskAction } from "../desk-action";

const answer = (status: number, body: unknown) => {
  const seen: { path: string; init: RequestInit }[] = [];
  const fetchImpl = async (path: string, init: RequestInit) => {
    seen.push({ path, init });
    return Response.json(body, { status });
  };
  return { seen, fetchImpl };
};

describe("submitDeskAction", () => {
  it("posts the action and returns Ranger's line", async () => {
    const { seen, fetchImpl } = answer(200, { ok: true, message: 'Approved "Adopt the date library". Ranger will start it.' });
    const result = await submitDeskAction({ action: "ranger.approve", key: "ranger:example/app#30" }, fetchImpl);
    expect(result).toEqual({ ok: true, text: 'Approved "Adopt the date library". Ranger will start it.' });
    expect(seen[0]?.path).toBe(DESK_ACTION_PATH);
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ action: "ranger.approve", key: "ranger:example/app#30" });
  });

  it("passes a Ranger failure through as its one line", async () => {
    const { fetchImpl } = answer(502, { ok: false, error: "Ranger refused: node is no longer open and unclaimed" });
    expect((await submitDeskAction({ action: "ranger.approve", key: "k" }, fetchImpl)).text).toBe("Ranger refused: node is no longer open and unclaimed");
  });

  it("prefers a gate's readable detail over its error code", async () => {
    const { fetchImpl } = answer(403, { error: "not_authorized", detail: "This identity may not act on this stack." });
    expect((await submitDeskAction({ action: "ranger.retry", key: "k" }, fetchImpl)).text).toBe("This identity may not act on this stack.");
  });

  it("never throws when Mission Control does not answer", async () => {
    const result = await submitDeskAction({ action: "ranger.approve", key: "k" }, async () => { throw new Error("offline"); });
    expect(result).toEqual({ ok: false, text: "Mission Control did not answer: offline" });
  });
});
