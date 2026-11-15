import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DeskOptions } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import { DeskSchema } from "../../../common/types/config";
import { studioRequestId } from "../desk/conversation-sources";
import { deskWriterRig } from "./conversation-writer-rig";

const WRITER = ["desk-note-tana.ts"];
const TANA_ID = "kX9_tana-node";
const open = deskWriterRig({ prefix: "conversation-note-", label: "ai.meta-factory.cortex.tana-note-writer-test", kind: "note", type: "tana-note", canonicalId: TANA_ID, owner: "tana", labels: { note: { objects: "Tana notes", noun: "Tana notes", fallback: "the Tana inbox" } } });
const rig = (writer: string[] | null = WRITER, policy: "local" | "cloud" = "cloud") => open(writer, policy);

const NOTE = { text: "Ivy probe 0a1b — safe to delete" };
const answer = (id: string) => () => Promise.resolve({ code: 0, stdout: JSON.stringify({ id, message: "Added the note to your Tana Inbox." }), stderr: "" });
const refusal = (stderr: string) => () => Promise.resolve({ code: 1, stdout: "", stderr });

describe("Note writer for conversation proposals", () => {
  test("labels default to neutral words and an empty label fails the config naming its key", async () => {
    const plain = await deskWriterRig({ prefix: "conversation-note-", label: "ai.meta-factory.cortex.note-writer-neutral-test", kind: "note", type: "tana-note", canonicalId: TANA_ID, owner: "tana" })(WRITER);
    const refused = await plain.confirm(await plain.propose({ ...NOTE, target: "otherNode" }));
    expect(refused.body.error).toBe("This stack adds notes only to the inbox. Nothing was created.");
    const empty = DeskSchema.safeParse({ ask: { writers: { note: WRITER }, writerLabels: { note: { objects: "Notes", noun: "", fallback: "the inbox" } } } });
    expect(empty.success).toBe(false);
    expect(JSON.stringify(empty.error?.issues)).toContain("writerLabels.note.noun");
  });

  test("the note writer registers under the catalog's note slot for any owner, and under none without an owner", () => {
    const keys = (owner?: string): string[] => {
      const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ask: { parser: [], timeoutSeconds: 5, writers: { note: WRITER }, ...(owner ? { writerOwners: { note: owner } } : {}), taskMaps: [] } };
      const db = new Database(":memory:");
      db.run("CREATE TABLE desk_balance (id TEXT)");
      const registered = Object.keys(conversationSources({ db, desk: () => options }).writers ?? {});
      db.close();
      return registered;
    };
    expect(keys("tana")).toContain("tana-note");
    expect(keys("obsidian")).toContain("tana-note");
    expect(keys("obsidian")).not.toContain("obsidian-note");
    expect(keys().filter(key => key === "tana-note")).toEqual([]);
  });

  test("the stack config declares a writer's owner on the writer, and a plain argument array declares none", () => {
    const declared = DeskSchema.parse({ ask: { writers: { note: { command: WRITER, owner: "tana" }, goal: ["desk-goal.ts"] } } }).ask;
    expect(declared.writers).toEqual({ note: WRITER, goal: ["desk-goal.ts"] });
    expect(declared.writerOwners).toEqual({ note: "tana" });
    expect(DeskSchema.parse({ ask: { writers: { note: WRITER } } }).ask).not.toHaveProperty("writerOwners");
    expect(DeskSchema.safeParse({ ask: { writers: { note: { command: WRITER, owner: "Tana Cloud" } } } }).success).toBe(false);
    expect(DeskSchema.safeParse({ ask: { writers: { note: { command: [] } } } }).success).toBe(false);
  });

  test("the type is ready only when the note writer declares an owner on an enabled Desk", async () => {
    const ready = await rig();
    expect(await ready.capability()).toBe("ready");
    ready.options.enabled = false;
    expect(await ready.capability()).toBe("blocked:3039");
    ready.options.enabled = true;
    const ask = ready.options.ask ?? { parser: [], timeoutSeconds: 5, writers: {}, taskMaps: [] };
    ask.writerOwners = { note: "keep" };
    expect(await ready.capability()).toBe("ready");
    delete ask.writerOwners;
    expect(await ready.capability()).toBe("blocked:3039");
    expect(await (await rig(null)).capability()).toBe("blocked:3039");
  });

  test("a confirmed proposal sends the note text with the derived request id and is created with the Tana node id; the identical confirm runs nothing", async () => {
    const r = await rig();
    const { view, reply } = await r.submit({ text: `  ${NOTE.text}  ` });
    expect(reply).toMatchObject({ status: 200, body: { proposal: { feedback: "created", operation: { canonicalId: TANA_ID } } } });
    const operationId = reply.body.proposal.operation?.operationId ?? "";
    expect(r.calls).toEqual([{ argv: WRITER, stdin: { kind: "note", requestId: studioRequestId(operationId), fields: { text: NOTE.text } } }]);
    expect(await r.confirm(view)).toMatchObject({ status: 200, body: { proposal: { operation: { operationId, canonicalId: TANA_ID } } } });
    expect(r.calls).toHaveLength(1);
  });

  test("the request id printed back as the id is the writer's fallback, so the operation stays uncertain and Check keeps it so", async () => {
    const r = await rig();
    r.answerWith(call => answer(call.stdin.requestId)());
    const { view, reply } = await r.submit(NOTE);
    expect(reply.body.proposal.feedback).toBe("uncertain");
    expect((await r.check(view)).body.proposal.feedback).toBe("uncertain");
    expect(r.calls).toHaveLength(1);
  });

  test("a target other than the configured one answers 409 before the writer runs", async () => {
    const inbox = await rig();
    const refused = await inbox.confirm(await inbox.propose({ ...NOTE, target: "otherNode" }));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("This stack adds Tana notes only to the Tana inbox. Nothing was created.");
    expect(inbox.calls).toEqual([]);
    const targeted = await rig([...WRITER, "--target", "projNode"]);
    expect((await targeted.confirm(await targeted.propose({ ...NOTE, target: "otherNode" }))).body.error).toBe("This stack adds Tana notes only to projNode. Nothing was created.");
    expect((await targeted.confirm(await targeted.propose({ ...NOTE, target: "projNode" }))).body.proposal.feedback).toBe("created");
    expect(targeted.calls).toHaveLength(1);
  });

  test("a local-only conversation's Tana note is refused and the writer never runs", async () => {
    const r = await rig(WRITER, "local");
    const view = await r.propose(NOTE);
    expect(view.refusal).toBe("This conversation is local-only and a tana note leaves this machine, so it cannot be created from here. Nothing was created.");
    const refused = await r.confirm(view);
    expect(refused.status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  test("a refusal fails with its sentence, but a refusal that says the note may have been created stays uncertain", async () => {
    const r = await rig();
    r.answerWith(refusal("Tana refused the note with HTTP 400; nothing was created.\n"));
    const refused = await r.confirm(await r.propose(NOTE));
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("Tana refused the note with HTTP 400. Nothing was created.");
    r.answerWith(refusal("Tana failed with HTTP 502; the note may have been created, so check Tana before asking again.\n"));
    const unknown = await r.confirm(await r.propose({ text: "Ivy probe 0a1c" }));
    expect(unknown.body.proposal.feedback).toBe("uncertain");
    expect(r.calls).toHaveLength(2);
  });

  test("a timeout stays uncertain, and Check never reruns the writer", async () => {
    const r = await rig();
    expect(await r.timeoutThenCheck(NOTE)).toStrictEqual({ runs: 1, feedback: ["uncertain", "uncertain"] });
  });
});
