import type { Database } from "bun:sqlite";
import { listGrants, setGrant } from "./autonomy";
import type { WriterRunner } from "./create";
import type { ListedMail, MailActionsConfig, TrashLedger } from "./mail-actions";
import { loggedFeatures, logMailDecision, mailFeatures, queryMailLog, type MailFeatures, type MailLogAction, type MailLogEntry } from "./mail-log";
import { movedTarget, moveMail, refuse, undoMove, type MoveDeps, type MoveResult } from "./mail-move";
import { DEFAULT_MAIL_RULES, RULE_ACTIONS, RULE_MATCHES, type MailRulesConfig, type RuleAction, type RuleMatch, type RuleState, type RuleTarget } from "./mail-rules-schema";
import { ago } from "./rank";
import type { SourceMail, SourceReading } from "./sources/command";
import { DAY_MS } from "./time";
import type { DeskItem } from "./types";
import { isVip, listVips } from "./vips";
import { attachMail, endLink, linkByRun, linkTargetOf, offDeskIds, type LinkTarget } from "./links";
import { readClassifications } from "./classify";
import { isSuspicious, suspicionContext, type SuspicionContext } from "./mail-suspicion";

export { DEFAULT_MAIL_RULES, MAIL_RULES_SQL, RULE_ACTIONS, RULE_MATCHES, type MailRulesConfig, type RuleAction, type RuleMatch, type RuleTarget } from "./mail-rules-schema";

export const RULES_GRANT = "mail.rules";
export const LATER_MS = 7 * DAY_MS;

export interface MailRule {
  id: string;
  match: RuleMatch;
  value: string;
  action: RuleAction;
  on: boolean;
  createdAt: number;
  lastRunAt: number | null;
  count: number;
  held: number | null;
  released: boolean;
  target: RuleTarget | null;
}

export interface MailRuleView {
  id: string;
  match: RuleMatch;
  value: string;
  action: RuleAction;
  on: boolean;
  sentence: string;
  lastRunAt: number | null;
  count: number;
  held: number | null;
  target: RuleTarget | null;
}

export interface RuleProposal {
  key: string;
  match: RuleMatch;
  value: string;
  action: Exclude<RuleAction, "digest">;
  target: RuleTarget | null;
  agreeing: number;
  examples: MailLogEntry[];
}

export interface RuleRun {
  id: string;
  ruleId: string;
  messageId: string;
  action: RuleAction;
  status: "done" | "failed";
  at: number;
  undoneAt: number | null;
}

interface RuleRow {
  id: string;
  match: RuleMatch;
  value: string;
  action: RuleAction;
  state: RuleState;
  created_at: number;
  last_run_at: number | null;
  count: number;
  held: number | null;
  released: number;
  target_kind: RuleTarget["kind"] | null;
  target_key: string | null;
  target_title: string | null;
}

interface RunRow {
  id: string;
  rule_id: string;
  message_id: string;
  action: RuleAction;
  status: "done" | "failed";
  created_at: number;
  undone_at: number | null;
}

const RULE_COLUMNS = "id, match, value, action, state, created_at, last_run_at, count, held, released, target_kind, target_key, target_title";
const RUN_COLUMNS = "id, rule_id, message_id, action, status, created_at, undone_at";

const toRule = (r: RuleRow): MailRule => ({
  id: r.id, match: r.match, value: r.value, action: r.action, on: r.state === "on", createdAt: r.created_at,
  lastRunAt: r.last_run_at, count: r.count, held: r.held, released: r.released === 1,
  target: r.target_kind && r.target_key ? { kind: r.target_kind, key: r.target_key, title: r.target_title ?? r.target_key } : null,
});

const toRun = (r: RunRow): RuleRun => ({ id: r.id, ruleId: r.rule_id, messageId: r.message_id, action: r.action, status: r.status, at: r.created_at, undoneAt: r.undone_at });

const isMatch = (v: unknown): v is RuleMatch => RULE_MATCHES.includes(v as RuleMatch);
const isAction = (v: unknown): v is RuleAction => RULE_ACTIONS.includes(v as RuleAction);

