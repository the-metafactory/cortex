import { afterEach, describe, expect, it } from "bun:test";
import { McSchema } from "../../../common/types/config";
import { DEFAULT_MAIL_ROUND_SLOTS } from "../../../common/types/desk-mail-rounds";
import { saveClassification } from "../desk/classify";
import { addVip } from "../desk/vips";
import { openMailRoundRig, putBackPayload, readAnswer, roundAt, roundEvent, roundMail, type MailRoundRig } from "./fixtures/mail-round-rig";

const iso = (day: number, hour: number, minute = 0): string => new Date(roundAt(day, hour, minute)).toISOString();

let rig: MailRoundRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function oneMailRound(): Promise<MailRoundRig> {
  const opened = await openMailRoundRig(roundAt(2, 8));
  opened.setState({ mail: [roundMail("a", roundAt(2, 7))] });
  opened.setNow(roundAt(2, 8, 31));
  return opened;
}

describe("mc.desk.mailRounds", () => {
  it("defaults to three local slots every day and refuses a malformed or repeated local time", () => {
    expect(McSchema.parse(undefined).desk.mailRounds.slots).toEqual([...DEFAULT_MAIL_ROUND_SLOTS]);
    expect(McSchema.parse({ desk: { mailRounds: { slots: ["06:15", "21:45"] } } }).desk.mailRounds.slots).toEqual(["06:15", "21:45"]);
    for (const slots of [["8:30"], ["24:00"], ["08:60"], ["08:30", "08:30"], []]) {
      expect(McSchema.safeParse({ desk: { mailRounds: { slots } } }).success).toBe(false);
    }
  });
});

