import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runWithTemporaryHome } from "./probe-temp-home";
import { openStudioDraftRig } from "../src/surface/mc/testing/studio-draft-rig";

const MARKER = `marker-${randomUUID()}`;
const ANSWER = { reply: "Noted.", summary: "We read the draft.", proposal: null };

async function probe(): Promise<void> {
  const received: string[] = [];
  const endpoint = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => {
    received.push(await req.text());
    return Response.json({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] });
  } });
  const cloudReceived: string[] = [];
  const cloudEndpoint = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => {
    cloudReceived.push(await req.text());
    return Response.json({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] });
  } });
  const cloud = { baseUrl: `http://127.0.0.1:${cloudEndpoint.port}/v1`, model: "cloud-model", timeoutSeconds: 5, maxPerPass: 1, contextTokens: 20_000, maxOutputTokens: 1_000 };
  const model = { baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, model: "recording-model", timeoutSeconds: 5, maxPerPass: 1, contextTokens: 20_000, maxOutputTokens: 1_000 };
  const rig = await openStudioDraftRig({ filer: { ...cloud, local: model } });
  try {
    const session = randomUUID();
    const post = async (body: object): Promise<{ status: number; body: { ok: boolean; error?: string } }> => {
      const response = await fetch(`${rig.baseUrl()}/api/desk/studio/session`, { method: "POST", headers: { "content-type": "application/json", origin: rig.baseUrl() }, body: JSON.stringify({ id: session, ...body }) });
      return { status: response.status, body: await response.json() };
    };
    const text = `# Draft\n\n${MARKER}\n`;
    const initial = await rig.read();
    assert.equal((await rig.put({ text, revision: initial.revision, requestId: randomUUID() })).status, 200);
    const saved = await rig.read();
    assert.equal((await post({ action: "start", thread: "question", scope: { kind: "thread" } })).status, 200);

    const head = rig.git("rev-parse", "HEAD");
    const answered = await post({ action: "say", turn: randomUUID(), text: "What do you make of the draft?" });
    assert.equal(answered.status, 200);
    assert.equal(received.length, 1);
    assert.ok(received[0]?.includes(MARKER), "the permitted endpoint received the draft marker");
    assert.ok(received[0]?.includes(saved.revision), "the prompt carries the draft revision");
    assert.equal(cloudReceived.length, 0, "the local thread never reached the cloud endpoint");
    assert.deepEqual(await rig.read(), saved);
    assert.equal(rig.git("rev-parse", "HEAD"), head);

    const big = "x".repeat(200_000);
    assert.equal((await rig.put({ text: big, revision: saved.revision, requestId: randomUUID() })).status, 200);
    const oversize = await rig.read();
    const refused = await post({ action: "say", turn: randomUUID(), text: "And now?" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error ?? "", /too large/);
    assert.equal(received.length, 1, "the oversize turn made no model call");
    assert.equal(cloudReceived.length, 0);
    assert.deepEqual(await rig.read(), oversize);
    console.log("Studio draft thinking: marker reached the permitted endpoint, oversize input refused readably without inference, draft unchanged on a disposable Cortex stack.");
  } finally { await rig.close(); endpoint.stop(true); cloudEndpoint.stop(true); }
}

await runWithTemporaryHome(import.meta.path, probe);
