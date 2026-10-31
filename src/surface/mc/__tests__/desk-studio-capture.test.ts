import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../db/init";
import { handleDeskAsk, handleDeskCaptureUndo, handleDeskCreate } from "../api/desk-ask";
import { handleDeskAutonomy } from "../api/desk-action";
import { HandledLedger } from "../desk/actions";
import { readDone, setGrant } from "../desk/autonomy";
import { composeDesk, type DeskRuntime } from "../desk/compose";
import { fileStudioCapture, undoStudioCapture, type CaptureModel } from "../desk/studio/capture";
import { parseThreadFile } from "../desk/studio/format";
import { runStudioAct } from "../desk/studio/writer";
import type { StudioOptions } from "../desk/types";

const NOW = new Date("2026-10-31T17:00:00Z");
const ENDPOINT = { baseUrl: "http://127.0.0.1:1234/v1", model: "cloud-test", timeoutSeconds: 5, maxPerPass: 10 };
const AREAS = [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "cloud" as const }, { id: "private", label: "Private", color: "", repos: [], goals: [], policy: "local" as const }];
const thread = (areas = "lab"): string => `---\ntype: question\nareas: [${areas}]\nstate: active\nopened: 2026-10-31\n---\n\n## Question\n\nHow should the Studio work?\n\n## Where I stand\n\nStill deciding.\n\n## Material\n\n- link: Existing source\n\n## Log\n\n- 2026-10-31: Opened\n`;
let dir: string;
let db: Database;
let options: StudioOptions;
let runtime: DeskRuntime;
let sequence = 0;
const rid = (): string => `capture-request-${++sequence}`;
const request = (body: unknown): Request => new Request("http://localhost/api/desk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const matching: CaptureModel = async () => ({ thread: "studio", reason: "This develops the Studio question." });
const file = (model: CaptureModel = matching, requestId = rid()) => fileStudioCapture({ options, areas: AREAS, db, requestId, text: "Let the board show empty places.", now: NOW, model });
const capture = (): string => readDone(db, NOW.getTime())[0]?.itemKey ?? "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desk-capture-"));
  mkdirSync(join(dir, "threads"));
  writeFileSync(join(dir, "threads/studio.md"), thread());
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.org");
  git("add", "-A");
  git("commit", "-qm", "seed");
  db = initDatabase(":memory:");
  options = { dir, maxActive: 5, filer: ENDPOINT };
  runtime = { options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: AREAS, studio: options, sources: [] }, ledger: new HandledLedger() };
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("Studio capture filing", () => {
  it("appends matched material, records a reason and a commit, and replays without a second write", async () => {
    const requestId = rid();
    const result = await file(matching, requestId);
    expect(result.ok).toBe(true);
    const parsed = parseThreadFile("threads/studio.md", readFileSync(join(dir, "threads/studio.md"), "utf8"));
    expect(parsed.ok && parsed.value.material.some((m) => m.label.includes("empty places"))).toBe(true);
    expect(readDone(db, NOW.getTime())[0]?.message).toContain("This develops");
    expect(git("log", "-1", "--format=%B")).toContain(`Desk-Request: ${requestId}`);
    const head = git("rev-parse", "HEAD");
    expect((await file(async () => { throw new Error("must not call model"); }, requestId)).ok).toBe(true);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readDone(db, NOW.getTime())).toHaveLength(1);
  });

  it("saves unrelated material in the parsed inbox", async () => {
    const result = await file(async () => ({ thread: null, reason: "No active question fits." }));
    expect(result.ok && result.studio.inbox[0]?.text).toBe("Let the board show empty places.");
    expect(git("log", "-1", "--format=%s")).toContain("in inbox");
  });

  it("retains a tentative target as an inbox suggestion", async () => {
    const result = await file(async () => ({ thread: "studio", match: false, reason: "Possibly related." }));
    expect(result.ok && result.studio.inbox[0]?.target).toEqual({ thread: "studio", reason: "Possibly related." });
  });

  it("falls back to the inbox on model failure and invalid model output", async () => {
    const failure = await file(async () => { throw new Error("offline"); });
    expect(failure.ok && failure.studio.inbox).toHaveLength(1);
    const invalid = await file(async () => ({ thread: "../../secret", reason: "bad" }));
    expect(invalid.ok && invalid.studio.inbox).toHaveLength(2);
  });

  it("routes mixed and unknown areas locally, and never falls back to the cloud model", async () => {
    writeFileSync(join(dir, "threads/studio.md"), thread("lab, private"));
    git("commit", "-am", "local policy");
    let called = false;
    expect((await file(async () => { called = true; return {}; })).ok).toBe(true);
    expect(called).toBe(false);
    options.filer = { ...ENDPOINT, local: { ...ENDPOINT, model: "local-test" } };
    await file(async (config) => { expect(config.model).toBe("local-test"); return { thread: "studio", reason: "Fits locally." }; });
    writeFileSync(join(dir, "threads/studio.md"), thread("unknown"));
    git("commit", "-am", "unknown area");
    await file(async (config) => { expect(config.model).toBe("local-test"); return { thread: null, reason: "No fit." }; });
  });

  it("Undo removes only its material and preserves a later response in a new commit", async () => {
    await file();
    const id = capture();
    await runStudioAct({ options, areas: AREAS, requestId: rid(), act: { act: "respond", thread: "studio", text: "A later response." }, now: NOW });
    const before = git("rev-list", "--count", "HEAD");
    const undone = await undoStudioCapture({ options, areas: AREAS, db, requestId: rid(), id, now: NOW });
    expect(undone.ok).toBe(true);
    const text = readFileSync(join(dir, "threads/studio.md"), "utf8");
    expect(text).not.toContain(`- capture: [${id}]`);
    expect(text).toContain("A later response.");
    expect(text).toContain("Existing source");
    expect(Number(git("rev-list", "--count", "HEAD"))).toBe(Number(before) + 1);
    expect(readDone(db, NOW.getTime())[0]?.action).toBe("studio.capture.undone");
  });

  it("Undo removes an inbox capture and refuses an already moved capture", async () => {
    await file(async () => ({ thread: null, reason: "Unrelated." }));
    const id = capture();
    expect((await undoStudioCapture({ options, areas: AREAS, db, requestId: rid(), id, now: NOW })).ok).toBe(true);
    expect((await undoStudioCapture({ options, areas: AREAS, db, requestId: rid(), id, now: NOW })).ok).toBe(false);
  });

  it("refuses a dirty tree before invoking any model", async () => {
    writeFileSync(join(dir, "uncommitted.txt"), "keep me");
    let called = false;
    const result = await file(async () => { called = true; return {}; });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    expect(readFileSync(join(dir, "uncommitted.txt"), "utf8")).toBe("keep me");
  });
});

