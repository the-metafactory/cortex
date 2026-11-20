import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleGetDesk } from "../api/desk";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { setGrant } from "../desk/autonomy";
import { MailClassifier } from "../desk/classify";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { setCorrection } from "../desk/corrections";
import { meetingItems } from "../desk/interrupt";
import { handoffItems, withHandoff, type HandoffRow } from "../desk/mail-handoff";
import { logMailDecision, mailFeatures } from "../desk/mail-log";
import { heldItems } from "../desk/mail-rules";
import { readSnooze, snoozeMail, snoozeWhen, wakeSnoozes } from "../desk/mail-snooze";
import { fold, mailItems } from "../desk/rank";
import { SourceCache, type SourceMail, type SourceReading } from "../desk/sources/command";
import type { DeskAction, DeskItem, DeskView } from "../desk/types";
import { actionText, autonomyText, linkText } from "../desk/wording";

const NOW = new Date(2026, 10, 15, 10).getTime();
const iso = (at: number): string => new Date(at).toISOString();
const NAME = "Helper";
const mail: SourceMail = { kind: "mail", id: "m1", from: { name: "Sender Name", address: "sender@example.test" }, subject: "Original subject", receivedAt: iso(NOW - 60_000), unread: true, url: "message://m1" };
const listed = { ...mail, sourceId: "fixture", area: null };
const reading: SourceReading = { id: "fixture", area: null, mail: [mail], events: [{ id: "review", title: "Original meeting", start: iso(NOW + 60_000), end: iso(NOW + 3_600_000) }], readAt: NOW, error: null, dropped: 0, problems: [] };
const handoff: HandoffRow = {
  id: "handoff-1", messageId: mail.id, account: "fixture", sourceId: "fixture", area: null, fromName: mail.from.name ?? null,
  fromAddress: mail.from.address, subject: mail.subject, url: mail.url ?? null, receivedAt: mail.receivedAt,
  summary: null, text: null, instruction: null, route: "local", taskId: "example/tasks#1", taskUrl: "https://example.test/tasks/1",
  state: "failed", model: null, findings: [], draft: null, error: "Synthetic failure", createdAt: NOW, finishedAt: NOW,
};

let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); setSystemTime(NOW); });
afterEach(() => { db.close(); setSystemTime(); });

const actions = (item: DeskItem): DeskAction[] => [...item.actions, ...(item.more ?? [])];
const card = (): DeskItem => mailItems({ now: NOW, mail: [listed], events: [], vips: new Set(), handoff: true, assistantName: NAME })[0]!;

test("fixed actions and folded kinds carry no label; named actions carry parameters; the bundled Desk phrases both", () => {
  const found = card();
  const hand = actions(found).find(a => a.id === "mail.assistant");
  const vip = actions(found).find(a => a.id === "vip.add");
  const open = actions(found).find(a => a.id === "open");
  expect(hand).toEqual({ id: "mail.assistant", role: "secondary", wired: true, labelPhrase: { code: "mail.assistant", params: { name: NAME } } });
  expect(vip).toEqual({ id: "vip.add", role: "secondary", wired: true, target: mail.from.address, labelPhrase: { code: "vip.add", params: { name: "Sender" } } });
  expect(open).toEqual({ id: "open", role: "primary", wired: true, url: mail.url });
  expect([hand, vip, open].map(a => actionText(a!))).toEqual(["Hand to Helper", "Always show mail from Sender", "Open in Mail"]);
  expect(fold([found])).toEqual([{ kind: "mail", count: 1, example: found.title }]);
  const unnamed = mailItems({ now: NOW, mail: [{ ...listed, from: { address: mail.from.address } }], events: [], vips: new Set() })[0]!;
  const unnamedVip = actions(unnamed).find(a => a.id === "vip.add")!;
  expect(unnamedVip).not.toHaveProperty("label");
  expect(unnamedVip.labelPhrase).toEqual({ code: "vip.add", params: {} });
  expect(actionText(unnamedVip)).toBe("Always show mail from this sender");
});

