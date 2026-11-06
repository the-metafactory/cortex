import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { buildRoutineCard, readRoutines } from "../desk/routines";
import { buildRoutineCapabilities } from "../desk/routine-capability";
import { CapabilityRefusalSchema } from "../desk/routine-capability-contract";
import { readRoutineProposal } from "../desk/routine-store";
import type { RoutineOptions, RoutineRunner } from "../desk/routine-command";
import { HandledLedger } from "../desk/actions";
import { RoutinesSection } from "../dashboard-v2/components/desk-routines";
import { RoutineOptionsSchema } from "../../../common/types/desk-routines";
import { RoutineReadLoop } from "../desk/routine-read";

const START = ["builder", "build-now", "{id}", "--map", "{map}"];
const STATUS = ["status-command", "{ref}"];
const BUILD = { writer: ["capability-writer"], map: "example/maps#12", start: START, status: STATUS, budget: { tokens: 200_000, invocations: 40, minutes: 60 } };
const OPTIONS: RoutineOptions = { composer: ["composer"], reflex: ["reflex"], target: "@example/pulse-flow", timeZone: "Europe/Zurich", timeoutSeconds: 10, composeTimeoutSeconds: 10, readTimeoutSeconds: 1, capabilityBuild: BUILD };
const NOW = Date.parse("2026-11-03T12:00:00Z");
const YAML = "name: F_AGENT\nactions:\n  - agent:\n      name: derive\n      capability: compose.judgment\n      prompt: 'Judge {text}'\n      collect: result\n";
const TWO_YAML = `${YAML}  - agent:\n      name: second\n      capability: review.adversarial\n      prompt: 'Attack {result}'\n      collect: ruling\n`;
const none = (): ReadonlySet<string> => new Set();
const ok = (stdout: string) => Promise.resolve({ code: 0, stdout, stderr: "" });

interface Harness { run: RoutineRunner; starts: string[][]; statuses: { argv: string[]; timeoutMs: number }[] }
function harness(options: { start?: (argv: string[]) => ReturnType<RoutineRunner>; status?: (ref: string) => ReturnType<RoutineRunner>; existing?: boolean } = {}): Harness {
  const h: Harness = { starts: [], statuses: [], run: () => ok("") };
  h.run = (argv, stdin, timeoutMs) => {
    if (argv[0] === "capability-writer") {
      const capability = (JSON.parse(stdin) as { capability: string }).capability;
      return ok(JSON.stringify({ ref: `example/maps#${capability === "compose.judgment" ? 21 : 22}`, url: `https://example.test/${capability}`, existing: options.existing ?? false }));
    }
    if (argv[0] === "builder") { h.starts.push(argv); return options.start?.(argv) ?? ok(""); }
    if (argv[0] === "status-command") { h.statuses.push({ argv, timeoutMs }); return options.status?.(argv[1] ?? "") ?? ok(JSON.stringify({ state: "filed" })); }
    return ok("[]");
  };
  return h;
}

async function draftWithNodes(db: Database, h: Harness, options: RoutineOptions = OPTIONS, yaml = TWO_YAML): Promise<string> {
  const composer: RoutineRunner = () => ok(JSON.stringify({ status: "complete", yaml }));
  const refused = await buildRoutineCard(db, "every minute, derive a result", options, NOW, composer, none);
  const { proposalId } = CapabilityRefusalSchema.parse(refused.capabilities);
  await buildRoutineCapabilities(db, options, new HandledLedger(), { requestId: "build-request-1", proposalId }, h.run);
  return proposalId;
}

