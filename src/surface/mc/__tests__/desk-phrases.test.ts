import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleGetDesk } from "../api/desk";
import { handleDeskMail } from "../api/desk-mail";
import { DEFAULT_CONFIG } from "../config";
import { startServer } from "../server";
import { HandledLedger } from "../desk/actions";
import { MailClassifier, saveClassification, type MailClassification } from "../desk/classify";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { DESK_ACT_PHRASE_CODES, DESK_BRIEF_PHRASE_CODES, DESK_ITEM_PHRASE_CODES, DESK_PHRASE_CODES, type DeskPhrase } from "../desk/phrases";
import { setCorrection } from "../desk/corrections";
import type { MailHandoffWorker } from "../desk/mail-handoff";
import { mailItems } from "../desk/rank";
import { addNote } from "../desk/notes";
import { logMailDecision, mailFeatures } from "../desk/mail-log";
import { SourceCache, type SourceMail } from "../desk/sources/command";
import type { RangerState } from "../desk/sources/ranger";
import type { WaitingTask } from "../desk/sources/waiting";
import { addSender, addVip } from "../desk/vips";
import type { DeskItem, DeskView, DeskWhyContent } from "../desk/types";
import { clock } from "../desk/time";
import { writeVigilSubject } from "../../../vigil/db";
import { RULES } from "./desk-interrupt-fixture";

const NOW = new Date(2026, 10, 15, 10).getTime();
const EARLIER = NOW - 3_600_000;
const iso = (at: number): string => new Date(at).toISOString();
const WORDING = "A goal's original wording.";
const DAY_MS = 24 * 3_600_000;
const WHY_CODES = "ranger.resume-queued ranger.blocked ranger.stopped ranger.approval-needed ranger.discussion-needed ranger.map-read-only ranger.approval-unavailable ranger.question ranger.conversations-unavailable ranger.retry-failed ranger.retried goal.check-regressed goal.reading meeting.soon meeting.ended reminder.due mail.meeting-today mail.deadline-today mail.vip mail.ranked mail.received mail.meeting-possible mail.meeting-linked mail.unimportant mail.precedent mail.unsubscribe mail.invitation mail.suspicious".split(" ");
const LABEL_CODES: readonly string[] = [
  "mailrule.release", "mail.assistant", "assistant.retry", "vip.add", "task.link", "mail.put-away-time",
  "mail.put-away-meeting", "mail.put-away-person", "correction.source", "mail.correction", "mail.sweep-category",
];
const CLASSIFIER_REASON = "Original classifier content";
const CONFIG = { command: ["unused-classifier"], timeoutSeconds: 5, maxPerPass: 0 };
const letter = (id: string, over: Partial<SourceMail> = {}): SourceMail => ({
  kind: "mail", id, from: { name: "Sender", address: `${id}@example.test` }, subject: `Subject ${id}`,
  receivedAt: iso(EARLIER), unread: true, ...over,
});

let db: Database;
let ranger: RangerState;
let rangerServer: ReturnType<typeof Bun.serve>;
let runtime: DeskRuntime;
let waiting: Map<string, WaitingTask>;
let source: { items: SourceMail[]; events: { id: string; title: string; start: string; end?: string }[] };

beforeEach(() => {
  setSystemTime(NOW);
  db = initDatabase(":memory:");
  ranger = { current: [], needsYou: [], maps: [] };
  rangerServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(ranger) });
  waiting = new Map();
  source = { items: [], events: [] };
  const options: DeskOptions = {
    enabled: true, displayName: "", topN: 50, rangerUrl: `http://127.0.0.1:${rangerServer.port}`, areas: [], sources: [],
    interruptions: { ...RULES, transport: "none" },
  };
  runtime = { options, ledger: new HandledLedger(), conversations: () => true, waitingTasks: { read: async () => waiting } };
});

afterEach(() => {
  rangerServer.stop(true);
  db.close();
  setSystemTime();
});

async function read(): Promise<DeskView> {
  runtime.sourceCache = new SourceCache(async () => JSON.stringify(source));
  const res = await handleGetDesk(db, runtime, { enabled: true, resolveGoalWording: () => WORDING });
  expect(res.status).toBe(200);
  return await res.json() as DeskView;
}

function options(): DeskOptions {
  if (!runtime.options) throw new Error("Fixture options missing");
  return runtime.options;
}

