import { afterEach, describe, expect, it } from "bun:test";
import { openMailRoundRig, queuedMails, roundAt, roundKeys, roundMail, roundSideEffects, roundStatuses, type MailRoundRig } from "./fixtures/mail-round-rig";

interface RoundAnswer {
  ok: boolean;
  message?: string;
  messagePhrase?: { code: string; params?: Record<string, unknown> };
  undo?: string;
  outcome?: string;
  error?: string;
  mailRound?: { id: string | null; revision: number; due: boolean; mails: { key: string }[]; waiting: number; unavailable: { mail: string[]; calendar: string[] } };
}

const putBackBody = (round: { id: string | null; revision: number }, key: string, requestId: string): Record<string, unknown> => ({
  action: "put-back",
  roundId: round.id,
  revision: round.revision,
  key,
  requestId,
});

const readAnswer = async (response: Response): Promise<RoundAnswer> => (await response.json()) as RoundAnswer;

let rig: MailRoundRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function openThreeMemberRound(): Promise<NonNullable<Awaited<ReturnType<MailRoundRig["get"]>>["mailRound"]>> {
  rig = await openMailRoundRig(roundAt(11, 8));
  rig.setState({ mail: [roundMail("a", roundAt(11, 7)), roundMail("b", roundAt(11, 7, 5)), roundMail("c", roundAt(11, 7, 10))] });
  rig.setNow(roundAt(11, 8, 31));
  const round = (await rig.get()).mailRound;
  expect(round?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:b", "mail:c"]);
  return round!;
}

describe("POST /api/desk/mail/round put-back", () => {
  it("removes a middle member from the open round and leads the successor with it", async () => {
    const round = await openThreeMemberRound();
    const before = roundSideEffects(rig!.database());
    const answer = await readAnswer(await rig!.postRound(putBackBody(round, "mail:b", "req-put-back-b")));
    expect(answer.ok).toBe(true);
    expect(answer.mailRound?.id).toBe(round.id);
    expect(answer.mailRound?.revision).toBe(round.revision + 1);
    expect(answer.mailRound?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:c"]);
    expect(answer.mailRound?.waiting).toBe(1);
    expect(typeof answer.undo).toBe("string");
    expect(answer.messagePhrase?.code).toBe("mail.put-back");
    expect(typeof answer.messagePhrase?.params?.nextAt).toBe("string");
    expect(roundSideEffects(rig!.database())).toEqual(before);
    expect(queuedMails(rig!.database())).toEqual([{ mail_key: "mail:b", put_back: 1, position: 0 }]);

    rig!.setNow(roundAt(11, 13, 31));
    const waiting = await rig!.refresh();
    expect(waiting.mailRound?.id).toBe(round.id);
    expect(waiting.mailRound?.waiting).toBe(1);

    expect((await rig!.post({ action: "hide", key: "mail:a" })).status).toBe(200);
    expect((await rig!.post({ action: "hide", key: "mail:c" })).status).toBe(200);
    const successor = await rig!.get();
    expect(successor.mailRound?.id).not.toBe(round.id);
    expect(successor.mailRound?.mails.map((member) => member.key)).toEqual(["mail:b"]);
  });

  it("completes the original round when its last member is put back", async () => {
    rig = await openMailRoundRig(roundAt(12, 8));
    rig.setState({ mail: [roundMail("a", roundAt(12, 7))] });
    rig.setNow(roundAt(12, 8, 31));
    const round = (await rig.get()).mailRound;
    const answer = await readAnswer(await rig.postRound(putBackBody(round!, "mail:a", "req-put-back-last")));
    expect(answer.ok).toBe(true);
    expect(answer.mailRound?.due).toBe(false);
    expect(roundStatuses(rig.database())).toEqual([{ id: round!.id, status: "finished" }]);
    expect(queuedMails(rig.database())).toEqual([{ mail_key: "mail:a", put_back: 1, position: 0 }]);

    rig.setNow(roundAt(12, 13, 31));
    const caughtUp = await rig.get();
    expect(caughtUp.mailRound?.id).not.toBe(round!.id);
    expect(caughtUp.mailRound?.mails.map((member) => member.key)).toEqual(["mail:a"]);
  });

  it("restores the prior position while the original round is open and replays the retry", async () => {
    const round = await openThreeMemberRound();
    const put = await readAnswer(await rig!.postRound(putBackBody(round, "mail:b", "req-put-back-undo")));
    const token = put.undo ?? "";
    const before = roundSideEffects(rig!.database());
    const undo = await readAnswer(await rig!.postRound({ action: "undo", token, requestId: "req-undo-open" }));
    expect(undo.ok).toBe(true);
    expect(undo.outcome).toBe("restored");
    expect(undo.messagePhrase?.code).toBe("mail.put-back-undone");
    expect(undo.mailRound?.id).toBe(round.id);
    expect(undo.mailRound?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:b", "mail:c"]);
    expect(queuedMails(rig!.database())).toEqual([]);
    expect(roundSideEffects(rig!.database())).toEqual(before);

    const replayed = await readAnswer(await rig!.postRound({ action: "undo", token, requestId: "req-undo-open" }));
    expect(replayed).toEqual(undo);
    const again = await readAnswer(await rig!.postRound({ action: "undo", token, requestId: "req-undo-other" }));
    expect(again.ok).toBe(false);
    expect(again.messagePhrase?.code).toBe("act.closed-item");
    expect((await rig!.get()).mailRound?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:b", "mail:c"]);
  });

  it("leaves the mail first in the next round when undo comes after the original round finished", async () => {
    rig = await openMailRoundRig(roundAt(13, 8));
    rig.setState({ mail: [roundMail("a", roundAt(13, 7)), roundMail("b", roundAt(13, 7, 5))] });
    rig.setNow(roundAt(13, 8, 31));
    const round = (await rig.get()).mailRound;
    const put = await readAnswer(await rig.postRound(putBackBody(round!, "mail:b", "req-put-back-late")));
    expect((await rig.post({ action: "hide", key: "mail:a" })).status).toBe(200);
    rig.setNow(roundAt(13, 13, 31));
    const successor = await rig.refresh();
    expect(successor.mailRound?.id).not.toBe(round!.id);
    expect(successor.mailRound?.mails.map((member) => member.key)).toEqual(["mail:b"]);

    const undo = await readAnswer(await rig.postRound({ action: "undo", token: put.undo, requestId: "req-undo-late" }));
    expect(undo.ok).toBe(true);
    expect(undo.outcome).toBe("next-round");
    expect(undo.messagePhrase?.code).toBe("mail.put-back-next-round");
    expect(undo.message).toContain("finished");
    expect(undo.mailRound?.id).toBe(successor.mailRound?.id);
    expect(undo.mailRound?.mails.map((member) => member.key)).toEqual(["mail:b"]);
    expect(roundStatuses(rig.database()).filter((row) => row.status === "finished")).toHaveLength(1);
  });

  it("keeps the put-back queued first when undo arrives before any successor opened", async () => {
    rig = await openMailRoundRig(roundAt(14, 8));
    rig.setState({ mail: [roundMail("a", roundAt(14, 7)), roundMail("b", roundAt(14, 7, 5))] });
    rig.setNow(roundAt(14, 8, 31));
    const round = (await rig.get()).mailRound;
    const put = await readAnswer(await rig.postRound(putBackBody(round!, "mail:a", "req-put-back-first")));
    expect((await rig.post({ action: "hide", key: "mail:b" })).status).toBe(200);
    expect((await rig.get()).mailRound?.due).toBe(false);
    const undo = await readAnswer(await rig.postRound({ action: "undo", token: put.undo, requestId: "req-undo-queued" }));
    expect(undo.outcome).toBe("next-round");
    expect(queuedMails(rig.database())).toEqual([{ mail_key: "mail:a", put_back: 1, position: 0 }]);
    rig.setNow(roundAt(14, 13, 31));
    expect((await rig.get()).mailRound?.mails.map((member) => member.key)).toEqual(["mail:a"]);
  });

  it("replays a duplicate request across a restart and refuses a conflicting reuse", async () => {
    const round = await openThreeMemberRound();
    const first = await readAnswer(await rig!.postRound(putBackBody(round, "mail:b", "req-put-back-restart")));
    const second = await readAnswer(await rig!.postRound(putBackBody(round, "mail:b", "req-put-back-restart")));
    expect(second).toEqual(first);

    rig!.reopen();
    const afterRestart = await readAnswer(await rig!.postRound(putBackBody(round, "mail:b", "req-put-back-restart")));
    expect(afterRestart).toEqual(first);
    expect(queuedMails(rig!.database())).toEqual([{ mail_key: "mail:b", put_back: 1, position: 0 }]);

    const conflicting = await rig!.postRound(putBackBody(round, "mail:c", "req-put-back-restart"));
    expect(conflicting.status).toBe(409);
    const conflict = await readAnswer(conflicting);
    expect(conflict.ok).toBe(false);
    expect(conflict.messagePhrase?.code).toBe("act.closed-item");
    expect((await rig!.get()).mailRound?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:c"]);

    rig!.reopen();
    const undo = await readAnswer(await rig!.postRound({ action: "undo", token: first.undo, requestId: "req-undo-restart" }));
    expect(undo.ok).toBe(true);
    expect(undo.outcome).toBe("restored");
    expect((await rig!.get()).mailRound?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:b", "mail:c"]);
  });

  it("returns 409 for a stale revision at the same time and applies one of two racing writes", async () => {
    const round = await openThreeMemberRound();
    const [left, right] = await Promise.all([
      rig!.postRound(putBackBody(round, "mail:a", "req-race-left")),
      rig!.postRound(putBackBody(round, "mail:c", "req-race-right")),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const view = await rig!.get();
    expect(view.mailRound?.revision).toBe(round.revision + 1);
    expect(view.mailRound?.mails).toHaveLength(2);
    expect(queuedMails(rig!.database())).toHaveLength(1);
  });

  it("refuses a malformed payload, an unknown mail and an unknown undo token without mutation", async () => {
    const round = await openThreeMemberRound();
    const before = roundStatuses(rig!.database());
    expect((await rig!.postRound({ action: "put-back", roundId: round.id, revision: round.revision, key: "mail:a" })).status).toBe(400);
    expect((await rig!.postRound({ action: "put-back", roundId: round.id, revision: round.revision, key: "a", requestId: "req-bad-key" })).status).toBe(400);
    expect((await rig!.postRound({ action: "put-back", roundId: "round-nope", revision: round.revision, key: "mail:a", requestId: "req-stale-round" })).status).toBe(409);
    expect((await rig!.postRound(putBackBody(round, "mail:zzz", "req-unknown-mail"))).status).toBe(409);
    expect((await rig!.postRound({ ...putBackBody(round, "mail:a", "req-extra-field"), source: "other", account: "work" })).status).toBe(400);
    const foreign = await fetch(`${rig!.baseUrl()}/api/desk/mail/round`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify(putBackBody(round, "mail:a", "req-foreign-origin")),
    });
    expect(foreign.status).toBe(403);

    const unknown = await rig!.postRound({ action: "undo", token: "00000000-0000-4000-8000-000000000000", requestId: "req-unknown-token" });
    expect(unknown.status).toBe(404);
    expect((await readAnswer(unknown)).messagePhrase?.code).toBe("act.unknown-target");
    expect(roundStatuses(rig!.database())).toEqual(before);
    expect(queuedMails(rig!.database())).toEqual([]);
    expect((await rig!.get()).mailRound?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:b", "mail:c"]);
  });

  it("reports an unavailable source explicitly and keeps the round membership it changed", async () => {
    const round = await openThreeMemberRound();
    rig!.setState({ mail: [], fail: true });
    rig!.setNow(roundAt(11, 8, 35));
    expect((await rig!.refresh()).sources.find((source) => source.id === "round-source")?.ok).toBe(false);
    const answer = await readAnswer(await rig!.postRound(putBackBody(round, "mail:b", "req-put-back-unavailable")));
    expect(answer.ok).toBe(true);
    expect(answer.mailRound?.unavailable.mail).toEqual(["round-source"]);
    expect(answer.mailRound?.unavailable.calendar).toEqual(["round-source"]);
    expect(answer.mailRound?.mails.map((member) => member.key)).toEqual(["mail:a", "mail:c"]);
    expect(answer.mailRound?.waiting).toBe(1);
  });
});
