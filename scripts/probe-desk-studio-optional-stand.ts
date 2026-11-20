import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DraftSchema, openStudioDraftRig } from "../src/surface/mc/testing/studio-draft-rig";
import { runWithTemporaryHome } from "./probe-temp-home";

const StudioStandsSchema = z.object({ studio: z.object({ active: z.array(z.object({ slug: z.string(), stand: z.string() })) }) });

async function probe(): Promise<void> {
  const rig = await openStudioDraftRig();
  try {
    const path = join(rig.studioDir, "threads/question.md");
    const readStands = async () => {
      const response = await fetch(`${rig.baseUrl()}/api/desk/studio`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("x-desk-api-version"));
      return StudioStandsSchema.parse(await response.json()).studio.active;
    };
    for (const stand of [null, "", "Try a narrow fold.", "Legacy answer.\n\nFull reasoning stays here."]) {
      const file = await rig.setStand(stand);
      const before = await readStands();
      assert.equal(before.find(thread => thread.slug === "question")?.stand, stand ?? "");
      const draft = await rig.read();
      const text = `# Full draft\n\n## Answer\n\n${stand ?? "No stand yet."}\n\n## Reasoning\n\nComplete Markdown remains editable.\n`;
      const response = await rig.put({ text, revision: draft.revision, requestId: randomUUID() });
      assert.equal(response.status, 200);
      assert.equal(DraftSchema.parse(await response.json()).text, text);
      await rig.reopen();
      assert.equal((await rig.read()).text, text);
      assert.deepEqual(await readStands(), before);
      assert.equal(await readFile(path, "utf8"), file);
    }
    console.log("Optional Studio stand: missing, empty, single-line and legacy multiline stands survive full draft GET/PUT and restart unchanged on a disposable development stack.");
  } finally { await rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
