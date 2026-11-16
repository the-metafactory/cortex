import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type AppState, type OutlineNode } from "../../../balance";
import { DESK_API_VERSION, withDeskApiVersion } from "../../../desk-api/version";
import type { DeskSearchResponse } from "../../../desk-api/wire/search";
import { handleDeskSearch } from "../api/desk-search";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { saveBalanceState } from "../desk/balance-store";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { addNote } from "../desk/notes";
import { fileStudioCapture, type CaptureModel } from "../desk/studio/capture";
import type { StudioOptions } from "../desk/types";
import { seedStudioRepo } from "./__fixtures__/studio-git";

const NOW = new Date("2026-10-31T17:00:00Z");
const ENDPOINT = { baseUrl: "http://127.0.0.1:1234/v1", model: "cloud-test", timeoutSeconds: 5, maxPerPass: 10 };
const AREAS = [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" as const }];
const thread = `---\ntype: question\nareas: [lab]\nstate: active\nopened: 2026-10-31\n---\n\n## Question\n\nHow should the zebrafish board work?\n\n## Where I stand\n\nStill deciding.\n\n## Material\n\n- link: Existing source\n\n## Log\n\n- 2026-10-31: Opened\n`;
const leaf = (id: string, title: string, children: OutlineNode[] = []): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children, effort: 1 });
const balance = (): AppState => ({
  outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [
    { id: "area:lab", title: "Lab", weight: 50, ordering: "parallel", children: [leaf("task-1", "Water the quokka garden")] },
    { id: "area:secret", title: "Secret", weight: 50, ordering: "parallel", children: [leaf("task-2", "Hide the quokka vault")] },
  ] },
  log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} }, outcomes: [],
});

let dir: string;
let db: Database;
let studio: StudioOptions | undefined;
let enabled = true;
let sequence = 0;
const toInbox: CaptureModel = async () => null;
const toThread: CaptureModel = async () => ({ thread: "studio", reason: "Fits the board." });

const runtime = (): DeskRuntime => {
  const options: DeskOptions = { enabled, displayName: "", topN: 5, rangerUrl: "", areas: AREAS, sources: [], ...(studio ? { studio } : {}) };
  return { options, ledger: new HandledLedger() };
};
const search = async (query: string): Promise<{ status: number; headers: Headers; body: DeskSearchResponse & { error?: string; messagePhrase?: { code: string } } }> => {
  const req = new Request(`http://localhost/api/desk/search?${query}`);
  const response = withDeskApiVersion("/api/desk/search", await handleDeskSearch(req, db, runtime(), undefined, NOW.getTime()));
  return { status: response.status, headers: response.headers, body: await response.json() };
};
const file = (text: string, model: CaptureModel) => fileStudioCapture({ options: studio!, areas: AREAS, assistantName: "Assistant", db, requestId: `search-request-${++sequence}`, text, now: NOW, model });

