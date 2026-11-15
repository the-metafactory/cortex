import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { McSchema } from "../../../common/types/config";
import { handleDeskAction } from "../api/desk-action";
import { handleDeskGoal } from "../api/desk-goal";
import { handleDeskRuling } from "../api/desk-ruling";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import { graphNodeWriter } from "../desk/graph-conversation-writer";
import { briefing, selectItems } from "../desk/present";
import { RulingLedger } from "../desk/ruling";
import { SourceCache } from "../desk/sources/command";
import { readThinking } from "../desk/studio/thinking";
import { seedDeskEscalation } from "./fixtures/vigil-escalation";

const NOW = Date.parse("2026-11-15T12:00:00Z");

describe("the Desk without Ranger or Soma", () => {
  let db: Database;
  let options: DeskOptions;
  let runtime: DeskRuntime;

  beforeEach(() => {
    db = initDatabase(":memory:");
    const defaults = McSchema.parse(undefined).desk;
    options = {
      enabled: defaults.enabled,
      displayName: defaults.displayName,
      topN: defaults.topN,
      rangerUrl: defaults.ranger.url,
      rangerCli: { bin: defaults.ranger.bin, config: defaults.ranger.config },
      somaBin: defaults.soma.bin,
      goals: defaults.goals,
      areas: defaults.areas,
      sources: defaults.sources,
    };
    runtime = { options, ledger: new HandledLedger(), rulings: new RulingLedger() };
  });

  afterEach(() => { db.close(); });

  it("loads with no integration items or broken-source warning when neither built-in is configured", async () => {
    const view = await composeDesk(db, options, undefined, {
      now: NOW,
      fetchImpl: async () => { throw new Error("An unconfigured Ranger must not be read."); },
    });
    expect(view.items).toEqual([]);
    expect(view.today).toEqual([]);
    expect(view.ahead).toEqual([]);
    expect(view.sources).toEqual([]);
    expect(view.systems).toEqual(["No source is connected, so the Desk cannot see anything yet. Turn on Vigil or set mc.desk.ranger.url."]);
    expect(briefing(view, selectItems(view, "all", new Set()), null).lines[0]).toBe("The Desk cannot see anything yet: no source is connected.");
  });

  it("still lists an independent calendar source without either built-in", async () => {
    options.sources = [{ id: "calendar", command: ["fixture-calendar"], everySeconds: 300, timeoutSeconds: 30 }];
    const view = await composeDesk(db, options, undefined, {
      now: NOW,
      sourceCache: new SourceCache(async () => JSON.stringify({ events: [
        { id: "meeting", title: "Planning", start: "2026-11-15T13:00:00Z", end: "2026-11-15T14:00:00Z" },
      ] })),
    });
    expect(view.sources).toEqual([{ id: "calendar", ok: true }]);
    expect(view.today).toMatchObject([{ title: "Planning", kind: "meeting" }]);
    expect(view.items).toEqual([]);
    expect(view.systems).toEqual([]);
  });

  it("keeps independent Vigil escalations visible and explains why their Soma ruling is unavailable", async () => {
    const subjectKey = seedDeskEscalation(db, NOW);
    const view = await composeDesk(db, options, { enabled: true }, { now: NOW });
    expect(view.sources).toEqual([{ id: "vigil", ok: true }]);
    expect(view.items).toHaveLength(1);
    const card = view.items[0]!;
    expect(card.key).toBe(`vigil:${subjectKey}`);
    expect(card.kind).toBe("escalation");
    expect(card.detail.summary).toContain("Soma rulings are not set up on this stack. Answer on the issue.");
    expect(card.actions.filter(action => action.id === "ranger.rule")).toEqual([]);
  });

  it("names the missing setup when actions, rulings or goal commands are requested", async () => {
    const post = (body: object): Request => new Request("http://localhost/api/desk", { method: "POST", body: JSON.stringify(body) });
    const cases = [
      { response: await handleDeskAction(post({ action: "ranger.retry", key: "ranger:example/app#12" }), runtime), error: "Ranger actions are not set up on this stack." },
      { response: await handleDeskRuling(post({ key: "ranger:example/app#12", text: "Proceed.", requestId: "request-3718" }), runtime), error: "Rulings are not set up on this stack." },
      { response: await handleDeskGoal(post({ action: "goal.pause", goal: "G1" }), runtime), error: "Pausing goals is not set up on this stack." },
      { response: await handleDeskGoal(post({ action: "goal.check", goal: "G1" }), runtime), error: "No check is set up for this goal." },
    ];
    for (const { response, error } of cases) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, error });
    }
    expect(await readThinking("", options.rangerCli)).toEqual({
      kind: "unavailable", reason: "Thinking needs Ranger configured on this stack.",
    });
  });

  it("explains that Soma is missing when a conversation tries to create a graph node", async () => {
    const operationId = "optional-builtins";
    const result = await graphNodeWriter({ db, desk: () => options }).create({
      operationId, type: "graph-node", activation: "none", signal: new AbortController().signal,
      fields: { repository: "github:github.com/example/app", parent: "1", title: "Add export", kind: "task", checkpoint: "export" },
      provenance: { conversationId: "conversation", proposalId: "proposal", revision: 1, operationId, entryId: null, link: "http://localhost/conversation" },
    });
    expect(result).toEqual({ state: "failed", error: "Soma is not set up on this stack. Nothing was created." });
  });
});
