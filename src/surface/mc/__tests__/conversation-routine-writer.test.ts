import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ProposalView } from "../../../conversations/creation";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import type { WriterResult } from "../desk/create";
import type { InstalledRoutine, RoutineOptions } from "../desk/routine-command";
import { conversationRoutineId } from "../desk/routine-conversation-writer";
import { conversationWriterRig } from "./conversation-writer-rig";

const TARGET = "@jc/pulse-flow";
const REFLEX = ["reflex-bin"];
const writerRig = conversationWriterRig("conversation-routine-", "ai.meta-factory.cortex.routine-writer-test");

const routineOptions: RoutineOptions = { composer: ["composer-bin"], reflex: REFLEX, target: TARGET, timeZone: "Europe/Zurich", timeoutSeconds: 5, readTimeoutSeconds: 1 };
const refusal = (code: string, message: string): WriterResult => ({ code: 1, stdout: JSON.stringify({ error: { code, message } }), stderr: "" });
const ok = (data: unknown): WriterResult => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });

function fakeReflex() {
  const routines = new Map<string, InstalledRoutine>();
  const calls: string[][] = [];
  let afterAdd: ((argv: string[]) => WriterResult) | undefined;
  const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1] ?? "";
  const run = (argv: string[]): Promise<WriterResult> => {
    calls.push(argv);
    const args = argv.slice(REFLEX.length);
    if (args[0] === "routine" && args[1] === "list") return Promise.resolve(ok([...routines.values()]));
    if (args[0] !== "routine" || args[1] !== "add") return Promise.resolve(refusal("invalid-input", `unexpected ${args.join(" ")}`));
    const id = flag(args, "--id");
    if (routines.has(id)) return Promise.resolve(refusal("invalid-input", `Duplicate activation id ${id}`));
    routines.set(id, { id, schedule: flag(args, "--schedule"), timezone: flag(args, "--timezone"), policy: "approval", paused: args.includes("--paused"), runtimeConfirmed: true, target: flag(args, "--target"), file: `${id}.yaml`, lastDecision: null });
    return Promise.resolve(afterAdd ? afterAdd(argv) : ok({ id, file: `${id}.yaml` }));
  };
  return { routines, calls, run, failAfterAdd: (answer: (argv: string[]) => WriterResult) => { afterAdd = answer; } };
}

interface Reply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string }; types: { type: string; status: string }[] }

async function rig(routines: RoutineOptions | null = routineOptions) {
  const db = writerRig.database();
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(routines ? { routines } : {}) };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const { host, call } = await writerRig.open<Reply>(db, runtime);
  const reflex = fakeReflex();
  await host.attachSources(conversationSources({ db, desk: () => options, runRoutine: reflex.run }));
  const id = (await call("POST", "/api/conversations", { title: "Synthetic routine", origin: { kind: "web" }, policy: "local" })).body.conversation.id;
  const propose = async (fields: Record<string, string>) => (await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "routine", fields })).body.proposal;
  const confirm = (view: ProposalView) => call("POST", `/api/conversations/${id}/proposals/${view.proposal.proposalId}/confirm`, { revision: view.proposal.revision, digest: view.digest });
  const check = (view: ProposalView) => call("POST", `/api/conversations/${id}/proposals/${view.proposal.proposalId}/check`);
  const capability = async () => (await call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === "routine")?.status;
  return { options, reflex, propose, confirm, check, capability };
}

const PROBE = { name: "Ivy probe 0a1b", target: TARGET, schedule: "0 3 1 1 *", timezone: "Europe/Zurich" };
const operationIdOf = (view: ProposalView): string => view.operation?.operationId ?? "";
const forbidden = (argv: string[]): boolean => argv.some(a => ["lifecycle", "set-policy", "approve", "remove", "run", "fire"].includes(a)) || argv.includes("--policy");

describe("Reflex routine writer for conversation proposals", () => {
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