beforeEach(() => {
  dir = seedStudioRepo("desk-search-", { studio: thread });
  db = initDatabase(":memory:");
  studio = { dir, maxActive: 5, filer: ENDPOINT };
  enabled = true;
  saveBalanceState(db, balance());
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("GET /api/desk/search", () => {
  it("finds an inbox capture and a thread capture by words only the capture text holds", async () => {
    await file("Remember the narwhal sonar idea.", toInbox);
    await file("Add the okapi lantern to the board.", toThread);
    const inbox = await search("q=narwhal");
    expect(inbox.status).toBe(200);
    expect(inbox.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
    expect(inbox.body.status).toBe("ok");
    expect(inbox.body.hits).toHaveLength(1);
    expect(inbox.body.hits[0]).toMatchObject({ kind: "studio-capture", open: { method: "GET", path: "/api/desk/studio" } });
    expect(inbox.body.hits[0]?.snippet).toContain("narwhal");
    expect(inbox.body.hits[0]?.id).toMatch(/^capture-[a-f0-9]{32}$/);
    const filed = await search("q=okapi");
    expect(filed.body.hits.map((hit) => hit.kind)).toEqual(["studio-capture"]);
    expect(filed.body.hits[0]?.snippet).toContain("okapi");
  });

  it("finds notes, reminders, threads and Balance tasks, and narrows by kind", async () => {
    addNote(db, "note", "Call the pangolin keeper", null, NOW.getTime());
    addNote(db, "reminder", "Feed the axolotl tomorrow", NOW.getTime() + 86_400_000, NOW.getTime());
    expect((await search("q=pangolin")).body.hits.map((hit) => hit.kind)).toEqual(["desk-note"]);
    expect((await search("q=axolotl")).body.hits.map((hit) => hit.kind)).toEqual(["desk-reminder"]);
    expect((await search("q=zebrafish&kinds=studio-thread")).body.hits.map((hit) => hit.kind)).toEqual(["studio-thread"]);
    const both = await search("q=quokka&kinds=balance-task,studio-thread");
    expect(both.body.hits.map((hit) => [hit.kind, hit.id])).toEqual([["balance-task", "task-1"]]);
    expect(both.body.hits[0]?.open).toEqual({ method: "GET", path: "/api/desk/balance-surfaces/task", query: { ref: "task-1", area: "lab" } });
    expect((await search("q=quokka&kinds=studio-thread")).body.status).toBe("empty");
  });

  it("finds a Desk item by its title", async () => {
    addNote(db, "reminder", "Water the okra seedlings", NOW.getTime() - 1000, NOW.getTime() - 5000);
    const result = await search("q=okra&kinds=desk-item");
    expect(result.body.hits.map((hit) => hit.kind)).toEqual(["desk-item"]);
    expect(result.body.hits[0]?.open).toEqual({ method: "GET", path: "/api/desk", query: {} });
  });

  it("never reveals a Balance task in an area the Desk does not list", async () => {
    const result = await search("q=vault");
    expect(result.body).toEqual({ status: "empty", hits: [], next: null, unavailableKinds: [] });
  });

  it("pages newest first without repeats and ends with next null", async () => {
    for (let i = 1; i <= 5; i++) addNote(db, "note", `heron entry ${i}`, null, NOW.getTime() + i * 1000);
    const seen: string[] = [];
    let url: string | null = "/api/desk/search?q=heron&limit=2";
    let pages = 0;
    while (url) {
      const page = await search(url.split("?")[1] ?? "");
      seen.push(...page.body.hits.map((hit) => hit.title));
      url = page.body.next;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(["heron entry 5", "heron entry 4", "heron entry 3", "heron entry 2", "heron entry 1"]);
  });

  it("answers empty, refuses bad input with a phrase and answers 503 when the Desk is off", async () => {
    expect((await search("q=nothingmatchesthis")).body).toMatchObject({ status: "empty", hits: [], next: null });
    for (const query of ["q=", `q=${"x".repeat(201)}`, "q=a&limit=21", "q=a&offset=501", "q=a&kinds=mail"]) {
      const refused = await search(query);
      expect(refused.status).toBe(400);
      expect(refused.body.messagePhrase?.code).toBe("act.invalid");
    }
    enabled = false;
    expect((await search("q=a")).status).toBe(503);
  });

  it("keeps Studio kinds available when the Studio directory has no .git", async () => {
    await file("Remember the narwhal sonar idea.", toInbox);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const result = await search("q=narwhal");
    expect(result.body.unavailableKinds ?? []).toEqual([]);
    expect(result.body.hits.map((hit) => hit.kind)).toEqual(["studio-capture"]);
  });

  it("lists the Studio kinds as unavailable and still answers the others when Studio is not configured", async () => {
    addNote(db, "note", "Call the pangolin keeper", null, NOW.getTime());
    studio = undefined;
    const result = await search("q=pangolin");
    expect(result.body.unavailableKinds).toEqual(["studio-capture", "studio-thread"]);
    expect(result.body.hits.map((hit) => hit.kind)).toEqual(["desk-note"]);
  });
});
