import assert from "node:assert/strict";
import { openMailRoundRig, roundAt } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";
import { runWithTemporaryHome } from "./probe-temp-home";

const RANGER = {
  current: [],
  needsYou: [{ key: "example/app#1", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "failed", endedAt: new Date(roundAt(16, 7)).toISOString(), reason: { class: "worker failed", detail: "tests failed" } }],
  maps: [],
};

async function probe(): Promise<void> {
  const now = roundAt(16, 10);
  const ranger = Bun.serve({ port: 0, fetch: () => Response.json(RANGER) });
  const rig = await openMailRoundRig(now, { rangerUrl: `http://127.0.0.1:${ranger.port}`, mailDigest: undefined, mailInvitations: undefined });
  const post = (body: unknown) => fetch(`${rig.baseUrl()}/api/desk/items/defer`, { method: "POST", headers: { "content-type": "application/json", origin: rig.baseUrl() }, body: JSON.stringify(body) });
  try {
    rig.setState({ mail: [] });
    const id = rig.database().query<{ id: number }, [number, number]>("INSERT INTO desk_notes (kind, text, due_at, created_at) VALUES ('reminder', 'Fixture reminder', ?, ?) RETURNING id").get(now - 60_000, now - 3_600_000)?.id;
    const reminder = `reminder:${id}`;
    assert.ok((await rig.get()).items.some((item) => item.key === reminder));
    assert.equal((await post({ action: "defer", key: reminder, until: { kind: "tomorrow" } })).status, 200);
    const away = await rig.get();
    assert.ok(!away.items.some((item) => item.key === reminder));
    const entry = away.deferred.find((item) => item.key === reminder);
    assert.deepEqual(entry, { key: reminder, title: "Fixture reminder", until: "until tomorrow at 08:00" });
    console.log(`POST defer reminder: 200; absent from items[]; deferred[] = ${JSON.stringify(entry)}`);

    const failed = (await rig.get()).items.find((item) => item.kind === "agent-failed");
    assert.ok(failed);
    const refused = await post({ action: "defer", key: failed.key, until: { kind: "tomorrow" } });
    assert.equal(refused.status, 400);
    const reason = ((await refused.json()) as { error: string }).error;
    assert.ok(reason.includes("an alarm stays on the Desk"));
    console.log(`POST defer agent-failed: 400; ${reason}`);
  } finally {
    ranger.stop(true);
    await rig.close();
  }
}

await runWithTemporaryHome(import.meta.path, probe);
