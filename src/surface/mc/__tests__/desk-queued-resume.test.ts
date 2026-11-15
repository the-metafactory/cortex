import { describe, expect, it } from "bun:test";
import { handleDeskAction } from "../api/desk-action";
import { HandledLedger, planRangerAction } from "../desk/actions";
import { rankItems } from "../desk/rank";
import type { RangerState } from "../desk/sources/ranger";

const CLI = { bin: "/opt/ranger/bin/ranger", config: "" };
const KEY = "ranger:example/app#12";

const state = (queued: boolean): RangerState => ({
  current: [],
  maps: [{ key: "example/app#1", repo: "example/app", lane: "headless", decisions: [{ id: "99", title: "Holder task" }] }],
  laneHolders: { headless: { repo: "example/app", nodeId: "99" }, visual: null },
  needsYou: [{
    key: "example/app#1", repo: "example/app", nodeId: "12", title: "Pick the export format", status: "parked",
    endedAt: "2026-10-31T08:00:00.000Z", reason: { class: "blocked", detail: "resume once: pick one" },
    queued: queued ? { lane: "headless", position: 2 } : null,
    actions: { resume: true, queueResume: { offered: !queued } },
  }],
});

describe("run both now", () => {
  it("plans resume-node --force only for a node Ranger lists as queued", () => {
    expect(planRangerAction(state(true), "ranger.run-now", KEY, CLI)).toMatchObject({ argv: [CLI.bin, "resume-node", "12", "--map", "example/app#1", "--force"] });
    expect(planRangerAction(state(false), "ranger.run-now", KEY, CLI)).toBe("Ranger does not list this node as queued.");
  });

  it("runs once for two clicks", async () => {
    const calls: string[][] = [];
    const runtime = { options: { enabled: true, rangerUrl: "http://127.0.0.1:1", rangerCli: CLI }, ledger: new HandledLedger() };
    const run = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; };
    const click = () => handleDeskAction(new Request("http://x/api/desk/action", { method: "POST", body: JSON.stringify({ action: "ranger.run-now", key: KEY }) }), runtime as never, { run, fetchImpl: async () => Response.json(state(true)) });
    expect((await click()).status).toBe(200);
    expect((await click()).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("shows the queued card with Run both now and Not now", () => {
    const items = rankItems({ now: Date.parse("2026-10-31T09:00:00.000Z"), ranger: state(true), areas: [], subjects: [], rangerActions: true, rulingActions: true });
    const card = items.find((i) => i.key === KEY);
    expect(card?.why).toContain('behind "Holder task"');
    expect(card?.why).toContain("place 2");
    expect(card?.actions.map((a) => [a.id, a.label])).toEqual([["ranger.run-now", "Run both now"], ["snooze", "Not now"]]);
  });
});
