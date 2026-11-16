import assert from "node:assert/strict";
import { openMailRoundRig, postDeskJson, roundAt, roundEvent } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";
import { runWithTemporaryHome } from "./probe-temp-home";

async function probe(): Promise<void> {
  const now = roundAt(16, 16, 10);
  const rig = await openMailRoundRig(now, { mailDigest: undefined, mailInvitations: undefined });
  const key = "meeting-after:cal:round-source:just-ended";
  try {
    rig.setState({ mail: [], events: [roundEvent("just-ended", roundAt(16, 15, 40), roundAt(16, 16, 5))] });
    await rig.get();
    const read = async () => (await (await fetch(`${rig.baseUrl()}/api/desk`)).json()) as Awaited<ReturnType<typeof rig.get>>;
    const before = await read();
    assert.deepEqual(before.items.filter((item) => item.kind === "meeting-after").map((item) => item.key), [key]);
    console.log(`GET /api/desk: one after-meeting card, ${key}`);

    const dismissed = await postDeskJson(rig.baseUrl(), "/api/desk/action", { action: "meeting.dismiss", key });
    assert.equal(dismissed.status, 200);
    assert.deepEqual(await dismissed.json(), { ok: true, message: "\"Meeting just-ended\" is dismissed from the Desk.", messagePhrase: { code: "meeting.dismissed" } });
    assert.deepEqual((await read()).items.filter((item) => item.kind === "meeting-after"), []);
    console.log("POST /api/desk/action meeting.dismiss: 200; the card is gone");

    rig.reopen();
    assert.deepEqual((await read()).items.filter((item) => item.kind === "meeting-after"), []);
    console.log("GET /api/desk from a second client on the same Cortex database: the card stays gone");

    const refused = await postDeskJson(rig.baseUrl(), "/api/desk/action", { action: "meeting.dismiss", key: "meeting-after:cal:round-source:not-a-card" });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "The Desk has no after-meeting card with this key.");
    console.log("POST /api/desk/action for a key that is not a card: 400 with a readable reason");
  } finally { await rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