function item(view: DeskView, key: string): DeskItem {
  const found = view.items.find(i => i.key === key);
  expect(found).toBeDefined();
  if (!found) throw new Error(`Missing fixture item ${key}`);
  return found;
}

function expectWhyContent(found: DeskItem | undefined, content: DeskWhyContent): void {
  expect(found).toBeDefined();
  if (!found) throw new Error("Missing item with content");
  expect(found.whyContent).toEqual(content);
  const phrase = JSON.stringify(found.whyPhrase) ?? "";
  for (const [field, value] of Object.entries(content)) {
    expect(found).not.toHaveProperty(field);
    for (const text of [value].flat()) expect(phrase).not.toContain(text);
  }
}

function seedSubject(vocab: "check" | "goal" | "escalation", ref: string, value: string, goal: string | null): string {
  const key = `state:${vocab}:default:${ref}`;
  writeVigilSubject(db, {
    subject_key: key, subject_kind: "state", vocab, ref, value, healthy: 0, goal_id: goal, producer: "fixture",
    stack: "default", run_kind: null, last_run_id: "fixture-run", last_ended_at: EARLIER, last_seen_at: EARLIER,
  }, EARLIER);
  return `vigil:${key}`;
}

function withMail(): void {
  options().sources = [{ id: "fixture", command: ["unused-source"], everySeconds: 300, timeoutSeconds: 5 }];
  runtime.mailClassifier = new MailClassifier(CONFIG);
  options().mailClassifier = CONFIG;
}

function classify(id: string, overrides: Partial<MailClassification> = {}): void {
  saveClassification(db, id, { category: "action", reason: CLASSIFIER_REASON, ...overrides }, "fixture", NOW);
}

function noteRetry(status: "failed" | "done", message: string | null): void {
  db.query("DELETE FROM desk_done").run();
  db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("fixture-attempt", "ranger.retry", "ranger:example/app#2", "Retry", status, message, EARLIER, EARLIER);
}

test("pins the exact Desk phrase vocabulary and its union coverage", () => {
  expect<readonly string[]>(DESK_ITEM_PHRASE_CODES).toEqual([...WHY_CODES, ...LABEL_CODES]);
  expect<readonly string[]>(DESK_ACT_PHRASE_CODES).toEqual("act.done act.invalid act.forbidden act.unknown-target act.closed-item act.busy act.not-set-up act.unavailable act.duplicate act.method act.failed act.refused mail.moved mail.restored mail.domain-blocked mail.unimportant-moved mail.unimportant-hidden mail.reply-drafted mail.reported mail.correction-recorded mail.corrected mail.swept mail.sweep-undone mail.snoozed mail.snooze-cancelled mail.hidden mail.hide-undone mail.kept mail.unsubscribed mail.unsubscribe-rule-archived mail.dismissed mail.dismissal-undone mail.sender-trusted mail.opened mail.attached mail.attach-undone mail.linked mail.link-undone mail.handed mail.handoff-approved mail.handoff-discarded mail.handoff-retried mail.invite-proposed mail.invite-replied mail.studio-added mail.studio-proposed create.done create.kept autonomy.set handoff.done routine.saved routine.paused routine.resumed routine.removed routine.installed routine.denied routine.approved routine.auto routine.approval routine.discarded studio.done studio.spar-queued ranger.action-done ranger.action-queued mail.put-back mail.put-back-undone mail.put-back-next-round meeting.dismissed".split(" "));
  expect<readonly string[]>(DESK_PHRASE_CODES).toEqual([...DESK_ITEM_PHRASE_CODES, ...DESK_ACT_PHRASE_CODES, ...DESK_BRIEF_PHRASE_CODES]);
  const coversUnion: Exclude<DeskPhrase["code"], typeof DESK_PHRASE_CODES[number]> extends never ? true : never = true;
  expect(coversUnion).toBe(true);
  expect(new Set(DESK_PHRASE_CODES).size).toBe(DESK_PHRASE_CODES.length);
  expect(DESK_PHRASE_CODES.every(code => /^[a-z]+\.[a-z]+(?:-[a-z]+)*$/.test(code))).toBe(true);
});

