import type { Database } from "bun:sqlite";
import { readClassifications, type MailClassification } from "./classify";
import type { ListedMail } from "./mail-actions";
import { mailFeatures } from "./mail-log";
import { movedTarget, moveMail, refuse, undoMove, type MoveDeps, type MoveTarget } from "./mail-move";
import { digestedIds, pendingRuleMail } from "./mail-rules";
import { DEFAULT_SIMILARITY, embedderFor, groupBySimilarity, mailText, precedentLine, readVectors, textHash, vectorModel, type EmbedderConfig } from "./mail-similar";
import { suspicionContext, suspicionOf, type SuspicionContext } from "./mail-suspicion";
import type { SourceReading } from "./sources/command";
import { SWEEP_WORDS } from "./mail-sweep-schema";
import { DAY_MS } from "./time";
import { isVip } from "./vips";

export const SWEEP_KINDS = ["bundle", "sweep"] as const;
export type SweepKind = (typeof SWEEP_KINDS)[number];
export type SweepBasis = "similar" | "list" | "sender" | "age";

export const SWEEP_LIMITS = { minBundle: 2, minSweep: 3, ageDays: 3, maxBundles: 5, maxSweeps: 3, maxMails: 200 } as const;


export type SweepMember = ListedMail & { area: string | null };

export interface SweepMailView {
  key: string;
  subject: string;
  from: string;
  at: string;
}

export interface MailSweepView {
  id: string;
  kind: SweepKind;
  basis: SweepBasis;
  target: MoveTarget;
  label: string;
  title: string;
  why: string;
  area: string | null;
  mails: SweepMailView[];
}

export interface SweepGroup extends Omit<MailSweepView, "mails"> {
  members: SweepMember[];
}

export interface SweepInput {
  now: number;
  mail: readonly SweepMember[];
  classified: ReadonlyMap<string, MailClassification>;
  suspicion: SuspicionContext;
  vectors?: ReadonlyMap<string, ArrayLike<number>>;
  threshold?: number;
  exclude?: ReadonlySet<string>;
}

const KEEPERS = new Set<string>(["reply", "plan", "todo", "keep"]);
const PERSONAL = new Set<string>(["action", "reply", "meeting"]);
const SAFE = "None is from a VIP or looks suspicious.";

const hash = (text: string): string => textHash(text).slice(0, 16);
const senderOf = (m: SweepMember): string => m.from.name ?? m.from.address;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const commonArea = (members: readonly SweepMember[]): string | null => {
  const first = members[0]?.area ?? null;
  return members.every((m) => m.area === first) ? first : null;
};
const quoted = (s: string): string => `“${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`;
const byAge = (a: SweepMember, b: SweepMember): number => Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.id.localeCompare(b.id);
const groupKey = (m: SweepMember): { basis: "list" | "sender"; key: string } =>
  m.headers?.listId ? { basis: "list", key: m.headers.listId.toLowerCase() } : { basis: "sender", key: m.from.address.trim().toLowerCase() };

function eligible(input: SweepInput): SweepMember[] {
  const vips = input.suspicion.vips;
  return input.mail
    .filter((m) => m.unread && !input.exclude?.has(m.id) && !isVip(vips, m.from.address) && input.classified.get(m.id)?.suspicious !== true && suspicionOf(m, input.suspicion).length === 0)
    .sort(byAge);
}

function bundleTitle(basis: SweepBasis, members: readonly SweepMember[], target: MoveTarget): { label: string; title: string } {
  const head = members[0];
  const n = members.length;
  const verb = `${SWEEP_WORDS[target].verb} all?`;
  if (!head) return { label: "", title: "" };
  if (basis === "list") return { label: "same mailing list", title: `${n} mails from the ${senderOf(head)} list: ${verb}` };
  if (basis === "sender") return { label: "same sender", title: `${n} mails from ${senderOf(head)}: ${verb}` };
  return { label: "similar content", title: `${n} mails like ${quoted(head.subject)}: ${verb}` };
}

function learnedWhy(members: readonly SweepMember[], target: MoveTarget, classified: SweepInput["classified"]): string {
  for (const m of members) {
    const c = classified.get(m.id);
    const line = c?.precedents ? precedentLine(target, c.precedents) : null;
    if (line) return line;
  }
  return `The Desk suggests to ${SWEEP_WORDS[target].verb} each of them.`;
}

interface Keyed {
  key: string;
  basis: SweepBasis;
  members: SweepMember[];
}

function byListOrSender(mails: readonly SweepMember[]): Keyed[] {
  const out = new Map<string, Keyed>();
  for (const m of mails) {
    const { basis, key } = groupKey(m);
    const g = out.get(`${basis}:${key}`) ?? { key: `${basis}:${key}`, basis, members: [] };
    g.members.push(m);
    out.set(g.key, g);
  }
  return [...out.values()];
}

