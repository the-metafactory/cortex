import assert from "node:assert/strict";
import { openMailRoundRig, roundAt, roundMail } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";
import { runWithTemporaryHome } from "./probe-temp-home";

async function probe(): Promise<void> {
  const now = roundAt(16, 10);
  const rig = await openMailRoundRig(now, { mailDigest: undefined, mailInvitations: undefined });
  const key = "mail:early-fixture";
  const original = roundMail("early-fixture", now - 1000, { subject: "Venue quote" });
  try {
    rig.setState({ mail: [original] });
    assert.ok((await rig.get()).items.some((item) => item.key === key));
    const deferred = await rig.defer({ action: "defer", key, until: { kind: "next-week" } });
    assert.equal(deferred.status, 200);
    rig.setNow(now + 120_000);
    const quiet = await rig.refresh();
    assert.ok(quiet.deferred.some((entry) => entry.key === key));
    console.log("deferred to next week, thread quiet: stays in deferred[]");

    const reply = roundMail("early-reply", now + 60_000, { from: { name: "Priya Shah", address: "priya@example.org" }, subject: "Re: Venue quote", headers: { inReplyTo: "early-fixture" } });
    rig.setState({ mail: [original, reply] });
    rig.setNow(now + 240_000);
    const back = await rig.refresh();
    const item = back.items.find((entry) => entry.key === key);
    assert.ok(item);
    assert.equal(item.back?.line, "Back because Priya Shah wrote again: “Re: Venue quote”.");
    assert.ok(item.urgency === "today" || item.urgency === "now");
    assert.equal(item.interrupt, undefined);
    assert.ok(!back.deferred.some((entry) => entry.key === key));
    console.log(`reply added to the thread: back in items[] at urgency ${item.urgency}, ${item.back?.line}`);
  } finally { await rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
