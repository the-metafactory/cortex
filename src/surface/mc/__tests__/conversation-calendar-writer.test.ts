import { describe, expect, test } from "bun:test";
import type { ProposalView } from "../../../conversations/creation";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources, studioRequestId } from "../desk/conversation-sources";
import { WriterTimeout, type WriterResult } from "../desk/create";
import { conversationWriterRig } from "./conversation-writer-rig";

const WRITER = ["calendar-bin", "--create"];
const writerRig = conversationWriterRig("conversation-calendar-", "ai.meta-factory.cortex.calendar-writer-test");

interface Reply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string }; types: { type: string; status: string }[] }
interface Call { argv: string[]; stdin: { kind: string; requestId: string; fields: Record<string, string> } }

async function rig(writer: string[] | null = WRITER, policy: "local" | "cloud" = "cloud") {
  const db = writerRig.database();
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(writer ? { ask: { parser: [], timeoutSeconds: 5, writers: { calendar: writer }, taskMaps: [] } } : {}) };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const rig = await writerRig.open<Reply>(db, runtime);
  const calls: Call[] = [];
  let answer = (): Promise<WriterResult> => Promise.resolve({ code: 0, stdout: JSON.stringify({ id: "EVENT-1:ABC", message: "Added." }), stderr: "" });
  const run = (argv: string[], stdin: string): Promise<WriterResult> => {
    calls.push({ argv, stdin: JSON.parse(stdin) as Call["stdin"] });
    return answer();
  };
  await rig.host.attachSources(conversationSources({ db, desk: () => options, runCalendar: run }));
  const id = await rig.start("Synthetic calendar", policy);
  const propose = (fields: Record<string, string>) => rig.propose(id, "calendar-event", fields);
  const confirm = (view: ProposalView) => rig.confirm(id, view);
  const check = (view: ProposalView) => rig.check(id, view);
  const capability = async () => (await rig.call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === "calendar-event")?.status;
  const submit = async (fields: Record<string, string>) => {
    const view = await propose(fields);
    return { view, reply: await confirm(view) };
  };
  return { id, options, calls, propose, confirm, check, submit, capability, answerWith: (next: () => Promise<WriterResult>) => { answer = next; } };
}

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
      notes: `Safe to delete.\n\nFrom Ivy conversation ${r.id}, operation ${operationId}.`,
    } } }]);
    expect(await r.confirm(view)).toMatchObject({ status: 200, body: { proposal: { operation: { canonicalId: "EVENT-1:ABC" } } } });
    expect(r.calls).toHaveLength(1);
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
    const r = await rig();
    r.answerWith(() => Promise.reject(new WriterTimeout("timed out after 5 seconds")));
    const { view, reply } = await r.submit(PROBE);
    const checked = await r.check(view);
    expect([reply, checked].map(answer => answer.body.proposal.feedback)).toEqual(["uncertain", "uncertain"]);
    expect(r.calls).toHaveLength(1);
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