const makeGroup = (g: Omit<SweepGroup, "area" | "members">, members: readonly SweepMember[]): SweepGroup =>
  ({ ...g, area: commonArea(members), members: members.slice(0, SWEEP_LIMITS.maxMails) });

const largestFirst = (groups: SweepGroup[], max: number): SweepGroup[] => groups.sort((a, b) => b.members.length - a.members.length).slice(0, max);

function bundles(pool: readonly SweepMember[], input: SweepInput): SweepGroup[] {
  const out: SweepGroup[] = [];
  const threshold = input.threshold ?? DEFAULT_SIMILARITY.threshold;
  for (const target of ["archive", "junk", "trash"] as const) {
    const candidates = pool.filter((m) => input.classified.get(m.id)?.predictedAction === target);
    const withVector = candidates.flatMap((m) => {
      const vector = input.vectors?.get(m.id);
      return vector ? [{ item: m, vector }] : [];
    });
    const similar = groupBySimilarity(withVector, threshold).map((members): Keyed => ({ key: "", basis: "similar", members }));
    for (const { basis, members } of [...similar, ...byListOrSender(candidates.filter((c) => !input.vectors?.has(c.id)))]) {
      const head = members[0];
      if (!head || members.length < SWEEP_LIMITS.minBundle) continue;
      out.push(makeGroup({ id: `bundle:${target}:${hash(head.id)}`, kind: "bundle", basis, target, ...bundleTitle(basis, members, target), why: learnedWhy(members, target, input.classified) }, members));
    }
  }
  return largestFirst(out, SWEEP_LIMITS.maxBundles);
}

function sweeps(pool: readonly SweepMember[], input: SweepInput, bundled: readonly SweepGroup[]): SweepGroup[] {
  const quiet = pool.filter((m) => !KEEPERS.has(input.classified.get(m.id)?.predictedAction ?? ""));
  const out: SweepGroup[] = [];
  const old = input.now - SWEEP_LIMITS.ageDays * DAY_MS;
  for (const category of ["fyi", "bulk"] as const) {
    const members = quiet.filter((m) => input.classified.get(m.id)?.category === category && Date.parse(m.receivedAt) < old);
    if (members.length < SWEEP_LIMITS.minSweep) continue;
    out.push(makeGroup({ id: `sweep:age:${category}`, kind: "sweep", basis: "age", target: "archive", label: category, title: `${members.length} ${category} mails older than ${SWEEP_LIMITS.ageDays} days are still unread`, why: SAFE }, members));
  }
  const same = (a: readonly SweepMember[], b: readonly SweepMember[]): boolean => a.length === b.length && a.every((m) => b.some((x) => x.id === m.id));
  for (const { key, basis, members } of byListOrSender(quiet.filter((x) => !PERSONAL.has(input.classified.get(x.id)?.category ?? "")))) {
    const head = members[0];
    if (!head || members.length < SWEEP_LIMITS.minSweep || bundled.some((g) => same(g.members, members))) continue;
    const from = basis === "list" ? `the ${senderOf(head)} list` : senderOf(head);
    out.push(makeGroup({ id: `sweep:${hash(key)}`, kind: "sweep", basis, target: "archive", label: basis === "list" ? "mailing list" : "sender", title: `${members.length} unread mails from ${from}`, why: SAFE }, members));
  }
  return largestFirst(out, SWEEP_LIMITS.maxSweeps);
}

export function buildSweeps(input: SweepInput): SweepGroup[] {
  const pool = eligible(input);
  const found = bundles(pool, input);
  return [...found, ...sweeps(pool, input, found)];
}

export const sweepView = (g: SweepGroup): MailSweepView => {
  const { members, ...rest } = g;
  return { ...rest, mails: members.map((m) => ({ key: `mail:${m.id}`, subject: m.subject, from: senderOf(m), at: m.receivedAt })) };
};

export const bundledKeys = (groups: readonly SweepGroup[]): Set<string> =>
  new Set(groups.filter((g) => g.kind === "bundle").flatMap((g) => g.members.map((m) => `mail:${m.id}`)));

export interface SweepContext {
  embedder?: EmbedderConfig;
  ownDomains?: string[];
  localSources: ReadonlySet<string>;
  handled?: { has(key: string): boolean };
}

export interface SweepOptions {
  mailEmbedder?: EmbedderConfig;
  mailOwnDomains?: string[];
  areas: readonly { id: string; policy?: string }[];
}

