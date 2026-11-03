import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { Capability } from "../../../conversations/creation";
import { CreationSection } from "../dashboard-v2/components/desk-conversation-create";
import { handleDeskCaptureUndo } from "../api/desk-ask";
import { HandledLedger } from "../desk/actions";
import { studioRequestId } from "../desk/conversation-sources";
import { captureId, captureMarker, type CaptureModel, type CaptureRequest } from "../desk/studio/capture";
import { runStudioAct } from "../desk/studio/writer";
import { failureOf, studioConversationRig } from "./studio-conversation-rig";

const rig = studioConversationRig("conversation-studio-capture-", "studio-capture", { alpha: "active", beta: "active", gamma: "parked" });
const AREAS = [{ id: "lab", label: "Lab", color: "#7c3aed", policy: "local" as const }];

function filer(answer: unknown) {
  const asked: CaptureRequest[] = [];
  const model: CaptureModel = (_config, request) => {
    asked.push(request);
    return Promise.resolve(answer);
  };
  return { asked, model };
}

const ALPHA = { thread: "alpha", match: true, reason: "It is about alpha." };
const text = (dir: string, path: string): string => readFileSync(join(dir, path), "utf8");
const inbox = (dir: string): string[] => readdirSync(join(dir, "inbox")).sort();

