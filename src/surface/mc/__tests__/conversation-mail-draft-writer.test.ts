import { describe, expect, test } from "bun:test";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import { WriterTimeout, type WriterResult, type WriterRunner } from "../desk/create";
import { resolveListedMail, type ListedMail } from "../desk/mail-actions";
import { conversationWriterRig, type DeskWriterReply } from "./conversation-writer-rig";

const DRAFT = ["desk-mail-draft"];
const LISTED: ListedMail = { kind: "mail", id: "probe-1@example.test", from: { name: "Kit Shop", address: "sales@kits.example" }, subject: "Quote for the glider kit", receivedAt: "2026-11-02T08:00:00.000Z", unread: true, account: "work", sourceId: "work-mail" };
const KEY = `mail:${LISTED.id}`;
const REPLY = "Ivy probe 0a1b — safe to delete";
const MESSAGE_ID = "draft-7f3a@kits.example";
const writerRig = conversationWriterRig("conversation-mail-draft-", "ai.meta-factory.cortex.mail-draft-writer-test");

interface Call { argv: string[]; stdin: Record<string, unknown> }

async function rig(opts: { draft?: string[] | null; listed?: ListedMail[]; policy?: "local" | "cloud" } = {}) {
  const db = writerRig.database();
  const draft = opts.draft === undefined ? DRAFT : opts.draft;
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(draft ? { mailActions: { draft, timeoutSeconds: 5 } } : {}) };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const r = await writerRig.open<DeskWriterReply>(db, runtime);
  const listed = [...(opts.listed ?? [LISTED])];
  const calls: Call[] = [];
  let answer = (): Promise<WriterResult> => Promise.resolve({ code: 0, stdout: `${JSON.stringify({ id: MESSAGE_ID, message: "Draft saved in work Drafts." })}\n`, stderr: "" });
  const run: WriterRunner = (argv, stdin) => {
    calls.push({ argv, stdin: JSON.parse(stdin) as Record<string, unknown> });
    return answer();
  };
  await r.host.attachSources(conversationSources({ db, desk: () => options, lookupMail: key => resolveListedMail(listed.map(({ sourceId, ...mail }) => ({ id: sourceId, area: null, events: [], mail: [mail], readAt: 0, error: null, dropped: 0, problems: [] })), key), ledger: runtime.ledger, runMailDraft: run }));
  const id = await r.start("Synthetic mail draft", opts.policy ?? "cloud");
  const propose = (fields: Record<string, string> = { mail: KEY, body: REPLY }) => r.propose(id, "mail-draft", fields);
  const submit = async (fields?: Record<string, string>) => {
    const view = await propose(fields);
    return { view, reply: await r.confirm(id, view) };
  };
  const capability = async () => (await r.call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === "mail-draft")?.status;
  return { ...r, id, options, runtime, listed, calls, propose, submit, capability, answerWith: (next: () => Promise<WriterResult>) => { answer = next; } };
}

describe("Mail reply-draft writer for conversation proposals", () => {
  test("the type is ready only when the Desk is on and the draft command is configured", async () => {
    const ready = await rig();
    expect(await ready.capability()).toBe("ready");
    ready.options.enabled = false;
    expect(await ready.capability()).toBe("blocked:3041");
    expect(await (await rig({ draft: null })).capability()).toBe("blocked:3041");
  });

  test("a confirmed reply sends only the draft action for the listed mail and is created with the Message-ID; the identical confirm runs nothing", async () => {
    const r = await rig();
    const { view, reply } = await r.submit({ mail: KEY, body: `  ${REPLY}  ` });
    expect(reply).toMatchObject({ status: 200, body: { proposal: { feedback: "created", operation: { canonicalId: MESSAGE_ID } } } });
    expect(r.calls).toEqual([{ argv: DRAFT, stdin: { action: "draft", account: "work", messageId: LISTED.id, to: "sales@kits.example", subject: "Re: Quote for the glider kit", body: REPLY } }]);
    const operationId = reply.body.proposal.operation?.operationId;
    expect(await r.confirm(r.id, view)).toMatchObject({ status: 200, body: { proposal: { operation: { operationId, canonicalId: MESSAGE_ID } } } });
    expect((await r.confirm(r.id, view, { digest: "0".repeat(64) })).status).toBe(409);
    expect(r.calls.map(c => c.stdin.action)).toEqual(["draft"]);
  });

  test("a draft saved without a Message-ID stays uncertain, and Check does not run the command again", async () => {
    const r = await rig();
    r.answerWith(() => Promise.resolve({ code: 0, stdout: JSON.stringify({ id: "", message: "Draft saved in work Drafts." }), stderr: "" }));
    const { view, reply } = await r.submit();
    expect(reply.body.proposal.feedback).toBe("uncertain");
    expect((await r.check(r.id, view)).body.proposal.feedback).toBe("uncertain");
    expect(r.calls).toHaveLength(1);
  });

  test("a mail that left the Desk answers 409 failed and the command never runs", async () => {
    const r = await rig();
    const view = await r.propose();
    r.listed.splice(0);
    const refused = await r.confirm(r.id, view);
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("That mail is no longer on the Desk. Nothing was created.");
    expect(r.calls).toEqual([]);
  });

  test("a mail without an account and a draft already being saved from the Desk fail with the owner's sentence", async () => {
    const r = await rig({ listed: [{ ...LISTED, account: undefined }] });
    expect((await r.submit()).reply.body.error).toBe("The mail source names no account for this mail, so the Desk cannot draft a reply. Nothing was created.");
    const busy = await rig();
    busy.runtime.ledger.claim(`draft:${LISTED.id}`);
    const refused = await busy.submit();
    expect(refused.reply.body.proposal.feedback).toBe("failed");
    expect(refused.reply.body.error).toBe("A draft for this mail is already being saved. Nothing was created.");
    expect([...r.calls, ...busy.calls]).toEqual([]);
  });

  test("a timeout or an unconfirmed save stays uncertain; a plain refusal fails", async () => {
    const r = await rig();
    r.answerWith(() => Promise.reject(new WriterTimeout("timed out after 5 seconds")));
    expect((await r.submit()).reply.body.proposal.feedback).toBe("uncertain");
    r.answerWith(() => Promise.resolve({ code: 1, stdout: "", stderr: "The email CLI gave no confirmation that the draft was saved; check work Drafts before trying again.\n" }));
    expect((await r.submit({ mail: KEY, body: "second" })).reply.body.proposal.feedback).toBe("uncertain");
    r.answerWith(() => Promise.resolve({ code: 1, stdout: "", stderr: "The work mail server did not save the draft: login failed\n" }));
    const refused = await r.submit({ mail: KEY, body: "third" });
    expect(refused.reply.body.proposal.feedback).toBe("failed");
    expect(refused.reply.body.error).toBe("The draft was not saved: The work mail server did not save the draft: login failed. Nothing was created.");
    expect(r.calls.map(c => c.stdin.action)).toEqual(["draft", "draft", "draft"]);
  });

  test("a local-only conversation's reply draft is refused and the command never runs", async () => {
    const r = await rig({ policy: "local" });
    const view = await r.propose();
    expect(view.refusal).toBe("This conversation is local-only and a reply draft leaves this machine, so it cannot be created from here. Nothing was created.");
    expect((await r.confirm(r.id, view)).status).toBe(403);
    expect(r.calls).toEqual([]);
  });
});