describe("starting a filed capability build", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("runs the start command once per newly filed node with the node id and the map", async () => {
    const h = harness();
    await draftWithNodes(db, h);
    expect(h.starts).toEqual([
      ["builder", "build-now", "21", "--map", "example/maps#12"],
      ["builder", "build-now", "22", "--map", "example/maps#12"],
    ]);
  });

  it("keeps the filing and records why when the start command exits non-zero", async () => {
    const h = harness({ start: () => Promise.resolve({ code: 1, stdout: "", stderr: "refused: the implement lane is held\n" }) });
    const proposalId = await draftWithNodes(db, h, OPTIONS, YAML);
    const node = readRoutineProposal(db, proposalId)?.draft?.nodes["compose.judgment"];
    expect(node).toEqual({ ref: "example/maps#21", url: "https://example.test/compose.judgment", existing: false, notStarted: "refused: the implement lane is held" });
  });

  it("reports a start command that throws as not started", async () => {
    const h = harness({ start: () => Promise.reject(new Error("spawn builder ENOENT")) });
    const proposalId = await draftWithNodes(db, h, OPTIONS, YAML);
    expect(readRoutineProposal(db, proposalId)?.draft?.nodes["compose.judgment"]?.notStarted).toContain("spawn builder ENOENT");
  });

  it("does not start a node that was already filed", async () => {
    const h = harness({ existing: true });
    const proposalId = await draftWithNodes(db, h, OPTIONS, YAML);
    expect(h.starts).toEqual([]);
    expect(readRoutineProposal(db, proposalId)?.draft?.nodes["compose.judgment"]?.notStarted).toBeUndefined();
  });

  it("does not start anything when no start command is configured", async () => {
    const h = harness();
    await draftWithNodes(db, h, { ...OPTIONS, capabilityBuild: { ...BUILD, start: undefined } }, YAML);
    expect(h.starts).toEqual([]);
  });

  it("does not start a node a second build request already recorded", async () => {
    const h = harness();
    const proposalId = await draftWithNodes(db, h);
    await buildRoutineCapabilities(db, OPTIONS, new HandledLedger(), { requestId: "build-request-2", proposalId }, h.run);
    expect(h.starts).toHaveLength(2);
  });
});