test("held counts, assistant retries and task link identifiers are phrase parameters", () => {
  const [held] = heldItems([{ id: "rule-1", match: "sender", value: mail.from.address, action: "archive", on: true, createdAt: NOW, lastRunAt: null, count: 0, held: 37, released: false, target: null }]);
  expect(held?.actions[0]).toEqual({ id: "mailrule.release", labelPhrase: { code: "mailrule.release", params: { count: 37 } }, role: "primary", wired: true, target: "rule-1" });
  expect(actionText(held!.actions[0]!)).toBe("Handle all 37");
  expect(held?.actions[1]).not.toHaveProperty("labelPhrase");
  const retry = withHandoff(card(), handoff, NOW, NAME).actions[0]!;
  expect(retry).toMatchObject({ id: "assistant.retry", target: handoff.id, labelPhrase: { code: "assistant.retry", params: { name: NAME } } });
  expect(actionText(retry)).toBe("Ask Helper again");
  for (const state of ["failed", "ready"] as const) {
    const [found] = handoffItems([{ ...handoff, state }], new Set(), NOW, NAME);
    expect(found?.detail.links).toEqual([
      { kind: "mail", url: mail.url! },
      { kind: "task", url: handoff.taskUrl!, labelPhrase: { code: "task.link", params: { id: handoff.taskId } } },
    ]);
    expect(found?.detail.links.map(linkText)).toEqual(["Open in Mail", "Task example/tasks#1"]);
    if (state === "failed") expect(found?.actions[0]).toMatchObject({ labelPhrase: { code: "assistant.retry", params: { name: NAME } } });
  }
});

test.each([
  [{ kind: "tomorrow" }, `until ${snoozeWhen(new Date(2026, 10, 16, 8).getTime(), NOW)}`, { code: "mail.put-away-time", params: { until: iso(new Date(2026, 10, 16, 8).getTime()) } }],
  [{ kind: "meeting", event: "cal:fixture:review" }, "until “Original meeting” ends", { code: "mail.put-away-meeting", params: { title: "Original meeting" } }],
  [{ kind: "person", address: "SENDER@example.test" }, "until Sender Name writes", { code: "mail.put-away-person", params: { person: "Sender Name" } }],
  [{ kind: "person", address: "unknown@example.test" }, "until unknown@example.test writes", { code: "mail.put-away-person", params: { person: "unknown@example.test" } }],
] as const)("put-away choice %j preserves its label and reconstructs its phrase from stored values", (choice, label, phrase) => {
  const result = snoozeMail(db, listed, choice, { now: NOW, readings: [reading] });
  expect(result).toMatchObject({ ok: true, until: label, labelPhrase: phrase });
  expect(readSnooze(db, mail.id)).toMatchObject({ label, labelPhrase: phrase });
  const stored = db.query<{ label: string }, []>("SELECT label FROM desk_mail_snoozes").get();
  expect(stored?.label).toBe(label);
});

test("a moved meeting refreshes the put-away phrase and label together", () => {
  snoozeMail(db, listed, { kind: "meeting", event: "cal:fixture:review" }, { now: NOW, readings: [reading] });
  wakeSnoozes(db, { events: new Map([["cal:fixture:review", { title: "Renamed meeting", at: NOW + 120_000, end: NOW + 7_200_000 }]]), covered: () => true, wrote: () => null, conversationReply: () => null, urgentNow: new Set() }, NOW);
  expect(readSnooze(db, mail.id)).toMatchObject({ label: "until “Renamed meeting” ends", labelPhrase: { code: "mail.put-away-meeting", params: { title: "Renamed meeting" } } });
});