describe("capture command bar API", () => {
  it("proposes a capture, creates it only after confirmation and offers Undo in Done for you", async () => {
    const ask = await handleDeskAsk(request({ text: "capture: empty places on the board" }), runtime, {}, db);
    expect(await ask.json()).toMatchObject({ proposal: { kind: "capture", fields: { text: "Empty places on the board" } } });
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
    const created = await handleDeskCreate(request({ requestId: rid(), kind: "capture", fields: { text: "Empty places on the board" } }), db, runtime, { captureModel: matching, now: () => NOW.getTime() });
    expect(created.status).toBe(200);
    const view = await composeDesk(db, runtime.options ?? (() => { throw new Error("missing options"); })(), undefined, { now: NOW.getTime() });
    expect(view.autonomy.done[0]?.undo).toBe(capture());
    const undo = await handleDeskCaptureUndo(request({ id: capture(), requestId: rid() }), db, runtime);
    expect(undo.status).toBe(200);
  });

  it("advertises automatic filing only after promotion, even without Ranger", async () => {
    const promoted = await handleDeskAutonomy(request({ action: "studio.capture", on: true }), db, runtime);
    expect(promoted.status).toBe(200);
    const response = await handleDeskAsk(request({ text: "thought: make empty places visible" }), runtime, {}, db);
    expect(await response.json()).toMatchObject({ proposal: { kind: "capture", automatic: true } });
    setGrant(db, "studio.capture", false, NOW.getTime());
    expect(await (await handleDeskAsk(request({ text: "capture: another thought" }), runtime, {}, db)).json()).toMatchObject({ proposal: { kind: "capture" } });
  });

  it("validates Undo identifiers and refuses filing with Studio disabled", async () => {
    expect((await handleDeskCaptureUndo(request({ id: "../oops", requestId: rid() }), db, runtime)).status).toBe(400);
    if (!runtime.options) throw new Error("missing runtime options");
    const off: DeskRuntime = { ...runtime, options: { ...runtime.options, studio: undefined } };
    const response = await handleDeskCreate(request({ kind: "capture", fields: { text: "A thought" }, requestId: rid() }), db, off);
    expect(response.status).toBe(409);
  });
});
