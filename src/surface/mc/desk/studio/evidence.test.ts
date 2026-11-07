import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskOptions } from "../compose";
import { StudioEvidenceInput } from "../../../../conversations/tools/studio-evidence";
import { buildStudioView } from "./view";
import { newOverseerRun, saveOverseerRun } from "./overseer-audit";
import { readStudioEvidence } from "./evidence";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const jobId = "11111111-1111-4111-8111-111111111111";
const text = (body = "A thought") => `---\ntype: question\nareas: [lab]\nstate: active\nopened: 2026-11-01\n---\n## Question\nWhich approach?\n## Where I stand\nTest it.\n## Ivy's notes\n### 2026-11-02T12:00:00Z\ntrigger: nightly\nmodel: fixture\nrun: ${jobId}\n\n${body}\n## Responses\n### 2026-11-03T12:00:00Z\nre: 2026-11-02T12:00:00Z\nWe tried it.\n## Log\n- 2026-11-03: Next step: compare both approaches\n`;
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "studio-evidence-")); dirs.push(dir);
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", dir, ...args]); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(dir, "threads")); await writeFile(join(dir, "threads/alpha.md"), text("A".repeat(9000)));
  git("add", "."); git("commit", "-qm", "Initial note and response");
  const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" }], studio: { dir, maxActive: 5 }, rangerCli: { bin: "fixture-ranger", config: "" } };
  const view = buildStudioView({ threads: [{ path: "threads/alpha.md", text: text("A".repeat(9000)) }], inbox: [], proposals: [] }, { dir, maxActive: 5 }, desk.areas);
  const thread = view.active[0]; if (!thread) throw new Error("Missing fixture thread");
  const audit = newOverseerRun(new Date());
  audit.status = "succeeded"; audit.endedAt = new Date().toISOString();
  const requestId = `overseer-${audit.id}-0`;
  audit.selections = [{ thread: "alpha", selected: true, reason: "Asked to think tonight", jobUuid: jobId, jobId: 7, created: true, enqueue: "confirmed" }];
  await saveOverseerRun(dir, audit);
  const job = { id: 7, runUuid: jobId, params: { thread: "alpha", requestId }, status: "succeeded", reason: null as string | null, queuedAt: "2026-11-02T11:59:00Z", startedAt: "2026-11-02T12:00:00Z", finishedAt: "2026-11-02T12:01:00Z", substrate: "fixture", policy: "cloud" };
  const ranger = async (argv: string[]) => { expect(argv).toEqual(["fixture-ranger", "job", "list", "--studio"]); return { code: 0, stdout: JSON.stringify({ directory: dir, dailyRuns: { local: 5, cloud: 5 }, runs: [job] }), stderr: "" }; };
  const read = (input: object, queue = ranger) => readStudioEvidence(desk, StudioEvidenceInput.parse(input), thread, { ranger: queue });
  return { dir, git, desk, thread, audit, job, read, ranger };
}

test("completed scan traces through explicit enqueue receipt and job UUID to full paginated note", async () => {
  const r = await rig();
  const jobs = await r.read({ scope: "jobs", thread: "alpha", run: r.audit.id });
  expect(jobs).toMatchObject({ status: "ok", items: [{ run: r.audit.id, job: jobId, status: "succeeded", endedAt: r.job.finishedAt, output: "note-recorded", provenance: "recorded" }] });
  const first = await r.read({ scope: "notes", thread: "alpha", run: r.audit.id, limit: 1 });
  expect(first).toMatchObject({ items: [{ contentLength: 9000, content: "A".repeat(6000), contentNext: 6000, run: r.audit.id, job: jobId, author: null, url: "?desk=studio&thread=alpha#note-2026-11-02T12:00:00Z" }] });
  expect(await r.read({ scope: "notes", thread: "alpha", job: jobId, contentOffset: 6000 })).toMatchObject({ items: [{ content: "A".repeat(3000), contentNext: null }] });
});

test("queued, running, failed, missing output and missing provenance remain distinct", async () => {
  const r = await rig(); r.thread.notes = [];
  for (const status of ["queued", "running", "failed", "succeeded"]) {
    r.job.status = status; r.job.reason = status === "failed" ? "Model unavailable" : null;
    expect(await r.read({ scope: "jobs", thread: "alpha" })).toMatchObject({ items: [{ status, failure: r.job.reason, output: status === "succeeded" ? "missing-note" : "not-completed" }] });
  }
  r.thread.notes = [{ at: "2026-11-02T12:00:00Z", trigger: "fixture", model: "fixture", kind: "note", status: "open", sample: false, text: "No provenance" }];
  expect(await r.read({ scope: "notes", thread: "alpha" })).toMatchObject({ items: [{ run: null, job: null, provenance: "missing-job-provenance" }] });
  expect(await r.read({ scope: "notes", thread: "alpha" }, async () => ({ code: 1, stdout: "", stderr: "offline" }))).toMatchObject({ queueEvidence: "unavailable", items: [{ content: "No provenance" }] });
});

