import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ProposalView } from "../../../conversations/creation";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import type { WriterResult } from "../desk/create";
import type { FlowOptions } from "../desk/flow-conversation-writer";
import type { InstalledRoutine, RoutineOptions } from "../desk/routine-command";
import { conversationRoutineId } from "../desk/routine-conversation-writer";
import { conversationWriterRig } from "./conversation-writer-rig";

const TARGET = "@jc/pulse-flow";
const REFLEX = ["reflex-bin"];
const PULSE = ["pulse-bin", "--stack", "test"];
const writerRig = conversationWriterRig("conversation-routine-", "ai.meta-factory.cortex.routine-writer-test");

const routineOptions: RoutineOptions = { composer: ["composer-bin"], reflex: REFLEX, target: TARGET, timeZone: "Europe/Zurich", timeoutSeconds: 5, readTimeoutSeconds: 1 };
const refusal = (code: string, message: string): WriterResult => ({ code: 1, stdout: JSON.stringify({ error: { code, message } }), stderr: "" });
const ok = (data: unknown): WriterResult => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });

function fakeReflex() {
  const routines = new Map<string, InstalledRoutine>();
  const calls: string[][] = [];
  const files: { path: string; bytes: Buffer; mode: number }[] = [];
  let afterAdd: ((argv: string[]) => WriterResult) | undefined;
  const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1] ?? "";
  const run = (argv: string[]): Promise<WriterResult> => {
    calls.push(argv);
    const args = argv.slice(REFLEX.length);
    if (args[0] === "routine" && args[1] === "list") return Promise.resolve(ok([...routines.values()]));
    if (args[0] !== "routine" || args[1] !== "add") return Promise.resolve(refusal("invalid-input", `unexpected ${args.join(" ")}`));
    if (args.includes("--flow-file")) {
      const path = flag(args, "--flow-file");
      files.push({ path, bytes: readFileSync(path), mode: statSync(path).mode & 0o777 });
    }
    const id = flag(args, "--id");
    if (routines.has(id)) return Promise.resolve(refusal("invalid-input", `Duplicate activation id ${id}`));
    routines.set(id, { id, schedule: flag(args, "--schedule"), timezone: flag(args, "--timezone"), policy: "approval", paused: args.includes("--paused"), runtimeConfirmed: true, target: flag(args, "--target"), file: `${id}.yaml`, lastDecision: null });
    return Promise.resolve(afterAdd ? afterAdd(argv) : ok({ id, file: `${id}.yaml` }));
  };
  return { routines, calls, files, run, failAfterAdd: (answer: (argv: string[]) => WriterResult) => { afterAdd = answer; } };
}

interface Reply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string }; types: { type: string; status: string }[] }

async function rig(routines: RoutineOptions | null = routineOptions, flows?: FlowOptions) {
  const db = writerRig.database();
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(routines ? { routines } : {}), ...(flows ? { flows } : {}) };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const rig = await writerRig.open<Reply>(db, runtime);
  const reflex = fakeReflex();
  const pulseCalls: string[][] = [];
  let pulseReply = () => Promise.resolve(ok({ name: FLOW, source: "saved", yaml: YAML }));
  const runFlow = async (argv: string[], stdin: string, timeout: number) => {
    pulseCalls.push(argv);
    expect(stdin).toBe("");
    expect(timeout).toBe(5_000);
    return pulseReply();
  };
  await rig.host.attachSources(conversationSources({ db, desk: () => options, runRoutine: reflex.run, runFlow }));
  const id = await rig.start("Synthetic routine");
  const propose = (fields: Record<string, string>) => rig.propose(id, "routine", fields);
  const confirm = (view: ProposalView) => rig.confirm(id, view);
  const check = (view: ProposalView) => rig.check(id, view);
  const capability = async () => (await rig.call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === "routine")?.status;
  const flowField = async () => (await rig.call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === "routine");
  return { options, reflex, propose, confirm, check, capability, flowField, pulseCalls, answerPulse: (reply: typeof pulseReply) => { pulseReply = reply; } };
}

