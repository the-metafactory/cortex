import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ProposalView } from "../../../conversations/creation";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { studioRequestId } from "../desk/conversation-ids";
import { conversationSources } from "../desk/conversation-sources";
import type { WriterResult } from "../desk/create";
import type { FlowOptions } from "../desk/flow-conversation-writer";
import { conversationWriterRig, type ConversationWriterReply as Reply } from "./conversation-writer-rig";

const PULSE = ["pulse-bin", "--stack", "test"];
const writerRig = conversationWriterRig("conversation-flow-", "ai.meta-factory.cortex.flow-writer-test");
const answer = (code: number, data: unknown): WriterResult => ({ code, stdout: JSON.stringify(data), stderr: "" });

interface SavedFlow { yaml: string; requestId: string; conversation: string; exchange: string }

function fakePulse() {
  const flows = new Map<string, SavedFlow>();
  const calls: string[][] = [];
  const files: { path: string; mode: number }[] = [];
  let next: ((argv: string[]) => WriterResult | Promise<WriterResult>) | undefined;
  const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1] ?? "";
  const save = (args: string[]): WriterResult => {
    const path = flag(args, "--file");
    files.push({ path, mode: statSync(path).mode & 0o777 });
    const yaml = readFileSync(path, "utf8");
    const name = /^name:\s*(\S+)/m.exec(yaml)?.[1] ?? "";
    const requestId = flag(args, "--request-id");
    const prior = flows.get(name);
    if (prior && (prior.requestId !== requestId || prior.yaml !== yaml)) return answer(1, { status: "conflict", reason: `A saved flow is already named ${name}.` });
    if (!prior) flows.set(name, { yaml, requestId, conversation: flag(args, "--conversation"), exchange: flag(args, "--exchange") });
    return answer(0, { status: prior ? "exists" : "saved", name, path: `/flows/${name}.yaml`, sha256: "abc" });
  };
  const show = (args: string[]): WriterResult => {
    const requestId = flag(args, "--request-id");
    const hit = [...flows.entries()].find(([, f]) => f.requestId === requestId);
    return hit ? answer(0, { name: hit[0], path: `/flows/${hit[0]}.yaml`, source: "saved", sha256: "abc", provenance: null, yaml: hit[1].yaml }) : answer(1, { status: "not-found" });
  };
  const run = async (argv: string[]): Promise<WriterResult> => {
    calls.push(argv);
    if (next) return next(argv);
    const args = argv.slice(PULSE.length);
    if (args[0] === "flow" && args[1] === "save") return save(args);
    if (args[0] === "flow" && args[1] === "show") return show(args);
    return answer(1, { status: "invalid", findings: [{ rule: "test", message: `unexpected ${args.join(" ")}` }] });
  };
  return { flows, calls, files, run, save: (argv: string[]) => save(argv.slice(PULSE.length)), answerNext: (reply: typeof next) => { next = reply; } };
}

async function rig(flows: FlowOptions | null = { pulse: PULSE }) {
  const db = writerRig.database();
  const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(flows ? { flows } : {}) };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const rig = await writerRig.open<Reply>(db, runtime);
  const pulse = fakePulse();
  await rig.host.attachSources(conversationSources({ db, desk: () => options, runFlow: pulse.run }));
  const id = await rig.start("Synthetic flow");
  const propose = (fields: Record<string, string>) => rig.propose(id, "flow", fields);
  const confirm = (view: ProposalView) => rig.confirm(id, view);
  const check = (view: ProposalView) => rig.check(id, view);
  const capability = async () => (await rig.call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === "flow");
  const confirmThenCheck = async () => {
    const view = await propose(PROBE);
    const confirmed = (await confirm(view)).body.proposal;
    const checked = (await check(view)).body.proposal;
    return { feedback: [confirmed.feedback, checked.feedback], checked };
  };
  return { id, options, pulse, propose, confirm, check, capability, confirmThenCheck };
}

const NAME = "F_IVY_PROBE_0A1B";
const DEFINITION = `name: ${NAME}\ndescription: Synthetic probe\nsteps:\n  - id: echo\n    action: shell\n    command: echo hi\n`;
const PROBE = { name: NAME, definition: DEFINITION };
const operationIdOf = (view: ProposalView): string => view.operation?.operationId ?? "";
const forbidden = (argv: string[]): boolean => argv.some(a => ["run", "pulse-flow", "reflex", "routine", "schedule", "enable"].includes(a));

