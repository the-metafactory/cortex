import { canonicalTaskRef, QUESTION_UNAVAILABLE, TASK_UNAVAILABLE, type WaitingTask } from "./sources/waiting";
import { DEFAULT_YES_FILTER } from "./studio/view";
import type { VigilSubjectView } from "../../../vigil/subjects-view";
import type { SourceEvent, SourceMail } from "./sources/command";
import type { RangerMap, RangerMapNode, RangerNeedsYou, RangerState } from "./sources/ranger";
import { rangerItemKey, rangerTitles } from "./sources/ranger";
import { approvable, retryable } from "./actions";
import { agentQuestion, RULING_ACTION, type RulingExplanation } from "./ruling";
import { clock, DAY_MS, startOfDay } from "./time";
import { isUnimportant, isVip } from "./vips";
import { eventKey, UNIMPORTANT_REASON, upcomingMeetings, type ClassifierEvent, type MailCategory, type MailClassification } from "./classify";
import type { AreaPolicy, DeskAction, DeskArea, DeskFoldedGroup, DeskItem, DeskItemKind } from "./types";
import { evidenceView, replySubject, suggestionLine, type EvidenceLinks } from "./mail-triage";
import { ACTION_LABEL, precedentLine } from "./mail-similar";

export interface AreaRule extends DeskArea {
  repos: string[];
  goals: string[];
  policy?: AreaPolicy;
}

export interface RankInput {
  waitingTasks?: ReadonlyMap<string, WaitingTask>;
  now: number;
  subjects: VigilSubjectView[];
  ranger: RangerState | null;
  areas: AreaRule[];
  rangerActions?: boolean;
  rulingActions?: boolean;
  hidden?: ReadonlySet<string>;
  goalActions?: GoalActionsInput;
  explanations?: ReadonlyMap<string, RulingExplanation>;
}

export interface GoalActionsInput {
  check: ReadonlySet<string>;
  checking: ReadonlySet<string>;
  pause: boolean;
  pausable: (goal: string) => boolean;
}

const action = (id: string, label: string, role: DeskAction["role"], wired: boolean): DeskAction => ({ id, label, role, wired });
const LOOK = action("detail", "Look first", "secondary", true);
const LATER = action("snooze", "Not now", "secondary", true);

export const FOLDED_LABELS: Record<DeskItemKind, string> = {
  sensor: "Goal checks that stopped working",
  goal: "Goals that need a look",
  "agent-blocked": "Agent tasks waiting for your ruling",
  "agent-failed": "Agent tasks parked after a failure",
  decision: "Decisions agents are waiting for",
  grilling: "Questions agents want to grill you on",
  escalation: "Older escalations",
  mail: "Mail you may want to read",
  reminder: "Reminders",
  meeting: "Meetings starting soon",
  "mail-rule": "Mail rules the Desk proposes",
  dmarc: "DMARC failures for your domains",
};

export const isRegressedGoalCheck = (s: VigilSubjectView): boolean => s.vocab === "check" && s.goalId !== null && s.value === "regressed";

export function areaFor(areas: AreaRule[], repo: string | null, goalId: string | null): string | null {
  for (const a of areas) {
    if (goalId && a.goals.includes(goalId)) return a.id;
    if (repo && a.repos.some((r) => repo === r || repo.startsWith(r.endsWith("/") ? r : `${r}/`))) return a.id;
  }
  return null;
}

export function goalShort(wording: string | null): string {
  if (!wording) return "A goal without a description";
  const head = (wording.split(/[:.;]/)[0] ?? wording).trim();
  const clause = (head.split(/,| (?:on|by|so|for|from|to the) /)[0] ?? head).trim();
  const short = clause.length >= 20 ? clause : head;
  if (short.length <= 48) return short;
  const cut = short.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ")).trimEnd()}…`;
}

export function ago(now: number, at: number): string {
  const diff = now - at;
  if (diff < 0) return "soon";
  const today = startOfDay(now);
  if (at >= today) return `today at ${clock(at)}`;
  if (at >= today - DAY_MS) return `yesterday at ${clock(at)}`;
  return `${Math.round(diff / DAY_MS)} days ago`;
}

export function asOf(now: number, at: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return `as of ${clock(at)} today`;
  if (days === 1) return `as of ${clock(at)} yesterday`;
  if (days < 7) return `as of ${new Date(at).toLocaleDateString("en-GB", { weekday: "long" })} at ${clock(at)}`;
  return `as of ${days} days ago`;
}

