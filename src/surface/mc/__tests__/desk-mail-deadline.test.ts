import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { MailClassifier, MAIL_CLASSIFIER_CONTRACT, readClassifications, saveClassification, validateAnswer, type ClassifierRunner, type EndpointConfig } from "../desk/classify";
import { interrupts, NO_SWITCHES } from "../desk/interrupt";
import { switchKey } from "../desk/interrupt-switches";
import { mailItems } from "../desk/rank";
import { SourceMailSchema, type SourceMail } from "../desk/sources/command";
import { RULES } from "./desk-interrupt-fixture";

const local = (day: number, hhmm = "09:00"): number => new Date(`2026-10-${String(day).padStart(2, "0")}T${hhmm}:00`).getTime();
const NOW = local(31);
const iso = (at: number): string => new Date(at).toISOString();

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail & { area: string | null; sourceId: string } => ({
  kind: "mail", id, from: { name: "Sender", address: `${id}@example.org` }, subject: "Grades", receivedAt: iso(NOW - 10 * 60_000), unread: true, area: null, sourceId: "work-mail", ...over,
});

const keys = new Set<string>();

describe("the classifier's deadline", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("keeps a valid deadline and reads it back", () => {
    const answer = validateAnswer({ category: "action", reason: "Confirm the list.", deadline: "2026-10-31" }, keys, false, iso(NOW));
    expect(answer).toEqual({ category: "action", reason: "Confirm the list.", deadline: "2026-10-31" });
    if (!answer) throw new Error("no answer");
    saveClassification(db, "m1", answer, "chat-fast", NOW);
    expect(readClassifications(db, ["m1"]).get("m1")?.deadline).toBe("2026-10-31");
    expect(validateAnswer({ category: "action", reason: "r", deadline: "2026-10-31T18:00:00+01:00" }, keys, false, iso(NOW))?.deadline).toBe("2026-10-31T18:00:00+01:00");
  });

  it("drops an unparsable or out-of-range deadline and keeps the category", () => {
    for (const deadline of ["Friday", "2026-10-31 18:00", "2026-10-25", "2028-01-01", 20261031]) {
      expect(validateAnswer({ category: "reply", reason: "r", deadline }, keys, false, iso(NOW))).toEqual({ category: "reply", reason: "r" });
    }
  });

  it("classifies a contract-2 row again so it can get a deadline", async () => {
    expect(MAIL_CLASSIFIER_CONTRACT).toBe(3);
    db.query("INSERT INTO desk_mail_classes (message_id, category, meeting_key, reason, model, classified_at, details) VALUES ('m1', 'action', NULL, 'old', 'chat-fast', ?, ?)")
      .run(NOW - 86_400_000, JSON.stringify({ commitment: "request", contractVersion: 2 }));
    const run: ClassifierRunner = async () => ({ category: "action", commitment: "request", reason: "Confirm the list.", deadline: "2026-10-31" });
    const config: EndpointConfig = { baseUrl: "https://llm.example/v1", model: "chat-fast", timeoutSeconds: 5, maxPerPass: 10 };
    await new MailClassifier(config, run, () => undefined).kick(db, { now: NOW, mail: [mail("m1")], events: [], vips: [] });
    expect(readClassifications(db, ["m1"]).get("m1")).toMatchObject({ reason: "Confirm the list.", deadline: "2026-10-31" });
  });
});

describe("a source's dueAt", () => {
  it("drops a bad date and keeps the mail", () => {
    const parsed = SourceMailSchema.safeParse({ ...mail("m1"), dueAt: "soon" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.dueAt).toBeUndefined();
  });
});

describe("a deadline on the mail item", () => {
  const classified = (deadline: string) => new Map([["m1", { category: "fyi" as const, reason: "Info.", deadline }]]);
  const item = (m: SourceMail & { area: string | null; sourceId: string }, deadline?: string) =>
    mailItems({ now: NOW, mail: [m], events: [], vips: new Set(), ...(deadline ? { classified: classified(deadline) } : {}) })[0];

  it("prefers the source's date and says where the date came from", () => {
    const fromSource = item(mail("m1", { dueAt: "2026-11-02" }), "2026-10-31");
    expect(fromSource).toMatchObject({ dueAt: "2026-11-02", dueFrom: "source" });
    expect(fromSource?.detail.history).toContain(`The mail is flagged due ${new Date(2026, 10, 2).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.`);
    const fromClassifier = item(mail("m1"), "2026-10-31");
    expect(fromClassifier).toMatchObject({ dueAt: "2026-10-31", dueFrom: "classifier", urgency: "today" });
    expect(fromClassifier?.detail.history).toContain(`The mail asks for this by ${new Date(2026, 9, 31).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.`);
  });

  it("ranks for today only when the deadline is today", () => {
    expect(item(mail("m1", { dueAt: "2026-10-31" }))?.urgency).toBe("today");
    expect(item(mail("m1", { dueAt: "2026-10-30" }))?.urgency).toBe("waiting");
    expect(item(mail("m1", { dueAt: "2026-11-01" }))?.urgency).toBe("waiting");
    expect(item(mail("m1"))?.dueAt).toBeUndefined();
  });

  it("interrupts with mail.deadline-today, after a linked meeting and before a VIP", () => {
    const due = item(mail("m1", { dueAt: iso(local(31, "23:30")) }));
    if (!due) throw new Error("no item");
    const vips = new Set(["m1@example.org"]);
    expect(interrupts(due, RULES, NOW, { ...NO_SWITCHES, vips })).toEqual({ code: "mail.deadline-today", dueAt: iso(local(31, "23:30")) });
    const off = new Map([[switchKey("mail.deadline-today"), { on: false, setBy: "switch" as const, changedAt: NOW }]]);
    expect(interrupts(due, RULES, NOW, { ...NO_SWITCHES, vips, switches: off })?.code).toBe("mail.vip");
    const overdue = item(mail("m1", { dueAt: "2026-10-30" }));
    if (!overdue) throw new Error("no item");
    expect(interrupts(overdue, RULES, NOW, NO_SWITCHES)).toBeNull();
  });

  it("never lets a deadline make suspicious mail interrupt", () => {
    const phishing = item(mail("m1", { dueAt: "2026-10-31" }));
    if (!phishing) throw new Error("no item");
    expect(interrupts({ ...phishing, suspicious: true, urgency: "waiting" }, RULES, NOW, NO_SWITCHES)).toBeNull();
    const flagged = mailItems({ now: NOW, mail: [mail("m2", { dueAt: "2026-10-31" })], events: [], vips: new Set(), classified: new Map([["m2", { category: "action" as const, reason: "Pay now.", suspicious: true, deadline: "2026-10-31" }]]) })[0];
    if (!flagged) throw new Error("no item");
    expect(flagged.suspicious).toBe(true);
    expect(flagged.dueAt).toBeUndefined();
    expect(interrupts(flagged, RULES, NOW, NO_SWITCHES)?.code).toBe("mail.ranked");
  });
});
