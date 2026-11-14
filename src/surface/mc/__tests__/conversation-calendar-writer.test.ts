import { describe, expect, test } from "bun:test";
import { studioRequestId } from "../desk/conversation-sources";
import { deskWriterRig } from "./conversation-writer-rig";

const WRITER = ["calendar-bin", "--create"];
const open = deskWriterRig({ prefix: "conversation-calendar-", label: "ai.meta-factory.cortex.calendar-writer-test", kind: "calendar", type: "calendar-event", canonicalId: "EVENT-1:ABC" });
const rig = (writer: string[] | null = WRITER, policy: "local" | "cloud" = "cloud") => open(writer, policy);

const PROBE = { title: "Ivy probe 0a1b", start: "2027-01-06T03:00:00+01:00", end: "2027-01-06T03:15:00+01:00", notes: "Safe to delete." };

describe("calendar writer for conversation proposals", () => {
  test("the type is ready only with a calendar writer on an enabled Desk", async () => {
    const ready = await rig();
    expect(await ready.capability()).toBe("ready");
    ready.options.enabled = false;
    expect(await ready.capability()).toBe("blocked:3036");
    expect(await (await rig(null)).capability()).toBe("blocked:3036");
  });

  test("a confirmed proposal runs the writer with the derived request id and provenance, and the identical confirm runs nothing", async () => {
    const r = await rig();
    const { view, reply } = await r.submit(PROBE);
    expect(reply).toMatchObject({ status: 200, body: { proposal: { feedback: "created", operation: { canonicalId: "EVENT-1:ABC" } } } });
    const operationId = reply.body.proposal.operation?.operationId ?? "";
    expect(r.calls).toEqual([{ argv: WRITER, stdin: { kind: "calendar", requestId: studioRequestId(operationId), fields: {
      title: PROBE.title, start: "2027-01-06T02:00:00.000Z", end: "2027-01-06T02:15:00.000Z",
      notes: `Safe to delete.\n\nFrom conversation ${r.id}, operation ${operationId}.`,
    } } }]);
    expect(await r.confirm(view)).toMatchObject({ status: 200, body: { proposal: { operation: { canonicalId: "EVENT-1:ABC" } } } });
    expect(r.calls).toHaveLength(1);
  });

  test("a time without an offset, as the conversation form's datetime-local input sends it, is read in the stack's time zone", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      const r = await rig();
      const { reply } = await r.submit({ ...PROBE, start: "2027-01-06T03:00", end: "2027-01-06T03:15" });
      expect(reply.body.proposal.feedback).toBe("created");
      expect(r.calls[0]?.stdin.fields).toMatchObject({ start: "2027-01-05T14:00:00.000Z", end: "2027-01-05T14:15:00.000Z" });
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  test("another calendar is refused with 409 before the writer runs", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, calendar: "Work" }));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("This stack saves events only to the default calendar. Nothing was created.");
    const named = await rig([...WRITER, "--calendar", "Home"]);
    expect((await named.confirm(await named.propose({ ...PROBE, calendar: "Work" }))).body.error).toBe("This stack saves events only to Home. Nothing was created.");
    expect((await named.confirm(await named.propose({ ...PROBE, calendar: "Home" }))).body.proposal.feedback).toBe("created");
    expect(r.calls).toEqual([]);
    expect(named.calls).toHaveLength(1);
  });

  test("a writer timeout stays uncertain, and Check keeps it uncertain without running the writer again", async () => {
    expect(await (await rig()).timeoutThenCheck(PROBE)).toEqual({ feedback: ["uncertain", "uncertain"], runs: 1 });
  });

  test.each([
    [{ end: "2027-01-06T02:59:00+01:00" }, "The end must come after the start. Nothing was created."],
    [{ start: "6 Jan 2027 03:00" }, "The start is not an ISO 8601 date and time such as 2027-01-06T09:00:00+01:00. Nothing was created."],
    [{ end: "2027-01-06" }, "The end is not an ISO 8601 date and time such as 2027-01-06T09:00:00+01:00. Nothing was created."],
  ])("invalid times %p fail with the validation sentence and no writer run", async (change, error) => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, ...change }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(error);
    expect(r.calls).toEqual([]);
  });

  test("a local-only conversation is refused before the writer runs", async () => {
    const r = await rig(WRITER, "local");
    const refused = await r.confirm(await r.propose(PROBE));
    expect(refused.status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  test("a writer refusal fails with its sentence", async () => {
    const r = await rig();
    r.answerWith(() => Promise.resolve({ code: 2, stdout: "", stderr: "The calendar Home is read-only.\n" }));
    const refused = await r.confirm(await r.propose(PROBE));
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("The calendar Home is read-only. Nothing was created.");
  });
});
