import { describe, expect, test } from "bun:test";
import { studioRequestId } from "../desk/conversation-sources";
import { deskWriterRig } from "./conversation-writer-rig";

const WRITER = ["reminders-bin"];
const open = deskWriterRig({ prefix: "conversation-reminder-", label: "ai.meta-factory.cortex.reminder-writer-test", kind: "reminder", type: "reminder", canonicalId: "REMINDER-1" });
const rig = (writer: string[] | null = WRITER) => open(writer);

const PROBE = { title: "Ivy probe 0a1b", due: "2027-01-07T03:00:00+01:00" };

describe("reminder writer for conversation proposals", () => {
  test("the type is ready only with a reminder writer on an enabled Desk", async () => {
    const ready = await rig();
    expect(await ready.capability()).toBe("ready");
    ready.options.enabled = false;
    expect(await ready.capability()).toBe("blocked:3037");
    expect(await (await rig(null)).capability()).toBe("blocked:3037");
  });

  test("a confirmed proposal sends text, due and the derived request id, and the identical confirm runs nothing", async () => {
    const r = await rig();
    const { view, reply } = await r.submit(PROBE);
    expect(reply).toMatchObject({ status: 200, body: { proposal: { feedback: "created", operation: { canonicalId: "REMINDER-1" } } } });
    const operationId = reply.body.proposal.operation?.operationId ?? "";
    expect(r.calls).toEqual([{ argv: WRITER, stdin: { kind: "reminder", requestId: studioRequestId(operationId), fields: { text: PROBE.title, due: "2027-01-07T02:00:00.000Z" } } }]);
    expect(await r.confirm(view)).toMatchObject({ status: 200, body: { proposal: { operation: { canonicalId: "REMINDER-1" } } } });
    expect(r.calls).toHaveLength(1);
  });

  test("a proposal without a due time shows it missing and confirm answers 400 without running the writer", async () => {
    const r = await rig();
    const view = await r.propose({ title: PROBE.title });
    expect(view.missing).toEqual(["Due"]);
    const refused = await r.confirm(view);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Fill in Due first. Nothing was created.");
    expect(r.calls).toEqual([]);
  });

  test("another list is refused with 409 before the writer runs", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, list: "Work" }));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("This stack saves reminders only to the default list. Nothing was created.");
    const named = await rig([...WRITER, "--list", "Home"]);
    expect((await named.confirm(await named.propose({ ...PROBE, list: "Work" }))).body.error).toBe("This stack saves reminders only to Home. Nothing was created.");
    expect((await named.confirm(await named.propose({ ...PROBE, list: "Home" }))).body.proposal.feedback).toBe("created");
    expect(r.calls).toEqual([]);
    expect(named.calls).toHaveLength(1);
  });

  test("a due time that is not ISO 8601 fails with the validation sentence and no writer run", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, due: "tomorrow 3am" }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("The due time is not an ISO 8601 date and time such as 2027-01-06T09:00:00+01:00. Nothing was created.");
    expect(r.calls).toEqual([]);
  });

  test("a writer refusal fails with its sentence", async () => {
    const r = await rig();
    r.answerWith(() => Promise.resolve({ code: 3, stdout: "", stderr: "desk-reminders-mac has no full access to Reminders.\n" }));
    const refused = await r.confirm(await r.propose(PROBE));
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("desk-reminders-mac has no full access to Reminders. Nothing was created.");
  });

  test("an unknown result stays uncertain, and Check never reruns the writer", async () => {
    const r = await rig();
    const outcome = await r.timeoutThenCheck(PROBE);
    expect(outcome.feedback.every(feedback => feedback === "uncertain") && outcome.runs === 1).toBe(true);
    expect(r.calls[0]?.stdin.kind).toBe("reminder");
  });
});
