import { fetchIssueOrPr } from "../../adapters/github/fetch";
import { githubRef } from "../ruling";
import { safeHttpUrl, type RangerState } from "./ranger";

export type WaitingTask =
  | { kind: "open" | "closed"; title: string; question: string | null; url: string }
  | { kind: "unavailable"; reason: string };

export const TASK_UNAVAILABLE: WaitingTask = { kind: "unavailable", reason: "Source status could not be checked." };
export const QUESTION_UNAVAILABLE = "The question is unavailable. Open the source to see what is needed.";
export const canonicalTaskRef = (ref: string): string => ref.replace(/^github:github\.com\//, "");
export type WaitingTaskReader = (ref: string) => Promise<WaitingTask>;
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;
const CONCURRENT_READS = 6;

export function questionSummary(body: string | null): string | null {
  if (!body) return null;
  const sections = body.split(/^#{1,6} +/m);
  for (const section of sections.slice(1)) {
    const end = section.indexOf("\n");
    const heading = section.slice(0, end).trim().replace(/[:?]$/, "");
    if (!/^(?:question|questions|decision|decision needed|decision request|principal request|blocking condition|resume condition|what (?:you|the principal) must decide)$/i.test(heading)) continue;
    const paragraph = section.slice(end + 1).trim().split(/\n\s*\n/)[0] ?? "";
    const text = conciseQuestion(paragraph);
    if (text) return text;
  }
  const first = (sections[0] ?? "").trim().split(/\n\s*\n/)[0] ?? "";
  if (first.endsWith("?")) return conciseQuestion(first);
  return null;
}

function conciseQuestion(paragraph: string): string {
  const text = paragraph.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(?:^|\n)\s*[-*>]\s*/g, "").replace(/\s+/g, " ").trim();
  return text.length <= 300 ? text : `${text.slice(0, 297).replace(/\s+\S*$/, "")}…`;
}

export async function readWaitingTask(ref: string, fetchIssue: typeof fetchIssueOrPr = fetchIssueOrPr): Promise<WaitingTask> {
  const split = /^(?:github:github\.com\/)?([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(ref);
  const repo = split?.[1];
  const id = split?.[2];
  const parsed = repo && id ? githubRef(repo, id) : null;
  if (!parsed || !Number.isSafeInteger(parsed.number)) return TASK_UNAVAILABLE;
  const result = await fetchIssue(parsed, { timeoutMs: 4000 });
  if ("kind" in result || (result.state !== "open" && result.state !== "closed") || !result.title.trim()) return TASK_UNAVAILABLE;
  return { kind: result.state, title: result.title, question: questionSummary(result.body), url: safeHttpUrl(result.html_url) ?? `https://github.com/${repo}/issues/${id}` };
}

export class WaitingTasks {
  private readonly cache = new Map<string, { until: number; value: WaitingTask }>();
  private readonly pending = new Map<string, Promise<WaitingTask>>();
  private readonly queued = new Set<string>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly reader: WaitingTaskReader = readWaitingTask, private readonly clock = Date.now) {}

  read(refs: string[]): Promise<ReadonlyMap<string, WaitingTask>> {
    const unique = [...new Set(refs.map(canonicalTaskRef))];
    const active = new Set(unique);
    for (const ref of this.cache.keys()) if (!active.has(ref)) this.cache.delete(ref);
    const values = new Map<string, WaitingTask>();
    for (const ref of unique) {
      const hit = this.cache.get(ref);
      values.set(ref, hit && hit.until > this.clock() ? hit.value : TASK_UNAVAILABLE);
    }
    void this.warm(unique);
    return Promise.resolve(values);
  }

  warm(refs: string[]): Promise<void> {
    for (const raw of refs) {
      const ref = canonicalTaskRef(raw);
      const hit = this.cache.get(ref);
      if (!hit || hit.until <= this.clock()) this.queued.add(ref);
    }
    return this.queued.size ? this.start() : this.refreshing ?? Promise.resolve();
  }

  private start(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.drain().finally(() => {
      this.refreshing = null;
      if (this.queued.size) return this.start();
    });
    return this.refreshing;
  }

  private async drain(): Promise<void> {
    while (this.queued.size) {
      const refs = [...this.queued].slice(0, CONCURRENT_READS);
      for (const ref of refs) this.queued.delete(ref);
      await Promise.all(refs.map(ref => this.one(ref)));
    }
  }

  private async one(ref: string): Promise<WaitingTask> {
    const cached = this.cache.get(ref);
    if (cached && cached.until > this.clock()) return cached.value;
    const existing = this.pending.get(ref);
    if (existing) return existing;
    const request = Promise.resolve().then(() => this.reader(ref)).catch(() => TASK_UNAVAILABLE).then(value => {
      this.cache.set(ref, { value, until: this.clock() + (value.kind === "unavailable" ? RETRY_MS : FRESH_MS) });
      return value;
    }).finally(() => this.pending.delete(ref));
    this.pending.set(ref, request);
    return request;
  }
}

export function withoutClosedTasks(state: RangerState, tasks: ReadonlyMap<string, WaitingTask>): RangerState {
  const closed = (repo: string, id: string) => tasks.get(canonicalTaskRef(`${repo}#${id}`))?.kind === "closed";
  return {
    ...state,
    needsYou: state.needsYou.filter(n => !closed(n.repo, n.nodeId)),
    maps: state.maps.map(m => ({ ...m, decisions: m.decisions?.filter(n => !closed(m.repo, n.id)), grillings: m.grillings?.filter(n => !closed(m.repo, n.id)) })),
  };
}
