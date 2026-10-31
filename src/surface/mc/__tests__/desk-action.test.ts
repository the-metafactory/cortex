import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDeskAction, handleDeskAutonomy } from "../api/desk-action";
import { HandledLedger, type RangerRunResult } from "../desk/actions";
import { listGrants, readDone, runAutonomy, setGrant } from "../desk/autonomy";
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

  function startDesk(state: RangerState) {
    const secretPath = join(tmpDir, "step-up-totp.json");
    writeEnrollment(secretPath, createEnrollment("2026-10-16T00:00:00.000Z"));
    const ranger = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(state) });
    const marker = join(tmpDir, "ranger-calls");
    const bin = join(tmpDir, "ranger");
    writeFileSync(bin, `#!/bin/sh\necho "$1 $2" >> ${marker}\n`, { mode: 0o755 });
    const soma = join(tmpDir, "soma");
    writeFileSync(soma, `#!/bin/sh\necho "soma $1 $2 $3" >> ${marker}\n`, { mode: 0o755 });
    const ctx = startServer(
      { ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"], stepUp: { secretPath } } },
      db,
      { desk: { ...DESK, rangerUrl: `http://127.0.0.1:${ranger.port}`, rangerCli: { bin, config: "" }, somaBin: soma } },
    );
    const base = `http://localhost:${ctx.server.port}`;
    return {
      marker,
      send: (path: string, email: string, body: unknown) => fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, "Cf-Access-Authenticated-User-Email": email },
        body: JSON.stringify(body),
      }),
      stop: () => {
        ctx.stop(true);
        void ranger.stop(true);
      },
    };
  }

  it("runs an action for the principal without a step-up code, and refuses another identity before Ranger is called", async () => {
    const desk = startDesk(rangerState());
    const send = (email: string) => desk.send("/api/desk/action", email, { action: "ranger.approve", key: "ranger:example/app#30" });
    try {
      const stranger = await send("unlisted@example.com");
      expect(stranger.status).toBe(403);
      expect((await stranger.json()).error).toBe("not_authorized");
      expect(existsSync(desk.marker)).toBe(false);

      expect((await send("principal@example.com")).status).toBe(200);
      expect(readFileSync(desk.marker, "utf8").trim()).toBe("approve-node 30");
    } finally {
      desk.stop();
    }
  });

  it("records a ruling and resumes for the principal without a step-up code, and refuses another identity before anything runs", async () => {
    const state = rangerState();
    state.needsYou.push({
      key: "example/app#1", repo: "example/app", nodeId: "14", title: "Pick the export format", status: "parked",
      endedAt: "2026-10-30T09:00:00.000Z", reason: { class: "blocked", detail: "resume once: a format is picked — two are named" }, actions: { resume: true },
    });
    const desk = startDesk(state);
    const send = (email: string) => desk.send("/api/desk/ruling", email, { key: "ranger:example/app#14", text: "Use JSON.", requestId: "req-00000001" });
    try {
      expect((await send("unlisted@example.com")).status).toBe(403);
      expect(existsSync(desk.marker)).toBe(false);

      expect((await send("principal@example.com")).status).toBe(200);
      expect(readFileSync(desk.marker, "utf8").trim().split("\n")).toEqual(["soma graph rule 14", "resume-node 14"]);
    } finally {
      desk.stop();
    }
  });

  it("runs a check for the principal without a step-up code, and refuses another identity before anything runs", async () => {
    const secretPath = join(tmpDir, "step-up-totp.json");
    writeEnrollment(secretPath, createEnrollment("2026-10-16T00:00:00.000Z"));
    const marker = join(tmpDir, "check-calls");
    const bin = join(tmpDir, "check");
    writeFileSync(bin, `#!/bin/sh\necho "$1 $CHECK_TAG" >> ${marker}\n`, { mode: 0o755 });
    const ctx = startServer(
      { ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"], stepUp: { secretPath } } },
      db,
      { desk: { ...DESK, rangerUrl: "", goals: { somaBin: "", check: { G6: { command: [bin, "fire"], env: { CHECK_TAG: "g6" }, timeoutSeconds: 10 } } } } },
    );
    const base = `http://localhost:${ctx.server.port}`;
    const send = (email: string) => fetch(`${base}/api/desk/goal`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "Cf-Access-Authenticated-User-Email": email },
      body: JSON.stringify({ action: "goal.check", goal: "G6" }),
    });
    try {
      const stranger = await send("unlisted@example.com");
      expect(stranger.status).toBe(403);
      expect(existsSync(marker)).toBe(false);

      expect((await send("principal@example.com")).status).toBe(200);
      expect(readFileSync(marker, "utf8").trim()).toBe("fire g6");
    } finally {
      ctx.stop(true);
    }
  });

  it("refuses a promotion from another identity, and retries at once for the principal", async () => {
    const desk = startDesk(rangerState());
    const send = (email: string) => desk.send("/api/desk/autonomy", email, { action: "ranger.retry", on: true });
    try {
      expect((await send("unlisted@example.com")).status).toBe(403);
      expect(listGrants(db).size).toBe(0);

      expect((await send("principal@example.com")).status).toBe(200);
      for (let i = 0; i < 50 && !existsSync(desk.marker); i++) await Bun.sleep(20);
      expect(readFileSync(desk.marker, "utf8").trim()).toBe("resume-node 12");
    } finally {
      desk.stop();
    }
  });
});

