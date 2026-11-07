import { z } from "zod";
import type { StudioEvidenceInput } from "../../../../conversations/tools/studio-evidence";
import type { DeskOptions } from "../compose";
import { RoutineSchema, reflexCommand, type RoutineRunner } from "../routine-command";
import { readBoundedGit } from "./committed-batch";
const gitEvidence = async (dir: string, args: string[]): Promise<string> => (await readBoundedGit(dir, args, 4_000_000)).toString("utf8");
import { overseerRunIds, readOverseerOrigin, readOverseerRun } from "./overseer-audit";
import { readThinking } from "./thinking";
import type { RangerRunner } from "../actions";
import type { StudioThreadView } from "./view";

export const threadUrl = (slug: string): string => `?desk=studio&thread=${encodeURIComponent(slug)}`;
const chunk = (text: string, offset: number) => {
  let content = text.slice(offset, offset + 6000);
  while (JSON.stringify(content).length > 6002) content = content.slice(0, Math.ceil(content.length / 2));
  return { content, contentNext: text.length > offset + content.length ? offset + content.length : null, contentLength: text.length };
};
const page = <T>(rows: T[], input: StudioEvidenceInput) => ({ items: rows.slice(input.offset, input.offset + input.limit), next: rows.length > input.offset + input.limit ? { offset: input.offset + input.limit } : null });
const unavailable = (reason: string) => ({ status: "unavailable", reason });

async function schedule(desk: DeskOptions, run?: RoutineRunner): Promise<object> {
  const routines = desk.routines;
  if (!routines) return unavailable("No Reflex schedule reader is configured; external launchd/watch scheduling is unknown");
  try {
    const rows = await reflexCommand({ ...routines, timeoutSeconds: routines.readTimeoutSeconds }, ["routine", "list"], z.array(RoutineSchema), run);
    const found = rows.find(row => row.id === "studio-overseer" && row.target === routines.target);
    return found ? { status: "available", expression: found.schedule, timezone: found.timezone, enabled: found.runtimeConfirmed ? found.policy !== "disabled" && !found.paused : null, paused: found.paused, policy: found.policy, runtimeConfirmed: found.runtimeConfirmed, nextRun: null, nextRunEvidence: "The owner does not expose a next execution time", url: "?desk=routines" } : { status: "empty", reason: "No studio-overseer routine is registered for this target; external scheduling is unknown", enabled: null, nextRun: null };
  } catch {
    return unavailable("Reflex schedule evidence could not be read");
  }
}

