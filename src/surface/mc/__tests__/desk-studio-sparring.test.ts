import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskStudioAct } from "../api/desk-studio-act";
import { HandledLedger, type RangerRunner } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { buildStudioView } from "../desk/studio/view";
import { threadThinking } from "../desk/studio/thinking-view";
import { parseThreadFile } from "../desk/studio/format";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
const text = `---
type: question
areas: [work]
state: active
opened: 2026-10-31
---

## Question

What could go wrong?

## Where I stand

Try it.
`;
const areas = [{ id: "work", label: "Work", color: "", repos: [], goals: [], policy: "local" as const }];
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "sparring-")); dirs.push(dir);
  mkdirSync(join(dir, "threads")); writeFileSync(join(dir, "threads/alpha.md"), text);
  const studio = buildStudioView({ threads: [{ path: "threads/alpha.md", text }], inbox: [], proposals: [] }, { dir, maxActive: 5, personas: ["A skeptic"] }, areas);
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", rangerCli: { bin: "ranger", config: "/tmp/ranger-test.yaml" }, areas, studio: { dir, maxActive: 5, personas: ["A skeptic"] }, sources: [] } };
  const calls: string[][] = [];
  const run: RangerRunner = async argv => {
    calls.push(argv);
    return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("enqueue") ? { runId: 1, queued: true } : { directory: dir, dailyRuns: { local: 5, cloud: 5 }, runs: [] }) };
  };
  const post = (mode: string) => handleDeskStudioAct(new Request("http://localhost/api/desk/studio/act", { method: "POST", body: JSON.stringify({ act: "spar", thread: "alpha", mode, requestId: "request-sparring" }) }), runtime, { run });
  return { studio, calls, post, runtime, run, dir };
}

test("every requested sparring mode enqueues native ivy-think with its explicit trigger and durable request id", async () => {
  const r = rig();
  for (const mode of ["think", "grill", "other-side", "red-team", "first-principles", "persona:A skeptic"]) {
    expect((await r.post(mode)).status).toBe(200);
    expect(r.calls.at(-2)).toEqual(["ranger", "job", "enqueue", "ivy-think", "--param", "thread=alpha", "--param", `mode=${mode}`, "--param", `trigger=You asked: ${mode}`, "--param", "requestId=request-sparring", "--config", "/tmp/ranger-test.yaml"]);
  }
  expect((await r.post("persona:Not configured")).status).toBe(400);
  expect((await r.post("bogus")).status).toBe(400);
});

test("a mismatched native Studio directory refuses enqueue", async () => {
  const r = rig();
  const run: RangerRunner = async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ directory: tmpdir(), dailyRuns: { local: 5, cloud: 5 }, runs: [] }) });
  const res = await handleDeskStudioAct(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ act: "spar", thread: "alpha", mode: "think", requestId: "request-sparring" }) }), r.runtime, { run });
  expect(res.status).toBe(503);
});

test("pending survives unrelated notes and resolves only for the corresponding run; spent budgets include failed starts", () => {
  const r = rig(); const thread = r.studio.active[0]; if (!thread) throw new Error("fixture missing");
  const now = new Date("2026-10-31T12:00:00Z");
  const uuid = "00000000-0000-4000-8000-000000000001";
  const run = { runUuid: uuid, params: { thread: "alpha", mode: "red-team", requestId: "request-sparring" }, status: "queued" as const, startedAt: null, policy: null, reason: "Deferred until tomorrow: the local daily run budget is spent" };
  const studio = { ...r.studio, thinking: { kind: "ready" as const, dailyRuns: { local: 1, cloud: 5 }, runs: [run, { ...run, runUuid: "other", status: "failed" as const, startedAt: now.toISOString(), policy: "local" as const }] } };
  const unrelated = { at: now.toISOString(), trigger: "You asked: red-team", mode: "red-team", model: "local", kind: "note" as const, status: "open" as const, sample: false, text: "An unrelated note" };
  expect(threadThinking(studio, { ...thread, notes: [unrelated] }, now)).toMatchObject({ kind: "ready", budgetSpent: true, runs: [{ id: uuid, status: "pending", reason: run.reason }, { status: "failed" }] });
  expect(threadThinking(studio, { ...thread, notes: [{ ...unrelated, run: uuid }] }, now)).toMatchObject({ runs: [{ id: "other" }] });
  const parsed = parseThreadFile("threads/alpha.md", `${text}\n## Ivy's notes\n\n### ${now.toISOString()}\ntrigger: You asked: red-team\nmodel: local / pi\nmode: red-team\nrun: ${uuid}\n\nA note.\n`);
  expect(parsed.ok && parsed.value.notes[0]?.run).toBe(uuid);
});


test("conflicting person request ids return a conflict without another enqueue", async () => {
  const r = rig(); let enqueues = 0;
  const run: RangerRunner = async argv => {
    if (argv.includes("enqueue")) enqueues++;
    return { code: 0, stderr: "", stdout: JSON.stringify({ directory: r.dir, dailyRuns: { local: 5, cloud: 5 }, runs: [{ runUuid: "00000000-0000-4000-8000-000000000001", params: { thread: "alpha", mode: "grill", requestId: "request-sparring" }, status: "succeeded", startedAt: null, policy: "local", reason: null }] }) };
  };
  const response = await handleDeskStudioAct(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ act: "spar", thread: "alpha", mode: "red-team", requestId: "request-sparring" }) }), r.runtime, { run });
  expect(response.status).toBe(409); expect(enqueues).toBe(0);
});
