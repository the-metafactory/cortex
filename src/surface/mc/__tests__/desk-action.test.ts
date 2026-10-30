import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskAction } from "../api/desk-action";
import { HandledLedger, type RangerRunResult } from "../desk/actions";
import { composeDesk, type DeskOptions } from "../desk/compose";
import type { RangerState } from "../desk/sources/ranger";
import { createEnrollment, writeEnrollment } from "../../../common/step-up/enrollment";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { writeVigilSubject } from "../../../vigil/db";
import { startServer } from "../server";

const NOW = Date.parse("2026-10-30T11:16:00.000Z");

const DESK: DeskOptions = {
  enabled: true,
  displayName: "Ada",
  topN: 5,
  rangerUrl: "http://127.0.0.1:7311",
  rangerCli: { bin: "/opt/ranger/bin/ranger", config: "/home/ada/.config/ranger/ranger.yaml" },
  areas: [],
  sources: [],
};

function rangerState(): RangerState {
  return {
    current: [],
    needsYou: [{
      key: "example/app#1", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "failed",
      endedAt: "2026-10-30T08:00:00.000Z", reason: { class: "worker failed" }, actions: { resume: true },
    }],
    maps: [{
      key: "example/app#1", repo: "example/app", walk: "full", servedOnly: false,
      decisions: [
        { id: "30", title: "Adopt the new date library", approvable: true, approvalVersion: "abc123" },
        { id: "33", title: "Write the migration guide", approvable: false },
      ],
    }],
  };
}

const fetchRanger = (state: RangerState) => async () => Response.json(state);

function fakeRunner(result: RangerRunResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: string[][] = [];
  return { calls, run: async (argv: string[]) => { calls.push(argv); return result; } };
}

interface Deps { ledger: HandledLedger; run: (argv: string[]) => Promise<RangerRunResult>; fetchImpl: () => Promise<Response> }
const act = (body: unknown, deps: Deps, desk: DeskOptions = DESK): Promise<Response> =>
  handleDeskAction(post(body), { options: desk, ledger: deps.ledger }, deps);