const VERB: Record<RuleAction, string> = { archive: "Archive", junk: "Move to Junk", trash: "Delete", digest: "Keep for the digest", attach: "Attach" };
const DONE_BY: Record<RuleAction, string> = { archive: "Archived by your rule", junk: "Moved to Junk by your rule", trash: "Deleted by your rule", digest: "Kept for the digest by your rule", attach: "Attached by your rule" };
const PAST: Partial<Record<MailLogAction, string>> = { archive: "archived", junk: "moved to Junk", trash: "deleted", attach: "attached", studio: "added to a thread" };

const whose = (match: RuleMatch, value: string): string => {
  switch (match) {
    case "sender":
      return `from ${value}`;
    case "domain":
      return `from anyone at ${value}`;
    case "list":
      return `from the list ${value}`;
    case "subject":
      return `whose subject contains “${value}”`;
  }
};

/** One plain sentence for a rule, such as "Archive mail from reports@example.org". */
export const ruleSentence = (r: Pick<MailRule, "match" | "value" | "action"> & { target?: RuleTarget | null }): string =>
  `${VERB[r.action]} mail ${whose(r.match, r.value)}${r.target ? ` to “${r.target.title}”` : ""}`;

/** The stored form of a match value, or an error line. */
export function normalizeRuleValue(match: RuleMatch, raw: string): string | { error: string } {
  const v = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (!v || v.length > 200) return { error: "A rule needs a match of 1 to 200 characters." };
  switch (match) {
    case "sender":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : { error: "A sender rule needs a full address such as ada@example.org." };
    case "domain": {
      const d = v.replace(/^@/, "");
      return /^[^@\s]+\.[^@\s]+$/.test(d) ? d : { error: "A domain rule needs a domain such as example.org." };
    }
    case "list":
      return v;
    case "subject":
      return v.length >= 3 ? v : { error: "A subject rule needs at least 3 characters." };
  }
}

const listIdOf = (mail: Pick<SourceMail, "headers">): string => mail.headers?.listId?.trim().toLowerCase() ?? "";

/** True when the mail matches the rule's sender, exact domain, List-Id or subject text. It does not look at VIPs. */
export function matchesRule(rule: Pick<MailRule, "match" | "value">, mail: Pick<SourceMail, "from" | "subject" | "headers">): boolean {
  const address = mail.from.address.trim().toLowerCase();
  switch (rule.match) {
    case "sender":
      return address === rule.value;
    case "domain":
      return address.slice(address.lastIndexOf("@") + 1) === rule.value;
    case "list":
      return listIdOf(mail) === rule.value;
    case "subject":
      return mail.subject.toLowerCase().includes(rule.value);
  }
}

/** The first rule that is on and matches the mail. A VIP's mail and a mail that looks like phishing never match. */
export function ruleFor(rules: readonly MailRule[], mail: Pick<SourceMail, "from" | "subject" | "headers" | "links"> & { id?: string }, suspicion: SuspicionContext, classifierSuspicious = false): MailRule | undefined {
  if (isVip(suspicion.vips, mail.from.address) || isSuspicious(mail, suspicion, classifierSuspicious)) return undefined;
  return rules.find((r) => r.on && matchesRule(r, mail));
}

const flaggedByClassifier = (db: Database, ids: string[]): Set<string> =>
  new Set([...readClassifications(db, ids)].filter(([, c]) => c.suspicious === true).map(([id]) => id));

const allRows = (db: Database): RuleRow[] => db.query<RuleRow, []>(`SELECT ${RULE_COLUMNS} FROM desk_mail_rules ORDER BY created_at, id`).all();

/** The approved rules, on or off, oldest first. Answers to proposals (Not now, Never) live in desk_mail_rule_answers. */
export const listRules = (db: Database): MailRule[] => allRows(db).map(toRule);

export const ruleById = (db: Database, id: string): MailRule | null => listRules(db).find((r) => r.id === id) ?? null;

export const ruleViews = (db: Database): MailRuleView[] =>
  listRules(db).map((r) => ({ id: r.id, match: r.match, value: r.value, action: r.action, on: r.on, sentence: ruleSentence(r), lastRunAt: r.lastRunAt, count: r.count, held: r.held, target: r.target }));

/** Rule runs, newest first, for Done for you and the weekly mirror. */
export function ruleRuns(db: Database, q: { since?: number; ruleId?: string; limit?: number } = {}): RuleRun[] {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? 500)), 5000);
  return db
    .query<RunRow, [number, string | null, string | null]>(`SELECT ${RUN_COLUMNS} FROM desk_mail_rule_runs WHERE created_at >= ? AND (? IS NULL OR rule_id = ?) ORDER BY created_at DESC, id DESC LIMIT ${limit}`)
    .all(q.since ?? 0, q.ruleId ?? null, q.ruleId ?? null)
    .map(toRun);
}