export function sweepContext(desk: SweepOptions, readings: readonly SourceReading[], handled?: SweepContext["handled"]): SweepContext {
  const local = new Set(desk.areas.filter((a) => a.policy === "local").map((a) => a.id));
  return {
    ...(desk.mailEmbedder ? { embedder: desk.mailEmbedder } : {}),
    ...(desk.mailOwnDomains ? { ownDomains: desk.mailOwnDomains } : {}),
    localSources: new Set(readings.filter((r) => r.area !== null && local.has(r.area)).map((r) => r.id)),
    ...(handled ? { handled } : {}),
  };
}

function vectorsOf(db: Database, mail: readonly SweepMember[], config: EmbedderConfig | undefined, localSources: ReadonlySet<string>, now: number): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!config) return out;
  const byModel = new Map<string, { id: string; hash: string }[]>();
  for (const m of mail) {
    const access = embedderFor(config, localSources.has(m.sourceId));
    if (!access) continue;
    const model = vectorModel(access);
    byModel.set(model, [...(byModel.get(model) ?? []), { id: m.id, hash: textHash(mailText({ subject: m.subject, summary: m.firstParagraph ?? null })) }]);
  }
  for (const [model, list] of byModel) {
    const known = readVectors(db, model, list.map((x) => x.hash), now);
    for (const { id, hash: h } of list) {
      const v = known.get(h);
      if (v) out.set(id, v);
    }
  }
  return out;
}

/**
 * The sweeps and bundles the Desk offers for the sources' last reading. Bundles group mail the classifier would move
 * the same way, by cached content vectors when present and by List-Id or sender otherwise; sweeps group by category
 * and age, or by List-Id or sender. VIP, suspicious, rule-bound, digested and already moved mail is never included.
 */
export function listSweeps(db: Database, readings: readonly SourceReading[], ctx: SweepContext, now: number): SweepGroup[] {
  const ids = readings.flatMap((r) => r.mail.map((m) => m.id));
  const digested = digestedIds(db, ids);
  const mail = readings.flatMap((r) => r.mail.filter((m) => m.unread && !digested.has(m.id) && (!ctx.handled || movedTarget(ctx.handled, m.id) === undefined)).map((m) => ({ ...m, area: r.area, sourceId: r.id })));
  const suspicion = suspicionContext(db, ctx.ownDomains);
  return buildSweeps({
    now,
    mail,
    classified: readClassifications(db, mail.map((m) => m.id)),
    suspicion,
    vectors: vectorsOf(db, mail, ctx.embedder, ctx.localSources, now),
    threshold: ctx.embedder?.threshold ?? DEFAULT_SIMILARITY.threshold,
    exclude: pendingRuleMail(db, mail, suspicion),
  });
}

export interface SweepFailure {
  subject: string;
  error: string;
}

export interface SweepOutcome {
  ok: true;
  message: string;
  sweep: string;
  moved: number;
  failed: SweepFailure[];
  skipped: number;
}

interface Refusal {
  ok: false;
  status: number;
  error: string;
}


const failureList = (failed: readonly SweepFailure[]): string =>
  failed.map((f) => `${quoted(f.subject)} (${f.error.replace(/\.$/, "")})`).join("; ");

/**
 * Moves exactly the previewed mails of one sweep through the move contract: one move, one log row each, and one Done for
 * you line with Undo for the whole sweep. Keys that are no longer in the group are not moved and are listed.
 */
export async function runSweep(group: SweepGroup, keys: readonly string[], deps: MoveDeps): Promise<SweepOutcome | Refusal> {
  const wanted = new Set(keys);
  const members = group.members.filter((m) => wanted.has(`mail:${m.id}`));
  const gone = keys.filter((k) => !members.some((m) => `mail:${m.id}` === k));
  if (members.length === 0) return refuse(409, "None of these mails is in this group any more. Look at it again.");
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const title = `${SWEEP_WORDS[group.target].done} ${plural(members.length, "mail")}: ${group.title.replace(/: [^:]*\?$/, "")}`;
  deps.db.transaction(() => {
    deps.db.query("INSERT INTO desk_mail_sweeps (id, group_id, target, title, created_at) VALUES (?, ?, ?, ?, ?)").run(id, group.id, group.target, title, deps.now);
    for (const m of members) deps.db.query("INSERT INTO desk_mail_sweep_mails (sweep_id, message_id, subject, status) VALUES (?, ?, ?, 'moving')").run(id, m.id, m.subject);
    deps.db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, 'mail.sweep', ?, ?, 'done', ?, ?, ?)")
      .run(`mail-sweep:${id}`, id, title, `Moving ${plural(members.length, "mail")}…`, deps.now, deps.now);
  })();
  running.add(id);
  try {
    return await moveAll(id, group, members, gone.length, title, deps);
  } finally {
    running.delete(id);
  }
}