export async function readStudioEvidence(desk: DeskOptions, input: StudioEvidenceInput, thread?: StudioThreadView, runners: { ranger?: RangerRunner; routine?: RoutineRunner } = {}): Promise<object> {
  if (!desk.studio) return unavailable("Studio is not configured");
  const dir = desk.studio.dir;
  const base = { observedAt: new Date().toISOString(), interpretation: "Evidence only. Later activity does not establish usefulness or causation." };
  try {
    if (input.scope === "overseer") {
      const ids = await overseerRunIds(dir);
      const selected = page(ids.reverse(), input);
      const runs = await Promise.all(selected.items.map(async id => {
        const run = await readOverseerRun(dir, id);
        return { id: run.id, startedAt: run.startedAt, endedAt: run.endedAt, status: run.status, failure: run.failure, thinkingCompleted: null, runtimeSchedule: run.schedule ? { ...run.schedule, observedAt: run.startedAt, currentEnabled: null, nextRun: null } : null, staleDays: run.staleDays ?? null, url: "?desk=studio", meaning: "Scan status records scheduling, not completed thinking", selections: { run: run.id, scope: "selections" } };
      }));
      return { ...base, status: ids.length ? "ok" : "empty", schedule: await schedule(desk, runners.routine), runs, runEvidence: ids.length ? "recorded" : "unavailable", next: selected.next, coverage: "Only instrumented scans are recorded. A running scan with no end may have stopped. Older scans and external process liveness are unavailable." };
    }
    if (input.scope === "selections") {
      if (!input.run) return unavailable("A recorded overseer run ID is required");
      const run = await readOverseerRun(dir, input.run);
      const selections = thread ? run.selections.filter(row => row.thread === thread.slug) : run.selections;
      return { ...base, status: selections.length ? "ok" : "empty", run: run.id, ...page(selections, input) };
    }
    if (!thread) return unavailable("The thread could not be read");
    const url = threadUrl(thread.slug);
    const thinking = input.scope === "history" ? { kind: "unavailable" as const, reason: "Queue evidence is not needed for history" } : await readThinking(dir, desk.rangerCli, runners.ranger);
    const jobs = thinking.kind === "ready" ? thinking.runs.filter(job => job.params.thread === thread.slug) : [];
    const audit = input.run ? await readOverseerRun(dir, input.run) : null;
    const receipts = new Set(audit?.selections.filter(row => row.thread === thread.slug).map(row => row.jobUuid));
    const matchesRun = (job: (typeof jobs)[number]) => !audit || receipts.has(job.runUuid);
    if (input.scope === "jobs") {
      if (thinking.kind === "unavailable") return unavailable(thinking.reason);
      const filtered = jobs.filter(job => (!input.job || job.runUuid === input.job) && matchesRun(job)).reverse();
      const selected = page(filtered, input);
      const rows = await Promise.all(selected.items.map(async job => {
        const provenance = await originatingRun(dir, thread.slug, job.runUuid);
        return { job: job.runUuid, jobId: job.id ?? null, run: provenance.run, provenance: provenance.status, status: job.status, failure: job.reason, queuedAt: job.queuedAt ?? null, startedAt: job.startedAt, endedAt: job.finishedAt ?? null, agent: job.substrate ?? null, notes: thread.notes.filter(note => note.run === job.runUuid).slice(0, 2).map(note => ({ at: note.at, url: `${url}#note-${note.at}` })), notesNext: thread.notes.filter(note => note.run === job.runUuid).length > 2 ? { scope: "notes", thread: thread.slug, job: job.runUuid, offset: 2 } : null, output: thread.notes.some(note => note.run === job.runUuid) ? "note-recorded" : job.status === "succeeded" ? "missing-note" : "not-completed", url };
      }));
      return { ...base, policy: selected.items.some(job => job.policy === "local") ? "local" : thread.policy, status: filtered.length ? "ok" : "empty", items: rows, next: selected.next };
    }
    if (input.scope === "notes") {
      const notes = thread.notes.filter(note => (!input.job || note.run === input.job) && (!audit || receipts.has(note.run ?? null)));
      const selected = page(notes, input);
      const rows = await Promise.all(selected.items.map(async note => {
        const job = jobs.find(job => job.runUuid === note.run);
        const provenance = await originatingRun(dir, thread.slug, note.run);
        return { at: note.at, status: note.status, kind: note.kind, sample: note.sample, model: note.model, author: null, agent: job?.substrate ?? null, agentEvidence: job ? "Ranger records execution substrate, not an authenticated assistant identity" : "Job evidence is unavailable", authorEvidence: "The note format records a model but no authenticated author", job: note.run ?? null, run: provenance.run, provenance: !note.run ? "missing-job-provenance" : provenance.status, thread: thread.slug, url: `${url}#note-${note.at}`, threadUrl: url, ...chunk(note.text, input.contentOffset) };
      }));
      return { ...base, policy: selected.items.some(note => jobs.some(job => job.runUuid === note.run && job.policy === "local")) ? "local" : thread.policy, status: notes.length ? "ok" : "empty", queueEvidence: thinking.kind, items: rows, next: selected.next, coverage: "Unattributed notes remain unattributed; read without a run filter to inspect missing provenance" };
    }
    const revision = (await gitEvidence(dir, ["rev-parse", "--verify", input.revision ?? "HEAD"])).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) return unavailable("Committed thread history is unavailable");
    const log = await gitEvidence(dir, ["log", "--format=%H%x00%aI%x00%an%x00%ae%x00%cI%x00%s", `--skip=${input.offset}`, `--max-count=${input.limit + 1}`, revision, "--", thread.path]);
    const lines = log.trim().split("\n").filter(Boolean);
    const history = await Promise.all(lines.slice(0, input.limit).map(async line => {
      const [commit, at, author, email, committedAt, subject] = line.split("\0");
      if (!commit || !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid Studio history revision");
      const patch = await gitEvidence(dir, ["show", "--format=", "--no-ext-diff", "--no-textconv", commit, "--", thread.path]);
      return { commit, at, author, email, committedAt, subject, authorship: "Recorded Git author; identity is not verified", url, source: `${thread.path}@${commit}`, ...chunk(patch, input.contentOffset) };
    }));
    return { ...base, status: history.length ? "ok" : "empty", history: history.sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? "") || a.commit.localeCompare(b.commit)), next: lines.length > input.limit ? { offset: input.offset + input.limit, revision } : null, revision, order: "Chronological within each page; next reads older changes", thread: thread.slug, url, current: { state: thread.state, outcome: thread.outcome ?? null }, coverage: "Committed changes include notes, responses, stand, decisions and recorded next steps. Uncommitted changes are not historical evidence. Git authorship is preserved without inferring principal or agent roles." };
  } catch {
    return unavailable("Studio evidence is absent, unreadable or exceeds its read limit");
  }
}

async function originatingRun(dir: string, thread: string, job?: string): Promise<{ run: string | null; status: string }> {
  if (!job) return { run: null, status: "missing-job-provenance" };
  try {
    const run = await readOverseerOrigin(dir, thread, job);
    return { run, status: run ? "recorded" : "missing-overseer-provenance" };
  } catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return { run: null, status: missing ? "missing-overseer-provenance" : "overseer-evidence-unavailable" };
  }
}