describe("reading the build state of a draft", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  const read = async (h: Harness, present: string[] = []) => readRoutines(db, OPTIONS, h.run, () => new Set(present));
  const markup = (view: Awaited<ReturnType<typeof read>>): string => renderToStaticMarkup(<RoutinesSection view={view} onChanged={() => undefined} />);

  it("shows building and in review with a link to each node", async () => {
    const states: Record<string, string> = {
      "example/maps#21": JSON.stringify({ state: "building" }),
      "example/maps#22": JSON.stringify({ state: "in-review", pr: 3200 }),
    };
    const h = harness({ status: (ref) => ok(states[ref] ?? "") });
    await draftWithNodes(db, h);
    const html = markup(await read(h));
    expect(html).toContain("Building");
    expect(html).toContain("In review");
    expect(html).toContain("PR #3200");
    expect(html).toContain('href="https://example.test/compose.judgment"');
    expect(html).toContain('href="https://example.test/review.adversarial"');
  });

  it("shows merged and failed with its reason", async () => {
    const h = harness({ status: (ref) => ok(JSON.stringify(ref.endsWith("#21") ? { state: "merged", pr: 3201 } : { state: "failed", reason: "tests failed after the worker" })) });
    await draftWithNodes(db, h);
    const html = markup(await read(h));
    expect(html).toContain("Merged");
    expect(html).not.toContain("Live");
    expect(html).toContain("Failed: tests failed after the worker");
  });

  it("shows filed", async () => {
    const h = harness();
    await draftWithNodes(db, h);
    expect(markup(await read(h))).toContain("Filed, waiting to start");
  });

  it("shows live instead of merged once the capability is in local presence", async () => {
    const h = harness({ status: () => ok(JSON.stringify({ state: "merged" })) });
    await draftWithNodes(db, h);
    const view = await read(h, ["compose.judgment"]);
    const states = Object.fromEntries((view.drafts?.[0]?.nodes ?? []).map((n) => [n.capability, n.build?.state]));
    expect(states).toEqual({ "compose.judgment": "live", "review.adversarial": "merged" });
    expect(markup(view)).toContain("Live");
  });

  it("shows state unknown with the error when the status command fails, never a guess", async () => {
    const h = harness({ status: () => Promise.resolve({ code: 2, stdout: "", stderr: "journal is locked\n" }) });
    await draftWithNodes(db, h);
    const html = markup(await read(h));
    expect(html).toContain("State unknown: journal is locked");
    expect(html).not.toContain("Filed, waiting");
  });

  it("shows state unknown when the status command prints invalid JSON or an unknown state", async () => {
    for (const printed of ["not json", JSON.stringify({ state: "sleeping" }), JSON.stringify({})]) {
      const h = harness({ status: () => ok(printed) });
      const local = initDatabase(":memory:");
      await draftWithNodes(local, h);
      const view = await readRoutines(local, OPTIONS, h.run, none);
      expect(view.drafts?.[0]?.nodes.map((n) => n.build?.state)).toEqual(["unknown", "unknown"]);
      local.close();
    }
  });

  it("shows state unknown when the status command times out", async () => {
    const slow: RoutineOptions = { ...OPTIONS, readTimeoutSeconds: 0.05 };
    const h = harness({ status: () => new Promise(() => undefined) });
    await draftWithNodes(db, h, slow, YAML);
    const view = await readRoutines(db, slow, h.run, none);
    expect(view.drafts?.[0]?.nodes[0]?.build).toMatchObject({ state: "unknown" });
  });

  it("reads each ref once per read, with the routine read timeout", async () => {
    const h = harness();
    await draftWithNodes(db, h);
    await read(h);
    expect(h.statuses.map((s) => s.argv[1]).sort()).toEqual(["example/maps#21", "example/maps#22"]);
    expect(h.statuses.every((s) => s.timeoutMs === 1000)).toBe(true);
  });

  it("reads a node shared by two drafts once", async () => {
    const h = harness({ existing: true });
    await draftWithNodes(db, h, OPTIONS, YAML);
    const composer: RoutineRunner = () => ok(JSON.stringify({ status: "complete", yaml: YAML }));
    const second = await buildRoutineCard(db, "every hour, derive a result", OPTIONS, NOW, composer, none);
    await buildRoutineCapabilities(db, OPTIONS, new HandledLedger(), { requestId: "build-request-3", proposalId: CapabilityRefusalSchema.parse(second.capabilities).proposalId }, h.run);
    const view = await read(h);
    expect(view.drafts).toHaveLength(2);
    expect(h.statuses.map((s) => s.argv[1])).toEqual(["example/maps#21"]);
  });

  it("the Desk read loop shows drafts and Live through its presence check", async () => {
    const h = harness({ status: () => ok(JSON.stringify({ state: "merged" })) });
    await draftWithNodes(db, h);
    const loop = new RoutineReadLoop(() => new Set(["compose.judgment"]));
    await loop.refresh(db, OPTIONS, NOW, h.run);
    const view = loop.read(db, OPTIONS, NOW);
    expect(view.drafts?.[0]?.nodes.map((n) => [n.capability, n.build?.state])).toEqual([["compose.judgment", "live"], ["review.adversarial", "merged"]]);
  });

  it("shows a node that was not started with its reason", async () => {
    const h = harness({ start: () => Promise.resolve({ code: 1, stdout: "", stderr: "the implement lane is held" }) });
    await draftWithNodes(db, h, OPTIONS, YAML);
    expect(markup(await read(h))).toContain("Not started: the implement lane is held");
  });

  it("reads no state without a status command, and no drafts without the capability check", async () => {
    const h = harness();
    await draftWithNodes(db, h, OPTIONS, YAML);
    const noStatus: RoutineOptions = { ...OPTIONS, capabilityBuild: { ...BUILD, status: undefined } };
    const view = await readRoutines(db, noStatus, h.run, none);
    expect(view.drafts?.[0]?.nodes[0]?.build).toBeNull();
    const before = h.statuses.length;
    expect((await readRoutines(db, OPTIONS, h.run)).drafts).toBeUndefined();
    expect(h.statuses).toHaveLength(before);
  });

  it("still shows draft state when Reflex cannot be read", async () => {
    const h = harness();
    await draftWithNodes(db, h, OPTIONS, YAML);
    const failing: RoutineRunner = (argv, stdin, timeoutMs) => argv[0] === "reflex" ? Promise.resolve({ code: 3, stdout: "", stderr: "down" }) : h.run(argv, stdin, timeoutMs);
    const view = await readRoutines(db, OPTIONS, failing, none);
    expect(view.error).toContain("Routines could not be read");
    expect(view.drafts).toHaveLength(1);
  });
});

describe("the start and status configuration", () => {
  const base = { composer: ["c"], reflex: ["r"], target: "@example/pulse-flow", timeZone: "Europe/Zurich" };
  it("accepts commands that pass the node", () => {
    expect(RoutineOptionsSchema.safeParse({ ...base, capabilityBuild: BUILD }).success).toBe(true);
    expect(RoutineOptionsSchema.safeParse({ ...base, capabilityBuild: { ...BUILD, start: ["start", "{ref}"], status: ["status", "--id", "{id}"] } }).success).toBe(true);
  });
  it("rejects a command that never passes the node, and an empty one", () => {
    for (const bad of [{ ...BUILD, start: ["builder", "build-now"] }, { ...BUILD, status: [] }, { ...BUILD, status: ["status", "{map}"] }]) {
      expect(RoutineOptionsSchema.safeParse({ ...base, capabilityBuild: bad }).success).toBe(false);
    }
  });
});
