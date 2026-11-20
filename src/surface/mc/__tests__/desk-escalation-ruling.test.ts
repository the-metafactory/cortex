import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { getVigilSubject, writeVigilSubject } from "../../../vigil/db";
import { listVigilSubjects } from "../../../vigil/subjects-view";
import { handleDeskRuling } from "../api/desk-ruling";
import { HandledLedger, type RangerRunner } from "../desk/actions";
import { composeCurrentDay, composeDesk, currentDayItems, type DeskOptions } from "../desk/compose";
import { EscalationRulings, escalationEntries, RULING_STATUS_FRESH_MS, RULING_STATUS_RETRY_MS, explainRuling, RULING_BODY_UNREADABLE, RULING_MODEL_FAILED, RULING_NOT_GROUNDED, RULING_NO_MODEL, RULING_POLICY_REFUSED, RulingExplainLoop, RulingLedger } from "../desk/ruling";
import type { WaitingTask } from "../desk/sources/waiting";
import { initDatabase } from "../db/init";

const NOW = Date.parse("2026-11-14T09:00:00Z");
const REF = "example/app#12";
const SUBJECT = `state:escalation:default:${REF}`;
const KEY = `vigil:${SUBJECT}`;
const BODY = "## Question\n\nShould example/app export CSV or JSON? Picking one lets the export work continue.";
const EXPLANATION = {
  sentence: "The export in example/app needs a choice between CSV and JSON so the export work can continue.",
  choices: [
    { label: "Choose CSV", consequence: "The export work can continue with CSV.", ruling: "Use CSV for the export in example/app." },
    { label: "Choose JSON", consequence: "The export work can continue with JSON.", ruling: "Use JSON for the export in example/app." },
  ],
};
const DESK: DeskOptions = { enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", somaBin: "/opt/soma/bin/soma", areas: [], sources: [] };
const TASKS = new Map<string, WaitingTask>([[REF, { kind: "open", title: "Pick an export format", question: "CSV or JSON?", body: BODY, url: "https://github.com/example/app/issues/12" }]]);
const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
const node = (typed = true, status = "open", id = "12") => result(JSON.stringify({ ref: { id }, typed, status }));
const post = (extra: Record<string, unknown> = {}) => new Request("http://localhost/api/desk/ruling", { method: "POST", body: JSON.stringify({ key: KEY, text: EXPLANATION.choices[0]!.ruling, requestId: "escalation-0001", ...extra }) });

describe("Vigil escalation explanations and answers", () => {
  let db: Database;
  beforeEach(() => {
    db = initDatabase(":memory:");
    writeVigilSubject(db, { subject_key: SUBJECT, subject_kind: "state", vocab: "escalation", ref: REF, value: "needs-principal", healthy: 0, goal_id: null, producer: "soma", stack: "default", run_kind: null, last_run_id: "run-1", last_ended_at: NOW, last_seen_at: NOW }, NOW);
  });
  afterEach(() => db.close());
  const entries = async () => escalationEntries(await listVigilSubjects(db), TASKS);
  const compose = async (soma: RangerRunner, rulingExplain?: RulingExplainLoop, desk = DESK) => {
    const escalationRulings = new EscalationRulings(desk.somaBin ?? "", soma);
    await escalationRulings.warm([REF]);
    return composeDesk(db, desk, { enabled: true }, { escalationRulings, rulingExplain, now: NOW, waitingTasks: { read: async () => TASKS } });
  };
  const runtime = () => ({ options: DESK, ledger: new HandledLedger(), rulings: new RulingLedger() });
  const deps = (soma: RangerRunner) => ({ soma, readSubject: (key: string) => getVigilSubject(db, key), ranger: async () => { throw new Error("Escalations must not call Ranger"); }, fetchImpl: async () => { throw new Error("Escalations must not read Ranger"); } });

  it("reads the escalated issue body through the shared explainer and offers choices with a graph answer action", async () => {
    const reads: string[][] = [];
    const prompts: unknown[] = [];
    const loop = new RulingExplainLoop(async prompt => { prompts.push(JSON.parse(prompt)); return EXPLANATION; }, async (repo, id) => { reads.push([repo, id]); return BODY; });
    await loop.warm(await entries());
    const view = await compose(async () => node(), loop);
    const card = view.items.find(item => item.key === KEY)!;
    expect(reads).toEqual([["example/app", "12"]]);
    expect(prompts).toEqual([expect.objectContaining({ repo: "example/app", node: "12", body: BODY })]);
    expect(card.explanation).toEqual(EXPLANATION);
    expect(card.actions[0]).toEqual({ id: "ranger.rule", role: "primary", wired: true });
    expect(card.detail.summary).toContain("Answer from this card");
    expect(card.detail.links[0]?.url).toBe("https://github.com/example/app/issues/12");
  });

  it("applies cloud source policy before reading a private or unknown repository body", async () => {
    let reads = 0;
    const loop = new RulingExplainLoop(async () => EXPLANATION, async () => { reads++; return BODY; });
    const model = { baseUrl: "http://model.invalid", model: "test", sourcePolicy: "cloud" as const, timeoutSeconds: 10 };
    for (const areas of [[], [{ id: "private", label: "Private", color: "gray", repos: ["example/app"], goals: [], policy: "local" as const }]]) {
      const view = await compose(async () => node(), loop, { ...DESK, areas, rulingExplainer: model });
      expect(view.items[0]?.explanation).toBeUndefined();
      expect(view.items[0]?.detail.summary).toContain(RULING_POLICY_REFUSED);
    }
    expect(reads).toBe(0);
    const allowed = { ...DESK, areas: [{ id: "public", label: "Public", color: "gray", repos: ["example/app"], goals: [], policy: "cloud" as const }], rulingExplainer: model };
    await compose(async () => node(), loop, allowed);
    await loop.warm(await entries());
    expect((await compose(async () => node(), loop, allowed)).items[0]?.explanation).toEqual(EXPLANATION);
    expect(reads).toBe(2);
  });

  it.each(["currentDayItems", "composeCurrentDay"])("%s carries the configured escalation explanation into conversation context", async helper => {
    const rulingExplain = new RulingExplainLoop(async () => EXPLANATION, async () => BODY);
    await rulingExplain.warm(await entries());
    const options = { ...DESK, rulingExplainer: { command: ["/opt/explain"], timeoutSeconds: 10, sourcePolicy: "local" as const } };
    const context = { ...runtime(), options, rulingExplain, waitingTasks: { read: async () => TASKS } };
    const items = helper === "currentDayItems"
      ? await currentDayItems(db, context, { enabled: true }, NOW)
      : (await composeCurrentDay(db, context, options, { enabled: true }, NOW)).items;
    const card = items.find(item => item.key === KEY)!;
    expect(card.detail.summary).not.toContain(RULING_NO_MODEL);
    expect(card.explanation).toEqual(EXPLANATION);
  });

  it("bounds body reads and model calls across overlapping polls and warm calls", async () => {
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reads: string[] = [];
    let models = 0;
    const loop = new RulingExplainLoop(async () => { models++; return EXPLANATION; }, async (_repo, id) => {
      reads.push(id);
      await gate;
      return BODY;
    });
    const entry = (await entries())[0]!;
    const backlog = Array.from({ length: 9 }, (_, i) => ({ ...entry, nodeId: String(i + 1), itemKey: i % 2 ? `vigil:escalation-${i}` : undefined, reason: { class: i % 2 ? "escalation" : "blocked" } }));
    const irrelevant = { ...entry, nodeId: "99", itemKey: undefined, reason: { class: "worker failed" } };
    await loop.read(backlog.slice(0, 6));
    const warming = loop.warm([...backlog, irrelevant]);
    await loop.read([...backlog, irrelevant]);
    try {
      expect(reads).toHaveLength(4);
    } finally {
      release();
      await warming;
    }
    const cached = await loop.read([...backlog, irrelevant]);
    expect(cached.size).toBe(9);
    expect([...cached.values()].every(value => value.kind === "explained")).toBe(true);
    expect(new Set(reads).size).toBe(9);
    expect(reads).toHaveLength(9);
    expect(models).toBe(9);
  });

  it("names missing models, unreadable bodies, model failures and ungrounded answers", async () => {
    const entry = (await entries())[0]!;
    const cases = [
      [null, BODY, RULING_NO_MODEL],
      [async () => EXPLANATION, null, RULING_BODY_UNREADABLE],
      [async () => { throw new Error("unavailable"); }, BODY, RULING_MODEL_FAILED],
      [async () => ({ ...EXPLANATION, sentence: "Edit /invented/path in example/app." }), BODY, RULING_NOT_GROUNDED],
      [async () => ({ ...EXPLANATION, choices: [{ ...EXPLANATION.choices[0], ruling: "Edit /invented/path in example/app." }, EXPLANATION.choices[1]] }), BODY, RULING_NOT_GROUNDED],
    ] as const;
    for (const [explainer, body, line] of cases) expect(await explainRuling(entry, body, explainer)).toEqual({ kind: "unexplained", line });
    expect((await compose(async () => node())).items[0]?.detail.summary).toContain(RULING_NO_MODEL);
    const loop = new RulingExplainLoop(async () => EXPLANATION, async () => null);
    await loop.warm(await entries());
    expect((await compose(async () => node(), loop)).items[0]?.detail.summary).toContain(RULING_BODY_UNREADABLE);
  });

  it("only links the issue when the node is untyped, closed or unreadable", async () => {
    for (const read of [node(false), node(true, "closed"), result("not json"), result("", 1), node(true, "open", "99")]) {
      const card = (await compose(async () => read)).items[0]!;
      expect(card.actions.some(action => action.id === "ranger.rule")).toBe(false);
      expect(card.detail.summary).toContain("Answer on the issue.");
      expect(card.detail.links).toEqual([{ kind: "issue", url: "https://github.com/example/app/issues/12" }]);
    }
  });

  it("records from a fresh Vigil ref and fresh typed node read, never from posted target fields or Ranger", async () => {
    const calls: string[][] = [];
    const texts: string[] = [];
    const soma: RangerRunner = async argv => {
      calls.push(argv);
      if (argv[2] === "node") return node(true, "open", "13");
      texts.push(readFileSync(argv[argv.indexOf("--text-file") + 1]!, "utf8"));
      return result();
    };
    db.run("UPDATE vigil_subjects SET ref = ? WHERE subject_key = ?", ["example/other#13", SUBJECT]);
    const run = runtime();
    const response = await handleDeskRuling(post({ ref: "evil/repo#99", repo: "evil/repo", nodeId: "99" }), run, deps(soma));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, message: "Recorded your ruling on the escalated issue." });
    expect(calls[0]).toEqual([DESK.somaBin!, "graph", "node", "13", "--repo", "github:github.com/example/other", "--json"]);
    expect(calls[1]?.slice(0, 4)).toEqual([DESK.somaBin!, "graph", "rule", "13"]);
    expect(calls[1]?.slice(-3)).toEqual(["--repo", "github:github.com/example/other", "--json"]);
    expect(texts).toEqual([EXPLANATION.choices[0]!.ruling]);
    expect((await handleDeskRuling(post(), run, deps(soma))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("returns Soma's refusal, keeps the action, and records a retry once", async () => {
    let refuse = true;
    let writes = 0;
    const soma: RangerRunner = async argv => {
      if (argv[2] === "node") return node();
      writes++;
      return refuse ? result("", 1, "soma graph rule refused: permission denied") : result();
    };
    const run = runtime();
    const failed = await handleDeskRuling(post(), run, deps(soma));
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("Your ruling was not recorded: soma graph rule refused: permission denied");
    expect((await compose(soma)).items[0]?.actions[0]?.id).toBe("ranger.rule");
    refuse = false;
    expect((await handleDeskRuling(post(), run, deps(soma))).status).toBe(200);
    expect((await handleDeskRuling(post(), run, deps(soma))).status).toBe(200);
    expect(writes).toBe(2);
  });

  it("refuses stale subjects and ineligible graph reads before writing anything", async () => {
    let writes = 0;
    for (const read of [node(false), node(true, "closed"), result("broken"), result("", 1)]) {
      const soma: RangerRunner = async argv => { if (argv[2] !== "node") writes++; return read; };
      expect((await handleDeskRuling(post(), runtime(), deps(soma))).status).toBe(409);
    }
    db.run("UPDATE vigil_subjects SET healthy = 1 WHERE subject_key = ?", [SUBJECT]);
    const never: RangerRunner = async () => { throw new Error("must not run"); };
    expect((await handleDeskRuling(post(), runtime(), deps(never))).status).toBe(409);
    expect((await handleDeskRuling(post({ key: "vigil:missing" }), runtime(), deps(never))).status).toBe(409);
    expect(writes).toBe(0);
  });

  it("claims concurrent confirmations before the node read and writes once", async () => {
    let writes = 0;
    const soma: RangerRunner = async argv => { if (argv[2] === "node") return node(); writes++; return result(); };
    const run = runtime();
    const responses = await Promise.all([handleDeskRuling(post(), run, deps(soma)), handleDeskRuling(post(), run, deps(soma))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(writes).toBe(1);
  });
});


describe("escalation graph status refresh", () => {
  it("serves cold and cached status without waiting, deduplicates refs and bounds subprocesses", async () => {
    let running = 0;
    let peak = 0;
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reader = new EscalationRulings(DESK.somaBin!, async argv => {
      calls++;
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
      return node(true, "open", argv[3]);
    });
    const refs = Array.from({ length: 9 }, (_, index) => `example/app#${index + 1}`);
    const cold = reader.read([...refs, ...refs]);
    expect(cold.get(refs[0]!)).toContain("being checked");
    expect(calls).toBe(4);
    release();
    await reader.warm(refs);
    expect(peak).toBe(4);
    expect(calls).toBe(9);
    expect([...reader.read(refs).values()]).toEqual(Array(9).fill(null));
    await reader.warm(refs);
    expect(calls).toBe(9);
  });

  it("does not re-read a backlog of escalations on every compose before the status lifetime ends", async () => {
    let now = NOW;
    let calls = 0;
    const reader = new EscalationRulings(DESK.somaBin!, async argv => {
      calls++;
      now += 1_000;
      return node(true, "open", argv[3]);
    }, () => now);
    const refs = Array.from({ length: 142 }, (_, index) => `example/app#${index + 1}`);
    await reader.warm(refs);
    expect(calls).toBe(142);
    for (let minute = 0; minute < 27; minute++) {
      now += 60_000;
      reader.read(refs);
      await reader.warm(refs);
    }
    expect(calls).toBe(142);
    now = NOW + 142_000 + RULING_STATUS_FRESH_MS;
    await reader.warm(refs);
    expect(calls).toBe(284);
  });

  it("keeps a node's status when one compose leaves it out of the ref list", async () => {
    let calls = 0;
    const reader = new EscalationRulings(DESK.somaBin!, async argv => {
      calls++;
      return node(true, "open", argv[3]);
    }, () => NOW);
    const all = Array.from({ length: 6 }, (_, index) => `example/app#${index + 1}`);
    await reader.warm(all);
    expect(calls).toBe(6);
    reader.read(all.slice(0, 3));
    await reader.warm(all.slice(0, 3));
    reader.read(all);
    await reader.warm(all);
    expect(calls).toBe(6);
    expect([...reader.read(all).values()]).toEqual(Array(6).fill(null));
  });

  it("waits before re-reading a node whose read failed", async () => {
    let now = NOW;
    let calls = 0;
    const reader = new EscalationRulings(DESK.somaBin!, async () => {
      calls++;
      return calls === 1 ? result("", 1, "API rate limit exceeded") : node();
    }, () => now);
    await reader.warm([REF]);
    expect(reader.read([REF]).get(REF)).toContain("could not be read");
    now += RULING_STATUS_RETRY_MS - 1;
    await reader.warm([REF]);
    expect(calls).toBe(1);
    now += 1;
    await reader.warm([REF]);
    expect(calls).toBe(2);
    expect(reader.read([REF]).get(REF)).toBeNull();
  });

  it("refreshes an open node to closed and makes a changed explanation target cold", async () => {
    let now = NOW;
    let closed = false;
    const reader = new EscalationRulings(DESK.somaBin!, async () => node(true, closed ? "closed" : "open"), () => now);
    await reader.warm([REF]);
    expect(reader.read([REF]).get(REF)).toBeNull();
    closed = true;
    now += RULING_STATUS_FRESH_MS;
    await reader.warm([REF]);
    expect(reader.read([REF]).get(REF)).toContain("closed");
    const entry = { repo: "example/app", nodeId: "12", itemKey: KEY, title: "Format", status: "open" };
    const loop = new RulingExplainLoop(async () => EXPLANATION, async () => BODY);
    await loop.warm([entry]);
    expect((await loop.read([entry])).get(KEY)?.kind).toBe("explained");
    expect((await loop.read([{ ...entry, repo: "example/other" }])).get(KEY)).toMatchObject({ kind: "unexplained" });
    await loop.warm([{ ...entry, repo: "example/other" }]);
  });
});
