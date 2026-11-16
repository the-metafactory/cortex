import assert from "node:assert/strict";
import { readSnooze } from "../src/surface/mc/desk/mail-snooze";
import { openMailRoundRig, roundAt, roundMail } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";
import { runWithTemporaryHome } from "./probe-temp-home";

async function probe(): Promise<void> {
  const now = roundAt(16, 10);
  const rig = await openMailRoundRig(now, { mailDigest: undefined, mailInvitations: undefined });
  const key = "mail:defer-fixture";
  const post = (body: unknown) => fetch(`${rig.baseUrl()}/api/desk/items/defer`, { method: "POST", headers: { "content-type": "application/json", origin: rig.baseUrl() }, body: JSON.stringify(body) });
  try {
    rig.setState({ mail: [roundMail("defer-fixture", now - 1000)] });
    assert.ok((await rig.get()).items.some((item) => item.key === key));
    const deferred = await post({ action: "defer", key, until: { kind: "tomorrow" } });
    assert.equal(deferred.status, 200);
    assert.equal(readSnooze(rig.database(), "defer-fixture")?.state, "snoozed");
    const away = await rig.get();
    assert.ok(!away.items.some((item) => item.key === key));
    assert.deepEqual(away.deferred, [{ key, title: "Subject defer-fixture", until: "until tomorrow at 08:00" }]);
    console.log(`POST defer: 200; absent from items[]; deferred[] = ${JSON.stringify(away.deferred)}`);

    assert.equal((await post({ action: "defer.cancel", key })).status, 200);
    const restored = await rig.get();
    const item = restored.items.find((entry) => entry.key === key);
    assert.ok(item);
    assert.equal(item.back, undefined);
    assert.ok(!item.why.includes("Back because"));
    assert.deepEqual(restored.deferred, []);
    assert.equal(readSnooze(rig.database(), "defer-fixture"), null);
    console.log("POST defer.cancel: 200; fixture back in items[] without a return reason; deferred[] = []");
  } finally { await rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