test("GET /api/desk serves every why phrase code beside its original sentence or flat interruption reason", async () => {
  const seen = new Set<string>();
  const check = (view: DeskView, key: string, why: string, phrase: DeskPhrase): DeskItem => {
    const found = item(view, key);
    expect(found.why).toBe(why);
    expect(found.whyPhrase).toEqual(phrase);
    seen.add(phrase.code);
    return found;
  };
  ranger.needsYou = [
    { key: "blocked", repo: "example/app", nodeId: "1", title: "Blocked", status: "parked", endedAt: iso(EARLIER), reason: { class: "blocked" } },
    { key: "failed", repo: "example/app", nodeId: "2", title: "Failed", status: "failed", endedAt: iso(EARLIER) },
    { key: "queued", repo: "example/app", nodeId: "3", title: "Queued", status: "parked", queued: { lane: "build", position: 2 } },
  ];
  ranger.maps = [{ key: "map", repo: "example/app", decisions: [{ id: "4", title: "Decision" }], grillings: [{ id: "5", title: "Question" }] }];
  const sensor = seedSubject("check", "G1.sensor", "regressed", "G1");
  const goal = seedSubject("goal", "G1", "off-track", "G1");
  const escalation = seedSubject("escalation", "example/other#6", "needs-principal", null);
  waiting.set("example/other#6", { kind: "open", title: "Escalated", question: "Original agent question?", url: "https://example.test/6" });
  let view = await read();
  check(view, "ranger:example/app#1", "The agent in app cannot go on without a decision from you.", { code: "ranger.blocked", params: { repo: "app" } });
  check(view, "ranger:example/app#2", `It stopped today at ${clock(EARLIER)} in app, and nothing moves until it is retried or parked.`, { code: "ranger.stopped", params: { repo: "app", endedAt: iso(EARLIER), failed: true } });
  check(view, "ranger:example/app#3", "Ranger queued the resume, at place 2. It starts when the lane is free.", { code: "ranger.resume-queued", params: { position: 2 } });
  check(view, "ranger:example/app#4", "Agents in app will not start it without you.", { code: "ranger.approval-needed", params: { repo: "app" } });
  check(view, "ranger:example/app#5", "It blocks work in app until you have talked it through.", { code: "ranger.discussion-needed", params: { repo: "app" } });
  check(view, sensor, `Without it, nobody can tell whether this goal is on track. It last ran today at ${clock(EARLIER)}.`, { code: "goal.check-regressed", params: { lastRanAt: iso(EARLIER) } });
  expectWhyContent(check(view, goal, `This reading is as of ${clock(EARLIER)} today. ${WORDING}`, { code: "goal.reading", params: { at: iso(EARLIER), wordingAvailable: true } }), { goalWording: WORDING });
  expectWhyContent(check(view, escalation, "Original agent question? In other.", { code: "ranger.question", params: { repo: "other", questionAvailable: true } }), { reason: "Original agent question?" });

  options().rangerCli = { bin: "unused-ranger", config: "" };
  view = await read();
  check(view, "ranger:example/app#4", "No agent builds this map; Ranger only shows it.", { code: "ranger.map-read-only" });
  ranger.maps[0]!.walk = "full";
  view = await read();
  check(view, "ranger:example/app#4", "Ranger does not take an approval for it here. Look first to see what it needs.", { code: "ranger.approval-unavailable" });
  runtime.conversations = () => false;
  view = await read();
  check(view, "ranger:example/app#5", "Conversations are not set up on this stack.", { code: "ranger.conversations-unavailable" });
  noteRetry("failed", "Original command failure");
  view = await read();
  expectWhyContent(check(view, "ranger:example/app#2", `The Desk tried to retry it on its own today at ${clock(EARLIER)}. Original command failure`, { code: "ranger.retry-failed", params: { at: iso(EARLIER) } }), { reason: "Original command failure" });
  noteRetry("done", null);
  view = await read();
  check(view, "ranger:example/app#2", `The Desk retried it on its own today at ${clock(EARLIER)}, and it failed again.`, { code: "ranger.retried", params: { at: iso(EARLIER) } });

  withMail();
  const meetingStart = iso(NOW + 5 * 60_000);
  source.events = [{ id: "review", title: "Budget review", start: meetingStart }, { id: "ended", title: "Budget review", start: iso(NOW - 10 * 60_000), end: iso(NOW - 5 * 60_000) }];
  source.items = [letter("received"), letter("possible", { subject: "Budget review agenda" }), letter("linked"), letter("vip"), letter("ranked"), letter("deadline", { dueAt: iso(NOW + 3_600_000) }), letter("quiet"), letter("precedent"), letter("unsubscribe", { headers: { listUnsubscribe: "<https://lists.example.test/leave>" } }), letter("invite", { invitation: {
    method: "REQUEST", uid: "invitation", sequence: 0, summary: "Invitation content", start: meetingStart,
    organizer: { address: "organizer@example.test" }, attendee: { address: "reader@example.test", status: "NEEDS-ACTION" }, attendees: 2,
  } }), letter("suspicious", { headers: { authResults: { dmarc: "fail" } } })];
  for (const id of ["linked", "ranked", "deadline", "unsubscribe"]) classify(id, id === "linked" ? { category: "meeting", meetingKey: "cal:fixture:review" } : {});
  classify("precedent", { predictedAction: "archive", precedents: { basis: "sender", note: "Original precedent note", items: [
    { subject: "Old mail", at: EARLIER, correction: false, action: "archive", sender: "news@example.test" },
    { subject: "Other action", at: EARLIER, correction: false, action: "keep", sender: "other@example.test" },
  ] } });
  addVip(db, "vip@example.test", null, NOW);
  addSender(db, "unimportant", "quiet@example.test", null, NOW);
  const unsub = source.items.find(m => m.id === "unsubscribe")!;
  for (let i = 0; i < 5; i++) logMailDecision(db, mailFeatures(db, { ...unsub, id: `old-${i}`, sourceId: "fixture" }), "archive", "desk", EARLIER);
  const reminder = addNote(db, "reminder", "Reminder content", NOW - 60_000, EARLIER);
  view = await read();
  check(view, `reminder:${reminder.id}`, `You asked to be reminded today at ${clock(NOW - 60_000)}.`, { code: "reminder.due", params: { dueAt: iso(NOW - 60_000) } });
  check(view, `meeting:cal:fixture:review@${NOW + 5 * 60_000}`, "It starts in 5 minutes.", { code: "meeting.soon", params: { startsAt: meetingStart } });
  check(view, "meeting-after:cal:fixture:ended", "It ended 5 minutes ago.", { code: "meeting.ended", params: { endedAt: iso(NOW - 5 * 60_000) } });
  check(view, "mail:received", `It arrived today at ${clock(EARLIER)}.`, { code: "mail.received", params: { receivedAt: iso(EARLIER) } });
  expectWhyContent(check(view, "mail:possible", `It may be about "Budget review" today at ${clock(Date.parse(meetingStart))}.`, { code: "mail.meeting-possible", params: { meetingStart } }), { meetingTitle: "Budget review" });
  expectWhyContent(check(view, "mail:linked", `${CLASSIFIER_REASON}. The meeting is today at ${clock(Date.parse(meetingStart))}.`, { code: "mail.meeting-linked", params: { meetingStart } }), { reason: CLASSIFIER_REASON, meetingTitle: "Budget review" });
  check(view, "mail:vip", `Sender is on your VIP list. It arrived today at ${clock(EARLIER)}.`, { code: "mail.vip", params: { target: "Sender", receivedAt: iso(EARLIER), vip: "Sender" } });
  check(view, "mail:quiet", "You marked mail from this sender unimportant.", { code: "mail.unimportant", params: {} });
  expectWhyContent(check(view, "mail:precedent", "Archived like the last mail from this sender (Original precedent note).", { code: "mail.precedent", params: { action: "archive", basis: "sender", count: 1 } }), { precedentNote: "Original precedent note", precedentSenders: ["news@example.test"] });
  expectWhyContent(check(view, "mail:unsubscribe", `${CLASSIFIER_REASON}. You archived or deleted 5 of its mails unread. Its unsubscribe page is https://lists.example.test/leave; the Desk does not open it for you.`, { code: "mail.unsubscribe", params: { unsubscribeKind: "page", unsubscribeHost: "lists.example.test", dismissed: 5 } }), { reason: CLASSIFIER_REASON, unsubscribeUrl: "https://lists.example.test/leave" });
  const invite = item(view, "mail:invite");
  expect(invite.why).toBe(`${invite.invitation!.organizer} invites you to "Invitation content", ${invite.invitation!.when}. ${invite.invitation!.conflictLine}`);
  expect(invite.whyPhrase).toEqual({ code: "mail.invitation", params: { start: meetingStart, attendee: true } });
  seen.add("mail.invitation");
  expect(item(view, "mail:suspicious").why).toMatch(/^This may be phishing:/);
  expect(item(view, "mail:suspicious").whyPhrase).toEqual({ code: "mail.suspicious" });
  seen.add("mail.suspicious");
  expect(item(view, "mail:ranked").why).toBe(`${CLASSIFIER_REASON}.`);
  expect(item(view, "mail:ranked").whyPhrase).toBeUndefined();
  expectWhyContent(item(view, "mail:ranked"), { reason: CLASSIFIER_REASON });
  for (const key of ["mail:linked", "mail:deadline", "mail:vip", "mail:ranked", `reminder:${reminder.id}`, `meeting:cal:fixture:review@${NOW + 5 * 60_000}`]) {
    const reason = item(view, key).interrupt?.reason;
    expect(reason).toBeDefined();
    if (!reason) throw new Error(`Missing interruption for ${key}`);
    const { code, phrase, ...params } = reason;
    expect<object>(phrase).toEqual(Object.keys(params).length ? { code, params } : { code });
    seen.add(code);
  }
  expect([...seen].sort()).toEqual([...WHY_CODES].sort());
});

