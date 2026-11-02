import type { Database } from "bun:sqlite";
import type { z } from "zod/v4";
import { DeskMailMirrorSchema } from "../../../common/types/config";
import { PRINCIPAL_ACTED_WHERE, queryMailLog, type MailLogAction, type MailLogEntry, type MailLogWhere } from "./mail-log";
import { listRules, matchesRule, ruleSentence, type MailRule, type RuleMatch } from "./mail-rules";
import { listKey, type UnsubscribeView } from "./mail-unsubscribe";
import { isVip, listVips } from "./vips";

export type MailMirrorConfig = z.infer<typeof DeskMailMirrorSchema>;

export const DEFAULT_MAIL_MIRROR: MailMirrorConfig = DeskMailMirrorSchema.parse({});

export const MAIL_MIRROR_LOG_LIMIT = 5000;

export interface MailMirrorCount<K extends string> {
  key: K;
  count: number;
}

export interface MailMirrorSender {
  kind: "list" | "sender";
  value: string;
  decisions: number;
}

export interface MailMirrorRule {
  id: string;
  sentence: string;
  match: RuleMatch;
  value: string;
  action: MailRule["action"];
  on: boolean;
  runs: number;
  failed: number;
  undone: number;
  check: boolean;
}

export interface MailMirrorUnsubscribe {
  key: string;
  view: UnsubscribeView;
}

export interface MailMirrorUnread {
  kind: "list" | "sender";
  value: string;
  count: number;
  rule: { match: "list" | "sender"; value: string; action: "archive"; sentence: string };
  unsubscribe?: MailMirrorUnsubscribe;
}

export interface MailMirrorTime {
  mails: number;
  totalMs: number;
  medianMs: number;
  capped: number;
  untimed: number;
  capMs: number;
}

export interface MailMirror {
  decisions: number;
  mails: number;
  partial: boolean;
  byAction: MailMirrorCount<MailLogAction>[];
  byWhere: MailMirrorCount<MailLogWhere>[];
  senders: MailMirrorSender[];
  rules: MailMirrorRule[];
  checkRules: MailMirrorRule[];
  archivedUnread: MailMirrorUnread[];
  time: MailMirrorTime | null;
  config: MailMirrorConfig;
}

export interface MailMirrorRun {
  ruleId: string;
  status: "done" | "failed";
  at: number;
  undoneAt: number | null;
}

export interface MailMirrorInput {
  start: number;
  end: number;
  entries: readonly MailLogEntry[];
  runs: readonly MailMirrorRun[];
  rules: readonly MailRule[];
  vips: ReadonlySet<string>;
  offers?: ReadonlyMap<string, MailMirrorUnsubscribe>;
  partial?: boolean;
  config?: MailMirrorConfig;
}

const DISMISSED = new Set<MailLogAction>(["archive", "trash", "unimportant"]);
const PRINCIPAL = new Set<MailLogWhere>([...PRINCIPAL_ACTED_WHERE, "correction"]);

const counted = <K extends string>(keys: readonly K[]): MailMirrorCount<K>[] => {
  const counts = new Map<K, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};

const listOf = (e: Pick<MailLogEntry, "listId">): string | null => {
  const id = e.listId?.trim().toLowerCase();
  return id === undefined || id === "" ? null : id;
};

const senderOf = (e: Pick<MailLogEntry, "listId" | "sender">): { kind: "list" | "sender"; value: string } => {
  const list = listOf(e);
  return list ? { kind: "list", value: list } : { kind: "sender", value: e.sender.trim().toLowerCase() };
};

const asMail = (e: Pick<MailLogEntry, "listId" | "sender" | "subject">) => {
  const listId = listOf(e);
  return { from: { name: "", address: e.sender }, subject: e.subject ?? "", ...(listId ? { headers: { listId } } : {}) };
};

/** The I5 list key of a logged mail: `list:<List-Id>` when it has one, otherwise `sender:<address>`. */
export const mirrorListKey = (e: Pick<MailLogEntry, "listId" | "sender">): string => listKey(asMail({ ...e, subject: null }));

const inWeek = (at: number | null, start: number, end: number): boolean => at !== null && at >= start && at < end;

function topSenders(entries: readonly MailLogEntry[], top: number): MailMirrorSender[] {
  const groups = new Map<string, MailMirrorSender>();
  for (const e of entries) {
    if (!PRINCIPAL.has(e.where)) continue;
    const s = senderOf(e);
    const key = `${s.kind}:${s.value}`;
    const g = groups.get(key) ?? { ...s, decisions: 0 };
    g.decisions += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.decisions - a.decisions || a.value.localeCompare(b.value)).slice(0, top);
}

function ruleCounts(input: MailMirrorInput, config: MailMirrorConfig): MailMirrorRule[] {
  return input.rules.map((r): MailMirrorRule => {
    const mine = input.runs.filter((x) => x.ruleId === r.id);
    const undone = mine.filter((x) => inWeek(x.undoneAt, input.start, input.end)).length;
    return {
      id: r.id, sentence: ruleSentence(r), match: r.match, value: r.value, action: r.action, on: r.on,
      runs: mine.filter((x) => x.status === "done" && inWeek(x.at, input.start, input.end)).length,
      failed: mine.filter((x) => x.status === "failed" && inWeek(x.at, input.start, input.end)).length,
      undone,
      check: undone > config.checkAfterUndos,
    };
  }).sort((a, b) => b.undone - a.undone || b.runs - a.runs || a.sentence.localeCompare(b.sentence));
}

