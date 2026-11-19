import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runWithTemporaryHome } from "./probe-temp-home";
import { DraftSchema, openStudioDraftRig } from "../src/surface/mc/testing/studio-draft-rig";

const withoutLook = (view: unknown): unknown => {
  const copy = structuredClone(view) as { studio?: { board?: { look?: unknown } } | null };
  if (copy.studio?.board) copy.studio.board.look = undefined;
  return copy;
};

async function probe(): Promise<void> {
  const rig = await openStudioDraftRig();
  try {
    const before = await (await fetch(`${rig.baseUrl()}/api/desk/studio`)).json();
    const threadFiles = rig.git("ls-tree", "-r", "HEAD", "threads");
    const initial = await rig.read();
    assert.equal(initial.text, "");
    const text = " \n# Complete Markdown 🦊\r\n\r\n---\n\n## Section\n\n  Body\t\n\n ";
    const request = { text, revision: initial.revision, requestId: randomUUID() };
    const response = await rig.put(request);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("x-desk-api-version"));
    const saved = DraftSchema.parse(await response.json());
    assert.equal(saved.text, text);
    assert.notEqual(saved.revision, initial.revision);
    assert.deepEqual(await rig.read(), saved);
    assert.equal(await readFile(join(rig.studioDir, "drafts/question.md"), "utf8"), text);
    const stale = await rig.put({ text: "Stale overwrite", revision: initial.revision, requestId: randomUUID() });
    assert.equal(stale.status, 409);
    assert.deepEqual(DraftSchema.parse(await stale.json()), saved);
    await rig.reopen();
    assert.deepEqual(await rig.read(), saved);
    const head = rig.git("rev-parse", "HEAD");
    assert.equal((await rig.put(request)).status, 200);
    assert.equal(rig.git("rev-parse", "HEAD"), head);
    assert.equal(rig.git("ls-tree", "-r", "HEAD", "threads"), threadFiles);
    const after = await (await fetch(`${rig.baseUrl()}/api/desk/studio`)).json();
    assert.deepEqual(withoutLook(after), withoutLook(before));
    console.log("Studio draft: exact GET/PUT round-trip, stale-save 409, process restart, retry identity and unchanged notes/thread listing passed on a disposable Cortex stack.");
  } finally { await rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