test("mail, unsubscribe and meeting links name their destinations by kind; the bundled Desk phrases them", () => {
  const [found] = mailItems({ now: NOW, mail: [listed], events: [], vips: new Set(), unsubscribe: new Map([[mail.id, { kind: "page", dismissed: 5, host: "example.test", url: "https://example.test/leave" }]]) });
  expect(found?.detail.links).toEqual([{ kind: "mail", url: mail.url! }, { kind: "unsubscribe-page", url: "https://example.test/leave" }]);
  expect(found?.detail.links.map(linkText)).toEqual(["Open in Mail", "Unsubscribe page: https://example.test/leave"]);
  for (const online of [true, false]) {
    const [meeting] = meetingItems([{ key: "event-1", at: NOW + 60_000, kind: "meeting", title: "Meeting", area: null, url: "https://example.test/meeting", online }], NOW, 15);
    expect(meeting?.detail.links).toEqual([{ kind: online ? "meeting-join" : "meeting", url: "https://example.test/meeting" }]);
    expect(meeting?.detail.links.map(linkText)).toEqual([online ? "Join" : "Open"]);
    expect(meeting?.actions[0]).toMatchObject({ id: "open", labelPhrase: { code: online ? "meeting.join" : "meeting.open" } });
    expect(actionText(meeting!.actions[0]!)).toBe(online ? "Join" : "Open");
  }
});

test("GET keeps configured content and code-only switches and autonomy, and phrases corrections", async () => {
  const area = { id: "fixture", label: "Configured area content", color: "blue", repos: [], goals: [] };
  const options: DeskOptions = { enabled: true, displayName: "", topN: 10, rangerUrl: "", sources: [], areas: [area], rangerCli: { bin: "unused-ranger", config: "" } };
  const runtime: DeskRuntime = { options, ledger: new HandledLedger() };
  setCorrection(db, "goal", "vigil", "less", NOW);
  setGrant(db, "mail.link-meeting", true, NOW);
  const response = await handleGetDesk(db, runtime, undefined);
  expect(response.status).toBe(200);
  const view = await response.json() as DeskView;
  expect(view.areas).toEqual([{ id: area.id, label: area.label, color: area.color }]);
  expect(view.corrections[0]).toEqual({ kind: "goal", source: "vigil", mode: "less", label: "Goals that need a look, from vigil", labelPhrase: { code: "correction.source", params: { kind: "goal", source: "vigil" } }, createdAt: NOW });
  expect(view.interruptions.length).toBeGreaterThan(0);
  for (const reason of view.interruptions) expect(Object.keys(reason).filter(key => key.startsWith("label"))).toEqual([]);
  expect(view.autonomy.types).toContainEqual({ action: "mail.link-meeting", on: true });
  expect(autonomyText("mail.link-meeting").label).toBe("Link mail to its meeting");
});

test("mail correction wording carries the original subject and sender as content parameters", async () => {
  const config = { command: ["unused-classifier"], timeoutSeconds: 5, maxPerPass: 1, sourcePolicy: "local" as const };
  const corrections: unknown[] = [];
  const classifier = new MailClassifier(config, async (input) => { corrections.push(...input.corrections); return { category: "action", reason: "Synthetic result" }; });
  const options: DeskOptions = { enabled: true, displayName: "", topN: 10, rangerUrl: "", sources: [{ id: "fixture", command: ["unused-source"], everySeconds: 300, timeoutSeconds: 5 }], areas: [], mailClassifier: config };
  logMailDecision(db, { ...mailFeatures(db, listed), category: "not bulk" }, "archive", "correction", NOW);
  const runtime: DeskRuntime = { options, ledger: new HandledLedger(), sourceCache: new SourceCache(async () => JSON.stringify({ items: [mail] })), mailClassifier: classifier };
  await handleGetDesk(db, runtime, undefined);
  await classifier.kick(db, { now: NOW, mail: [], events: [], vips: [] });
  expect(corrections).toContainEqual({ kind: "mail", source: mail.from.address, mode: "archive", label: "“Original subject” from sender@example.test: the person would archive it; it is not bulk", labelPhrase: { code: "mail.correction", params: { subject: mail.subject, sender: mail.from.address, action: "archive", learnedAction: "archive", category: "not bulk" } } });
});
