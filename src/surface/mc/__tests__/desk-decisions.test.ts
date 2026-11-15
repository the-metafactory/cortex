import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskAction } from "../api/desk-action";
import { handleDeskRuling } from "../api/desk-ruling";
import { HandledLedger, type RangerRunner } from "../desk/actions";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { DECISION_RETENTION_MS, DecisionStore, decisionDay, readDecisions } from "../desk/decisions";
import { RulingLedger } from "../desk/ruling";
import type { RangerState } from "../desk/sources/ranger";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { startServer } from "../server";

const NOW = Date.parse("2026-10-31T09:00:00.000Z");
const CLI = { bin: "/opt/ranger/bin/ranger", config: "" };
const DESK: DeskOptions = { enabled: true, displayName: "Ada", topN: 5, rangerUrl: "http://127.0.0.1:1", rangerCli: CLI, somaBin: "/opt/soma/bin/soma", areas: [], sources: [] };
const KEY = "ranger:example/app#12";
const ok = { code: 0, stdout: "", stderr: "" };

const state = (queued = false): RangerState => ({
  current: [],
  maps: [{ key: "example/app#1", repo: "example/app", lane: "headless", walk: "full", decisions: [{ id: "30", title: "Ship the exporter", approvable: true, approvalVersion: "v1" }, { id: "99", title: "Holder task" }] }],
  laneHolders: { headless: { repo: "example/app", nodeId: "99" }, visual: null },
  needsYou: [{
    key: "example/app#1", repo: "example/app", nodeId: "12", title: "Pick the export format", status: "parked", endedAt: "2026-10-31T08:00:00.000Z",
    reason: { class: "blocked", detail: "resume once: pick one — blocked" }, queued: null, actions: { resume: true, queueResume: { offered: queued } },
  }],
});

const post = (path: string, body: Record<string, unknown>) => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });

describe("the Desk decisions list", () => {
  let db: Database;
  let clock: number;
  let runtime: DeskRuntime;
  let soma: string[][];
  beforeEach(() => {
    db = initDatabase(":memory:");
    clock = NOW;
    soma = [];
    runtime = { options: DESK, ledger: new HandledLedger(), rulings: new RulingLedger(), decisions: new DecisionStore(db, () => clock) };
  });
  afterEach(() => db.close());

  const rule = (requestId: string, text: string, ranger: RangerRunner, fetchState: RangerState = state(), key = KEY) =>
    handleDeskRuling(post("/api/desk/ruling", { key, text, requestId }), runtime, {
      soma: async argv => { soma.push(argv); return node(argv) ?? ok; },
      ranger, fetchImpl: async () => Response.json(fetchState), now: () => clock,
      readSubject: () => ({ vocab: "escalation", value: "needs-principal", ref: "example/app#40", healthy: false }),
    });
  const node = (argv: string[]) => argv[2] === "node" ? { code: 0, stdout: JSON.stringify({ typed: true, status: "open", ref: { id: argv[3] } }), stderr: "" } : null;
  const view = async () => (await composeDesk(db, DESK, { enabled: false }, { now: clock })).decisions;

  it("keeps a saved ruling visible when the resume fails, and a repeat only moves the outcome", async () => {
    const failed = await rule("req-00000001", "Use CSV for example/app.", async () => ({ code: 1, stdout: "", stderr: "lane unavailable" }));
    expect(failed.status).toBe(502);
    const first = (await view())[0]!;
    expect(first).toMatchObject({ key: KEY, title: "Pick the export format", action: "ranger.rule", text: "Use CSV for example/app.", decidedAt: NOW, withdrawable: false, supersededBy: null, target: { repo: "example/app", nodeId: "12", link: "https://github.com/example/app/issues/12" }, outcome: { state: "failed", detail: "lane unavailable" } });

    clock += 60_000;
    expect((await rule("req-00000001", "Use CSV for example/app.", async () => ok)).status).toBe(200);
    const after = await view();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: first.id, decidedAt: NOW, text: "Use CSV for example/app.", outcome: { state: "accepted" } });
    expect(soma.filter(argv => argv[2] === "rule")).toHaveLength(1);
  });

  it("never downgrades an accepted resume when a repeat is refused as already sent", async () => {
    await rule("req-00000002", "Use JSON.", async () => ok);
    const repeat = await rule("req-00000002", "Use JSON.", async () => ok);
    expect(repeat.status).toBe(502);
    expect((await view())[0]?.outcome.state).toBe("accepted");
  });

  it("records a queued resume as queued", async () => {
    await rule("req-00000003", "Use CSV.", async () => ok, state(true));
    expect((await view())[0]?.outcome).toMatchObject({ state: "queued" });
  });

  it("records an escalation ruling that triggers no Ranger call as not requested", async () => {
    const res = await rule("req-00000004", "Ship it.", async () => { throw new Error("no ranger"); }, state(), "vigil:state:escalation:default:example/app#40");
    expect(res.status).toBe(200);
    expect((await view())[0]).toMatchObject({ key: "vigil:state:escalation:default:example/app#40", title: "example/app#40", outcome: { state: "not-requested" }, target: { nodeId: "40" } });
  });

  it("does not list invalid or refused rulings", async () => {
    expect((await handleDeskRuling(post("/api/desk/ruling", { key: KEY, text: "", requestId: "req-00000005" }), runtime)).status).toBe(400);
    const refused = await handleDeskRuling(post("/api/desk/ruling", { key: KEY, text: "x", requestId: "req-00000006" }), runtime, {
      soma: async () => ({ code: 1, stdout: "", stderr: "graph said no" }), fetchImpl: async () => Response.json(state()), now: () => clock,
    });
    expect(refused.status).toBe(502);
    expect(await view()).toEqual([]);
  });

  it("supersedes an earlier ruling on the same target without changing it", async () => {
    await rule("req-00000007", "Use CSV.", async () => ok);
    clock += 1000;
    await rule("req-00000008", "Actually JSON.", async () => ok);
    const later = (await view())[0]!;
    const earlier = (await view())[1];
    expect(later).toMatchObject({ text: "Actually JSON.", supersededBy: null });
    expect(earlier).toMatchObject({ text: "Use CSV.", supersededBy: { id: later.id, decidedAt: later.decidedAt } });
  });

  it("records accepted approve, retry and run-now actions and skips refused ones", async () => {
    const act = (action: string, key: string, run: RangerRunner, s = state()) => handleDeskAction(post("/api/desk/action", { action, key }), runtime, { run, fetchImpl: async () => Response.json(s), now: () => clock });
    expect((await act("ranger.approve", "ranger:example/app#30", async () => ok)).status).toBe(200);
    clock += 1;
    expect((await act("ranger.retry", KEY, async () => ({ code: 1, stdout: "", stderr: "no" }))).status).toBe(502);
    expect((await act("ranger.retry", KEY, async () => ok)).status).toBe(200);
    expect((await act("ranger.approve", "ranger:example/app#30", async () => ok)).status).toBe(409);
    clock += 1;
    const queued = state(true);
    queued.needsYou[0]!.queued = { lane: "headless", position: 1 };
    runtime.ledger = new HandledLedger();
    expect((await act("ranger.run-now", KEY, async () => ok, queued)).status).toBe(200);
    expect((await view()).map((d: { action: string; title: string; text: unknown }) => [d.action, d.title, d.text])).toEqual([
      ["ranger.run-now", "Pick the export format", null], ["ranger.retry", "Pick the export format", null], ["ranger.approve", "Ship the exporter", null],
    ]);
    expect(await view()).toHaveLength(3);
  });

  it("serves every decision of the day, newest first with an id tie-break, not capped at ten", async () => {
    for (let n = 0; n < 14; n++) runtime.decisions!.record({ operationKey: `ruling:bulk-${n}`, itemKey: KEY, action: "ranger.rule", target: { repo: "example/app", nodeId: String(100 + n) }, title: `t${n}`, text: "x", outcome: { state: "pending" } });
    const list = await view();
    expect(list).toHaveLength(14);
    const ids = list.map((d: { id: string }) => d.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("keeps decisions across a database reopen, with pending staying pending", async () => {
    const dir = join(tmpdir(), `desk-decisions-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const file = initDatabase(join(dir, "mc.db"));
      new DecisionStore(file, () => NOW).record({ operationKey: "ruling:reopen-1", itemKey: KEY, action: "ranger.rule", target: { repo: "example/app", nodeId: "12" }, title: "T", text: "Keep me", outcome: { state: "pending" } });
      file.close();
      const reopened = initDatabase(join(dir, "mc.db"));
      expect(readDecisions(reopened, NOW + 1000)[0]).toMatchObject({ text: "Keep me", outcome: { state: "pending" } });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expires entries 90 elapsed days after the decision", () => {
    const store = new DecisionStore(db, () => NOW);
    store.record({ operationKey: "ruling:old", itemKey: KEY, action: "ranger.rule", target: { repo: "example/app", nodeId: "12" }, title: "T", text: "old", outcome: { state: "accepted" } });
    expect(readDecisions(db, NOW + DECISION_RETENTION_MS - 1)).toHaveLength(0);
    new DecisionStore(db, () => NOW + DECISION_RETENTION_MS + 1).record({ operationKey: "ruling:new", itemKey: KEY, action: "ranger.rule", target: { repo: "example/app", nodeId: "13" }, title: "N", text: "new", outcome: { state: "accepted" } });
    expect(db.query("SELECT operation_key FROM desk_decisions").all()).toEqual([{ operation_key: "ruling:new" }]);
  });

  it("prunes expired entries on a read with no new decision", () => {
    new DecisionStore(db, () => NOW).record({ operationKey: "ruling:old", itemKey: KEY, action: "ranger.rule", target: { repo: "example/app", nodeId: "12" }, title: "T", text: "old", outcome: { state: "accepted" } });
    readDecisions(db, NOW + DECISION_RETENTION_MS + 1);
    expect(db.query("SELECT operation_key FROM desk_decisions").all()).toEqual([]);
  });

  it("follows the stack's calendar day across midnight and a DST change", () => {
    const saved = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const springDay = new Date(2026, 2, 8, 12).getTime();
      const { start, end } = decisionDay(springDay);
      expect((end - start) / 3_600_000).toBe(23);
      const store = (at: number) => new DecisionStore(db, () => at);
      store(start - 1).record({ operationKey: "ruling:before", itemKey: KEY, action: "ranger.rule", target: { repo: "example/app", nodeId: "1" }, title: "before", text: "b", outcome: { state: "accepted" } });
      store(start).record({ operationKey: "ruling:first", itemKey: KEY, action: "ranger.rule", target: { repo: "example/app", nodeId: "2" }, title: "first", text: "f", outcome: { state: "accepted" } });
      expect(readDecisions(db, end - 1).map(d => d.title)).toEqual(["first"]);
      expect(readDecisions(db, end + 1).map(d => d.title)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe("the decisions list through the running stack", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `desk-decisions-live-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const script = (name: string, body: string): string => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("serves submitted decisions to the principal across a restart, refuses a stranger without leaking, and keeps a failed resume", async () => {
    const soma = script("soma", 'if [ "$2" = "node" ]; then echo \'{"typed":true,"status":"open","ref":{"id":"12"}}\'; fi');
    const ranger = script("ranger", `case "$1" in approve-node) exit 0;; resume-node) echo "lane broke" >&2; exit 1;; esac`);
    const fake = Bun.serve({ port: 0, fetch: () => Response.json(state()) });
    const config = { ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"] } };
    const desk = { ...DESK, rangerUrl: `http://127.0.0.1:${fake.port}`, rangerCli: { bin: ranger, config: "" }, somaBin: soma };
    const file = join(dir, "mc.db");
    const call = (base: string, email: string, path: string, body?: Record<string, unknown>) => fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", origin: base, "Cf-Access-Authenticated-User-Email": email },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const principal = "principal@example.com";
    let ctx = startServer(config, initDatabase(file), { desk });
    let base = `http://localhost:${ctx.server.port}`;
    try {
      expect((await call(base, principal, "/api/desk/ruling", { key: KEY, text: "Use CSV for example/app.", requestId: "live-request-1" })).status).toBe(502);
      expect((await call(base, principal, "/api/desk/action", { action: "ranger.approve", key: "ranger:example/app#30" })).status).toBe(200);
      const before = (await (await call(base, principal, "/api/desk")).json()).decisions;
      expect(before.map((d: { action: string }) => d.action).sort()).toEqual(["ranger.approve", "ranger.rule"]);

      const deniedRuling = await call(base, "unlisted@example.com", "/api/desk/ruling", { key: KEY, text: "Sneaky", requestId: "live-request-2" });
      expect(deniedRuling.status).toBe(403);
      const denial = await deniedRuling.text();
      expect(denial).not.toContain("Sneaky");
      expect(denial).not.toContain("example/app");
      const deniedAction = await call(base, "unlisted@example.com", "/api/desk/action", { action: "ranger.retry", key: KEY });
      expect(deniedAction.status).toBe(403);

      ctx.stop(true);
      ctx = startServer(config, initDatabase(file), { desk });
      base = `http://localhost:${ctx.server.port}`;
      const after = (await (await call(base, principal, "/api/desk")).json()).decisions;
      expect(after).toEqual(before);
      expect(after.find((d: { action: string }) => d.action === "ranger.rule")).toMatchObject({ text: "Use CSV for example/app.", outcome: { state: "failed", detail: "lane broke" } });
    } finally {
      ctx.stop(true);
      fake.stop(true);
    }
  });
});