function newestPerMail(entries: readonly MailLogEntry[]): MailLogEntry[] {
  const newest = new Map<string, MailLogEntry>();
  for (const e of entries) {
    if (!PRINCIPAL_ACTED_WHERE.has(e.where)) continue;
    const known = newest.get(e.messageId);
    if (!known || e.at > known.at || (e.at === known.at && e.id > known.id)) newest.set(e.messageId, e);
  }
  return [...newest.values()];
}

function archivedUnread(input: MailMirrorInput, config: MailMirrorConfig): MailMirrorUnread[] {
  const on = input.rules.filter((r) => r.on);
  const groups = new Map<string, { latest: MailLogEntry; count: number }>();
  for (const e of newestPerMail(input.entries)) {
    if (!DISMISSED.has(e.action) || isVip(input.vips, e.sender)) continue;
    const key = mirrorListKey(e);
    const g = groups.get(key) ?? { latest: e, count: 0 };
    g.count += 1;
    if (e.at > g.latest.at) g.latest = e;
    groups.set(key, g);
  }
  const out: MailMirrorUnread[] = [];
  for (const [key, g] of groups) {
    if (g.count < config.archivedUnread || on.some((r) => matchesRule(r, asMail(g.latest)))) continue;
    const s = senderOf(g.latest);
    const rule = { match: s.kind, value: s.value, action: "archive" as const };
    const offer = input.offers?.get(key);
    out.push({ ...s, count: g.count, rule: { ...rule, sentence: ruleSentence(rule) }, ...(offer ? { unsubscribe: offer } : {}) });
  }
  return out.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const at = (i: number): number => sorted[i] ?? 0;
  return sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
}

const ON_THE_DESK = new Set<MailLogWhere>(["desk", "conversation"]);

function openToDecision(entries: readonly MailLogEntry[], capMs: number): MailMirrorTime | null {
  const byMail = new Map<string, MailLogEntry[]>();
  for (const e of entries) byMail.set(e.messageId, [...(byMail.get(e.messageId) ?? []), e]);
  const spans: number[] = [];
  let opens = 0;
  for (const rows of byMail.values()) {
    const ordered = [...rows].sort((a, b) => a.at - b.at || a.id - b.id);
    const opened = ordered.find((e) => e.action === "opened" && e.where === "desk");
    if (!opened) continue;
    opens += 1;
    const acted = ordered.find((e) => e.at >= opened.at && e.id !== opened.id && e.action !== "opened" && ON_THE_DESK.has(e.where));
    if (acted) spans.push(acted.at - opened.at);
  }
  if (opens === 0) return null;
  const counted = spans.map((s) => Math.min(s, capMs));
  return {
    mails: spans.length,
    totalMs: counted.reduce((sum, s) => sum + s, 0),
    medianMs: counted.length > 0 ? median(counted) : 0,
    capped: spans.filter((s) => s > capMs).length,
    untimed: opens - spans.length,
    capMs,
  };
}

/** The weekly mirror's mail section, from the decision log and rule runs of one week. Pure. */
export function mailMirror(input: MailMirrorInput): MailMirror {
  const config = input.config ?? DEFAULT_MAIL_MIRROR;
  const entries = input.entries.filter((e) => e.at >= input.start && e.at < input.end);
  const decided = entries.filter((e) => e.action !== "opened");
  const rules = ruleCounts(input, config);
  return {
    decisions: decided.length,
    mails: new Set(decided.map((e) => e.messageId)).size,
    partial: input.partial === true,
    byAction: counted(decided.map((e) => e.action)),
    byWhere: counted(decided.map((e) => e.where)),
    senders: topSenders(decided, config.top),
    rules,
    checkRules: rules.filter((r) => r.check),
    archivedUnread: archivedUnread({ ...input, entries: decided }, config),
    time: openToDecision(entries, config.openCapMinutes * 60_000),
    config,
  };
}

interface RunRow {
  rule_id: string;
  status: "done" | "failed";
  created_at: number;
  undone_at: number | null;
}

/** Rule runs that started or were undone within [start, end). */
export function mirrorRuleRuns(db: Database, start: number, end: number): MailMirrorRun[] {
  return db
    .query<RunRow, [number, number, number, number]>("SELECT rule_id, status, created_at, undone_at FROM desk_mail_rule_runs WHERE (created_at >= ? AND created_at < ?) OR (undone_at >= ? AND undone_at < ?)")
    .all(start, end, start, end)
    .map((r) => ({ ruleId: r.rule_id, status: r.status, at: r.created_at, undoneAt: r.undone_at }));
}

/** Reads one week's log, rule runs, rules and VIPs and builds the mail section. */
export function readMailMirror(db: Database, week: { start: number; end: number }, options: { config?: MailMirrorConfig; offers?: ReadonlyMap<string, MailMirrorUnsubscribe> } = {}): MailMirror {
  const entries = queryMailLog(db, { since: week.start, limit: MAIL_MIRROR_LOG_LIMIT });
  return mailMirror({
    start: week.start, end: week.end, entries,
    runs: mirrorRuleRuns(db, week.start, week.end),
    rules: listRules(db),
    vips: new Set(listVips(db).map((v) => v.address)),
    partial: entries.length >= MAIL_MIRROR_LOG_LIMIT,
    ...(options.config ? { config: options.config } : {}),
    ...(options.offers ? { offers: options.offers } : {}),
  });
}