test("bounded run and selection pages preserve failed and incomplete records", async () => {
  const r = await rig();
  const pending = newOverseerRun(new Date()); await saveOverseerRun(r.dir, pending);
  const first = await r.read({ scope: "overseer", limit: 1 });
  expect(first).toMatchObject({ status: "ok", runs: [{ id: pending.id, status: "running", endedAt: null, thinkingCompleted: null }], next: { offset: 1 }, schedule: { status: "unavailable" } });
  expect(await r.read({ scope: "overseer", limit: 1, offset: 1 })).toMatchObject({ runs: [{ id: r.audit.id }], next: null });
  expect(await r.read({ scope: "selections", run: r.audit.id, limit: 1 })).toMatchObject({ items: [{ enqueue: "confirmed", reason: "Asked to think tonight" }], next: null });
  expect(StudioEvidenceInput.safeParse({ scope: "overseer", limit: 3 }).success).toBe(false);
  expect(StudioEvidenceInput.safeParse({ scope: "history", thread: "../private" }).success).toBe(false);
});

test("history preserves recorded authors, subsequent decisions and next steps without causal claims", async () => {
  const r = await rig();
  await writeFile(join(r.dir, "threads/alpha.md"), text().replace("Test it.", "Choose approach B.").replace("state: active", "state: closed\noutcome: decided"));
  r.git("add", "."); r.git("commit", "-qm", "Decision after experiment");
  const before = r.git("status", "--porcelain");
  const history = await r.read({ scope: "history", thread: "alpha", limit: 1 });
  expect(history).toMatchObject({ status: "ok", history: [{ author: "Fixture", email: "fixture@example.invalid", subject: "Decision after experiment", content: expect.stringContaining("Choose approach B.") }], next: { offset: 1 } });
  expect(await r.read({ scope: "history", thread: "alpha", offset: 1, contentOffset: 6000, limit: 1 })).toMatchObject({ history: [{ subject: "Initial note and response", content: expect.stringContaining("Next step:") }] });
  expect(r.git("status", "--porcelain")).toBe(before);
});

test("disabled scheduling, empty results and unavailable owners are separate evidence", async () => {
  const r = await rig();
  const { RoutineOptionsSchema } = await import("../../../../common/types/desk-routines");
  r.desk.routines = RoutineOptionsSchema.parse({ composer: ["fixture"], reflex: ["fixture"], target: "@fixture/pulse-flow", timeZone: "UTC" });
  const routine = async (argv: string[]) => {
    expect(argv).toEqual(["fixture", "routine", "list", "--json"]);
    return { code: 0, stdout: JSON.stringify([{ id: "studio-overseer", schedule: "*/15 * * * *", timezone: "UTC", policy: "disabled", paused: false, runtimeConfirmed: true, target: "@fixture/pulse-flow", file: "fixture.yaml", lastDecision: null }]), stderr: "" };
  };
  expect(await readStudioEvidence(r.desk, StudioEvidenceInput.parse({ scope: "overseer" }), undefined, { routine })).toMatchObject({ schedule: { status: "available", enabled: false, nextRun: null, expression: "*/15 * * * *" } });
  r.thread.notes = [];
  expect(await r.read({ scope: "notes", thread: "alpha" })).toMatchObject({ status: "empty", items: [] });
  expect(await r.read({ scope: "selections", run: "11111111-1111-4111-8111-111111111111" })).toMatchObject({ status: "unavailable" });
});


test("an origin pointer is not provenance unless its scan records the same job UUID", async () => {
  const r = await rig();
  r.audit.selections[0]!.jobUuid = "22222222-2222-4222-8222-222222222222";
  await saveOverseerRun(r.dir, r.audit);
  expect(await r.read({ scope: "notes", thread: "alpha" })).toMatchObject({ items: [{ run: null, provenance: "missing-overseer-provenance" }] });
});

test("history pages pin the revision and content chunks stay bounded after JSON escaping", async () => {
  const r = await rig();
  const first = await r.read({ scope: "history", thread: "alpha", limit: 1 }) as { revision: string };
  await writeFile(join(r.dir, "threads/alpha.md"), text("Changed after first read"));
  r.git("add", "."); r.git("commit", "-qm", "New activity");
  expect(await r.read({ scope: "history", thread: "alpha", revision: first.revision })).toMatchObject({ history: [{ subject: "Initial note and response" }] });
  r.thread.notes[0]!.text = "\n".repeat(9000);
  const notes = await r.read({ scope: "notes", thread: "alpha", limit: 1 });
  expect(JSON.stringify(notes).length).toBeLessThan(18000);
  expect(notes).toMatchObject({ items: [{ contentNext: 3000 }] });
});


test("note provenance survives an unavailable or pruned Ranger queue", async () => {
  const r = await rig();
  expect(await r.read({ scope: "notes", thread: "alpha", run: r.audit.id }, async () => ({ code: 1, stdout: "", stderr: "offline" }))).toMatchObject({ queueEvidence: "unavailable", items: [{ run: r.audit.id, job: jobId, provenance: "recorded" }] });
});

test("a receipt for an already queued job is an association and does not invent an originating scan", async () => {
  const r = await rig();
  r.audit.selections[0]!.created = false;
  await saveOverseerRun(r.dir, r.audit);
  expect(await r.read({ scope: "notes", thread: "alpha", run: r.audit.id })).toMatchObject({ items: [{ job: jobId, run: null, provenance: "missing-overseer-provenance" }] });
});