export const repoName = (repo: string): string => repo.split("/").pop() ?? repo;

type Add = (item: DeskItem) => void;
type Titles = Map<string, { title: string; url?: string }>;

export const parsedOr = (iso: string | undefined, fallback: number): number => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : fallback;
};

const issueLinks = (url: string | undefined) => (url ? [{ label: "Issue", url }] : []);

export function rankItems(input: RankInput): DeskItem[] {
  const items = new Map<string, DeskItem>();
  const titles: Titles = input.ranger ? new Map([...rangerTitles(input.ranger)].map(([ref, value]) => [canonicalTaskRef(ref), value])) : new Map<string, { title: string; url?: string }>();
  const listedTasks = new Set<string>();
  const add: Add = (item) => {
    const ref = canonicalTaskRef(item.detail.refs[0] ?? "");
    const task = item.source === "ranger" ? input.waitingTasks?.get(ref) : undefined;
    if (task?.kind === "closed") return;
    if (item.source === "ranger" && listedTasks.has(rangerItemKey(ref))) return;
    if (item.source === "ranger") listedTasks.add(rangerItemKey(ref));
    const enriched = task?.kind === "unavailable"
      ? { ...item, why: `${item.why} ${task.reason}` }
      : task?.kind === "open" ? {
        ...item,
        title: `"${task.title}" needs you.`,
        why: `${task.question ?? item.question?.condition ?? item.question?.reason ?? QUESTION_UNAVAILABLE} In ${repoName(ref.split("#")[0] ?? ref)}.`,
        detail: { ...item.detail, links: issueLinks(task.url) },
      } : item;
    if (!items.has(item.key)) items.set(item.key, enriched);
  };
  rangerNeedsYouItems(input, add);
  rangerMapItems(input, add);
  vigilItems(input, titles, (key) => listedTasks.has(key) || items.has(key) || (input.hidden?.has(key) ?? false), add);
  return [...items.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

function rulingAction(n: RangerNeedsYou, url: string | undefined, rulingActions: boolean): DeskAction {
  if (rulingActions && retryable(n)) return action(RULING_ACTION, "Give your ruling", "primary", true);
  return { ...action("open", "Give your ruling", "primary", url !== undefined), ...(url ? { url } : {}) };
}

function rangerNeedsYouItems({ now, ranger, areas, rangerActions = false, rulingActions = false, explanations }: RankInput, add: Add): void {
  for (const n of ranger?.needsYou ?? []) {
    const ref = `${n.repo}#${n.nodeId}`;
    const endedAt = parsedOr(n.endedAt, now);
    const ageDays = Math.max(0, (now - endedAt) / DAY_MS);
    const failed = n.status === "failed";
    const links = issueLinks(n.url);
    const base = { ...(n.endedAt ? { sourceRevision: n.endedAt } : {}), ...(n.dueAt && Number.isFinite(Date.parse(n.dueAt)) ? { dueAt: n.dueAt } : {}), key: rangerItemKey(ref), source: "ranger", area: areaFor(areas, n.repo, null), urgency: "waiting" as const };
    const detail = {
      summary: n.reason?.detail ? `${n.reason.class ?? "Stopped"}: ${n.reason.detail}` : `The agent stopped (${n.status}).`,
      history: [`Stopped ${ago(now, endedAt)}`],
      refs: [ref, n.key],
      links,
    };
    if (n.reason?.class === "blocked") {
      const question = agentQuestion(n.reason.detail);
      const explanation = explanations?.get(rangerItemKey(ref));
      add({
        ...base, kind: "agent-blocked",
        title: `"${n.title}" waits for your ruling.`,
        why: `The agent in ${repoName(n.repo)} cannot go on without a decision from you.`,
        score: 65 - ageDays * 2,
        actions: [rulingAction(n, n.url, rulingActions), LOOK, LATER],
        detail,
        ...(question ? { question } : {}),
        ...(explanation ? { explanation } : {}),
      });
    } else {
      add({
        ...base, kind: "agent-failed",
        title: failed ? `An agent failed on "${n.title}".` : `An agent stopped on "${n.title}".`,
        why: `It stopped ${ago(now, endedAt)} in ${repoName(n.repo)}${failed ? ", and nothing moves until it is retried or parked" : ""}.`,
        score: (failed ? 60 : 40) - ageDays * 5,
        actions: [action("ranger.retry", "Let it retry", "primary", rangerActions && retryable(n)), LOOK, action("ranger.park", "Park it", "secondary", false)],
        detail,
      });
    }
  }
}

interface MapNodeRule {
  kind: "decision" | "grilling";
  urgency: DeskItem["urgency"];
  score: number;
  title: (title: string) => string;
  why: (repo: string) => string;
  primary: DeskAction;
  wired: (map: RangerMap, node: RangerMapNode) => boolean;
}

const MAP_NODE_RULES: { rule: MapNodeRule; nodes: (m: RangerMap) => RangerMapNode[] }[] = [
  {
    nodes: (m) => m.decisions ?? [],
    rule: {
      kind: "decision", urgency: "this-week", score: 45,
      title: (t) => `"${t}" waits for your go-ahead.`,
      why: (repo) => `Agents in ${repo} will not start it without you.`,
      primary: action("ranger.approve", "Approve", "primary", false),
      wired: approvable,
    },
  },
  {
    nodes: (m) => m.grillings ?? [],
    rule: {
      kind: "grilling", urgency: "waiting", score: 25,
      title: (t) => `An agent wants to settle a question with you: "${t}"`,
      why: (repo) => `It blocks work in ${repo} until you have talked it through.`,
      primary: action("ranger.grill", "Start the grilling", "primary", false),
      wired: () => false,
    },
  },
];

export function approvalBlocked(map: RangerMap, node: RangerMapNode): string | null {
  if (approvable(map, node)) return null;
  if (map.walk !== "full" || map.servedOnly === true) return "No agent builds this map; Ranger only shows it.";
  return "Ranger does not take an approval for it here. Look first to see what it needs.";
}

function rangerMapItems({ ranger, areas, rangerActions = false }: RankInput, add: Add): void {
  for (const map of ranger?.maps ?? []) {
    for (const { rule, nodes } of MAP_NODE_RULES) {
      for (const node of nodes(map)) {
        const ref = `${map.repo}#${node.id}`;
        const blocked = rule.kind === "decision" && rangerActions ? approvalBlocked(map, node) : null;
        add({
          key: rangerItemKey(ref), kind: rule.kind, source: "ranger", area: areaFor(areas, map.repo, null), urgency: rule.urgency,
          title: rule.title(node.title),
          why: blocked ?? rule.why(repoName(map.repo)),
          score: rule.score,
          actions: blocked ? [{ ...LOOK, role: "primary" }, LATER] : [{ ...rule.primary, wired: rangerActions && rule.wired(map, node) }, LOOK, LATER],
          detail: { summary: node.title, history: [], refs: [ref, map.key], links: issueLinks(node.url) },
        });
      }
    }
  }
}

const CHECK_AGAIN = action("goal.check", "Check again now", "primary", true);
const PAUSE = action("goal.pause", "Pause this goal", "secondary", true);

function goalExtras(goals: GoalActionsInput | undefined, goalId: string): Pick<DeskItem, "goal" | "checking"> {
  return { goal: goalId, ...(goals?.checking.has(goalId) ? { checking: true } : {}) };
}

function vigilItems({ now, subjects, areas, goalActions, waitingTasks }: RankInput, titles: Titles, listed: (key: string) => boolean, add: Add): void {
  const goalWording = new Map<string, string | null>();
  for (const s of subjects) if (s.goalId) goalWording.set(s.goalId, s.goalWording ?? goalWording.get(s.goalId) ?? null);
  const canCheck = (goalId: string): boolean => goalActions?.check.has(goalId) ?? false;
  const canPause = (goalId: string): boolean => (goalActions?.pause ?? false) && (goalActions?.pausable(goalId) ?? false);

  const seenEscalations = new Set<string>();
  for (const s of subjects) {
    if (s.healthy) continue;
    const refs = [s.subjectKey];
    if (isRegressedGoalCheck(s) && s.goalId) {
      const part = s.ref.split(".").pop() ?? "check";
      const wording = goalWording.get(s.goalId) ?? null;
      add({
        key: `vigil:${s.subjectKey}`, kind: "sensor", source: "vigil", area: areaFor(areas, null, s.goalId), urgency: "today",
        title: `The ${part} check for "${goalShort(wording)}" stopped working.`,
        why: `Without it, nobody can tell whether this goal is on track. It last ran ${ago(now, s.lastEndedAt)}.`,
        score: 85,
        actions: [action("goal.check", "Run the check now", "primary", canCheck(s.goalId)), LOOK, LATER],
        detail: { summary: wording ?? "This goal has no description.", history: [`Last run ${ago(now, s.lastEndedAt)}`], refs: [s.goalId, ...refs], links: [] },
        ...goalExtras(goalActions, s.goalId),
      });
    } else if (s.vocab === "goal" && ["off-track", "at-risk", "stale"].includes(s.value)) {
      const goalId = s.goalId ?? s.ref;
      const state = s.value === "stale" ? "has had no news for too long" : s.value === "at-risk" ? "is at risk" : "is off track";
      const reading = asOf(now, s.lastEndedAt);
      add({
        key: `vigil:${s.subjectKey}`, kind: "goal", source: "vigil", area: areaFor(areas, null, goalId), urgency: "this-week",
        title: `"${goalShort(s.goalWording)}" ${state}.`,
        why: `This reading is ${reading}. ${s.goalWording ?? "Its description is not available, so open it to see which goal this is."}`,
        score: s.value === "off-track" ? 75 : s.value === "at-risk" ? 70 : 55,
        actions: [canCheck(goalId) ? CHECK_AGAIN : { ...LOOK, role: "primary" }, ...(canPause(goalId) ? [PAUSE] : []), LATER],
        detail: { summary: s.goalWording ?? "This goal has no description.", history: [`Last report ${ago(now, s.lastEndedAt)}`], refs: [goalId, ...refs], links: [] },
        ...goalExtras(goalActions, goalId),
      });
    } else if (s.vocab === "escalation" && (s.value === "needs-principal" || s.value === "overdue")) {
      const ref = canonicalTaskRef(s.ref);
      if (listed(rangerItemKey(ref)) || seenEscalations.has(ref)) continue;
      seenEscalations.add(ref);
      const task = waitingTasks?.get(ref) ?? TASK_UNAVAILABLE;
      if (task.kind === "closed") continue;
      const known = task.kind === "open" ? task : titles.get(ref);
      const question = task.kind === "unavailable" ? `${task.reason} ${QUESTION_UNAVAILABLE}` : task.question ?? QUESTION_UNAVAILABLE;
      const repo = ref.split("#")[0] ?? ref;
      add({
        key: `vigil:${s.subjectKey}`, kind: "escalation", source: "vigil", area: areaFor(areas, repo, null), urgency: "waiting",
        title: known ? `"${known.title}" needs you.` : `Task details are unavailable in ${repoName(repo)}.`,
        why: `${question} In ${repoName(repo)}.`,
        score: s.value === "needs-principal" ? 50 : 35,
        actions: [action("detail", "Look first", "primary", true), LATER],
        detail: { summary: question, history: [`Escalated ${ago(now, s.lastEndedAt)}`], refs: [s.ref, ...refs], links: issueLinks(known?.url ?? escalationUrl(s.ref)) },
      });
    }
  }
}

export function fold(rest: DeskItem[]): DeskFoldedGroup[] {
  const groups = new Map<DeskItemKind, DeskFoldedGroup>();
  for (const item of rest) {
    const g = groups.get(item.kind) ?? { kind: item.kind, label: FOLDED_LABELS[item.kind], count: 0, example: item.title };
    g.count += 1;
    groups.set(item.kind, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export interface MailInput {
  now: number;
  mail: (SourceMail & { area: string | null; sourceId: string })[];
  events: ClassifierEvent[];
  vips: ReadonlySet<string>;
  yesFilter?: import("./mail-yes-filter").MailYesFilter;
  classified?: ReadonlyMap<string, MailClassification>;
  unimportant?: ReadonlySet<string>;
  trash?: boolean;
  archive?: boolean;
  spam?: boolean;
  draft?: boolean;
  links?: EvidenceLinks;
  onDesk?: ReadonlySet<string>;
}

const STOPWORDS = new Set(["meeting", "update", "about", "with", "from", "your", "termin", "sitzung", "einladung", "invitation", "accepted", "re", "fw", "aw", "wg"]);
const words = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));

export function meetingFor(subject: string, events: SourceEvent[], now: number): SourceEvent | undefined {
  const subjectWords = words(subject);
  return upcomingMeetings(events, now).find((e) => [...words(e.title)].some((w) => subjectWords.has(w)));
}

const dayName = (at: number, now: number): string => {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return `today at ${clock(at)}`;
  if (days === 1) return `tomorrow at ${clock(at)}`;
  return `${new Date(at).toLocaleDateString("en-GB", { weekday: "long" })} at ${clock(at)}`;
};

const CATEGORY_SCORE: Record<MailCategory, number> = { meeting: 25, action: 50, reply: 45, fyi: 25, bulk: 15 };
const LINKED_MEETING_SCORE = 55;
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

interface MailVerdict {
  eventKey?: string;
  score: number;
  pressing: boolean;
  why: string | null;
  sorted?: MailCategory;
}

function verdictFor(m: SourceMail, input: MailInput): MailVerdict {
  const { now, events, classified } = input;
  const c = classified?.get(m.id);
  if (!c) {
    const meeting = meetingFor(m.subject, events, now);
    if (!meeting) return { score: 15, pressing: false, why: null };
    return { score: LINKED_MEETING_SCORE, pressing: true, why: `It may be about "${meeting.title}" ${dayName(Date.parse(meeting.start), now)}.` };
  }
  const linked = c.meetingKey && c.category !== "bulk" ? upcomingMeetings(events, now).find((e) => eventKey(e) === c.meetingKey) : undefined;
  const reason = sentence(c.reason);
  if (linked) {
    return {
      eventKey: eventKey(linked),
      score: LINKED_MEETING_SCORE,
      pressing: true,
      why: `${reason} The meeting is ${dayName(Date.parse(linked.start), now)}.`,
      sorted: c.category,
    };
  }
  return { score: CATEGORY_SCORE[c.category], pressing: c.category === "action" || c.category === "reply", why: reason, sorted: c.category };
}

const SEEN = action("mail.seen", "Seen, delete", "primary", true);
const DELETE = action("mail.trash", "Delete", "secondary", true);
const ARCHIVE = action("mail.archive", "Archive", "secondary", true);
const SPAM = action("mail.spam", "Spam", "secondary", true);
const UNIMPORTANT = action("mail.unimportant", "Unimportant", "secondary", true);
const SHOW_MEETING = action("meeting.show", "Show on the meeting", "primary", true);
const DRAFT_LABEL = "Draft a reply";
const UNIMPORTANT_VERDICT: MailVerdict = { score: CATEGORY_SCORE.bulk, pressing: false, why: UNIMPORTANT_REASON, sorted: "bulk" };

export function mailItems(input: MailInput): DeskItem[] {
  const { now, mail, vips, classified, unimportant = new Set<string>(), trash = false, archive = false, spam = false, draft = false, links = {}, onDesk = new Set<string>() } = input;
  return mail.filter((m) => m.unread).map((m): DeskItem => {
    const sender = m.from.name ?? m.from.address;
    const vip = isVip(vips, m.from.address);
    const marked = isUnimportant(unimportant, vips, m.from.address);
    const verdict = marked ? UNIMPORTANT_VERDICT : verdictFor(m, input);
    const quiet = trash && (verdict.sorted === "fyi" || verdict.sorted === "bulk");
    const triage = marked ? undefined : classified?.get(m.id);
    const showMeeting: DeskAction[] = triage?.suggestedAction === "link-meeting" && verdict.eventKey && onDesk.has(verdict.eventKey) && !quiet ? [{ ...SHOW_MEETING, target: verdict.eventKey }] : [];
    const predicted = triage?.predictedAction;
    const learned = predicted && triage.precedents ? precedentLine(predicted, triage.precedents) : null;
    const archiveFirst = archive && (predicted ? predicted === "archive" : triage?.suggestedAction === "archive") && showMeeting.length === 0;
    const spamFirst = spam && predicted === "junk" && showMeeting.length === 0;
    const trashFirst = trash && predicted === "trash" && showMeeting.length === 0;
    const moveFirst = archiveFirst || spamFirst || trashFirst;
    const suggestion = learned || showMeeting.length > 0 || (triage?.suggestedAction === "archive" && !archiveFirst) ? undefined : suggestionLine(triage?.suggestedAction);
    const evidence = triage?.evidence ? evidenceView(triage.evidence, onDesk, links) : [];
    const receivedAt = parsedOr(m.receivedAt, now);
    const ageDays = Math.max(0, (now - receivedAt) / DAY_MS);
    const arrived = `It arrived ${ago(now, receivedAt)}.`;
    const why = vip ? `${sender} is on your VIP list. ${learned ?? (verdict.sorted && verdict.why ? verdict.why : arrived)}` : learned ?? verdict.why ?? arrived;
    const canDraft = draft && Boolean(m.account);
    const replyFirst = canDraft && (predicted ? predicted === "reply" : triage?.suggestedAction === "reply" && !quiet) && showMeeting.length === 0;
    const seenFirst = quiet && !moveFirst && predicted !== "keep" && !replyFirst;
    const open: DeskAction[] = m.url ? [{ ...action("open", "Open in Mail", seenFirst || moveFirst || showMeeting.length > 0 || replyFirst ? "secondary" : "primary", true), url: m.url }] : [];
    const always: DeskAction[] = vip ? [] : [{ ...action("vip.add", `Always show mail from ${m.from.name?.split(" ")[0] ?? "this sender"}`, "secondary", true), target: m.from.address }];
    const reply = action("mail.draft", DRAFT_LABEL, replyFirst ? "primary" : "secondary", true);
    const replyLead = replyFirst ? [reply] : [];
    const replyTail = canDraft && !replyFirst ? [reply] : [];
    const lead = archiveFirst ? [{ ...ARCHIVE, role: "primary" as const }] : spamFirst ? [{ ...SPAM, role: "primary" as const }] : trashFirst ? [{ ...DELETE, role: "primary" as const }] : seenFirst ? [SEEN] : [];
    const moves = [...(archive && !archiveFirst ? [ARCHIVE] : []), ...(trash && !trashFirst && !seenFirst ? [DELETE] : []), ...(spam && !spamFirst ? [SPAM] : [])];
    const offered = [...lead, ...showMeeting, ...replyLead, ...open, ...moves, ...(vip || marked ? [] : [UNIMPORTANT]), ...replyTail, LATER];
    const history = [`Received ${ago(now, receivedAt)}${m.account ? ` in your ${m.account} mailbox` : ""}`];
    if (verdict.sorted) history.push(`The mail classifier sorted it as ${verdict.sorted}.`);
    if (triage && (!triage.commitment || triage.commitment === "unknown")) history.push("Whether this mail asks for a new commitment has not been established.");
    if (triage?.precedents?.note) history.push(`Similar past mail was ${triage.precedents.note}.`);
    const precedents = triage?.precedents?.items.map(({ subject, at, action: done, correction }) => ({ subject, at, action: ACTION_LABEL[done], ...(correction ? { correction } : {}) })) ?? [];
    return {
      key: `mail:${m.id}`,
      sourceRevision: m.receivedAt,
      ...(m.dueAt ? { dueAt: m.dueAt } : {}),
      kind: "mail",
      source: m.sourceId,
      area: m.area,
      urgency: vip || verdict.pressing ? "today" : "waiting",
      title: `${sender} wrote: "${m.subject}"`,
      why,
      score: (vip ? 80 : verdict.score) - ageDays * 5,
      actions: offered.slice(0, 3),
      more: [...always, ...offered.slice(3)],
      detail: {
        summary: triage?.summary ?? m.firstParagraph ?? m.subject,
        history,
        refs: [m.from.address, m.id],
        links: m.url ? [{ label: "Open in Mail", url: m.url }] : [],
        ...(evidence.length > 0 ? { evidence } : {}),
        ...(precedents.length > 0 ? { precedents } : {}),
      },
      ...(m.firstParagraph ? { excerpt: m.firstParagraph } : {}),
      ...(suggestion ? { suggestion } : {}),
      ...(verdict.eventKey ? { eventKey: verdict.eventKey } : {}),
      ...(canDraft ? { reply: { to: m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address, subject: replySubject(m.subject) } } : {}),
      ...((triage?.commitment === "request" || triage?.commitment === "invitation") ? { yesFilter: input.yesFilter ?? { questions: [...DEFAULT_YES_FILTER], commitments: [], problems: [] } } : {}),
      since: receivedAt,
    };
  });
}

function escalationUrl(ref: string): string | undefined {
  const parts = /^(?:github:github\.com\/)?([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(ref);
  return parts ? `https://github.com/${parts[1]}/issues/${parts[2]}` : undefined;
}