const runFor = (db: Database, id: string): RunRow | null => db.query<RunRow, [string]>(`SELECT ${RUN_COLUMNS} FROM desk_mail_rule_runs WHERE id = ?`).get(id);

/** The rule behind each run id, for "Stop doing this" in Done for you. */
export function rulesOfRuns(db: Database, runIds: string[]): Map<string, string> {
  if (runIds.length === 0) return new Map();
  const rows = db.query<{ id: string; rule_id: string }, [string]>("SELECT id, rule_id FROM desk_mail_rule_runs WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(runIds));
  return new Map(rows.map((r) => [r.id, r.rule_id]));
}

const ranIds = (db: Database, ids: string[]): Set<string> => {
  if (ids.length === 0) return new Set();
  return new Set(db.query<{ message_id: string }, [string]>("SELECT message_id FROM desk_mail_rule_runs WHERE message_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)).map((r) => r.message_id));
};

/** Of the given mails, those a rule kept for the digest and nobody took back: they stay off the Desk. */
export function digestedIds(db: Database, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set(db
    .query<{ message_id: string }, [string]>("SELECT message_id FROM desk_mail_rule_runs WHERE message_id IN (SELECT value FROM json_each(?)) AND action = 'digest' AND status = 'done' AND undone_at IS NULL")
    .all(JSON.stringify(ids)).map((r) => r.message_id));
}

const rulesRun = (db: Database): boolean => listGrants(db).has(RULES_GRANT);

/** Listed mails an approved rule will handle on its next pass. The Desk does not send them to the model; a paused rule's mail goes to the model. */
export function pendingRuleMail(db: Database, mails: readonly SourceMail[], suspicion: SuspicionContext = suspicionContext(db)): Set<string> {
  if (!rulesRun(db)) return new Set();
  const rules = listRules(db).filter((r) => r.on && (r.held === null || r.released));
  if (rules.length === 0) return new Set();
  const ids = mails.map((m) => m.id);
  const ran = ranIds(db, ids);
  const flagged = flaggedByClassifier(db, ids);
  const offDesk = offDeskIds(db);
  return new Set(mails.filter((m) => !ran.has(m.id) && !offDesk.has(m.id) && ruleFor(rules, m, suspicion, flagged.has(m.id))).map((m) => m.id));
}

const ATTACHES = new Set<MailLogAction>(["attach", "studio"]);
const DECISIVE = new Set<MailLogAction>(["archive", "junk", "trash", "restore", "kept", "todo", "draft", "plan", "snooze", ...ATTACHES]);
const PROPOSABLE = new Set<MailLogAction>(["archive", "junk", "trash", "attach"]);
const ORDER: RuleMatch[] = ["list", "domain", "sender"];

const proposalKey = (match: RuleMatch, value: string, action: RuleAction, target: RuleTarget | null): string =>
  target ? `mailrule:${match}:${action}:${target.kind}:${target.key}:${value}` : `mailrule:${match}:${action}:${value}`;

/** The action a proposal key stands for, as `proposalKey` wrote it. */
export const proposalAction = (key: string): string | null => key.split(":")[2] ?? null;

const isRuleTarget = (t: LinkTarget | null): t is LinkTarget & RuleTarget => t !== null && (t.kind === "task" || t.kind === "thread");

const decisionOf = (db: Database, e: MailLogEntry): { action: MailLogAction; target: RuleTarget | null; same: string } => {
  if (!ATTACHES.has(e.action)) return { action: e.action, target: null, same: e.action };
  const target = linkTargetOf(db, e.messageId, e.at);
  return { action: "attach", target: isRuleTarget(target) ? { kind: target.kind, key: target.key, title: target.title } : null, same: target ? `attach:${target.kind}:${target.key}` : "attach:" };
};

/**
 * Rules the log supports: a sender, domain or List-Id whose last `proposeAfter` or more mails the principal all moved
 * the same way (or attached to the same task or Studio thread), in the Desk or their mail client, with no counter-example in the window (another action, an Undo,
 * a mail kept in the inbox). Rule runs do not count. A domain is proposed only for two or more senders; a group whose
 * mails another proposal already covers, a VIP's mail, and any match the principal answered (rule, Not now, Never)
 * are left out.
 */
export function proposeRules(db: Database, now: number, config: MailRulesConfig = DEFAULT_MAIL_RULES, vips: ReadonlySet<string> = new Set(listVips(db).map((v) => v.address))): RuleProposal[] {
  const answers = db.query<{ match: string; value: string }, [number]>("SELECT match, value FROM desk_mail_rule_answers WHERE answer = 'never' OR until > ?").all(now);
  const answered = new Set([...allRows(db), ...answers].map((r) => `${r.match}\u0000${r.value}`));
  const entries = queryMailLog(db, { since: now - config.windowDays * DAY_MS, limit: 5000 }).filter((e) => e.where !== "rule" && DECISIVE.has(e.action));
  const groups = new Map<string, { match: RuleMatch; value: string; entries: MailLogEntry[] }>();
  const add = (match: RuleMatch, value: string | null, e: MailLogEntry): void => {
    const v = value?.trim().toLowerCase();
    if (!v) return;
    const k = `${match}\u0000${v}`;
    const g = groups.get(k) ?? { match, value: v, entries: [] };
    g.entries.push(e);
    groups.set(k, g);
  };
  for (const e of entries) {
    add("sender", e.sender, e);
    add("domain", e.senderDomain, e);
    add("list", e.listId, e);
  }
  const decisions = new Map(entries.map((e) => [e.id, decisionOf(db, e)]));
  const candidates: RuleProposal[] = [];
  for (const g of groups.values()) {
    const first = g.entries[0];
    const decided = first ? decisions.get(first.id) : undefined;
    if (!first || !decided || answered.has(`${g.match}\u0000${g.value}`) || !PROPOSABLE.has(decided.action)) continue;
    if (decided.action === "attach" && !decided.target) continue;
    if (g.entries.some((e) => decisions.get(e.id)?.same !== decided.same || isVip(vips, e.sender))) continue;
    if (g.match === "domain" && new Set(g.entries.map((e) => e.sender)).size < 2) continue;
    const agreeing = new Set(g.entries.map((e) => e.messageId)).size;
    if (agreeing < config.proposeAfter) continue;
    const action = decided.action as RuleProposal["action"];
    candidates.push({ key: proposalKey(g.match, g.value, action, decided.target), match: g.match, value: g.value, action, target: decided.target, agreeing, examples: g.entries.slice(0, 5) });
  }
  candidates.sort((a, b) => ORDER.indexOf(a.match) - ORDER.indexOf(b.match) || b.agreeing - a.agreeing || a.value.localeCompare(b.value));
  const covered = new Set<string>();
  const chosen: RuleProposal[] = [];
  for (const c of candidates) {
    const ids = groups.get(`${c.match}\u0000${c.value}`)?.entries.map((e) => e.messageId) ?? [];
    if (ids.every((id) => covered.has(id))) continue;
    for (const id of ids) covered.add(id);
    chosen.push(c);
  }
  return chosen;
}

const exampleLine = (e: MailLogEntry, now: number): string =>
  `“${e.subject ?? "(no subject)"}”: ${PAST[e.action] ?? e.action} ${e.where === "client" ? "in your mail client" : "on the Desk"} ${ago(now, e.at)}`;

/** Quiet cards for proposals: a plain sentence, the examples it rests on, Approve / Not now / Never. */
export function proposalItems(proposals: RuleProposal[], now: number): DeskItem[] {
  return proposals.map((p): DeskItem => {
    const sentence = ruleSentence(p);
    const verb = PAST[p.action] ?? p.action;
    return {
      key: p.key,
      kind: "mail-rule",
      source: "desk",
      area: null,
      urgency: "this-week",
      title: `${sentence} on its own?`,
      why: `You ${verb} the last ${p.agreeing} and never did anything else with one. Nothing changes until you approve.`,
      score: 12,
      actions: [
        { id: "mailrule.approve", label: "Approve", role: "primary", wired: true },
        { id: "mailrule.later", label: "Not now", role: "secondary", wired: true },
        { id: "mailrule.never", label: "Never", role: "secondary", wired: true },
      ],
      detail: {
        summary: `${sentence}. Each mail it moves shows in Done for you with Undo, and a VIP's mail is never touched.`,
        history: p.examples.map((e) => exampleLine(e, now)),
        refs: [],
        links: [],
      },
    };
  });
}

/** A card per rule that paused because one pass would have moved more mails than the cap. */
export function heldItems(rules: readonly MailRule[], config: MailRulesConfig = DEFAULT_MAIL_RULES): DeskItem[] {
  return rules.filter((r) => r.on && r.held !== null && !r.released).map((r): DeskItem => ({
    key: `mailrule:held:${r.id}`,
    kind: "mail-rule",
    source: "desk",
    area: null,
    urgency: "today",
    title: `Your rule paused: it would handle ${r.held} mails at once.`,
    why: `${ruleSentence(r)}. The Desk asks first when one pass would handle more than ${config.maxPerPass}.`,
    score: 30,
    actions: [
      { id: "mailrule.release", label: `Handle all ${r.held}`, role: "primary", wired: true, target: r.id },
      { id: "mailrule.stop", label: "Stop this rule", role: "secondary", wired: true, target: r.id },
      { id: "snooze", label: "Not now", role: "secondary", wired: true },
    ],
    detail: { summary: `${ruleSentence(r)}. It has handled ${r.count} mails so far.`, history: [], refs: [], links: [] },
  }));
}

export interface RuleEdit {
  match: RuleMatch;
  value: string;
  action: RuleAction;
  target: RuleTarget | null;
}

/** A rule as a request or a proposal gives it; an attach rule carries the task or thread its mail goes to. */
export interface RuleInput {
  match: unknown;
  value: unknown;
  action: unknown;
  target?: RuleTarget | null;
}

export type RuleChange = { ok: true; message: string; rule?: MailRuleView } | { ok: false; status: number; error: string };

const viewOf = (db: Database, id: string): MailRuleView | undefined => ruleViews(db).find((r) => r.id === id);

function checked(db: Database, edit: RuleInput, except: string | null): RuleEdit | { ok: false; status: number; error: string } {
  if (!isMatch(edit.match) || !isAction(edit.action) || typeof edit.value !== "string") return refuse(400, "A rule needs a match (sender, domain, list or subject), a value and an action.");
  const value = normalizeRuleValue(edit.match, edit.value);
  if (typeof value !== "string") return refuse(400, value.error);
  const clash = allRows(db).find((r) => r.match === edit.match && r.value === value && r.id !== except);
  if (clash) return refuse(409, `You already have a rule for that: ${ruleSentence(toRule(clash))}.`);
  if (edit.action === "attach" && !edit.target) return refuse(400, "An attach rule needs a task or a thread to attach to.");
  return { match: edit.match, value, action: edit.action, target: edit.action === "attach" ? edit.target ?? null : null };
}

const targetColumns = (t: RuleTarget | null): [string | null, string | null, string | null] => [t?.kind ?? null, t?.key ?? null, t?.title ?? null];

const clearAnswer = (db: Database, match: RuleMatch, value: string): void => {
  db.query("DELETE FROM desk_mail_rule_answers WHERE match = ? AND value = ?").run(match, value);
};

/** Creates an approved rule and turns on the mail.rules grant: approving is the principal's say-so. */
export function createRule(db: Database, edit: RuleInput, now: number, newId: () => string = () => crypto.randomUUID()): RuleChange {
  const rule = checked(db, edit, null);
  if ("ok" in rule) return rule;
  const id = newId();
  db.transaction(() => {
    clearAnswer(db, rule.match, rule.value);
    db.query("INSERT INTO desk_mail_rules (id, match, value, action, state, created_at, updated_at, target_kind, target_key, target_title) VALUES (?, ?, ?, ?, 'on', ?, ?, ?, ?, ?)")
      .run(id, rule.match, rule.value, rule.action, now, now, ...targetColumns(rule.target));
    setGrant(db, RULES_GRANT, true, now);
  })();
  return { ok: true, message: `${ruleSentence(rule)}: the Desk now does this on its own and lists each mail under Done for you.`, ...withView(db, id) };
}

const withView = (db: Database, id: string): { rule?: MailRuleView } => {
  const rule = viewOf(db, id);
  return rule ? { rule } : {};
};

/** Approve, Not now (for a week) or Never on a proposal the log still supports. */
export function answerProposal(db: Database, key: string, answer: "approve" | "later" | "never", now: number, config: MailRulesConfig = DEFAULT_MAIL_RULES, newId: () => string = () => crypto.randomUUID()): RuleChange {
  const p = proposeRules(db, now, config).find((x) => x.key === key);
  if (!p) return refuse(409, "That proposal is gone: the log no longer supports it, or you already answered it.");
  if (answer === "approve") return createRule(db, p, now, newId);
  db.transaction(() => {
    db.query("INSERT INTO desk_mail_rule_answers (match, value, action, answer, until, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(match, value) DO UPDATE SET action = excluded.action, answer = excluded.answer, until = excluded.until, created_at = excluded.created_at")
      .run(p.match, p.value, p.action, answer, answer === "later" ? now + LATER_MS : null, now);
  })();
  return { ok: true, message: answer === "later" ? "The Desk will ask again in a week if the log still agrees." : "The Desk will not propose this rule again." };
}

export function editRule(db: Database, id: string, edit: RuleInput, now: number): RuleChange {
  const existing = ruleById(db, id);
  if (!existing) return refuse(404, "There is no such rule.");
  const rule = checked(db, { ...edit, target: edit.target ?? existing.target }, id);
  if ("ok" in rule) return rule;
  db.transaction(() => {
    clearAnswer(db, rule.match, rule.value);
    db.query("UPDATE desk_mail_rules SET match = ?, value = ?, action = ?, target_kind = ?, target_key = ?, target_title = ?, held = NULL, released = 0, updated_at = ? WHERE id = ?")
      .run(rule.match, rule.value, rule.action, ...targetColumns(rule.target), now, id);
  })();
  return { ok: true, message: `Saved: ${ruleSentence(rule)}.`, ...withView(db, id) };
}

/** Turns a rule on or off. Off is "Stop doing this": the rule stays listed in Settings and does nothing. */
export function setRuleOn(db: Database, id: string, on: boolean, now: number): RuleChange {
  const rule = ruleById(db, id);
  if (!rule) return refuse(404, "There is no such rule.");
  db.query("UPDATE desk_mail_rules SET state = ?, held = NULL, released = 0, updated_at = ? WHERE id = ?").run(on ? "on" : "off", now, id);
  if (on) setGrant(db, RULES_GRANT, true, now);
  return { ok: true, message: on ? `${ruleSentence(rule)}: on again.` : `Stopped: ${ruleSentence(rule).toLowerCase()}. It stays in Settings, turned off.`, ...withView(db, id) };
}

export function deleteRule(db: Database, id: string): RuleChange {
  const rule = ruleById(db, id);
  if (!rule) return refuse(404, "There is no such rule.");
  db.query("DELETE FROM desk_mail_rules WHERE id = ?").run(id);
  return { ok: true, message: `Deleted the rule: ${ruleSentence(rule).toLowerCase()}. What it already did stays in Done for you.` };
}

/** "Handle all" on a paused rule: its next pass runs without the cap, once. */
export function releaseRule(db: Database, id: string, now: number): RuleChange {
  const rule = ruleById(db, id);
  if (!rule?.on) return refuse(404, "There is no such rule turned on.");
  if (rule.held === null) return refuse(409, "That rule is not paused.");
  db.query("UPDATE desk_mail_rules SET released = 1, held = NULL, updated_at = ? WHERE id = ?").run(now, id);
  return { ok: true, message: `The Desk will handle the ${rule.held} mails now; each one shows in Done for you.` };
}

export interface RulePassDeps {
  db: Database;
  mailActions: MailActionsConfig | undefined;
  ledger: TrashLedger;
  run: WriterRunner;
  now: () => number;
  config: MailRulesConfig;
  ownDomains?: readonly string[];
  newId?: () => string;
  attach?: RuleAttach;
}

export interface RuleAttachFailure { ok: false; status: number; error: string }

/** How a rule reaches its target at run time. A string from `task` says why the task cannot take mail ("is done"); `thread` files the mail as a capture and links it. */
export interface RuleAttach {
  task(id: string): Promise<LinkTarget | string>;
  thread(mail: ListedMail, slug: string, runId: string): Promise<{ ok: true } | (RuleAttachFailure & { gone: boolean })>;
  undoThread(runId: string): Promise<{ ok: true } | RuleAttachFailure>;
}

export interface RulePass {
  handled: number;
  failed: number;
  paused: string[];
}

const stillOn = (db: Database, id: string): boolean => rulesRun(db) && ruleById(db, id)?.on === true;

function recordRun(db: Database, rule: MailRule, mail: ListedMail, id: string, status: "done" | "failed", now: number): void {
  db.query("INSERT INTO desk_mail_rule_runs (id, rule_id, message_id, account, action, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING")
    .run(id, rule.id, mail.id, mail.account ?? null, rule.action, status, now);
  if (status === "done") db.query("UPDATE desk_mail_rules SET count = count + 1, last_run_at = ? WHERE id = ?").run(now, rule.id);
}

async function handleOne(rule: MailRule, mail: ListedMail, deps: RulePassDeps): Promise<"done" | "failed" | "skipped"> {
  const { db } = deps;
  const now = deps.now();
  const id = (deps.newId ?? (() => crypto.randomUUID()))();

  const features = mailFeatures(db, mail);
  if (rule.action === "attach") return attachByRule(rule, mail, deps, id, now, features);
  if (rule.action === "digest") {
    db.transaction(() => {
      recordOutcome(db, rule, mail, id, "done", { title: `${DONE_BY.digest}: “${mail.subject}”`, message: "It stays in your inbox and off the Desk." }, now);
      logMailDecision(db, features, "digest", "rule", now);
    })();
    return "done";
  }
  if (!deps.mailActions?.move?.length) return "skipped";
  const moveDeps: MoveDeps = { db, config: deps.mailActions, ledger: deps.ledger, run: deps.run, now, newId: () => id };
  const result = await moveMail(mail, rule.action, moveDeps, rule.action, features, { where: "rule", doneAction: "mail.rule", title: DONE_BY[rule.action], recorded: (moveId) => { recordRun(db, rule, mail, moveId, "done", now); } });
  if (result.ok) return "done";
  if (result.status === 409) return "skipped";
  return recordOutcome(db, rule, mail, id, "failed", { title: `Your rule could not handle “${mail.subject}”`, message: result.error }, now);
}

function recordOutcome<S extends "done" | "failed">(db: Database, rule: MailRule, mail: ListedMail, id: string, status: S, line: { title: string; message: string }, now: number): S {
  db.transaction(() => {
    recordRun(db, rule, mail, id, status, now);
    db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_key) DO NOTHING")
      .run(`mail-rule:${id}`, status === "done" ? "mail.rule" : "mail.rule.failed", id, line.title, status, line.message, now, now);
  })();
  return status;
}

const RULE_OFF = "The rule is turned off, and the mail stays on the Desk.";

async function attachByRule(rule: MailRule, mail: ListedMail, deps: RulePassDeps, id: string, now: number, features: MailFeatures): Promise<"done" | "failed" | "skipped"> {
  const { db } = deps;
  const target = rule.target;
  if (!target || !deps.attach) return "skipped";
  const cannot = (why: string): string => `Your rule could not attach “${mail.subject}”: “${target.title}” ${why}`;
  const turnOff = (why: string): "failed" => {
    setRuleOn(db, rule.id, false, now);
    return recordOutcome(db, rule, mail, id, "failed", { title: cannot(why), message: RULE_OFF }, now);
  };
  if (target.kind === "task") {
    const task = await deps.attach.task(target.key);
    if (typeof task === "string") return turnOff(task);
    if (!attachMail(db, mail, task, { id: `rule-${id}`, requestId: `rule-${id}`, origin: "rule", ruleRun: id, now }).ok) return "skipped";
  } else {
    const filed = await deps.attach.thread(mail, target.key, id);
    if (!filed.ok) return filed.gone ? turnOff("is closed") : recordOutcome(db, rule, mail, id, "failed", { title: cannot("could not take it"), message: filed.error }, now);
    logMailDecision(db, features, "attach", "rule", now, target.title);
  }
  return recordOutcome(db, rule, mail, id, "done", { title: `${DONE_BY.attach}: “${mail.subject}” → “${target.title}”`, message: "It stays in your mailbox and off the Desk." }, now);
}

/**
 * One pass of the approved rules over the listed unread mail, only while the mail.rules grant is on. A VIP's mail, a
 * mail the Desk already moved, and a mail any rule handled before (also when that was undone) are left alone. A rule
 * that would handle more than `maxPerPass` mails in one pass pauses and asks instead; "Handle all" releases it for
 * one pass. Each move goes through the move contract and lands in Done for you with Undo.
 */
export async function runMailRules(readings: readonly SourceReading[], deps: RulePassDeps): Promise<RulePass> {
  const { db } = deps;
  const pass: RulePass = { handled: 0, failed: 0, paused: [] };
  if (!rulesRun(db)) return pass;
  const rules = listRules(db).filter((r) => r.on);
  if (rules.length === 0) return pass;
  const suspicion = suspicionContext(db, deps.ownDomains);
  const listed = readings.filter((r) => r.error === null).flatMap((r) => r.mail.filter((m) => m.unread).map((m): ListedMail => ({ ...m, sourceId: r.id })));
  const ran = ranIds(db, listed.map((m) => m.id));
  const flagged = flaggedByClassifier(db, listed.map((m) => m.id));
  const offDesk = offDeskIds(db);
  const byRule = new Map<string, ListedMail[]>();
  for (const m of listed) {
    if (ran.has(m.id) || offDesk.has(m.id) || movedTarget(deps.ledger, m.id) !== undefined) continue;
    const rule = ruleFor(rules, m, suspicion, flagged.has(m.id));
    if (rule) byRule.set(rule.id, [...(byRule.get(rule.id) ?? []), m]);
  }
  for (const rule of rules) {
    const mails = byRule.get(rule.id) ?? [];
    if (!rule.released && (rule.held !== null || mails.length > deps.config.maxPerPass)) {
      db.query("UPDATE desk_mail_rules SET held = ? WHERE id = ?").run(mails.length > 0 ? mails.length : null, rule.id);
      if (mails.length > 0) pass.paused.push(rule.id);
      continue;
    }
    for (const m of mails) {
      if (!stillOn(db, rule.id)) break;
      const outcome = await handleOne(rule, m, deps);
      if (outcome === "done") pass.handled += 1;
      if (outcome === "failed") pass.failed += 1;
    }
    if (rule.released) db.query("UPDATE desk_mail_rules SET released = 0, held = NULL WHERE id = ?").run(rule.id);
  }
  return pass;
}

/**
 * Undo of one rule run: a move goes back to INBOX through the move contract; a mail kept for the digest or attached shows on the
 * Desk again. The Undo is logged as the principal's `restore`, a counter-example for future proposals.
 */
export async function undoRuleRun(id: string, deps: MoveDeps, attach?: RuleAttach): Promise<MoveResult> {
  const run = runFor(deps.db, id);
  if (!run) return refuse(404, "The Desk has no record of that rule run.");
  if (run.undone_at !== null) return refuse(409, "That is already undone.");
  if (run.status !== "done") return refuse(409, "That rule run did not move anything.");
  const link = run.action === "attach" ? linkByRun(deps.db, id) : null;
  if (link?.toKind === "thread") {
    if (!attach) return refuse(409, "The Studio is not set up on this stack.");
    const removed = await attach.undoThread(id);
    if (!removed.ok) return removed;
  }
  if (run.action !== "digest" && run.action !== "attach") {
    const result = await undoMove(id, deps);
    if (result.ok) deps.db.query("UPDATE desk_mail_rule_runs SET undone_at = ? WHERE id = ?").run(deps.now, id);
    return result;
  }
  deps.db.transaction(() => {
    if (link) endLink(deps.db, link.id, "undone", null, deps.now);
    deps.db.query("UPDATE desk_mail_rule_runs SET undone_at = ? WHERE id = ?").run(deps.now, id);
    deps.db.query("UPDATE desk_done SET action = 'mail.rule.undone', message = ?, updated_at = ? WHERE attempt_key = ?").run("Back on the Desk.", deps.now, `mail-rule:${id}`);
    const features = loggedFeatures(deps.db, run.message_id);
    if (features) logMailDecision(deps.db, features, "restore", "desk", deps.now);
  })();
  return { ok: true, message: "The mail is back on the Desk.", restored: `mail:${run.message_id}` };
}

/** Runs rule passes one after another: after each new source reading, and when a rule is approved or released. */
export class MailRuleLoop {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RulePassDeps, private readonly readings: () => readonly SourceReading[], private readonly log: (line: string) => void = console.error) {}

  kick(): Promise<unknown> {
    this.chain = this.chain.then(() => runMailRules(this.readings(), this.deps)).catch((err: unknown) => {
      this.log(`[desk] mail rule pass failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.chain;
  }
}
