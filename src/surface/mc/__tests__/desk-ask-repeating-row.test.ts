import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { handleDeskAsk, handleDeskCreate } from "../api/desk-ask";
import { handleDeskMyDay } from "../api/desk-my-day";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { saveBalanceState } from "../desk/balance-store";
import { askDesk } from "../dashboard-v2/lib/desk-ask";
import type { RoutineOptions, RoutineRunner } from "../desk/routine-command";
import { DEFAULT_SETTINGS, type AppState, type OutlineNode } from "../../../balance";

const NOW = new Date("2026-11-16T10:00:00").getTime();
const ROUTINES: RoutineOptions = { composer: ["composer"], reflex: ["reflex"], target: "@example/pulse-flow", timeZone: "Europe/Zurich", timeoutSeconds: 10, composeTimeoutSeconds: 10, readTimeoutSeconds: 1 };
const YAML = "name: F_READ\nactions:\n  - A_EXTRACT_URLS # sovereignty: D, residency: CH\n";
const TEXT = "every Monday at 9 call the bank";
const WEEKLY_MONDAY = { unit: "week", interval: 1, weekdays: [1] };

const area = (id: string, title: string): OutlineNode => ({ id: `area:${id}`, title, weight: 50, ordering: "parallel", children: [] });
const seed = (): AppState => ({
  outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [area("work", "Work"), area("home", "Home")] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});

interface Proposal { kind: string; label: string; fields: Record<string, unknown>; problem?: string; unwritable?: true }
interface Asked { status: number; body: { ok: boolean; error?: string; proposal?: Proposal; proposals?: Proposal[] } }

