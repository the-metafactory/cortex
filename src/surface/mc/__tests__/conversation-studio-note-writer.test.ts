import { describe, expect, test } from "bun:test";
import type { StudioAct } from "../desk/studio/acts";
import { runStudioAct } from "../desk/studio/writer";
import { failureOf, studioConversationRig } from "./studio-conversation-rig";

const rig = studioConversationRig("conversation-studio-note-", "studio-note", { alpha: "active", gamma: "parked", omega: "closed" });
const AREAS = [{ id: "lab", label: "Lab", color: "#7c3aed", policy: "local" as const }];
let acts = 0;
const act = (dir: string, studioAct: StudioAct) => runStudioAct({ options: { dir, maxActive: 5 }, areas: AREAS, assistantName: "Assistant", requestId: `studio-act-${++acts}-xyz`, act: studioAct });

describe("Studio note writer", () => {
  test("adds an open stand as Ivy's proposal, leaves Where I stand alone, and Keep in Studio makes it the stand", async () => {
    const r = await rig();
    try {
      const { view, reply } = await r.submit({ thread: "alpha", kind: "stand", text: "Run the workshop in spring." });
      const operation = r.created(reply);
      const t = r.parsed("alpha");
      expect(t.stand).toBe("Not settled.");
      expect(t.notes).toHaveLength(1);
      const note = t.notes[0];
      expect(note).toMatchObject({ trigger: "Ivy conversation", model: "local", kind: "stand", status: "open", text: "Run the workshop in spring." });
      expect(note?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(t.log.at(-1)?.text).toBe(`Added Assistant's stand from conversation ?desk=conversation&conversation=${r.id}`);
      expect(r.repo.git("log", "-n", "1", "--format=%s")).toContain("Add Assistant's stand to alpha from a conversation");

      await r.confirmedAgain(view, operation);
      expect(r.parsed("alpha").notes).toHaveLength(1);

      const kept = await act(r.repo.dir, { act: "keep", thread: "alpha", note: note?.at ?? "" });
      expect(kept).toMatchObject({ ok: true, message: "Assistant's stand is now yours." });
      const after = r.parsed("alpha");
      expect(after.stand).toBe("Run the workshop in spring.");
      expect(after.notes[0]?.status).toBe("kept");
    } finally { r.repo.clean(); }
  });

  test("keeps a plain note at once, also when the kind is empty, and lets Studio dismiss an idea on a parked thread", async () => {
    const r = await rig();
    try {
      r.created((await r.submit({ thread: "alpha", kind: "note", text: "The room seats twelve." })).reply);
      r.created((await r.submit({ thread: "alpha", kind: "", text: "Ask the lab first." })).reply);
      expect(r.parsed("alpha").notes.map(n => [n.kind, n.status, n.text])).toEqual([["note", "kept", "The room seats twelve."], ["note", "kept", "Ask the lab first."]]);
      const [first, second] = r.parsed("alpha").notes;
      expect(first?.at).not.toBe(second?.at);

      r.created((await r.submit({ thread: "gamma", kind: "idea", text: "Pair it with the autumn course." })).reply);
      const idea = r.parsed("gamma").notes[0];
      expect(idea).toMatchObject({ kind: "idea", status: "open", trigger: "Ivy conversation" });
      expect(await act(r.repo.dir, { act: "dismiss", thread: "gamma", note: idea?.at ?? "" })).toMatchObject({ ok: true });
      expect(r.parsed("gamma").notes[0]?.status).toBe("dismissed");
    } finally { r.repo.clean(); }
  });

  test("fails before the Studio is called for a relation or any other kind, and leaves the thread unchanged", async () => {
    const r = await rig();
    try {
      const relation = await r.submit({ thread: "alpha", kind: "relation", text: "Links to the budget." });
      expect(relation.reply.status).toBe(409);
      expect(relation.reply.body.proposal.feedback).toBe("failed");
      expect(failureOf(relation.reply.body.proposal)).toBe("relation is not a note kind; use note, idea or stand. Nothing was created.");
      const other = await r.submit({ thread: "alpha", kind: "question", text: "Why?" });
      expect(failureOf(other.reply.body.proposal)).toBe("question is not a note kind; use note, idea or stand. Nothing was created.");
      expect(r.commits()).toHaveLength(1);
      expect(r.parsed("alpha").notes).toHaveLength(0);
    } finally { r.repo.clean(); }
  });

  test("refuses a closed or missing thread with the owner's sentence and writes nothing", async () => {
    const r = await rig();
    try {
      const closed = await r.submit({ thread: "omega", kind: "idea", text: "Reopen it." });
      expect(closed.reply.status).toBe(409);
      expect(failureOf(closed.reply.body.proposal)).toBe("No open thread is called omega. Nothing was created.");
      const missing = await r.submit({ thread: "no-such-thread", kind: "note", text: "Hello?" });
      expect(failureOf(missing.reply.body.proposal)).toBe("No open thread is called no-such-thread. Nothing was created.");
      expect(r.commits()).toHaveLength(1);
      expect(r.parsed("omega").notes).toHaveLength(0);
    } finally { r.repo.clean(); }
  });

  test("replays the earlier commit when the writer is called again and reads it back from the Desk-Request trailer", async () => {
    const r = await rig();
    try {
      await r.replayed({ thread: "alpha", kind: "idea", text: "Try a half day." });
      expect(r.parsed("alpha").notes).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("lists studio-note as ready with thread, kind and text, and blocked without a Studio", async () => {
    const r = await rig();
    const bare = await rig({ studio: false });
    try {
      const listed = (await r.types()).find(t => t.type === "studio-note");
      expect(listed?.status).toBe("ready");
      expect(listed?.fields.map(f => [f.name, f.required, f.destination ?? false])).toEqual([["thread", true, true], ["kind", false, false], ["text", true, false]]);
      expect(await bare.status("studio-note")).toBe("blocked:3140");
    } finally {
      r.repo.clean();
      bare.repo.clean();
    }
  });
});