const PROBE = { name: "Ivy probe 0a1b", target: TARGET, schedule: "0 3 1 1 *", timezone: "Europe/Zurich" };
const FLOW = "F_IVY_PROBE_0A1B";
const YAML = `name: ${FLOW}\r\ndescription: Zürich ☕\r\nsteps: []\r\nprovenance:\r\n  conversation: synthetic\r\n  exchange: synthetic`;
const operationIdOf = (view: ProposalView): string => view.operation?.operationId ?? "";
const forbidden = (argv: string[]): boolean => argv.some(a => ["lifecycle", "set-policy", "approve", "remove", "run", "fire"].includes(a)) || argv.includes("--policy");
const expectOnlyFlowLookup = (r: Awaited<ReturnType<typeof rig>>): void => {
  expect(r.pulseCalls).toEqual([[...PULSE, "flow", "show", FLOW, "--json"]]);
  expect(r.reflex.calls.some(forbidden)).toBe(false);
};

describe("Reflex routine writer for conversation proposals", () => {
  test("the catalog offers an optional saved-flow name", async () => {
    const r = await rig();
    expect(await r.flowField()).toMatchObject({ fields: expect.arrayContaining([{ name: "flow", label: "Saved flow (name)", kind: "text", required: false }]) });
  });

  test.each([YAML, `${YAML}\n`])("a saved flow is copied byte for byte into a private temporary file and installed paused: %j", async yaml => {
    const r = await rig(routineOptions, { pulse: PULSE });
    r.answerPulse(() => Promise.resolve(ok({ name: FLOW, source: "saved", yaml })));
    const view = await r.propose({ ...PROBE, flow: FLOW });
    const confirmed = await r.confirm(view);
    expect([confirmed.status, confirmed.body.proposal.feedback]).toEqual([200, "created"]);
    const id = conversationRoutineId(PROBE.name, operationIdOf(confirmed.body.proposal));
    const file = r.reflex.files[0];
    expect(file?.bytes).toEqual(Buffer.from(yaml));
    expect(file?.mode).toBe(0o600);
    expect(existsSync(file?.path ?? "")).toBe(false);
    expect(r.reflex.calls).toEqual([[...REFLEX, "routine", "add", "--id", id, "--name", PROBE.name, "--schedule", PROBE.schedule, "--timezone", PROBE.timezone, "--target", TARGET, "--payload", "{}", "--paused", "--flow-file", file?.path ?? "", "--json"]]);
    expect((await r.check(view)).body.proposal.feedback).toBe("created");
    expect(r.reflex.routines.get(id)).toMatchObject({ paused: true, policy: "approval", target: TARGET });
    expect((await r.confirm(view)).body.proposal.feedback).toBe("created");
    expectOnlyFlowLookup(r);
  });

  test("no saved-flow lookup happens without a flow name", async () => {
    const r = await rig(routineOptions, { pulse: PULSE });
    expect((await r.confirm(await r.propose(PROBE))).body.proposal.feedback).toBe("created");
    expect(r.pulseCalls).toEqual([]);
    expect(r.reflex.files).toEqual([]);
  });

  test("a flow name without Pulse configured fails before either owner is called", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, flow: FLOW }));
    expect([refused.status, refused.body.proposal.feedback, refused.body.error]).toEqual([409, "failed", "This stack has no Pulse configured for saved flows. Nothing was created."]);
    expect(r.reflex.calls).toEqual([]);
    expect(r.pulseCalls).toEqual([]);
  });

  test.each([
    [1, { status: "not-found" }, `No saved flow is named ${FLOW}. Nothing was created.`],
    [0, { name: FLOW, source: "arc", yaml: YAML }, "Only saved flows can be attached. Nothing was created."],
    [2, { status: "unreadable", reason: "EACCES" }, "Pulse could not read the saved flows. Nothing was created."],
    [0, { status: "unreadable", name: FLOW, source: "saved", yaml: YAML }, "Pulse could not read the saved flows. Nothing was created."],
    [0, { name: FLOW, source: "saved" }, "Pulse could not read the saved flows. Nothing was created."],
    [0, { name: "another-flow", source: "saved", yaml: YAML }, "Pulse could not read the saved flows. Nothing was created."],
    [2, { name: FLOW, source: "saved", yaml: YAML }, "Pulse could not read the saved flows. Nothing was created."],
  ])("Pulse response %j %j fails before Reflex: %s", async (code, data, message) => {
    const r = await rig(routineOptions, { pulse: PULSE });
    r.answerPulse(() => Promise.resolve({ code, stdout: JSON.stringify(data), stderr: "" }));
    const refused = await r.confirm(await r.propose({ ...PROBE, flow: FLOW }));
    expect([refused.status, refused.body.proposal.feedback, refused.body.error]).toEqual([409, "failed", message]);
    expect(r.reflex.calls).toEqual([]);
    expect(r.pulseCalls).toEqual([[...PULSE, "flow", "show", FLOW, "--json"]]);
  });

  test.each(["malformed", "throws"])("a %s Pulse response fails rather than becoming uncertain", async kind => {
    const r = await rig(routineOptions, { pulse: PULSE });
    r.answerPulse(() => kind === "throws" ? Promise.reject(new Error("Pulse timed out")) : Promise.resolve({ code: 0, stdout: "not json", stderr: "" }));
    const refused = await r.confirm(await r.propose({ ...PROBE, flow: FLOW }));
    expect([refused.status, refused.body.proposal.feedback, refused.body.error]).toEqual([409, "failed", "Pulse could not read the saved flows. Nothing was created."]);
    expect(r.reflex.calls).toEqual([]);
  });

  test.each([true, false])("an existing routine with paused=%j follows the existing retry rule", async paused => {
    const r = await rig(routineOptions, { pulse: PULSE });
    const view = await r.propose({ ...PROBE, flow: FLOW });
    const id = conversationRoutineId(PROBE.name, `${view.proposal.conversationId}:${view.proposal.proposalId}:1`);
    const existing: InstalledRoutine = { id, schedule: PROBE.schedule, timezone: PROBE.timezone, target: TARGET, paused, policy: "approval", runtimeConfirmed: true, file: `${id}.yaml`, lastDecision: null };
    r.reflex.routines.set(id, existing);
    const confirmed = await r.confirm(view);
    expect(confirmed.body.proposal.feedback).toBe(paused ? "created" : "failed");
    expect(r.reflex.routines.get(id)).toEqual(existing);
    expect(existsSync(r.reflex.files[0]?.path ?? "")).toBe(false);
    expectOnlyFlowLookup(r);
  });

  test("temporary YAML is removed when Reflex leaves the write uncertain, and readback stays owner-backed", async () => {
    const r = await rig(routineOptions, { pulse: PULSE });
    r.reflex.failAfterAdd(() => refusal("write-uncertain", "Reflex could not confirm the write"));
    const view = await r.propose({ ...PROBE, flow: FLOW });
    expect((await r.confirm(view)).body.proposal.feedback).toBe("uncertain");
    expect(existsSync(r.reflex.files[0]?.path ?? "")).toBe(false);
    expect((await r.check(view)).body.proposal.feedback).toBe("created");
    expectOnlyFlowLookup(r);
  });

  test("the type is ready only with routines configured on an enabled Desk", async () => {
    const ready = await rig();
    expect(await ready.capability()).toBe("ready");
    ready.options.enabled = false;
    expect(await ready.capability()).toBe("blocked:3035");
    expect(await (await rig(null)).capability()).toBe("blocked:3035");
  });

  test("a confirmed proposal adds the routine paused with exactly the owner argv, and the identical confirm adds nothing", async () => {
    const r = await rig();
    const view = await r.propose(PROBE);
    const first = await r.confirm(view);
    expect(first.status).toBe(200);
    expect(first.body.proposal.feedback).toBe("created");
    const routineId = conversationRoutineId(PROBE.name, operationIdOf(first.body.proposal));
    expect(routineId).toMatch(/^ivy-probe-0a1b-[0-9a-f]{12}$/);
    expect(first.body.proposal.operation?.canonicalId).toBe(routineId);
    expect(r.reflex.calls).toEqual([[...REFLEX, "routine", "add", "--id", routineId, "--name", PROBE.name, "--schedule", PROBE.schedule, "--timezone", PROBE.timezone, "--target", TARGET, "--payload", "{}", "--paused", "--json"]]);
    expect(r.reflex.routines.get(routineId)).toMatchObject({ paused: true, policy: "approval", target: TARGET });
    const again = await r.confirm(view);
    expect(again.status).toBe(200);
    expect(again.body.proposal.operation?.canonicalId).toBe(routineId);
    expect([...r.reflex.routines.keys()]).toEqual([routineId]);
    expect(r.reflex.calls.some(forbidden)).toBe(false);
  });

  test("a write the owner saved but did not confirm stays uncertain, and Check finds the one routine", async () => {
    const r = await rig();
    r.reflex.failAfterAdd(() => refusal("write-uncertain", "Reflex could not confirm the write"));
    const view = await r.propose(PROBE);
    const confirmed = await r.confirm(view);
    expect(confirmed.body.proposal.feedback).toBe("uncertain");
    const checked = await r.check(view);
    expect(checked.body.proposal.feedback).toBe("created");
    const routineId = conversationRoutineId(PROBE.name, operationIdOf(checked.body.proposal));
    expect(checked.body.proposal.operation?.canonicalId).toBe(routineId);
    expect([...r.reflex.routines.keys()]).toEqual([routineId]);
    expect(r.reflex.calls.filter(argv => argv.includes("add"))).toHaveLength(1);
    expect(r.reflex.calls.some(forbidden)).toBe(false);
  });

  test("another target is refused with 409 before Reflex is called", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, target: "@jc/reflex-smoke" }));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe(`This stack creates routines only for ${TARGET}. Nothing was created.`);
    expect(r.reflex.calls).toEqual([]);
  });

  test("an id that exists with another schedule fails and leaves the existing routine unchanged", async () => {
    const r = await rig();
    const view = await r.propose(PROBE);
    const probe = conversationRoutineId(PROBE.name, `${view.proposal.conversationId}:${view.proposal.proposalId}:1`);
    const existing: InstalledRoutine = { id: probe, schedule: "0 4 * * *", timezone: "Europe/Zurich", policy: "approval", paused: true, runtimeConfirmed: true, target: TARGET, file: `${probe}.yaml`, lastDecision: null };
    r.reflex.routines.set(probe, existing);
    const refused = await r.confirm(view);
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe(`Duplicate activation id ${probe}. Nothing was created.`);
    expect(r.reflex.routines.get(probe)).toEqual(existing);
    expect(r.reflex.calls.some(forbidden)).toBe(false);
  });

  test("a long or accented name becomes a bounded slug cut at a dash", () => {
    const long = conversationRoutineId(`Zürich ${"weekly review ".repeat(10)}`, "c:p:1");
    expect(long).toMatch(/^zurich-weekly-review-[a-z0-9-]*-[0-9a-f]{12}$/);
    expect(long.length).toBeLessThanOrEqual(93);
    expect(long.split("-").slice(0, -1).join("-").endsWith("review")).toBe(true);
    expect(conversationRoutineId("!!!", "c:p:1")).toMatch(/^[0-9a-f]{12}$/);
    expect(conversationRoutineId("Morning brief", "c:p:1")).toBe(conversationRoutineId("Morning brief", "c:p:1"));
    expect(conversationRoutineId("Morning brief", "c:p:2")).not.toBe(conversationRoutineId("Morning brief", "c:p:1"));
  });
});
