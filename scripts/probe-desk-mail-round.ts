import assert from "node:assert/strict";
import { openMailRoundRig, roundAt, roundEvent, roundMail } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";

const rig = await openMailRoundRig(roundAt(9, 8), { mailDigest: undefined, mailInvitations: undefined });
try {
  rig.setState({ mail: [roundMail("a", roundAt(9, 7))], events: [roundEvent("one", roundAt(9, 8, 30), roundAt(9, 9, 15), "unknown"), roundEvent("two", roundAt(9, 9, 15), roundAt(9, 9, 30), "busy")] });
  rig.setNow(roundAt(9, 9));
  const shifted = await rig.get();
  assert.equal(shifted.mailRound?.due, false);
  assert.equal(shifted.mailRound?.nextScheduledAt, new Date(roundAt(9, 9, 30)).toISOString());

  rig.setNow(roundAt(9, 9, 1));
  rig.setState({ mail: [roundMail("a", roundAt(9, 7))], calendarCoverage: null });
  const calendarLost = await rig.refresh();
  assert.equal(calendarLost.sources.every(source => source.ok), true);
  assert.deepEqual(calendarLost.mailRound?.unavailable.calendar, ["round-source"]);
  rig.reopen();
  rig.setNow(roundAt(9, 9, 31));
  const stillQueued = await rig.refresh();
  assert.equal(stillQueued.mailRound?.due, false);
  assert.equal(stillQueued.mailRound?.waiting, 1);
  assert.equal(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_rounds").get()?.n, 0);
  rig.setState({ mail: [roundMail("a", roundAt(9, 7))], events: [roundEvent("one", roundAt(9, 8, 30), roundAt(9, 9, 15), "unknown"), roundEvent("two", roundAt(9, 9, 15), roundAt(9, 9, 30), "busy")] });
  rig.setNow(roundAt(9, 9, 32));
  const first = await rig.refresh();
  assert.equal(first.mailRound?.due, true);
  assert.deepEqual(first.mailRound?.mails.map((member) => member.key), ["mail:a"]);

  rig.setState({ mail: [roundMail("a", roundAt(9, 7)), roundMail("b", roundAt(9, 9, 45))], events: [roundEvent("one", roundAt(9, 8, 30), roundAt(9, 9, 15), "unknown"), roundEvent("two", roundAt(9, 9, 15), roundAt(9, 9, 30), "busy")] });
  rig.setNow(roundAt(9, 13, 31));
  const waiting = await rig.refresh();
  assert.equal(waiting.mailRound?.id, first.mailRound?.id);
  assert.deepEqual(waiting.mailRound?.mails.map((member) => member.key), ["mail:a"]);
  assert.equal(waiting.mailRound?.waiting, 1);

  rig.setState({ mail: [roundMail("a", roundAt(9, 7)), roundMail("b", roundAt(9, 9, 45))], calendarCoverage: null });
  rig.setNow(roundAt(9, 13, 32));
  const openDuringOutage = await rig.refresh();
  assert.equal(openDuringOutage.mailRound?.id, first.mailRound?.id);
  assert.equal((await rig.post({ action: "hide", key: "mail:a" })).status, 200);
  const noPrematureSuccessor = await rig.get();
  assert.equal(noPrematureSuccessor.mailRound?.due, false);
  assert.equal(noPrematureSuccessor.mailRound?.waiting, 1);
  rig.reopen();
  assert.equal((await rig.refresh()).mailRound?.due, false);
  rig.setState({ mail: [roundMail("a", roundAt(9, 7)), roundMail("b", roundAt(9, 9, 45))] });
  rig.setNow(roundAt(9, 13, 33));
  const lateCompletion = await rig.refresh();
  assert.notEqual(lateCompletion.mailRound?.id, first.mailRound?.id);
  assert.equal(lateCompletion.mailRound?.due, true);
  assert.deepEqual(lateCompletion.mailRound?.mails.map((member) => member.key), ["mail:b"]);

  rig.setState({ mail: [roundMail("a", roundAt(9, 7)), roundMail("b", roundAt(9, 9, 45)), roundMail("c", roundAt(9, 14))], events: [] });
  rig.setNow(roundAt(10, 0, 5));
  const midnight = await rig.refresh();
  assert.equal(midnight.mailRound?.id, lateCompletion.mailRound?.id);
  assert.equal(midnight.mailRound?.due, true);
  assert.deepEqual(midnight.mailRound?.mails.map((member) => member.key), ["mail:b"]);
  assert.equal(midnight.mailRound?.waiting, 1);

  rig.setNow(roundAt(10, 17));
  const later = await rig.refresh();
  assert.equal(later.mailRound?.id, lateCompletion.mailRound?.id);
  assert.equal(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_rounds WHERE status = 'open'").get()?.n, 1);

  assert.equal((await rig.post({ action: "hide", key: "mail:b" })).status, 200);
  const caughtUp = await rig.get();
  assert.notEqual(caughtUp.mailRound?.id, lateCompletion.mailRound?.id);
  assert.deepEqual(caughtUp.mailRound?.mails.map((member) => member.key), ["mail:c"]);

  rig.setState({ mail: [], fail: true });
  rig.setNow(roundAt(10, 17, 5));
  const unavailable = await rig.refresh();
  assert.equal(unavailable.mailRound?.id, caughtUp.mailRound?.id);
  assert.equal(unavailable.mailRound?.due, true);
  assert.deepEqual(unavailable.mailRound?.mails.map((member) => member.key), ["mail:c"]);
  assert.deepEqual(unavailable.mailRound?.unavailable.mail, ["round-source"]);
  assert.deepEqual(unavailable.mailRound?.unavailable.calendar, ["round-source"]);
  assert.equal(unavailable.sources.find((source) => source.id === "round-source")?.ok, false);

  rig.reopen();
  const reopened = await rig.refresh();
  assert.equal(reopened.mailRound?.id, caughtUp.mailRound?.id);
  assert.equal(reopened.mailRound?.due, true);
  assert.deepEqual(reopened.mailRound?.mails.map((member) => member.key), ["mail:c"]);

  console.log("Mail round probe passed: qualified meeting chains shift slots, calendar loss preserves queued mail and blocks successors across a reopen, restored coverage catches up, midnight keeps one round, and failed sources retain persisted membership.");
} finally {
  await rig.close();
}
