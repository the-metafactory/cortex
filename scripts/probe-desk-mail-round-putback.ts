import assert from "node:assert/strict";
import type { DeskView } from "../src/surface/mc/desk/types";
import { openMailRoundRig, putBackPayload, queuedMails, readAnswer, roundAt, roundKeys, roundMail, roundSideEffects, roundStatuses, type MailRoundRig } from "../src/surface/mc/__tests__/fixtures/mail-round-rig";

const rig: MailRoundRig = await openMailRoundRig(roundAt(9, 8), { mailDigest: undefined, mailInvitations: undefined });

const putBack = (round: NonNullable<DeskView["mailRound"]>, key: string, requestId: string): Promise<Response> =>
  rig.postRound(putBackPayload(round, key, requestId));
const undo = async (token: string | undefined, requestId: string): Promise<Response> => rig.postRound({ action: "undo", token, requestId });

try {
  rig.setState({ mail: [roundMail("a", roundAt(9, 7)), roundMail("b", roundAt(9, 7, 5)), roundMail("c", roundAt(9, 7, 10))] });
  rig.setNow(roundAt(9, 8, 31));
  const first = await rig.get();
  const round = first.mailRound;
  assert.ok(round?.id);
  assert.deepEqual(roundKeys(first), ["mail:a", "mail:b", "mail:c"]);
  const untouched = roundSideEffects(rig.database());

  const [left, right] = await Promise.all([putBack(round, "mail:a", "probe-race-a"), putBack(round, "mail:b", "probe-race-b")]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409]);
  const raced = left.status === 200 ? await readAnswer(left) : await readAnswer(right);
  const stale = left.status === 409 ? await readAnswer(left) : await readAnswer(right);
  assert.equal(stale.ok, false);
  assert.equal(stale.messagePhrase?.code, "act.closed-item");
  assert.ok(raced.undo);
  const racedKey = left.status === 200 ? "mail:a" : "mail:b";
  assert.deepEqual(roundStatuses(rig.database()), [{ id: round.id, status: "open" }]);

  const readBack = await rig.get();
  assert.equal(readBack.mailRound?.revision, round.revision + 1);
  assert.equal(readBack.mailRound?.mails.length, 2);
  assert.deepEqual(queuedMails(rig.database()), [{ mail_key: racedKey, put_back: 1, position: 0 }]);

  const restored = await readAnswer(await undo(raced.undo, "probe-undo-race"));
  assert.equal(restored.outcome, "restored");
  assert.deepEqual(restored.mailRound?.mails.map((member) => member.key), ["mail:a", "mail:b", "mail:c"]);
  assert.deepEqual(queuedMails(rig.database()), []);

  const current = (await rig.get()).mailRound;
  assert.ok(current?.id);
  const middle = await readAnswer(await putBack(current, "mail:b", "probe-put-back-middle"));
  assert.equal(middle.ok, true);
  assert.deepEqual(middle.mailRound?.mails.map((member) => member.key), ["mail:a", "mail:c"]);
  assert.equal(middle.messagePhrase?.code, "mail.put-back");
  assert.equal(middle.messagePhrase?.params?.nextAt, new Date(roundAt(9, 13, 30)).toISOString());
  assert.deepEqual(queuedMails(rig.database()), [{ mail_key: "mail:b", put_back: 1, position: 0 }]);

  const retried = await readAnswer(await putBack(current, "mail:b", "probe-put-back-middle"));
  assert.deepEqual(retried, middle);
  assert.deepEqual(queuedMails(rig.database()), [{ mail_key: "mail:b", put_back: 1, position: 0 }]);

  rig.reopen();
  const afterReopen = await readAnswer(await putBack(current, "mail:b", "probe-put-back-middle"));
  assert.deepEqual(afterReopen, middle);
  const reopened = await rig.refresh();
  assert.equal(reopened.mailRound?.revision, current.revision + 1);
  assert.deepEqual(roundKeys(reopened), ["mail:a", "mail:c"]);
  assert.equal(reopened.mailRound?.waiting, 1);

  const finalMember = (await rig.get()).mailRound;
  assert.ok(finalMember?.id);
  const lastButOne = await readAnswer(await putBack(finalMember, "mail:c", "probe-put-back-final-c"));
  assert.deepEqual(lastButOne.mailRound?.mails.map((member) => member.key), ["mail:a"]);
  const lastRound = (await rig.get()).mailRound;
  assert.ok(lastRound?.id);
  const last = await readAnswer(await putBack(lastRound, "mail:a", "probe-put-back-final-a"));
  assert.equal(last.mailRound?.due, false);
  assert.deepEqual(queuedMails(rig.database()), [
    { mail_key: "mail:a", put_back: 1, position: -2 },
    { mail_key: "mail:c", put_back: 1, position: -1 },
    { mail_key: "mail:b", put_back: 1, position: 0 },
  ]);
  assert.deepEqual(roundStatuses(rig.database()), [{ id: round.id, status: "finished" }]);

  const late = await readAnswer(await undo(lastButOne.undo, "probe-undo-late"));
  assert.equal(late.ok, true);
  assert.equal(late.outcome, "next-round");
  assert.equal(late.messagePhrase?.code, "mail.put-back-next-round");
  assert.match(late.message ?? "", /finished/);
  assert.deepEqual(roundStatuses(rig.database()), [{ id: round.id, status: "finished" }]);
  assert.deepEqual(queuedMails(rig.database()), [
    { mail_key: "mail:c", put_back: 1, position: -3 },
    { mail_key: "mail:a", put_back: 1, position: -2 },
    { mail_key: "mail:b", put_back: 1, position: 0 },
  ]);

  rig.setNow(roundAt(9, 13, 31));
  const successor = await rig.refresh();
  assert.notEqual(successor.mailRound?.id, round.id);
  assert.deepEqual(roundKeys(successor), ["mail:c", "mail:a", "mail:b"]);
  const successorId = successor.mailRound?.id;

  const inRound = await readAnswer(await undo(last.undo, "probe-undo-in-round"));
  assert.equal(inRound.outcome, "next-round");
  assert.equal(inRound.mailRound?.id, successorId);
  assert.deepEqual(roundKeys(inRound), ["mail:c", "mail:a", "mail:b"]);

  const refused = await undo("probe-no-such-token", "probe-undo-unknown");
  assert.equal(refused.status, 404);
  assert.equal((await readAnswer(refused)).messagePhrase?.code, "act.unknown-target");
  const conflict = await rig.postRound({ action: "put-back", roundId: successorId, revision: successor.mailRound?.revision, key: "mail:b", requestId: "probe-put-back-middle" });
  assert.equal(conflict.status, 409);

  assert.deepEqual(roundSideEffects(rig.database()), untouched);
  assert.equal(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_round_operations WHERE json_extract(result, '$.ok') = 1").get()?.n, 7);
  assert.equal(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_round_operations WHERE kind = 'put-back' AND undone_by IS NOT NULL").get()?.n, 3);

  console.log("Mail round put-back probe passed: a middle and a final member lead the successor in put-back order, a racing stale revision is refused, retries survive a reopen, and undo restores the open round or reports the finished one without touching mail, tasks or snoozes.");
} finally {
  await rig.close();
}