describe("Studio capture writer", () => {
  test("shows the filer's thread and reason, files the capture in its Material, replays an equal confirm, and Undo from Done for you removes it", async () => {
    const f = filer(ALPHA);
    const r = await rig({ filer: { local: true }, captureModel: f.model });
    try {
      const view = await r.propose({ text: "Ivy probe thought" });
      expect(view.proposal.fields).toEqual({ text: "Ivy probe thought", thread: "alpha" });
      expect(view.proposal.suggestion).toBe("It is about alpha.");
      expect(f.asked).toEqual([{ capture: "Ivy probe thought", threads: [{ slug: "alpha", question: "What about alpha?", stand: "Not settled." }, { slug: "beta", question: "What about beta?", stand: "Not settled." }] }]);

      const reply = await r.confirm(view);
      const operation = r.created(reply);
      const id = captureId(studioRequestId(operation.operationId));
      const thread = text(r.repo.dir, "threads/alpha.md");
      expect(thread).toContain(`${captureMarker(id)}Ivy probe thought`);
      expect(thread).toContain(`Filed capture ${id} from Ivy conversation ?desk=conversation&conversation=${r.id}`);

      await r.confirmedAgain(view, operation);
      expect(f.asked).toHaveLength(1);
      const done = r.db.query("SELECT action, item_key, title FROM desk_done").all();
      expect(done).toEqual([{ action: "studio.capture", item_key: id, title: "Ivy probe thought" }]);

      const undo = await handleDeskCaptureUndo(new Request("http://127.0.0.1:8767/api/desk/capture/undo", { method: "POST", body: JSON.stringify({ id, requestId: "undo-capture-1" }) }), r.db, { ledger: new HandledLedger(), options: r.desk });
      expect(undo.status).toBe(200);
      expect(text(r.repo.dir, "threads/alpha.md")).not.toContain(captureMarker(id));
      expect(r.db.query("SELECT action FROM desk_done").all()).toEqual([{ action: "studio.capture.undone" }]);
    } finally { r.repo.clean(); }
  });

  test("the proposal card shows the filer's reason as one plain line under the fields", async () => {
    const r = await rig({ filer: { local: true }, captureModel: filer(ALPHA).model });
    try {
      const view = await r.propose({ text: "Card thought" });
      const types = await r.types() as unknown as Capability[];
      const html = renderToStaticMarkup(<CreationSection id={r.id} archived={false} types={types} view={{ proposals: [view], grants: [] }} error={null} busy={false} seed={{ entryId: null, text: "" }} act={() => Promise.resolve()} />);
      expect(html).toContain("<p class=\"dcv-quiet\">Filer: It is about alpha.</p>");
      expect(html).toContain("in thread alpha.");
    } finally { r.repo.clean(); }
  });

  test("a thread the principal clears files the capture to the Studio inbox without asking the filer again", async () => {
    const f = filer(ALPHA);
    const r = await rig({ filer: { local: true }, captureModel: f.model });
    try {
      const view = await r.propose({ text: "Second thought" });
      const cleared = await r.revise(view, { text: "Second thought", thread: "" });
      expect(cleared.proposal.fields.thread).toBe("");
      expect(cleared.proposal.suggestion).toBeUndefined();
      const operation = r.created(await r.confirm(cleared));
      const id = captureId(studioRequestId(operation.operationId));
      expect(inbox(r.repo.dir)).toEqual([`${id}.md`]);
      expect(text(r.repo.dir, `inbox/${id}.md`)).toMatch(/^---\nat: .+\nvia: conversation\n---\n\nSecond thought\n$/);
      expect(text(r.repo.dir, "threads/alpha.md")).not.toContain("Second thought");
      expect(f.asked).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("a thread parked between proposal and confirm fails with the owner's sentence and writes nothing", async () => {
    const r = await rig({ filer: { local: true }, captureModel: filer(ALPHA).model });
    try {
      const view = await r.propose({ text: "Late thought" });
      expect(view.proposal.fields.thread).toBe("alpha");
      expect(await runStudioAct({ options: { dir: r.repo.dir, maxActive: 5 }, areas: AREAS, requestId: "studio-act-park-alpha", act: { act: "park", thread: "alpha" } })).toMatchObject({ ok: true });
      const before = r.commits();
      const reply = await r.confirm(view);
      expect(reply.status).toBe(409);
      expect(reply.body.proposal.feedback).toBe("failed");
      expect(failureOf(reply.body.proposal)).toBe("That thread is no longer active. Nothing was created.");
      expect(r.commits()).toEqual(before);
      expect(inbox(r.repo.dir)).toEqual([]);
    } finally { r.repo.clean(); }
  });

  test("without a filer the proposal has no suggestion and an empty thread, and confirming files to the inbox", async () => {
    const r = await rig();
    try {
      const view = await r.propose({ text: "Unfiled thought" });
      expect(view.proposal.fields).toEqual({ text: "Unfiled thought" });
      expect(view.proposal.suggestion).toBeUndefined();
      const operation = r.created(await r.confirm(view));
      expect(inbox(r.repo.dir)).toEqual([`${captureId(studioRequestId(operation.operationId))}.md`]);
    } finally { r.repo.clean(); }
  });

  test("an unrelated thought keeps the thread empty and says it goes to the inbox", async () => {
    const r = await rig({ filer: { local: true }, captureModel: filer({ thread: null, match: true, reason: "It fits no open question." }).model });
    try {
      const view = await r.propose({ text: "Groceries" });
      expect(view.proposal.fields).toEqual({ text: "Groceries" });
      expect(view.proposal.suggestion).toBe("It fits no open question; it goes to the Studio inbox.");
    } finally { r.repo.clean(); }
  });

  test("a local conversation asks only the local filer, also when every thread is cloud", async () => {
    const local = filer(ALPHA);
    const r = await rig({ filer: { local: false }, captureModel: local.model, areaPolicy: "cloud" });
    const cloud = filer(ALPHA);
    const c = await rig({ filer: { local: false }, captureModel: cloud.model, areaPolicy: "cloud", policy: "cloud" });
    try {
      const view = await r.propose({ text: "Private thought" });
      expect(view.proposal.fields).toEqual({ text: "Private thought" });
      expect(view.proposal.suggestion).toBeUndefined();
      expect(local.asked).toHaveLength(0);
      expect((await c.propose({ text: "Shared thought" })).proposal.fields.thread).toBe("alpha");
      expect(cloud.asked).toHaveLength(1);
    } finally {
      r.repo.clean();
      c.repo.clean();
    }
  });

  test("replays the earlier commit when the writer is called again and reads it back from the Desk-Request trailer", async () => {
    const r = await rig();
    try {
      await r.replayed({ text: "Replayed thought", thread: "beta" });
      expect(text(r.repo.dir, "threads/beta.md").match(/- capture: \[/g)).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("lists studio-capture as ready with text and an optional thread, and blocked without a Studio", async () => {
    const r = await rig();
    const bare = await rig({ studio: false });
    try {
      const listed = (await r.types()).find(t => t.type === "studio-capture");
      expect(listed?.status).toBe("ready");
      expect(listed?.fields.map(f => [f.name, f.required, f.destination ?? false])).toEqual([["text", true, false], ["thread", false, true]]);
      expect(await bare.status("studio-capture")).toBe("blocked:3142");
    } finally {
      r.repo.clean();
      bare.repo.clean();
    }
  });
});
