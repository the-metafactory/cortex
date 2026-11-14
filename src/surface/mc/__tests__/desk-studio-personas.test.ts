import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskStudioAct } from "../api/desk-studio-act";
import { handleGetDeskStudio } from "../api/desk-studio";
import { HandledLedger, type RangerRunner } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import type { MaterialLink } from "../desk/studio/format";
import { relatesTo, sparPersonas, threadPeople } from "../desk/studio/relates";
import { studioNote, studioThread } from "./__fixtures__/studio";

const LONG = "N".repeat(101);

const THREAD = `---
type: question
areas: [work]
state: active
opened: 2026-11-01
---

## Question

Should the proposal go out this week?

## Ivy's notes

### 2026-11-10T03:00:00+01:00
trigger: Stale thread
model: local
kind: relation
relates: person: Ana Example
status: kept

Ana reviewed the draft.

### 2026-11-11T03:00:00+01:00
trigger: Stale thread
model: local
kind: relation
relates: person: Olaf Open

Olaf might care.

## Material

- person: [Nico Example](mailto:nico@example.org)
- contact: A skeptic
- person: ${LONG}
- file: Draft.md
`;

const areas = [{ id: "work", label: "Work", color: "", repos: [], goals: [], policy: "local" as const }];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "personas-")); dirs.push(dir);
  mkdirSync(join(dir, "threads"));
  writeFileSync(join(dir, "threads/alpha.md"), THREAD);
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", rangerCli: { bin: "ranger", config: "/tmp/ranger-test.yaml" }, areas, studio: { dir, maxActive: 5, personas: ["A skeptic"] }, sources: [] } };
  const enqueued: string[] = [];
  const run: RangerRunner = async argv => {
    if (argv.includes("enqueue")) enqueued.push(argv.find(a => a.startsWith("mode=")) ?? "");
    return { code: 0, stderr: "", stdout: JSON.stringify(argv.includes("enqueue") ? { runId: 1, queued: true } : { directory: dir, dailyRuns: { local: 5, cloud: 5 }, runs: [] }) };
  };
  const spar = async (mode: string) => {
    const response = await handleDeskStudioAct(new Request("http://localhost/api/desk/studio/act", { method: "POST", body: JSON.stringify({ act: "spar", thread: "alpha", mode, requestId: crypto.randomUUID() }) }), runtime, { run });
    return { status: response.status, body: await response.json() as { error?: string } };
  };
  return { runtime, enqueued, spar };
}

const person = (label: string): MaterialLink => ({ kind: "person", label });

describe("sparring personas from a thread's people", () => {
  it("serves configured personas first, then the thread's people, each once", async () => {
    const body = await (await handleGetDeskStudio(rig().runtime)).json() as { studio: { active: { personas: unknown }[] } };
    expect(body.studio.active[0]?.personas).toEqual([
      { name: "A skeptic", from: "config" },
      { name: "Nico Example", from: "thread" },
      { name: "Ana Example", from: "thread" },
    ]);
  });

  it("enqueues a material person and a kept person relation, and still a configured name", async () => {
    const r = rig();
    for (const name of ["Nico Example", "Ana Example", "A skeptic"]) expect((await r.spar(`persona:${name}`)).status).toBe(200);
    expect(r.enqueued).toEqual(["mode=persona:Nico Example", "mode=persona:Ana Example", "mode=persona:A skeptic"]);
  });

  it("refuses an open proposal's person and a name the thread does not hold", async () => {
    const r = rig();
    for (const name of ["Olaf Open", "Somebody Else"]) {
      const refused = await r.spar(`persona:${name}`);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("Choose a perspective from the configured personas or the thread's people.");
    }
    expect(r.enqueued).toEqual([]);
  });

  it("takes the people group of the thread's relations", () => {
    const thread = studioThread("t", { material: [person("Nico"), { kind: "people", label: "The board" }, { kind: "file", label: "x" }], notes: [studioNote("2026-11-10T03:00:00+01:00", { kind: "relation", status: "kept", relates: { kind: "contact", label: "Ana" } })] });
    const studio = { maxActive: 5, yesFilter: { questions: [], fromConfig: false }, areas: [], active: [thread], parked: [], closed: [], inbox: [], proposals: [], problems: [] };
    expect(threadPeople(thread).map((p) => p.title)).toEqual(relatesTo(thread, studio).people.map((p) => p.title));
    expect(threadPeople(thread).map((p) => p.title)).toEqual(["Nico", "The board", "Ana"]);
  });

  it("offers at most ten thread people, in material order", () => {
    const material = Array.from({ length: 12 }, (_, i) => person(`Person ${i + 1}`));
    const offered = sparPersonas({ personas: [] }, { material, notes: [] });
    expect(offered.map((p) => p.name)).toEqual(material.slice(0, 10).map((m) => m.label));
  });
});
