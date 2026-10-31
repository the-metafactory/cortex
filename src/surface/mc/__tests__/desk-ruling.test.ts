import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { handleDeskRuling } from "../api/desk-ruling";
import { HandledLedger, type RangerRunResult } from "../desk/actions";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { agentQuestion, RulingLedger, somaRepo } from "../desk/ruling";
import type { RangerState } from "../desk/sources/ranger";
import { initDatabase } from "../db/init";

const NOW = Date.parse("2026-10-31T09:00:00.000Z");
const KEY = "ranger:example/app#12";

const DESK: DeskOptions = {
  enabled: true,
  displayName: "Ada",
  topN: 5,
  rangerUrl: "http://127.0.0.1:7311",
  rangerCli: { bin: "/opt/ranger/bin/ranger", config: "" },
  somaBin: "/opt/soma/bin/soma",
  areas: [],
  sources: [],
};

function rangerState(): RangerState {
  return {
    current: [],
    needsYou: [{
      key: "example/app#1", repo: "example/app", nodeId: "12", title: "Pick the export format", status: "parked",
      url: "https://github.com/example/app/issues/12", endedAt: "2026-10-31T08:00:00.000Z",
      reason: { class: "blocked", detail: "resume once: the principal picks CSV or JSON, — Blocked: the spec names both formats." },
      actions: { resume: true },
    }, {
      key: "example/app#1", repo: "example/app", nodeId: "13", title: "Fix the login timeout", status: "failed",
      endedAt: "2026-10-31T07:00:00.000Z", reason: { class: "worker failed" }, actions: { resume: true },
    }],
    maps: [],
  };
}

const fetchRanger = (state: RangerState) => async () => Response.json(state);

function runner(result: RangerRunResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: { argv: string[]; file: string | null }[] = [];
  return {
    calls,
    run: async (argv: string[]) => {
      const at = argv.indexOf("--text-file");
      calls.push({ argv, file: at >= 0 ? readFileSync(argv[at + 1] ?? "", "utf8") : null });
      return result;
    },
  };
}

const post = (body: unknown): Request =>
  new Request("http://localhost/api/desk/ruling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface Setup {
  soma?: ReturnType<typeof runner>;
  ranger?: ReturnType<typeof runner>;
  state?: RangerState;
  desk?: DeskOptions;
}

function setup({ soma = runner(), ranger = runner(), state = rangerState(), desk = DESK }: Setup = {}) {
  const runtime = { options: desk, ledger: new HandledLedger(), rulings: new RulingLedger() };
  const rule = (body: unknown) => handleDeskRuling(post(body), runtime, { soma: soma.run, ranger: ranger.run, fetchImpl: fetchRanger(state), now: () => NOW });
  return { runtime, soma, ranger, rule };
}

const RULING = { key: KEY, text: "--repo evil\nUse JSON; CSV can follow later.", requestId: "req-00000001" };

describe("agentQuestion", () => {
  it("splits Ranger's resume condition from the worker's reason", () => {
    expect(agentQuestion("resume once: the principal picks CSV or JSON, — Blocked: the spec names both formats.")).toEqual({
      condition: "the principal picks CSV or JSON",
      reason: "Blocked: the spec names both formats.",
    });
  });

  it("keeps a reason without a resume condition whole, and has nothing to show for an empty detail", () => {
    expect(agentQuestion("Blocked: no lane for this repo")).toEqual({ condition: null, reason: "Blocked: no lane for this repo" });
    expect(agentQuestion(undefined)).toBeNull();
  });
});

describe("somaRepo", () => {
  it("qualifies a bare GitHub repo, passes a qualified one, and refuses anything else", () => {
    expect(somaRepo("example/app")).toBe("github:github.com/example/app");
    expect(somaRepo("gitlab:gitlab.example.com/group/app")).toBe("gitlab:gitlab.example.com/group/app");
    expect(somaRepo("--repo")).toBeNull();
  });
});

