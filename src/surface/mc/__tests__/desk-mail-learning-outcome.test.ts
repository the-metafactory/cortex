import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleGetDesk } from "../api/desk";
import { HandledLedger } from "../desk/actions";
import { saveClassification, type MailClassification, type MailClassifier } from "../desk/classify";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { createRule } from "../desk/mail-rules";
import { SourceCache, type CommandRunner, type SourceMail } from "../desk/sources/command";
import type { DeskView } from "../desk/types";
import { addNote } from "../desk/notes";
import { initDatabase } from "../db/init";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const MEETING_KEY = "cal:work-calendar:review";

const MAIL_ACTIONS = { move: ["/opt/adapters/bin/desk-mail-move.ts"], draft: ["/opt/adapters/bin/desk-mail-draft.ts"], timeoutSeconds: 20 };

const DESK: DeskOptions = {
  enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [],
  sources: [
    { id: "work-calendar", command: ["cal"], everySeconds: 300, timeoutSeconds: 5 },
    { id: "work-mail", command: ["mail"], everySeconds: 300, timeoutSeconds: 5 },
  ],
  mailActions: MAIL_ACTIONS,
  mailClassifier: { command: ["desk-classify-mail"], timeoutSeconds: 5, maxPerPass: 10 },
};

const mail = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Sender", address: `${id}@example.org` }, subject: `Subject ${id}`, receivedAt: "2026-11-01T08:00:00.000Z", unread: true, account: "work", ...over,
});

const runner: CommandRunner = async ([cmd]) => JSON.stringify(cmd === "cal"
  ? { events: [{ id: "review", title: "Budget review", start: "2026-11-01T11:00:00.000Z", end: "2026-11-01T12:00:00.000Z", calendar: "Work" }] }
  : { items: [mail("attach"), mail("draft"), mail("update"), mail("archive"), mail("plain")] });

const quietClassifier = { kick: async (): Promise<void> => undefined } as unknown as MailClassifier;

describe("GET /api/desk mail learning and outcomes", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const read = async (): Promise<DeskView> => {
    const runtime: DeskRuntime = { options: DESK, ledger: new HandledLedger(), sourceCache: new SourceCache(runner), mailClassifier: quietClassifier, now: () => NOW };
    return await (await handleGetDesk(db, runtime, undefined)).json() as DeskView;
  };

  const classify = (id: string, c: MailClassification): void => saveClassification(db, id, c, "test-model", NOW);

  it("says the mail sort is learning until a rule exists", async () => {
    expect((await read()).mailLearning).toBe(true);
    createRule(db, { match: "sender", value: "attach@example.org", action: "archive" }, NOW);
    expect((await read()).mailLearning).toBe(false);
  });

  it("leaves the learning flag out and serves the rest when the rule store cannot be read", async () => {
    db.exec("DROP TABLE desk_mail_rules");
    const view = await read();
    expect(view).not.toHaveProperty("mailLearning");
    expect(view.items.some((item) => item.kind === "mail")).toBe(true);
  });

  it("suggests attach, draft, archive or nothing from the card's own actions and attention", async () => {
    classify("attach", { category: "meeting", meetingKey: MEETING_KEY, reason: "It sets the agenda.", suggestedAction: "link-meeting" });
    classify("draft", { category: "action", reason: "It asks for an answer.", predictedAction: "reply" });
    classify("update", { category: "fyi", reason: "For your information." });
    classify("archive", { category: "action", reason: "It is done.", predictedAction: "archive" });
    classify("plain", { category: "action", reason: "Nothing to do yet." });
    const view = await read();
    const outcomes = Object.fromEntries(view.items.filter((item) => item.kind === "mail").map((item) => [item.key, item.outcome]));
    expect(outcomes).toEqual({ "mail:attach": "attach", "mail:draft": "draft", "mail:update": "archive", "mail:archive": "archive", "mail:plain": undefined });
  });

  it("carries no suggested outcome on a card that is not mail", async () => {
    addNote(db, "reminder", "Call the bank", NOW - 60_000, NOW);
    const view = await read();
    const reminder = view.items.find((item) => item.kind === "reminder");
    expect(reminder).toBeDefined();
    expect(reminder).not.toHaveProperty("outcome");
  });
});