const MINUTE = 60_000;

function failedNodes(endedAt = "2026-10-30T11:00:00.000Z"): RangerState {
  return {
    current: [],
    needsYou: [
      { key: "example/app#1", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "failed", endedAt, reason: { class: "worker failed" }, actions: { resume: true } },
      { key: "example/app#1", repo: "example/app", nodeId: "14", title: "Pick a date library", status: "failed", endedAt, reason: { class: "blocked" }, actions: { resume: true } },
    ],
    maps: [],
  };
}

const postAutonomy = (body: unknown): Request =>
  new Request("http://localhost/api/desk/autonomy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("promoting Ranger retry", () => {
  let db: Database;
  beforeEach(() => {
    db = initDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  const tick = (state: RangerState = failedNodes(), runner = fakeRunner(), ledger = new HandledLedger(), now = NOW) =>
    runAutonomy({ db, rangerUrl: DESK.rangerUrl, cli: { bin: "/opt/ranger/bin/ranger", config: "" }, ledger, run: runner.run, fetchImpl: fetchRanger(state), now: () => now });

  const compose = (state: RangerState = failedNodes(), ledger = new HandledLedger(), now = NOW) =>
    composeDesk(db, DESK, undefined, { now, fetchImpl: fetchRanger(state), handled: ledger });

  it("retries a failed node without asking and lists it under Done for you", async () => {
    setGrant(db, "ranger.retry", true, NOW);
    const runner = fakeRunner();
    const ledger = new HandledLedger();
    await tick(failedNodes(), runner, ledger);
    expect(runner.calls).toEqual([["/opt/ranger/bin/ranger", "resume-node", "12", "--map", "example/app#1"]]);

    const view = await compose(failedNodes(), ledger);
    expect(view.items.map((i) => i.key)).not.toContain("ranger:example/app#12");
    expect(view.items.map((i) => i.key)).toContain("ranger:example/app#14");
    expect(view.autonomy.done).toEqual([{ key: "retry:example/app#1/12@2026-10-30T11:00:00.000Z", title: "Fix the login timeout", message: 'Ranger is retrying "Fix the login timeout".', at: NOW, ok: true }]);
    expect(view.autonomy.types).toEqual([expect.objectContaining({ action: "ranger.retry", on: true })]);
  });

  it("asks first when retry is not promoted, and again after Stop doing this on your own", async () => {
    const runner = fakeRunner();
    await tick(failedNodes(), runner);
    expect(runner.calls).toEqual([]);

    setGrant(db, "ranger.retry", true, NOW);
    setGrant(db, "ranger.retry", false, NOW);
    await tick(failedNodes(), runner);
    expect(runner.calls).toEqual([]);
    expect(listGrants(db).size).toBe(0);
    const view = await compose(failedNodes());
    expect(view.items.find((i) => i.key === "ranger:example/app#12")?.actions[0]).toMatchObject({ id: "ranger.retry", wired: true });
    expect(view.autonomy.types[0]?.on).toBe(false);
  });

  it("shows a retry Ranger refused as an item with the failure, and does not try it again", async () => {
    setGrant(db, "ranger.retry", true, NOW);
    const runner = fakeRunner({ code: 1, stdout: "", stderr: "map is paused\n" });
    await tick(failedNodes(), runner);
    await tick(failedNodes(), runner, new HandledLedger(), NOW + MINUTE);
    expect(runner.calls).toHaveLength(1);

    const item = (await compose(failedNodes())).items.find((i) => i.key === "ranger:example/app#12");
    expect(item?.why).toContain("Ranger refused: map is paused");
    expect(item?.urgency).toBe("today");
    expect(readDone(db, NOW)[0]).toMatchObject({ status: "failed", message: "Ranger refused: map is paused" });
  });

  it("retries a node once a day at most, and shows it when it fails again", async () => {
    setGrant(db, "ranger.retry", true, NOW);
    const runner = fakeRunner();
    await tick(failedNodes(), runner);
    const again = failedNodes("2026-10-30T11:30:00.000Z");
    await tick(again, runner, new HandledLedger(), NOW + 20 * MINUTE);
    expect(runner.calls).toHaveLength(1);

    const item = (await compose(again, new HandledLedger(), NOW + 20 * MINUTE)).items.find((i) => i.key === "ranger:example/app#12");
    expect(item?.why).toContain("failed again");
  });

  it("sends no further retry once the person stops it during a tick", async () => {
    setGrant(db, "ranger.retry", true, NOW);
    const state = failedNodes();
    state.needsYou.push({ key: "example/app#1", repo: "example/app", nodeId: "13", title: "Add export", status: "failed", endedAt: "2026-10-30T11:00:00.000Z", actions: { resume: true } });
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      setGrant(db, "ranger.retry", false, NOW);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runAutonomy({ db, rangerUrl: DESK.rangerUrl, cli: { bin: "/opt/ranger/bin/ranger", config: "" }, ledger: new HandledLedger(), run, fetchImpl: fetchRanger(state), now: () => NOW });
    expect(calls).toHaveLength(1);
  });

  it("does not send a retry twice after a restart, or one the person already sent", async () => {
    setGrant(db, "ranger.retry", true, NOW);
    const runner = fakeRunner();
    await tick(failedNodes(), runner);
    await tick(failedNodes(), runner, new HandledLedger());
    expect(runner.calls).toHaveLength(1);
    expect((await compose(failedNodes(), new HandledLedger())).items.map((i) => i.key)).not.toContain("ranger:example/app#12");

    db.query("DELETE FROM desk_done").run();
    const ledger = new HandledLedger();
    ledger.add("retry:example/app#1/12@2026-10-30T11:00:00.000Z", NOW);
    await tick(failedNodes(), runner, ledger);
    expect(runner.calls).toHaveLength(1);
  });

  it("promotes only Ranger retry, and only where Ranger actions are set up", async () => {
    const db = initDatabase(":memory:");
    const runtime = { options: DESK, ledger: new HandledLedger() };
    expect((await handleDeskAutonomy(postAutonomy({ action: "ranger.approve", on: true }), db, runtime)).status).toBe(400);
    expect((await handleDeskAutonomy(postAutonomy({ action: "ranger.retry" }), db, runtime)).status).toBe(400);
    const off = { options: { ...DESK, rangerCli: { bin: "", config: "" } }, ledger: new HandledLedger() };
    expect((await handleDeskAutonomy(postAutonomy({ action: "ranger.retry", on: true }), db, off)).status).toBe(409);
    expect(listGrants(db).size).toBe(0);

    const res = await handleDeskAutonomy(postAutonomy({ action: "ranger.retry", on: true }), db, runtime);
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("Done for you");
    expect([...listGrants(db)]).toEqual(["ranger.retry"]);
    db.close();
  });
});
