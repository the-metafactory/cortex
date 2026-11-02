import { describe, expect, test } from "bun:test";
import { listOpenNotes } from "../desk/notes";
import { deskWriterRig } from "./conversation-writer-rig";

const TANA_WRITER = ["desk-note-tana.ts"];
const open = deskWriterRig({ prefix: "conversation-desk-note-", label: "ai.meta-factory.cortex.desk-note-writer-test", kind: "note", type: "desk-note", canonicalId: "unused" });
const NOTE = { text: "Ivy probe 0b2c — safe to remove" };
const keptTexts = (r: Awaited<ReturnType<typeof open>>) => listOpenNotes(r.db).map(n => ({ id: String(n.id), kind: n.kind, text: n.text }));

describe("Desk note writer for conversation proposals", () => {
  test("without a note writer, a confirmed proposal keeps the note under Keep in mind and is created with its desk_notes id; the identical confirm keeps nothing more", async () => {
    const r = await open(null);
    expect(await r.capability()).toBe("ready");
    const { view, reply } = await r.submit({ text: `  ${NOTE.text}  ` });
    expect(reply.status).toBe(200);
    expect(reply.body.proposal.feedback).toBe("created");
    const kept = keptTexts(r);
    expect(kept).toEqual([{ id: reply.body.proposal.operation?.canonicalId ?? "", kind: "note", text: NOTE.text }]);
    expect(kept[0]?.id).toMatch(/^\d+$/);
    const again = await r.confirm(view);
    expect(again.status).toBe(200);
    expect(again.body.proposal.operation).toEqual(reply.body.proposal.operation);
    expect(keptTexts(r)).toEqual(kept);
    expect(r.calls).toEqual([]);
  });

  test("with a configured note writer the type is unavailable, no writer is wired and a confirm keeps nothing", async () => {
    const r = await open(TANA_WRITER);
    expect(await r.capability()).toBe("blocked:3040");
    const refused = await r.confirm(await r.propose(NOTE));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEndWith("Nothing was created.");
    expect(listOpenNotes(r.db)).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  test("a disabled Desk leaves the type unavailable", async () => {
    const r = await open(null);
    r.options.enabled = false;
    expect(await r.capability()).toBe("blocked:3040");
  });

  test("an empty note after trimming answers 400 naming the missing field and keeps nothing", async () => {
    const r = await open(null);
    const refused = await r.confirm(await r.propose({ text: "   " }));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Fill in Note first. Nothing was created.");
    expect(listOpenNotes(r.db)).toEqual([]);
  });

  test("a changed confirmation is refused with 409 and keeps nothing", async () => {
    const r = await open(null);
    const view = await r.propose(NOTE);
    const other = await r.propose({ text: "Something else" });
    const refused = await r.confirm({ ...view, digest: other.digest });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("The proposal you confirmed differs from the saved one. Nothing was created; review it again.");
    expect(listOpenNotes(r.db)).toEqual([]);
  });
});