describe("a durable scheduled mail round", () => {
  it("does not create a round from an empty queue, and always names the next slot", async () => {
    rig = await openMailRoundRig(roundAt(2, 8));
    expect((await rig.get()).mailRound).toMatchObject({ id: null, revision: 0, due: false, waiting: 0, mails: [] });
    expect((await rig.get()).mailRound?.nextScheduledAt).toBe(new Date(roundAt(2, 8, 30)).toISOString());
  });

  it("captures fresh mail at a passed slot and waits for the next slot for arrivals after it", async () => {
    rig = await openMailRoundRig(roundAt(2, 8));
    rig.setState({ mail: [roundMail("a", roundAt(2, 7))] });
    expect((await rig.get()).mailRound).toMatchObject({ due: false, waiting: 1 });
    rig.setNow(roundAt(2, 8, 31));
    const due = await rig.get();
    expect(due.mailRound).toMatchObject({ due: true, revision: 1, waiting: 0, scheduledFor: new Date(roundAt(2, 8, 30)).toISOString() });
    expect(due.mailRound?.mails.map((m) => m.key)).toEqual(["mail:a"]);

    rig.setState({ mail: [roundMail("a", roundAt(2, 7)), roundMail("b", roundAt(2, 8, 45))] });
    rig.setNow(roundAt(2, 13, 31));
    const stillOpen = await rig.refresh();
    expect(stillOpen.mailRound?.id).toBe(due.mailRound?.id);
    expect(stillOpen.mailRound?.mails.map((m) => m.key)).toEqual(["mail:a"]);
    expect(stillOpen.mailRound?.waiting).toBe(1);
  });

  it("reconciles membership through the existing mail route and starts a queued successor immediately when a slot passed", async () => {
    rig = await oneMailRound();
    const first = await rig.get();
    rig.setState({ mail: [roundMail("a", roundAt(2, 7)), roundMail("b", roundAt(2, 8, 45))] });
    rig.setNow(roundAt(2, 13, 31));
    expect((await rig.refresh()).mailRound?.waiting).toBe(1);

    expect((await rig.post({ action: "hide", key: "mail:a" })).status).toBe(200);
    const successor = await rig.get();
    expect(successor.mailRound?.id).not.toBe(first.mailRound?.id);
    expect(successor.mailRound).toMatchObject({ due: true, waiting: 0 });
    expect(successor.mailRound?.mails.map((m) => m.key)).toEqual(["mail:b"]);
  });

  it("keeps an unfinished round through midnight and later slots without a duplicate", async () => {
    rig = await oneMailRound();
    const round = (await rig.get()).mailRound;
    rig.setState({ mail: [roundMail("a", roundAt(2, 7)), roundMail("b", roundAt(2, 14))] });
    rig.setNow(roundAt(3, 0, 5));
    const midnight = await rig.refresh();
    expect(midnight.mailRound?.id).toBe(round?.id);
    expect(midnight.mailRound?.mails.map((m) => m.key)).toEqual(["mail:a"]);
    expect(midnight.mailRound?.waiting).toBe(1);

    rig.setNow(roundAt(3, 17));
    const later = await rig.refresh();
    expect(later.mailRound?.id).toBe(round?.id);
    expect(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_rounds WHERE status = 'open'").get()?.n).toBe(1);
  });

  it("prunes a finished round with its operation receipts after the retention", async () => {
    rig = await oneMailRound();
    const round = (await rig.get()).mailRound;
    expect(round?.due).toBe(true);
    expect((await readAnswer(await rig.postRound(putBackPayload(round!, "mail:a", "req-prune-a")))).ok).toBe(true);
    await rig.get();
    const count = (sql: string): number | undefined => rig?.database().query<{ n: number }, []>(sql).get()?.n;
    const finished = (): number | undefined => count("SELECT COUNT(*) AS n FROM desk_mail_rounds WHERE status = 'finished'");
    const receipts = (): number | undefined => count("SELECT COUNT(*) AS n FROM desk_mail_round_operations");
    expect(finished()).toBe(1);
    expect(receipts()).toBe(1);

    rig.setNow(roundAt(2, 8, 31) + 8 * 86_400_000);
    await rig.get();
    expect(finished()).toBe(0);
    expect(receipts()).toBe(0);
  });

  it("creates one round on a weekend slot and moves a slot past a shifted meeting chain", async () => {
    rig = await openMailRoundRig(roundAt(8, 8));
    rig.setState({ mail: [roundMail("weekend", roundAt(8, 7))] });
    rig.setNow(roundAt(8, 8, 31));
    expect((await rig.get()).mailRound?.due).toBe(true);
    await rig.close();

    rig = await openMailRoundRig(roundAt(9, 8));
    rig.setState({
      mail: [roundMail("shifted", roundAt(9, 7, 30))],
      events: [roundEvent("one", roundAt(9, 8, 30), roundAt(9, 9, 15), "unknown"), roundEvent("two", roundAt(9, 9, 15), roundAt(9, 9, 30))],
    });
    rig.setNow(roundAt(9, 9));
    const before = await rig.get();
    expect(before.mailRound).toMatchObject({ due: false });
    expect(before.mailRound?.nextScheduledAt).toBe(new Date(roundAt(9, 9, 30)).toISOString());
    rig.setNow(roundAt(9, 9, 31));
    expect((await rig.get()).mailRound?.due).toBe(true);
  });

  it("survives an unavailable source and a restart with its membership intact", async () => {
    rig = await openMailRoundRig(roundAt(4, 8));
    rig.setState({ mail: [roundMail("kept", roundAt(4, 7))] });
    rig.setNow(roundAt(4, 8, 31));
    const round = (await rig.get()).mailRound;
    rig.setState({ mail: [], fail: true });
    rig.setNow(roundAt(4, 8, 35));
    const unavailable = await rig.refresh();
    expect(unavailable.mailRound?.id).toBe(round?.id);
    expect(unavailable.mailRound?.mails.map((m) => m.key)).toEqual(["mail:kept"]);
    expect(unavailable.mailRound?.unavailable.mail).toEqual(["round-source"]);
    expect(unavailable.mailRound?.unavailable.calendar).toEqual(["round-source"]);
    expect(unavailable.sources.find((source) => source.id === "round-source")?.ok).toBe(false);

    rig.reopen();
    const reopened = await rig.refresh();
    expect(reopened.mailRound?.id).toBe(round?.id);
    expect(reopened.mailRound?.mails.map((m) => m.key)).toEqual(["mail:kept"]);
    expect(reopened.mailRound?.due).toBe(true);
  });

  it("orders digest and sweep groups before individual mail without duplicates, leaving interrupting mail out", async () => {
    rig = await openMailRoundRig(roundAt(5, 8));
    rig.setState({
      mail: [
        roundMail("s1", roundAt(5, 7, 10), { headers: { listId: "<reports.example>" }, from: { name: "Reports", address: "reports@example.org" } }),
        roundMail("s2", roundAt(5, 7, 20), { headers: { listId: "<reports.example>" }, from: { name: "Reports", address: "reports@example.org" } }),
        roundMail("news", roundAt(5, 7, 30), { headers: { listId: "<news.example>" } }),
        roundMail("plain", roundAt(5, 7, 40)),
        roundMail("vip", roundAt(5, 7, 50), { from: { name: "Boss", address: "boss@example.org" } }),
        roundMail("inv", roundAt(5, 7, 55), {
          account: "work",
          invitation: { method: "REQUEST", uid: "u1", sequence: 0, summary: "Review", start: iso(5, 10), organizer: { address: "organizer@example.org" }, attendee: { address: "me@example.org", status: "NEEDS-ACTION" }, attendees: 2 },
        }),
      ],
    });
    const db = rig.database();
    saveClassification(db, "s1", { category: "fyi", reason: "A report.", predictedAction: "archive" }, "fixture", roundAt(5, 7));
    saveClassification(db, "s2", { category: "fyi", reason: "A report.", predictedAction: "archive" }, "fixture", roundAt(5, 7));
    saveClassification(db, "news", { category: "bulk", reason: "A newsletter.", predictedAction: "archive" }, "fixture", roundAt(5, 7));
    addVip(db, "boss@example.org", "Boss", roundAt(5, 0));
    rig.setNow(roundAt(5, 8, 31));
    const view = await rig.get();
    const round = view.mailRound;
    const keys = round?.mails.map((m) => m.key) ?? [];
    expect(keys).not.toContain("mail:vip");
    expect(keys).toContain("mail:plain");
    expect(keys).toContain("mail:inv");
    expect(keys).toContain("mail:s1");
    expect(keys).toContain("mail:s2");
    expect(keys).toContain("mail:news");
    expect(new Set(keys).size).toBe(keys.length);
    const grouped = round?.groups.flatMap((group) => group.mails) ?? [];
    expect(grouped.length).toBeGreaterThan(0);
    expect(keys.slice(0, grouped.length)).toEqual(grouped);
    expect(view.items.find((item) => item.key === "mail:vip")?.interrupt?.reason?.code).toBe("mail.vip");
    expect(view.items.find((item) => item.key === "mail:inv")?.actions.map((action) => action.id)).toContain("invite.accept");
  });

  it("serves concurrent clients one round and no duplicate open round", async () => {
    rig = await openMailRoundRig(roundAt(6, 8));
    rig.setState({ mail: [roundMail("one", roundAt(6, 7))] });
    rig.setNow(roundAt(6, 8, 31));
    const views = await Promise.all(Array.from({ length: 6 }, () => rig!.get()));
    expect(views.every((view) => view.mailRound?.due === true)).toBe(true);
    expect(new Set(views.map((view) => view.mailRound?.id)).size).toBe(1);
    expect(rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_mail_rounds WHERE status = 'open'").get()?.n).toBe(1);
  });
});