const running = new Set<string>();

async function moveAll(id: string, group: SweepGroup, members: readonly SweepMember[], gone: number, title: string, deps: MoveDeps): Promise<SweepOutcome> {
  const failed: SweepFailure[] = [];
  let moved = 0;
  const failMail = (m: SweepMember, error: string): void => {
    failed.push({ subject: m.subject, error });
    deps.db.query("UPDATE desk_mail_sweep_mails SET status = 'failed', error = ? WHERE sweep_id = ? AND message_id = ?").run(error, id, m.id);
  };
  for (const m of members) {
    const by = { where: "desk" as const, doneAction: "mail.move", title, quiet: true, recorded: (moveId: string) => { deps.db.query("UPDATE desk_mail_sweep_mails SET move_id = ?, status = 'done' WHERE sweep_id = ? AND message_id = ?").run(moveId, id, m.id); } };
    try {
      const result = await moveMail(m, group.target, deps, group.target, mailFeatures(deps.db, m), by);
      if (result.ok) moved++;
      else failMail(m, result.error);
    } catch (err) {
      failMail(m, err instanceof Error ? err.message : String(err));
    }
  }
  const skipped = gone > 0 ? ` ${plural(gone, "mail was", "mails were")} no longer in this group and stayed.` : "";
  const message = failed.length === 0 ? `${SWEEP_WORDS[group.target].done} ${plural(moved, "mail")}.${skipped}` : `${SWEEP_WORDS[group.target].done} ${moved} of ${members.length}. Not moved: ${failureList(failed)}.${skipped}`;
  deps.db.query("UPDATE desk_done SET action = ?, status = ?, message = ?, updated_at = ? WHERE attempt_key = ?")
    .run(moved > 0 ? "mail.sweep" : "mail.sweep.failed", moved > 0 ? "done" : "failed", message, deps.now, `mail-sweep:${id}`);
  return { ok: true, message, sweep: id, moved, failed, skipped: gone };
}

interface SweptRow {
  message_id: string;
  subject: string;
  move_id: string;
  undone_at: number | null;
}

/** Undo of a whole sweep: every mail it moved goes back to INBOX. A mail that fails stays listed, and Undo stays offered. */
export async function undoSweep(id: string, deps: MoveDeps): Promise<{ ok: true; message: string } | Refusal> {
  const sweep = deps.db.query<{ undone_at: number | null }, [string]>("SELECT undone_at FROM desk_mail_sweeps WHERE id = ?").get(id);
  if (!sweep) return refuse(404, "The Desk has no record of that sweep.");
  if (sweep.undone_at !== null) return refuse(409, "That sweep is already undone.");
  if (running.has(id)) return refuse(409, "This sweep is still moving mail. Undo it when Done for you shows the result.");
  deps.db.query("UPDATE desk_mail_sweep_mails SET status = 'failed', error = 'interrupted' WHERE sweep_id = ? AND status = 'moving'").run(id);
  const rows = deps.db.query<SweptRow, [string]>("SELECT s.message_id, s.subject, s.move_id, m.undone_at FROM desk_mail_sweep_mails s JOIN desk_mail_moves m ON m.id = s.move_id WHERE s.sweep_id = ? AND s.status IN ('done', 'undone')").all(id);
  const failed: SweepFailure[] = [];
  let back = 0;
  for (const r of rows) {
    const result = r.undone_at === null ? await undoMove(r.move_id, deps) : { ok: true as const };
    if (result.ok) {
      back++;
      deps.db.query("UPDATE desk_mail_sweep_mails SET status = 'undone' WHERE sweep_id = ? AND message_id = ?").run(id, r.message_id);
    } else failed.push({ subject: r.subject, error: result.error });
  }
  if (failed.length > 0) {
    const message = `Moved ${back} of ${rows.length} back to INBOX. Still moved: ${failureList(failed)}. Undo again to retry.`;
    deps.db.query("UPDATE desk_done SET message = ?, updated_at = ? WHERE attempt_key = ?").run(message, deps.now, `mail-sweep:${id}`);
    return back > 0 ? { ok: true, message } : refuse(502, message);
  }
  const message = `Moved ${plural(back, "mail")} back to INBOX.`;
  deps.db.transaction(() => {
    deps.db.query("UPDATE desk_mail_sweeps SET undone_at = ? WHERE id = ?").run(deps.now, id);
    deps.db.query("UPDATE desk_done SET action = 'mail.sweep.undone', message = ?, updated_at = ? WHERE attempt_key = ? AND action = 'mail.sweep'").run(message, deps.now, `mail-sweep:${id}`);
  })();
  return { ok: true, message };
}