const labelCodes = (view: DeskView): string[] => {
  const codes: string[] = [];
  const add = (phrase?: DeskPhrase): void => { if (phrase) codes.push(phrase.code); };
  for (const found of view.items) {
    for (const action of [...found.actions, ...(found.more ?? [])]) add(action.labelPhrase);
    for (const link of found.detail.links) add(link.labelPhrase);
  }
  for (const correction of view.corrections) add(correction.labelPhrase);
  for (const sweep of view.mailSweeps ?? []) add(sweep.labelPhrase);
  return [...new Set(codes)].sort();
};

const postSnooze = async (until: unknown): Promise<DeskPhrase | undefined> => {
  const request = new Request("http://localhost/api/desk/mail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "snooze", key: "mail:recent", until }) });
  const response = await handleDeskMail(request, db, runtime);
  expect(response.status).toBe(200);
  return (await response.json() as { labelPhrase?: DeskPhrase }).labelPhrase;
};

test("GET, a snooze answer and the classifier input serve every label phrase code", async () => {
  const config = { ...CONFIG, maxPerPass: 1, sourcePolicy: "local" as const };
  const corrections: DeskPhrase[] = [];
  options().mailActions = { move: ["unused-move"], draft: ["unused-draft"], timeoutSeconds: 5 };
  options().ask = { parser: [], timeoutSeconds: 5, writers: { task: ["unused-task"] }, taskMaps: [{ ref: "example/tasks#1", label: "Tasks" }] };
  options().mailClassifier = config;
  options().mailHandoff = { lanes: { local: { provider: "spark", model: "longctx" } }, pi: { bin: "pi", extensions: [], tools: [], timeoutSeconds: 5, sessionDir: "/nonexistent", cwd: "/nonexistent", passEnv: [] } };
  options().sources = [{ id: "fixture", command: ["unused-source"], everySeconds: 300, timeoutSeconds: 5 }];
  runtime.mailHandoff = { kick: async () => {} } as unknown as MailHandoffWorker;
  runtime.mailClassifier = new MailClassifier(config, async (input) => {
    corrections.push(...input.corrections.flatMap(correction => correction.labelPhrase ? [correction.labelPhrase] : []));
    return { category: "action", reason: "Synthetic result" };
  });
  source.items = [
    letter("recent", { url: "message://recent" }),
    letter("old1", { receivedAt: iso(NOW - 4 * DAY_MS) }),
    letter("old2", { receivedAt: iso(NOW - 4 * DAY_MS) }),
    letter("old3", { receivedAt: iso(NOW - 4 * DAY_MS) }),
  ];
  source.events = [{ id: "review", title: "Budget review", start: iso(NOW + 3_600_000) }];
  for (const id of ["old1", "old2", "old3"]) classify(id, { category: "bulk", predictedAction: "archive" });
  const corrected = { ...letter("correction"), sourceId: "fixture", area: null };
  logMailDecision(db, { ...mailFeatures(db, corrected), category: "not bulk" }, "archive", "correction", EARLIER);
  setCorrection(db, "goal", "vigil", "less", NOW);
  db.query("INSERT INTO desk_mail_rules (id, match, value, action, state, created_at, updated_at, count, held, released) VALUES (?, ?, ?, ?, 'on', ?, ?, 0, 37, 0)").run("rule-held", "sender", "held@example.test", "archive", NOW, NOW);
  db.query("INSERT INTO desk_mail_handoffs (id, message_id, source_id, from_address, subject, url, received_at, route, task_id, task_url, state, error, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)")
    .run("handoff-label", "unlisted", "fixture", "sender@example.test", "Unlisted subject", "message://unlisted", iso(EARLIER), "local", "example/tasks#1", "https://example.test/tasks/1", "Synthetic failure", NOW, NOW);
  const view = await read();
  await runtime.mailClassifier.kick(db, { now: NOW, mail: [], events: [], vips: [] });
  expect(labelCodes(view)).toEqual(["assistant.retry", "correction.source", "mail.assistant", "mail.sweep-category", "mailrule.release", "task.link", "vip.add"]);
  const snoozed = [
    await postSnooze({ kind: "tomorrow" }),
    await postSnooze({ kind: "meeting", event: "cal:fixture:review" }),
    await postSnooze({ kind: "person", address: "sender@example.test" }),
  ];
  expect(snoozed.map(phrase => phrase?.code)).toEqual(["mail.put-away-time", "mail.put-away-meeting", "mail.put-away-person"]);
  expect(corrections.map(phrase => phrase.code)).toEqual(["mail.correction"]);
  expect([...labelCodes(view), ...snoozed.flatMap(phrase => phrase ? [phrase.code] : []), ...corrections.map(phrase => phrase.code)].sort()).toEqual([...LABEL_CODES].sort());
});

test("mixed mail wording separates prose, titles and URLs from named VIP and ISO parameters", () => {
  const classified = new Map<string, MailClassification>([["m", { category: "meeting", reason: CLASSIFIER_REASON, meetingKey: "cal:fixture:review" }]]);
  const input = { now: NOW, mail: [{ ...letter("m"), sourceId: "fixture", area: null }], vips: new Set(["m@example.test"]), events: [{ id: "review", sourceId: "fixture", title: "Budget review", start: iso(NOW + 3_600_000) }], classified };
  const found = mailItems(input)[0]!;
  expect(found.why).toBe(`Sender is on your VIP list. ${CLASSIFIER_REASON}. The meeting is today at ${clock(NOW + 3_600_000)}.`);
  expectWhyContent(found, { reason: CLASSIFIER_REASON, meetingTitle: "Budget review" });
  expect(found.whyPhrase).toEqual({ code: "mail.meeting-linked", params: { meetingStart: iso(NOW + 3_600_000), vip: "Sender" } });
  const [rule] = mailItems({ ...input, vips: new Set(), unsubscribe: new Map([["m", { kind: "rule", at: EARLIER, host: "lists.example.test" }]]) });
  expectWhyContent(rule, { reason: CLASSIFIER_REASON, meetingTitle: "Budget review" });
  expect(rule?.whyPhrase).toEqual({ code: "mail.meeting-linked", params: { meetingStart: iso(NOW + 3_600_000), unsubscribeKind: "rule", unsubscribeHost: "lists.example.test", unsubscribeAt: iso(EARLIER) } });
  const [page] = mailItems({ ...input, vips: new Set(), unsubscribe: new Map([["m", { kind: "page", dismissed: 5, host: "lists.example.test", url: "https://lists.example.test/leave" }]]) });
  expectWhyContent(page, { reason: CLASSIFIER_REASON, meetingTitle: "Budget review", unsubscribeUrl: "https://lists.example.test/leave" });
  expect(page?.whyPhrase).toEqual({ code: "mail.meeting-linked", params: { meetingStart: iso(NOW + 3_600_000), unsubscribeKind: "page", unsubscribeHost: "lists.example.test", dismissed: 5 } });
  const [failed] = mailItems({ ...input, vips: new Set(), unsubscribe: new Map([["m", { kind: "one-click", dismissed: 5, host: "lists.example.test", url: "https://lists.example.test/leave", failed: "Original transport failure" }]]) });
  expectWhyContent(failed, { reason: CLASSIFIER_REASON, meetingTitle: "Budget review", unsubscribeFailure: "Original transport failure" });
  expect(failed?.whyPhrase).toEqual({ code: "mail.meeting-linked", params: { meetingStart: iso(NOW + 3_600_000), unsubscribeKind: "one-click", unsubscribeHost: "lists.example.test", dismissed: 5, unsubscribeFailed: true } });
});

test("task enrichment, unavailable content and retry replacement keep the phrase aligned with the sentence", async () => {
  ranger.needsYou = [{ key: "failed", repo: "example/app", nodeId: "2", title: "Failed", status: "failed", endedAt: "garbled" }];
  let found = item(await read(), "ranger:example/app#2");
  expect(found.whyPhrase).toEqual({ code: "ranger.stopped", params: { repo: "app", endedAt: iso(NOW), failed: true } });
  waiting.set("example/app#2", { kind: "open", title: "Fresh title", question: "A person's question?", url: "https://example.test/2" });
  found = item(await read(), "ranger:example/app#2");
  expect(found.why).toBe("A person's question? In app.");
  expect(found.whyPhrase).toEqual({ code: "ranger.question", params: { repo: "app", questionAvailable: true } });
  expectWhyContent(found, { reason: "A person's question?" });
  waiting.set("example/app#2", { kind: "unavailable", reason: "Original lookup error" });
  found = item(await read(), "ranger:example/app#2");
  expect(found.why).toBe(`It stopped today at ${clock(NOW)} in app, and nothing moves until it is retried or parked. Original lookup error`);
  expectWhyContent(found, { sourceStatusReason: "Original lookup error" });
  expect(found.whyPhrase?.code).toBe("ranger.stopped");
  noteRetry("failed", null);
  found = item(await read(), "ranger:example/app#2");
  expect(found.why).toBe(`The Desk tried to retry it on its own today at ${clock(EARLIER)}. Ranger gave no reason.`);
  expect(found.whyPhrase).toEqual({ code: "ranger.retry-failed", params: { at: iso(EARLIER) } });
  expect(found.whyContent).toBeUndefined();
});

test("a running stack serves why phrases, link kinds and action label phrases through curl with unchanged wording", async () => {
  const output = JSON.stringify({ items: [letter("label", { url: "message://label" })] });
  const desk: DeskOptions = { ...options(), rangerUrl: "", sources: [{ id: "fixture", command: ["bun", "-e", `process.stdout.write(${JSON.stringify(output)})`], everySeconds: 300, timeoutSeconds: 5 }] };
  const reminder = addNote(db, "reminder", "Synthetic reminder", NOW - 60_000, EARLIER);
  const stack = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { desk });
  try {
    const curl = Bun.spawn(["curl", "--fail-with-body", "-sS", "-i", `http://127.0.0.1:${stack.port}/api/desk`], { stdout: "pipe", stderr: "pipe" });
    const [output, error, exitCode] = await Promise.all([new Response(curl.stdout).text(), new Response(curl.stderr).text(), curl.exited]);
    expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });
    const [headers, body] = output.split("\r\n\r\n");
    expect(headers).toMatch(/^HTTP\/1.1 200/);
    const view = JSON.parse(body ?? "") as DeskView;
    const found = item(view, `reminder:${reminder.id}`);
    expect(found.why).toBe(`You asked to be reminded today at ${clock(NOW - 60_000)}.`);
    expect(found.whyPhrase).toEqual({ code: "reminder.due", params: { dueAt: iso(NOW - 60_000) } });
    expect(found.interrupt?.reason).toEqual({ code: "reminder.due", phrase: { code: "reminder.due" } });
    const mail = item(view, "mail:label");
    const link = mail.detail.links[0];
    const action = [...mail.actions, ...(mail.more ?? [])].find(a => a.id === "vip.add");
    expect(link).toEqual({ kind: "mail", label: "Open in Mail", url: "message://label" });
    expect(action).toMatchObject({ label: "Always show mail from Sender", labelPhrase: { code: "vip.add", params: { name: "Sender" } } });
    console.log(JSON.stringify({ probe: "curl /api/desk", status: 200, why: found.why, whyPhrase: found.whyPhrase, reason: found.interrupt?.reason, link, action }));
  } finally {
    stack.stop(true);
  }
});
