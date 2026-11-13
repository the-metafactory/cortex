import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { handleGetDeskStudioRelations, type StudioRelationsDeps } from "../api/desk-studio-relations";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions } from "../desk/compose";
import { initDatabase } from "../db/init";
import { buildThreadPage } from "../desk/studio/page";
import { readStudioFiles } from "../desk/studio/read";
import { relatesContext, type RelatesDay } from "../desk/studio/relates";
import { buildStudioView } from "../desk/studio/view";
import { seedStudioRepo } from "./__fixtures__/studio-git";
import { startServer } from "../server";
import { DEFAULT_CONFIG } from "../config";

const NOW = Date.parse("2026-11-14T09:00:00+01:00");
const HOUR = 3_600_000;

const AREAS = [
  { id: "work", label: "Work", color: "#2563eb", policy: "local" as const, repos: [], goals: [] },
  { id: "lab", label: "Lab", color: "#7c3aed", policy: "cloud" as const, repos: [], goals: [] },
];

const PROPOSAL = `---
type: question
areas: [work]
state: active
opened: 2026-11-01
---

## Question

Where does the NetOps proposal go next?

## Ivy's notes

### 2026-11-10T03:00:00+01:00
trigger: Stale thread
model: local
kind: relation
relates: person: Ana Example
status: kept

Ana reviewed the first draft.

### 2026-11-12T03:00:00+01:00
trigger: Stale thread
model: local
kind: relation
relates: goal: G5: one post a week

It could become a post.

## Material

- mail: Cover email, sent 14 Oct
- goal: G5: one post a week
- person: [Nico Example](mailto:nico@example.org)
- event: NetOps sync, Mon 17 Nov
`;

const COVER = `---
type: topic
areas: [lab]
state: active
opened: 2026-11-02
---

## Question

Who reads the cover email?

## Material

- mail: Cover email, sent 14 Oct
`;

const DAY: RelatesDay = {
  generatedAt: NOW,
  goals: [{ id: "G5", text: "Make my know-how visible", state: "at-risk" }],
  today: [{ key: "cal:cal:sync", at: NOW + 2 * HOUR, title: "NetOps sync", area: null, kind: "meeting" }],
  ahead: [{ key: "cal:cal:sync", at: NOW + 2 * HOUR, title: "NetOps sync", area: null, kind: "meeting" }],
};

describe("GET /api/desk/studio/relations", () => {
  let dir = "";
  let db: Database;
  beforeEach(() => {
    dir = seedStudioRepo("desk-studio-relations-", { proposal: PROPOSAL, cover: COVER });
    db = initDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const desk = (studio = true): DeskOptions => ({ enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: AREAS, sources: [], ...(studio ? { studio: { dir, maxActive: 5 } } : {}) });
  const call = (query: string, options = desk(), deps: StudioRelationsDeps = { now: NOW, composeDay: async () => DAY }) =>
    handleGetDeskStudioRelations(new Request(`http://localhost/api/desk/studio/relations${query}`), db, { options, ledger: new HandledLedger() }, undefined, deps);

  it("serves the thread page's relations and open proposals, with the Desk's goals and events", async () => {
    const response = await call("?thread=proposal");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    const { files, problems } = await readStudioFiles(dir);
    const page = buildThreadPage(buildStudioView(files, desk().studio!, AREAS, problems), "proposal", relatesContext(DAY));
    expect(body).toEqual(JSON.parse(JSON.stringify({ thread: "proposal", generatedAt: NOW, relations: page?.relations, proposed: page?.proposedRelations, context: "complete" })));
    expect(body.relations.threads.map((r: { open: string }) => r.open)).toEqual(["cover"]);
    expect(body.relations.events.map((r: { key: string }) => r.key)).toEqual(["event:cal:cal:sync"]);
    expect(body.proposed.map((n: { relates: { label: string } }) => n.relates.label)).toEqual(["G5: one post a week"]);
  });

  it("names the rule behind each relation", async () => {
    const { relations } = await (await call("?thread=proposal")).json();
    expect(relations.threads[0].basis).toEqual([{ rule: "shared-source", source: "Cover email, sent 14 Oct" }]);
    expect(relations.goals[0].basis).toEqual([{ rule: "goal-material", goalState: "at-risk" }]);
    expect(relations.events[0].basis).toEqual([{ rule: "event-in-material", material: "NetOps sync, Mon 17 Nov" }]);
    expect(relations.people.map((p: { basis: unknown }) => p.basis)).toEqual([[{ rule: "person-material" }], [{ rule: "kept", note: "2026-11-10T03:00:00+01:00" }]]);
  });

  it("serves the Studio-only groups when the Desk cannot be composed", async () => {
    const body = await (await call("?thread=proposal", desk(), { now: NOW, composeDay: async () => { throw new Error("calendar source down"); } })).json();
    expect(body.context).toBe("studio-only");
    expect(body.generatedAt).toBe(NOW);
    expect(body.relations.goals.map((g: { title: string }) => g.title)).toEqual(["One post a week"]);
    expect(body.relations.events).toEqual([]);
    expect(body.relations.threads.map((r: { open: string }) => r.open)).toEqual(["cover"]);
    expect(body.relations.people).toHaveLength(2);
  });

  it("refuses a malformed slug and an unknown thread", async () => {
    const bad = await call("?thread=../etc");
    expect(bad.status).toBe(400);
    expect((await call("")).status).toBe(400);
    expect((await call("?thread=missing")).status).toBe(404);
  });

  it("is served by Mission Control for GET only", async () => {
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { desk: desk() });
    try {
      const url = `http://127.0.0.1:${ctx.port}/api/desk/studio/relations?thread=proposal`;
      const got = await fetch(url);
      expect(got.status).toBe(200);
      expect((await got.json()).thread).toBe("proposal");
      expect((await fetch(url, { method: "POST", headers: { Origin: `http://127.0.0.1:${ctx.port}` } })).status).toBe(405);
    } finally { ctx.stop(true); }
  });

  it("answers relations null when the Studio is off", async () => {
    const response = await call("?thread=proposal", desk(false));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ relations: null });
  });
});