describe("a ruling given on the Desk", () => {
  it("records the ruling from a file, then resumes the node through Ranger", async () => {
    const { soma, ranger, rule } = setup();
    const res = await rule(RULING);
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('Recorded your ruling and resumed "Pick the export format".');
    expect(soma.calls).toHaveLength(1);
    const argv = soma.calls[0]?.argv ?? [];
    expect([argv[0], ...argv.slice(1, 4)]).toEqual(["/opt/soma/bin/soma", "graph", "rule", "12"]);
    expect([argv[4], ...argv.slice(6)]).toEqual(["--text-file", "--repo", "github:github.com/example/app", "--json"]);
    expect(argv.some((a) => a.includes("Use JSON"))).toBe(false);
    expect(soma.calls[0]?.file).toBe("--repo evil\nUse JSON; CSV can follow later.");
    expect(existsSync(argv[5] ?? "")).toBe(false);
    expect(ranger.calls.map((c) => c.argv)).toEqual([["/opt/ranger/bin/ranger", "resume-node", "12", "--map", "example/app#1"]]);
  });

  it("hides the item until Ranger moves on", async () => {
    const { runtime, rule } = setup();
    await rule(RULING);
    const db = initDatabase(":memory:");
    const view = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(rangerState()), handled: runtime.ledger });
    expect(view.items.map((i) => i.key)).not.toContain(KEY);
    db.close();
  });

  it("keeps the ruling when Ranger refuses the resume, and records it once across a second Confirm", async () => {
    const ranger = runner({ code: 1, stdout: "", stderr: "ranger resume-node: lane soma is held by #900\n" });
    const { soma, rule } = setup({ ranger });
    const first = await rule(RULING);
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ ok: false, recorded: true, error: "Your ruling is recorded; Ranger did not resume: ranger resume-node: lane soma is held by #900" });
    const second = await rule({ ...RULING, text: "a changed ruling" });
    expect(second.status).toBe(502);
    expect(soma.calls).toHaveLength(1);
    expect(ranger.calls).toHaveLength(2);
  });

  it("resumes nothing when recording fails, and says why in one line", async () => {
    const soma = runner({ code: 1, stdout: "", stderr: "warning\nsoma graph rule refused: node 12 is closed, so nothing was written.\n" });
    const { ranger, rule } = setup({ soma });
    const res = await rule(RULING);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Your ruling was not recorded: soma graph rule refused: node 12 is closed, so nothing was written.");
    expect(ranger.calls).toEqual([]);
  });

  it("refuses an empty ruling, a node that is not blocked, and a stack without Soma, before anything runs", async () => {
    const { soma, ranger, rule } = setup();
    const empty = await rule({ ...RULING, text: "   " });
    const failed = await rule({ ...RULING, key: "ranger:example/app#13" });
    const noId = await rule({ key: KEY, text: "x" });
    const unset = await setup({ soma, ranger, desk: { ...DESK, somaBin: "" } }).rule(RULING);
    expect([empty.status, failed.status, noId.status, unset.status]).toEqual([400, 409, 400, 409]);
    expect((await failed.json()).error).toBe("Ranger no longer waits for a ruling on this node.");
    expect([...soma.calls, ...ranger.calls]).toEqual([]);
  });
});

describe("a blocked item on the Desk", () => {
  it("offers Give your ruling with the agent's question, wired only when Soma and Ranger's CLI are set", async () => {
    const db = initDatabase(":memory:");
    const blocked = async (desk: DeskOptions) => {
      const view = await composeDesk(db, desk, undefined, { now: NOW, fetchImpl: fetchRanger(rangerState()) });
      return view.items.find((i) => i.key === KEY);
    };
    const wired = await blocked(DESK);
    expect(wired?.actions[0]).toEqual({ id: "ranger.rule", label: "Give your ruling", role: "primary", wired: true });
    expect(wired?.question).toEqual({ condition: "the principal picks CSV or JSON", reason: "Blocked: the spec names both formats." });
    expect(wired?.detail.links).toEqual([{ label: "Issue", url: "https://github.com/example/app/issues/12" }]);
    const unwired = await blocked({ ...DESK, somaBin: "" });
    expect(unwired?.actions[0]).toMatchObject({ id: "open", label: "Give your ruling", url: "https://github.com/example/app/issues/12" });
    db.close();
  });
});