describe("recurring text offers a repeating row first and a routine second", () => {
  let db: Database;
  let composed: string[][];
  const run: RoutineRunner = async (argv) => {
    if (argv[0] === "composer") composed.push(argv);
    return { code: 0, stdout: JSON.stringify({ status: "complete", yaml: YAML }), stderr: "" };
  };
  const options = (routines: RoutineOptions | undefined): DeskOptions => ({
    enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], assistantName: "Ivy",
    areas: [{ id: "work", label: "Work", color: "", repos: [], goals: [] }, { id: "home", label: "Home", color: "", repos: [], goals: [], policy: "local" }],
    ...(routines ? { routines } : {}),
  });
  const runtime = (routines: RoutineOptions | null = ROUTINES): DeskRuntime => ({ options: options(routines ?? undefined), ledger: new HandledLedger() });
  const post = (body: unknown): Request => new Request("http://localhost/api/desk/ask", { method: "POST", body: JSON.stringify(body) });
  const ask = async (body: Record<string, unknown>, desk: DeskRuntime = runtime()): Promise<Asked> => {
    const response = await handleDeskAsk(post(body), desk, { now: () => NOW, runRoutine: run }, db);
    return { status: response.status, body: await response.json() as Asked["body"] };
  };
  const create = async (body: Record<string, unknown>, desk: DeskRuntime = runtime()) => {
    const response = await handleDeskCreate(post(body), db, desk, { now: () => NOW, runRoutine: run });
    return { status: response.status, body: await response.json() as { ok: boolean; id?: string; error?: string } };
  };
  const outline = async (): Promise<OutlineNode> => {
    const response = await handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db, runtime(), undefined, NOW);
    return ((await response.json()) as { outline: OutlineNode }).outline;
  };

  beforeEach(() => {
    db = initDatabase(":memory:");
    saveBalanceState(db, seed());
    composed = [];
  });
  afterEach(() => { db.close(); });

  it("offers the row, then the routine, without running the composer", async () => {
    const { status, body } = await ask({ text: TEXT, area: "work" });
    expect(status).toBe(200);
    expect(body.proposals?.map(p => [p.kind, p.label])).toEqual([["row", "Repeat it for me"], ["routine", "Have Ivy do it"]]);
    expect(body.proposals?.[0]).toMatchObject({ fields: { title: "call the bank", area: "work", repeat: WEEKLY_MONDAY } });
    expect(body.proposals?.[0]?.problem).toBeUndefined();
    expect(body.proposals?.[1]?.problem).toBeUndefined();
    expect(body.proposal).toEqual(body.proposals?.[0]);
    expect(composed).toHaveLength(0);
  });

  it("composes today's routine card when the client chooses the routine", async () => {
    const { status, body } = await ask({ text: TEXT, area: "work", choice: "routine" });
    expect(status).toBe(200);
    expect(composed).toHaveLength(1);
    expect(body.proposal).toMatchObject({ kind: "routine", fields: { proposalId: expect.any(String), title: "call the bank", steps: expect.any(Array) } });
    expect(body.proposals).toBeUndefined();
  });

  it("lets the Routine workspace ask for the routine choice through the dashboard client", async () => {
    const answer = await askDesk(TEXT, (_path, init) => handleDeskAsk(new Request("http://localhost/api/desk/ask", init), runtime(), { now: () => NOW, runRoutine: run }, db), undefined, "routine");
    expect(answer).toMatchObject({ ok: true, proposal: { kind: "routine", fields: { proposalId: expect.any(String) } } });
    expect(composed).toHaveLength(1);
  });

  it("refuses the routine choice for text that does not repeat", async () => {
    const { status } = await ask({ text: "note the bank called", choice: "routine" });
    expect(status).toBe(400);
    expect(composed).toHaveLength(0);
  });

  it("keeps the row writable and blocks the routine when the text has no time", async () => {
    const { body } = await ask({ text: "every Monday call the bank", area: "work" });
    const [row, routine] = body.proposals ?? [];
    expect(row).toMatchObject({ kind: "row", fields: { title: "call the bank", repeat: WEEKLY_MONDAY } });
    expect(row?.problem).toBeUndefined();
    expect(row?.unwritable).toBeUndefined();
    expect(routine).toMatchObject({ kind: "routine", problem: expect.stringMatching(/^Include a time/), unwritable: true });
    expect(composed).toHaveLength(0);
  });

  it("offers the row alone when routines are not set up", async () => {
    const { body } = await ask({ text: TEXT, area: "work" }, runtime(null));
    expect(body.proposals?.map(p => p.kind)).toEqual(["row"]);
    expect(body.proposal).toEqual(body.proposals?.[0]);
  });

  it("offers the routine alone for a minute or hour interval", async () => {
    const { body } = await ask({ text: "every 15 minutes, check the queue", area: "work" });
    expect(body.proposals?.map(p => p.kind)).toEqual(["routine"]);
    expect(body.proposal).toEqual(body.proposals?.[0]);
  });

  it("reads a day, a weekday list and every weekday as repeats", async () => {
    const repeat = async (text: string) => (await ask({ text, area: "work" })).body.proposals?.[0]?.fields.repeat;
    expect(await repeat("every day at 8 water the plants")).toEqual({ unit: "day", interval: 1 });
    expect(await repeat("every morning stretch")).toEqual({ unit: "day", interval: 1 });
    expect(await repeat("every weekday at 7:30 read the news")).toEqual({ unit: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] });
  });

  it("asks for an area when none was given, and writes once the client sets one", async () => {
    const { body } = await ask({ text: TEXT });
    const row = body.proposals?.[0];
    expect(row).toMatchObject({ kind: "row", problem: "Which area should this go in?" });
    expect(row?.unwritable).toBeUndefined();
    expect((await create({ requestId: "row-without-area", kind: "row", fields: row?.fields })).status).toBe(400);
    const written = await create({ requestId: "row-with-area", kind: "row", fields: { ...row?.fields, area: "work" } });
    expect(written).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("offers the row and blocks the routine under a provider restriction, and refuses the routine choice unchanged", async () => {
    const { body } = await ask({ text: TEXT, area: "home" });
    expect(body.proposals?.map(p => p.kind)).toEqual(["row", "routine"]);
    expect(body.proposals?.[0]?.problem).toBeUndefined();
    expect(body.proposals?.[1]).toMatchObject({ problem: "The routine composer cannot enforce this request's provider restriction.", unwritable: true });
    expect((await ask({ text: TEXT, area: "home", choice: "routine" })).status).toBe(409);
    expect(composed).toHaveLength(0);
  });

  it("writes the row under the chosen area with its repeat, and My day returns it", async () => {
    const { body } = await ask({ text: TEXT, area: "work" });
    const row = body.proposals?.[0];
    const written = await create({ requestId: "row-written", kind: "row", fields: row?.fields });
    const id = written.body.id;
    expect(written.status).toBe(200);
    expect(typeof id).toBe("string");
    expect((await create({ requestId: "row-written", kind: "row", fields: row?.fields })).status).toBe(409);
    const work = (await outline()).children.find(node => node.id === "area:work");
    const added = work?.children.find(node => node.id === id);
    expect(added).toMatchObject({ title: "call the bank", repeat: { ...WEEKLY_MONDAY, mode: "calendar" } });
    expect(work?.children).toHaveLength(1);
  });
});
