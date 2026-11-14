import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskStudioAct } from "../api/desk-studio-act";
import { HandledLedger, type RangerRunner } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { buildStudioView, type StudioView } from "../desk/studio/view";
import { handleGetDeskStudio } from "../api/desk-studio";
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
  expect(threadThinking(studio, { ...thread, notes: [unrelated] }, now)).toMatchObject({ kind: "ready", budget: "spent", runs: [{ id: uuid, status: "pending", reason: run.reason }, { status: "failed" }] });
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

const ranger = (dir: string, dailyRuns: { local: number; cloud: number }, startedToday = 0): RangerRunner => async argv => {
  const today = new Date().toISOString();
  const runs = Array.from({ length: startedToday }, (_, i) => ({ runUuid: `00000000-0000-4000-8000-00000000000${i + 1}`, params: { thread: "alpha" }, status: "succeeded", startedAt: today, policy: "local", reason: null }));
  return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("enqueue") ? { runId: 1, queued: true } : { directory: dir, dailyRuns, runs }) };
};
const threadThinkingOf = async (res: Response) => ((await res.json()) as { studio: StudioView }).studio.active[0]?.thinking;

test("GET /api/desk/studio gives each thread its budget and the reason an external UI shows", async () => {
  const r = rig();
  expect(await threadThinkingOf(await handleGetDeskStudio(r.runtime, ranger(r.dir, { local: 5, cloud: 5 })))).toEqual({ kind: "ready", budget: "open", reason: null, runs: [] });
  expect(await threadThinkingOf(await handleGetDeskStudio(r.runtime, ranger(r.dir, { local: 1, cloud: 5 }, 1)))).toEqual({ kind: "ready", budget: "spent", reason: "Today's local thinking budget is spent. Queued requests wait until tomorrow (UTC).", runs: [] });
  expect(await threadThinkingOf(await handleGetDeskStudio(r.runtime, ranger(r.dir, { local: 0, cloud: 5 })))).toEqual({ kind: "ready", budget: "off", reason: "Local thinking is turned off: its daily run limit in Ranger is 0.", runs: [] });
});

test("an unreadable or unconfigured Ranger marks each thread unavailable with the stack-wide reason", async () => {
  const r = rig();
  const body = (await (await handleGetDeskStudio(r.runtime, async () => ({ code: 1, stderr: "", stdout: "" }))).json()) as { studio: StudioView };
  expect(body.studio.thinking).toEqual({ kind: "unavailable", reason: "The thinking queue is unavailable. Check Ranger's Studio configuration." });
  expect(body.studio.active[0]?.thinking).toEqual({ kind: "unavailable", reason: "The thinking queue is unavailable. Check Ranger's Studio configuration." });
  const options = r.runtime.options; if (!options) throw new Error("fixture missing");
  const { rangerCli: _, ...withoutRanger } = options;
  const bare: DeskRuntime = { ...r.runtime, options: withoutRanger };
  expect(await threadThinkingOf(await handleGetDeskStudio(bare))).toEqual({ kind: "unavailable", reason: "Thinking needs Ranger configured on this stack." });
});

test("the spar answer carries the same per-thread thinking", async () => {
  const r = rig();
  const res = await handleDeskStudioAct(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ act: "spar", thread: "alpha", mode: "think", requestId: "request-sparring" }) }), r.runtime, { run: ranger(r.dir, { local: 1, cloud: 5 }, 1) });
  expect(res.status).toBe(200);
  expect(await threadThinkingOf(res)).toMatchObject({ kind: "ready", budget: "spent", reason: "Today's local thinking budget is spent. Queued requests wait until tomorrow (UTC)." });
});
