import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { DESK_API_VERSION, type DeskStudioResponse, type StudioLookResponse } from "../../../desk-api";
import { handleGetDeskStudio } from "../api/desk-studio";
import { handleDeskStudioLook } from "../api/desk-studio-look";
import { handleDeskStudioAct } from "../api/desk-studio-act";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { startServer } from "../server";

const NOW = new Date(2026, 10, 19, 10).getTime();
const post = () => new Request("http://localhost/api/desk/studio/look", { method: "POST" });

describe("Studio board and shared last look", () => {
  let dir: string;
  let db: Database;
  let options: DeskOptions;
  const runtime = (over: Partial<DeskOptions> = {}): DeskRuntime => ({ options: { ...options, ...over }, ledger: new HandledLedger() });
  const read = async (who = runtime(), now = NOW): Promise<DeskStudioResponse> => (await handleGetDeskStudio(who, undefined, { db, now: () => now })).json();
  const rows = () => db.query("SELECT * FROM desk_studio_look").all();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "studio-look-"));
    db = initDatabase(":memory:");
    options = { enabled: true, assistantName: "Assistant", displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "lab", label: "Lab", color: "#2563eb", repos: [], goals: [] }], sources: [], studio: { dir, maxActive: 3 }, routineScope: { principal: "principal", stack: "test" } };
    for (const folder of ["threads", "inbox", "proposals"]) mkdirSync(join(dir, folder));
    for (const slug of ["alpha", "beta"]) writeFileSync(join(dir, `threads/${slug}.md`), `---
type: question
areas: [lab]
state: active
opened: 2026-11-01
---
## Question
What comes next for ${slug}?
## Assistant's notes
### 2026-11-18T10:00:00Z
trigger: stale
model: local
kind: note
status: open
A thought.
## Material
- link: [Shared source](https://example.org/source)
`);
    writeFileSync(join(dir, "inbox/capture.md"), "---\nat: 2026-11-18T10:00:00Z\nvia: voice\ntarget: { thread: alpha, reason: source }\n---\nA capture.\n");
    writeFileSync(join(dir, "proposals/proposal.md"), "---\ntype: topic\nareas: [lab]\nproposed: 2026-11-18T10:00:00Z\ntarget: { place: new, area: lab, reason: source }\n---\n## Question\nA proposed thread?\n");
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("serves board facts from files and leaves GET side-effect free", async () => {
    const response = await handleGetDeskStudio(runtime(), undefined, { db, now: () => NOW });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body: DeskStudioResponse = await response.json();
    expect(body.studio?.board).toEqual({
      inbox: [{ id: "capture", target: { kind: "thread", slug: "alpha", place: 1, why: "named-thread" } }],
      proposals: [{ id: "proposal", target: { kind: "free", place: 3, area: "lab", why: "first-free" } }],
      shared: [{ a: "alpha", b: "beta", label: "Shared source" }],
      freePlaces: [3], waiting: 2, look: { since: NOW - 86_400_000, kind: "day" },
    });
    await read();
    expect(rows()).toEqual([]);
  });

  it("sets request time with no body, shares it across clients, and scopes it by both principal and stack", async () => {
    const response = handleDeskStudioLook(post(), db, runtime(), () => NOW);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, at: NOW });
    expect((await read(runtime(), NOW + 1000)).studio?.board.look).toEqual({ since: NOW, kind: "since-look" });
    const otherPrincipal = runtime({ routineScope: { principal: "other", stack: "test" } });
    const otherStack = runtime({ routineScope: { principal: "principal", stack: "other" } });
    for (const other of [otherPrincipal, otherStack]) {
      expect((await read(other)).studio?.board.look.kind).toBe("day");
      expect(handleDeskStudioLook(post(), db, other, () => NOW - 1000).status).toBe(200);
    }
    expect(handleDeskStudioLook(post(), db, runtime(), () => NOW + 2000).status).toBe(200);
    expect(rows()).toHaveLength(3);
    expect((await read(runtime(), NOW + 3000)).studio?.board.look).toEqual({ since: NOW + 2000, kind: "since-look" });
    await read(runtime(), NOW + 4000);
    expect((await read(runtime(), NOW + 5000)).studio?.board.look.since).toBe(NOW + 2000);
  });

  it("uses the server's local midnight for the overnight window", async () => {
    const today = new Date(NOW);
    today.setHours(0, 0, 0, 0);
    const at = today.getTime() - 3 * 3_600_000;
    handleDeskStudioLook(post(), db, runtime(), () => at);
    expect((await read()).studio?.board.look).toEqual({ since: at, kind: "overnight" });
  });

  it("keeps disabled Studio responses consistent and stores nothing", async () => {
    for (const who of [undefined, runtime({ enabled: false }), runtime({ studio: undefined })]) {
      const response = handleDeskStudioLook(post(), db, who, () => NOW);
      const act = await handleDeskStudioAct(post(), who);
      expect(response.status).toBe(409);
      expect(response.status).toBe(act.status);
      expect(await response.json()).toEqual(await act.json());
      expect(await (await handleGetDeskStudio(who, undefined, { db })).json()).toEqual({ studio: null });
    }
    expect(rows()).toEqual([]);
  });

  it("refuses an absent scope and methods other than POST without changing an existing look", async () => {
    handleDeskStudioLook(post(), db, runtime(), () => NOW);
    expect(handleDeskStudioLook(post(), db, runtime({ routineScope: undefined }), () => NOW + 1).status).toBe(409);
    const response = handleDeskStudioLook(new Request(post().url), db, runtime(), () => NOW + 2);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect((await read()).studio?.board.look.since).toBe(NOW);
    expect(rows()).toHaveLength(1);
  });

  it("persists a look across database and runtime reopens", async () => {
    db.close();
    const path = join(dir, "desk.sqlite");
    db = initDatabase(path);
    handleDeskStudioLook(post(), db, runtime(), () => NOW);
    db.close();
    db = initDatabase(path);
    expect((await read()).studio?.board.look).toEqual({ since: NOW, kind: "since-look" });
    expect(rows()).toHaveLength(1);
  });

  it("serves the curl POST then GET probe with version headers and rejects rebound hosts and origins", async () => {
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0 }, db, { desk: options });
    const base = `http://127.0.0.1:${ctx.port}`;
    const curl = async (args: string[]) => {
      const child = Bun.spawn(["curl", "--silent", "--show-error", "--max-time", "10", ...args], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return output;
    };
    try {
      const before = Date.now();
      const looked: StudioLookResponse = JSON.parse(await curl(["-X", "POST", `${base}/api/desk/studio/look`]));
      expect(looked.ok).toBe(true);
      if (!looked.ok) throw new Error(looked.error);
      expect(looked.at).toBeGreaterThanOrEqual(before);
      expect(looked.at).toBeLessThanOrEqual(Date.now());
      const output = await curl(["--include", `${base}/api/desk/studio`]);
      const boundary = output.indexOf("\r\n\r\n");
      expect(output.slice(0, boundary).toLowerCase()).toContain(`x-desk-api-version: ${DESK_API_VERSION}`);
      const body: DeskStudioResponse = JSON.parse(output.slice(boundary + 4));
      expect(body.studio?.board.look).toEqual({ since: looked.at, kind: "since-look" });
      for (const headers of [new Headers({ Host: "evil.example" }), new Headers({ Origin: "https://evil.example" })]) {
        const denied = await fetch(`${base}/api/desk/studio/look`, { method: "POST", headers });
        expect(denied.status).toBe(403);
      }
      expect((await read()).studio?.board.look.since).toBe(looked.at);
      const wrongMethod = await fetch(`${base}/api/desk/studio/look`);
      expect(wrongMethod.status).toBe(405);
      const response = await fetch(`${base}/api/desk/studio/look`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally { ctx.stop(true); }
  });
});
