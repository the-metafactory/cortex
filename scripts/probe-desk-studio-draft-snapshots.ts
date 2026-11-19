import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runWithTemporaryHome } from "./probe-temp-home";
import { DraftSchema, openStudioDraftRig } from "../src/surface/mc/testing/studio-draft-rig";

const Snapshots = z.object({ snapshots: z.array(z.object({ id: z.uuid(), revision: z.string(), transition: z.enum(["park", "close"]), at: z.iso.datetime() }).strict()) }).strict();
const FullSnapshot = Snapshots.shape.snapshots.element.extend({ text: z.string() });

async function probe(): Promise<void> {
  const rig = await openStudioDraftRig();
  try {
    const initial = await rig.read();
    const text = "\ufeff# A complete answer\r\n\r\nReasoning and [evidence](https://example.org/result).\n\n---\n  Exact whitespace\t\n ";
    const put = await rig.put({ text, revision: initial.revision, requestId: randomUUID() });
    assert.equal(put.status, 200);
    const saved = DraftSchema.parse(await put.json());
    const stale = await rig.act({ act: "close", thread: "question", outcome: "dropped", text: "Summary", draftRevision: initial.revision, requestId: randomUUID() });
    assert.equal(stale.status, 409);
    assert.deepEqual(DraftSchema.parse(await stale.json()), saved);
    const park = { act: "park", thread: "question", draftRevision: saved.revision, requestId: randomUUID() };
    assert.equal((await rig.act(park)).status, 200);
    assert.deepEqual(await rig.read(), { ...saved, editable: false });
    const listing = await rig.snapshots();
    assert.equal(listing.status, 200);
    assert.ok(listing.headers.get("x-desk-api-version"));
    const entries = Snapshots.parse(await listing.json()).snapshots;
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    const snapshot = FullSnapshot.parse(await (await rig.snapshots("question", entry.id)).json());
    assert.deepEqual(snapshot, { ...entry, revision: saved.revision, transition: "park", text });
    const path = join(rig.studioDir, `draft-snapshots/question/${entry.id}.json`);
    const bytes = await readFile(path);
    assert.equal((await rig.act({ act: "unpark", thread: "question", requestId: randomUUID() })).status, 200);
    const active = await rig.read();
    assert.equal(active.editable, true);
    const edited = await rig.put({ text: " \r\n\t ", revision: active.revision, requestId: randomUUID() });
    assert.equal(edited.status, 200);
    const blank = DraftSchema.parse(await edited.json());
    const head = rig.git("rev-parse", "HEAD");
    const refused = await rig.act({ act: "close", thread: "question", outcome: "shipped", text: "Short summary", draftRevision: blank.revision, requestId: randomUUID() });
    assert.equal(refused.status, 400);
    assert.equal(rig.git("rev-parse", "HEAD"), head);
    assert.deepEqual(await rig.read(), blank);
    await rig.reopen();
    assert.deepEqual(FullSnapshot.parse(await (await rig.snapshots("question", entry.id)).json()), snapshot);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await rig.act(park)).status, 200);
    assert.equal(rig.git("rev-parse", "HEAD"), head);
    assert.deepEqual(Snapshots.parse(await (await rig.snapshots()).json()).snapshots, entries);
    console.log("Studio snapshots passed on a disposable development stack: stale close 409, exact immutable park snapshot, unpark/edit preservation, restart/retry identity, and blank shipped refusal. No principal-owned Studio was used.");
  } finally { await rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
