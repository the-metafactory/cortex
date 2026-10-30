import { describe, expect, it } from "bun:test";
import { DESK_ACTION_PATH, submitDeskAction } from "../desk-action";
import { STEP_UP_HEADER } from "../authorize-lib";

const answer = (status: number, body: unknown) => {
  const seen: { path: string; init: RequestInit }[] = [];
  const fetchImpl = async (path: string, init: RequestInit) => {
    seen.push({ path, init });
    return Response.json(body, { status });
  };
  return { seen, fetchImpl };
};

describe("submitDeskAction", () => {
  it("sends the step-up code in its header and returns Ranger's line", async () => {
    const { seen, fetchImpl } = answer(200, { ok: true, message: 'Approved "Adopt the date library". Ranger will start it.' });
    const result = await submitDeskAction({ action: "ranger.approve", key: "ranger:example/app#30" }, " 123456 ", fetchImpl);
    expect(result).toEqual({ ok: true, text: 'Approved "Adopt the date library". Ranger will start it.', needsCode: false, codeAccepted: true });
    expect(seen[0]?.path).toBe(DESK_ACTION_PATH);
    expect((seen[0]?.init.headers as Record<string, string>)[STEP_UP_HEADER]).toBe("123456");
  });

  it("turns a refused step-up into one plain line", async () => {
    const { fetchImpl } = answer(403, { error: "step_up_invalid", detail: "the code did not verify" });
    expect(await submitDeskAction({ action: "ranger.retry", key: "k" }, "000000", fetchImpl)).toEqual({
      ok: false, text: "That step-up code did not match. Nothing was sent to Ranger.", needsCode: false, codeAccepted: false,
    });
  });

  it("sends no header inside the unlock window, and says when the server wants a code again", async () => {
    const { seen, fetchImpl } = answer(403, { error: "step_up_required" });
    const result = await submitDeskAction({ action: "ranger.retry", key: "k" }, "", fetchImpl);
    expect(STEP_UP_HEADER in (seen[0]?.init.headers as Record<string, string>)).toBe(false);
    expect(result.needsCode).toBe(true);
  });

  it("passes a Ranger failure through as its one line, and still counts the code as accepted", async () => {
    const { fetchImpl } = answer(502, { ok: false, error: "Ranger refused: node is no longer open and unclaimed" });
    const result = await submitDeskAction({ action: "ranger.approve", key: "k" }, "123456", fetchImpl);
    expect(result.text).toBe("Ranger refused: node is no longer open and unclaimed");
    expect(result.codeAccepted).toBe(true);
  });

  it("never throws when Mission Control does not answer", async () => {
    const result = await submitDeskAction({ action: "ranger.approve", key: "k" }, "123456", async () => { throw new Error("offline"); });
    expect(result).toEqual({ ok: false, text: "Mission Control did not answer: offline", needsCode: false, codeAccepted: false });
  });
});