describe("Pulse flow writer for conversation proposals", () => {
  test("the type is ready only with flows configured on an enabled Desk, and names its own build node otherwise", async () => {
    const ready = await rig();
    const capability = await ready.capability();
    expect(capability?.status).toBe("ready");
    expect(capability?.fields.map(f => f.name)).toEqual(["name", "definition"]);
    ready.options.enabled = false;
    expect((await ready.capability())?.status).toBe("blocked:3146");
    const missing = await rig(null);
    expect(await missing.capability()).toMatchObject({ status: "blocked:3146", reason: "No Pulse writer is connected on this stack yet." });
  });

  test("a confirmed proposal saves the flow with exactly the owner argv, and the identical confirm saves nothing more", async () => {
    const r = await rig();
    const view = await r.propose(PROBE);
    const first = await r.confirm(view);
    expect([first.status, first.body.proposal.feedback, first.body.proposal.operation?.canonicalId]).toEqual([200, "created", NAME]);
    const requestId = studioRequestId(operationIdOf(first.body.proposal));
    const [file] = r.pulse.files;
    expect(r.pulse.calls).toEqual([[...PULSE, "flow", "save", "--file", file?.path ?? "", "--request-id", requestId, "--conversation", r.id, "--exchange", view.proposal.proposalId, "--json"]]);
    expect(file?.mode).toBe(0o600);
    expect(existsSync(file?.path ?? "")).toBe(false);
    expect(r.pulse.flows.get(NAME)).toEqual({ yaml: DEFINITION, requestId, conversation: r.id, exchange: view.proposal.proposalId });
    const again = await r.confirm(view);
    expect(again.status).toBe(200);
    expect(again.body.proposal.operation?.canonicalId).toBe(NAME);
    expect([...r.pulse.flows.keys()]).toEqual([NAME]);
    expect(r.pulse.calls.some(forbidden)).toBe(false);
  });

  test("a save Pulse made but did not confirm stays uncertain, and Check finds the one flow by request ID", async () => {
    const r = await rig();
    r.pulse.answerNext(argv => {
      r.pulse.answerNext(undefined);
      r.pulse.save(argv);
      return { code: 0, stdout: "not json", stderr: "" };
    });
    const { feedback, checked } = await r.confirmThenCheck();
    expect(feedback).toEqual(["uncertain", "created"]);
    expect(checked.operation?.canonicalId).toBe(NAME);
    const requestId = studioRequestId(operationIdOf(checked));
    expect(r.pulse.calls.at(-1)).toEqual([...PULSE, "flow", "show", "--request-id", requestId, "--json"]);
    expect([...r.pulse.flows.keys()]).toEqual([NAME]);
    expect(r.pulse.calls.filter(argv => argv.includes("save"))).toHaveLength(1);
    expect(r.pulse.calls.some(forbidden)).toBe(false);
  });

  test("a name Pulse already holds fails with the owner's sentence and leaves the existing flow unchanged", async () => {
    const r = await rig();
    const existing: SavedFlow = { yaml: `name: ${NAME}\nsteps: []\n`, requestId: "conv-someone-else", conversation: "other", exchange: "other" };
    r.pulse.flows.set(NAME, existing);
    const refused = await r.confirm(await r.propose(PROBE));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe(`A saved flow is already named ${NAME}. Nothing was created.`);
    expect(r.pulse.flows.get(NAME)).toEqual(existing);
    expect(r.pulse.calls.some(forbidden)).toBe(false);
  });

  test("an invalid definition fails with Pulse's findings", async () => {
    const r = await rig();
    r.pulse.answerNext(() => answer(1, { status: "invalid", findings: [{ rule: "schedule", message: "The input must not have a schedule key; a saved flow is never scheduled." }] }));
    const refused = await r.confirm(await r.propose(PROBE));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("The input must not have a schedule key; a saved flow is never scheduled. Nothing was created.");
  });

  test("a name that differs from the definition's name fails before Pulse is called", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, name: "F_IVY_OTHER" }));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("The name and the flow definition's name differ. Nothing was created.");
    expect(r.pulse.calls).toEqual([]);
  });

  test("a definition that is not a named YAML mapping fails before Pulse is called", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ ...PROBE, definition: "- just\n- a list\n" }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("The flow definition is not a YAML mapping with a name. Nothing was created.");
    expect(r.pulse.calls).toEqual([]);
  });

  test("with no flows configured, confirm refuses without calling Pulse", async () => {
    const r = await rig(null);
    const refused = await r.confirm(await r.propose(PROBE));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("No Pulse writer is connected on this stack yet");
    expect(r.pulse.calls).toEqual([]);
  });

  test("an unreadable flows directory leaves the save uncertain, and Check cannot read it back", async () => {
    const r = await rig();
    r.pulse.answerNext(() => answer(2, { status: "unreadable", reason: "EACCES" }));
    expect((await r.confirmThenCheck()).feedback).toEqual(["uncertain", "uncertain"]);
    expect(r.pulse.flows.size).toBe(0);
  });
});