const post = (body: unknown): Request =>
  new Request("http://localhost/api/desk/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Desk actions that write to Ranger", () => {
  it("approves a node through Ranger's CLI with arguments from Ranger's own state", async () => {
    const runner = fakeRunner();
    const res = await act({ action: "ranger.approve", key: "ranger:example/app#30" }, {
      ledger: new HandledLedger(), run: runner.run, fetchImpl: fetchRanger(rangerState()),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("Adopt the new date library");
    expect(runner.calls).toEqual([[
      "/opt/ranger/bin/ranger", "approve-node", "30", "--map", "example/app#1", "--approval-version", "abc123",
      "-c", "/home/ada/.config/ranger/ranger.yaml",
    ]]);
  });

  it("retries a failed node through resume-node", async () => {
    const runner = fakeRunner();
    const res = await act({ action: "ranger.retry", key: "ranger:example/app#12" }, {
      ledger: new HandledLedger(), run: runner.run, fetchImpl: fetchRanger(rangerState()),
    });
    expect(res.status).toBe(200);
    expect(runner.calls[0]?.slice(1, 5)).toEqual(["resume-node", "12", "--map", "example/app#1"]);
  });

  it("sends the same action to Ranger once, whether repeated or sent twice at the same time", async () => {
    const runner = fakeRunner();
    const deps = { ledger: new HandledLedger(), run: runner.run, fetchImpl: fetchRanger(rangerState()) };
    const body = { action: "ranger.approve", key: "ranger:example/app#30" };
    const [a, b] = await Promise.all([act(body, deps), act(body, deps)]);
    const again = await act(body, deps);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(again.status).toBe(409);
    expect(runner.calls).toHaveLength(1);
  });

  it("says in one line what failed when Ranger refuses, and keeps the item on the Desk", async () => {
    const runner = fakeRunner({ code: 1, stdout: "", stderr: "warming up\nranger approve-node: node changed since the card was read; refresh before approving\n" });
    const ledger = new HandledLedger();
    const res = await act({ action: "ranger.approve", key: "ranger:example/app#30" }, {
      ledger, run: runner.run, fetchImpl: fetchRanger(rangerState()),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Ranger refused: ranger approve-node: node changed since the card was read; refresh before approving");

    const db = initDatabase(":memory:");
    const view = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(rangerState()), handled: ledger });
    db.close();
    expect(view.items.map((i) => i.key)).toContain("ranger:example/app#30");
  });

  it("hides an approved item until Ranger's state moves on", async () => {
    const ledger = new HandledLedger();
    await act({ action: "ranger.approve", key: "ranger:example/app#30" }, {
      ledger, run: fakeRunner().run, fetchImpl: fetchRanger(rangerState()),
    });
    const db = initDatabase(":memory:");
    const view = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(rangerState()), handled: ledger });
    db.close();
    expect(view.items.map((i) => i.key)).not.toContain("ranger:example/app#30");
    expect(view.items.map((i) => i.key)).toContain("ranger:example/app#12");
  });

  it("lets a retry through again when Ranger gives no stop time to tell two stops apart", async () => {
    const state = rangerState();
    state.needsYou = state.needsYou.map(({ endedAt: _endedAt, ...n }) => n);
    const runner = fakeRunner();
    const deps = { ledger: new HandledLedger(), run: runner.run, fetchImpl: fetchRanger(state) };
    const body = { action: "ranger.retry", key: "ranger:example/app#12" };
    expect((await act(body, deps)).status).toBe(200);
    expect((await act(body, deps)).status).toBe(200);
    expect(runner.calls).toHaveLength(2);
  });

  it("does not bring an approved node back as a Vigil escalation while Ranger catches up", async () => {
    const ledger = new HandledLedger();
    await act({ action: "ranger.approve", key: "ranger:example/app#30" }, { ledger, run: fakeRunner().run, fetchImpl: fetchRanger(rangerState()) });
    const db = initDatabase(":memory:");
    writeVigilSubject(db, {
      subject_key: "state:escalation:default:example/app#30", subject_kind: "state", vocab: "escalation", ref: "example/app#30",
      value: "needs-principal", healthy: 0, goal_id: null, producer: "soma", stack: "default", run_kind: null,
      last_run_id: "run-1", last_ended_at: NOW - 3_600_000, last_seen_at: NOW - 3_600_000,
    }, NOW - 3_600_000);
    const view = await composeDesk(db, DESK, { enabled: true }, { now: NOW, fetchImpl: fetchRanger(rangerState()), handled: ledger });
    db.close();
    expect(view.items.filter((i) => i.kind === "escalation")).toEqual([]);
  });

  it("refuses a node Ranger does not take an approval for, and a stack without the CLI", async () => {
    const runner = fakeRunner();
    const deps = { ledger: new HandledLedger(), run: runner.run, fetchImpl: fetchRanger(rangerState()) };
    const notApprovable = await act({ action: "ranger.approve", key: "ranger:example/app#33" }, deps);
    const gone = await act({ action: "ranger.approve", key: "ranger:example/app#99" }, deps);
    const unset = await act({ action: "ranger.approve", key: "ranger:example/app#30" }, deps, { ...DESK, rangerCli: { bin: "", config: "" } });
    const park = await act({ action: "ranger.park", key: "ranger:example/app#12" }, deps);
    expect([notApprovable.status, gone.status, unset.status, park.status]).toEqual([409, 409, 409, 400]);
    expect(runner.calls).toEqual([]);
  });

  it("wires Approve and Retry only where Ranger accepts them and the CLI is set", async () => {
    const db = initDatabase(":memory:");
    const wired = async (desk: DeskOptions) => {
      const view = await composeDesk(db, desk, undefined, { now: NOW, fetchImpl: fetchRanger(rangerState()) });
      return Object.fromEntries(view.items.map((i) => [i.key, i.actions[0]?.wired]));
    };
    expect(await wired(DESK)).toMatchObject({ "ranger:example/app#30": true, "ranger:example/app#12": true });
    expect(await wired({ ...DESK, rangerCli: undefined })).toMatchObject({ "ranger:example/app#30": false, "ranger:example/app#12": false });
    db.close();
  });

  it("offers no dead Approve button, and says why, for a decision Ranger will not take an approval for", async () => {
    const state = rangerState();
    state.maps.push({ key: "example/notes#1", repo: "example/notes", walk: "none", decisions: [{ id: "40", title: "Plan the next talk", approvable: false, approvalVersion: "v1" }] });
    const db = initDatabase(":memory:");
    const view = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(state) });
    db.close();
    const item = (key: string) => view.items.find((i) => i.key === key);
    expect(item("ranger:example/notes#40")?.why).toBe("No agent builds this map; Ranger only shows it.");
    expect(item("ranger:example/app#33")?.why).toBe("Ranger does not take an approval for it here. Look first to see what it needs.");
    for (const key of ["ranger:example/notes#40", "ranger:example/app#33"]) {
      expect(item(key)?.actions.map((a) => [a.id, a.role, a.wired])).toEqual([["detail", "primary", true], ["snooze", "secondary", true]]);
    }
    expect(item("ranger:example/app#30")?.actions[0]?.id).toBe("ranger.approve");
  });
});

describe("the Desk action route through Mission Control", () => {
  let tmpDir: string;
  let db: Database;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-desk-action-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = initDatabase(join(tmpDir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs an action for the principal without a step-up code, and refuses another identity before Ranger is called", async () => {
    const secretPath = join(tmpDir, "step-up-totp.json");
    writeEnrollment(secretPath, createEnrollment("2026-10-16T00:00:00.000Z"));
    const ranger = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(rangerState()) });
    const marker = join(tmpDir, "ranger-calls");
    const bin = join(tmpDir, "ranger");
    writeFileSync(bin, `#!/bin/sh\necho "$2" >> ${marker}\n`, { mode: 0o755 });
    const ctx = startServer(
      { ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"], stepUp: { secretPath } } },
      db,
      { desk: { ...DESK, rangerUrl: `http://127.0.0.1:${ranger.port}`, rangerCli: { bin, config: "" } } },
    );
    const base = `http://localhost:${ctx.server.port}`;
    const send = (email: string) => fetch(`${base}/api/desk/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "Cf-Access-Authenticated-User-Email": email },
      body: JSON.stringify({ action: "ranger.approve", key: "ranger:example/app#30" }),
    });
    try {
      const stranger = await send("unlisted@example.com");
      expect(stranger.status).toBe(403);
      expect((await stranger.json()).error).toBe("not_authorized");
      expect(existsSync(marker)).toBe(false);

      expect((await send("principal@example.com")).status).toBe(200);
      expect(readFileSync(marker, "utf8").trim()).toBe("30");
    } finally {
      ctx.stop(true);
      void ranger.stop(true);
    }
  });
});
