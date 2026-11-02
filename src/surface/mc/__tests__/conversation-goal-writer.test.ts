import { describe, expect, test } from "bun:test";
import { studioRequestId } from "../desk/conversation-sources";
import { openGoals } from "../desk/goal-conversation-writer";
import { deskWriterRig } from "./conversation-writer-rig";

const WRITER = ["desk-goal.ts"];
const SOMA = "/opt/soma";
const open = deskWriterRig({ prefix: "conversation-goal-", label: "ai.meta-factory.cortex.goal-writer-test", kind: "goal", type: "soma-goal", canonicalId: "G13", somaBin: SOMA });
const rig = (writer: string[] | null = WRITER) => open(writer, "local");

const WORDING = "Ivy probe 0a1b — safe to drop";
const row = (id: string, status: string, wording: string) => `${id}\t${status}\tsupports: [M0]\tsensor: -\t${wording}`;
const listing = (...rows: string[]) => () => Promise.resolve({ code: 0, stdout: `${rows.join("\n")}\n`, stderr: "" });
const refusal = (stderr: string) => () => Promise.resolve({ code: 1, stdout: "", stderr });

describe("Soma goal writer for conversation proposals", () => {
  test("the type is ready only with a goal writer and a soma binary on an enabled Desk", async () => {
    const ready = await rig();
    expect(await ready.capability()).toBe("ready");
    ready.options.somaBin = "";
    expect(await ready.capability()).toBe("blocked:3038");
    ready.options.somaBin = SOMA;
    ready.options.enabled = false;
    expect(await ready.capability()).toBe("blocked:3038");
    expect(await (await rig(null)).capability()).toBe("blocked:3038");
  });

  test("a confirmed proposal sends the trimmed wording with the derived request id, and the identical confirm runs nothing", async () => {
    const r = await rig();
    const { view, reply } = await r.submit({ wording: `  ${WORDING}  ` });
    expect(reply).toMatchObject({ status: 200, body: { proposal: { feedback: "created", operation: { canonicalId: "G13" } } } });
    const operationId = reply.body.proposal.operation?.operationId ?? "";
    expect(r.calls).toEqual([{ argv: WRITER, stdin: { kind: "goal", requestId: studioRequestId(operationId), fields: { wording: WORDING } } }]);
    expect(await r.confirm(view)).toMatchObject({ status: 200, body: { proposal: { operation: { canonicalId: "G13" } } } });
    expect(r.calls).toHaveLength(1);
    expect(r.lists).toEqual([]);
  });

  test("a wording an open goal already has answers created with that goal's id", async () => {
    const r = await rig();
    r.answerWith(() => Promise.resolve({ code: 0, stdout: JSON.stringify({ id: "G9", message: `Goal G9 already says "${WORDING}"; nothing new was added.` }), stderr: "" }));
    const { reply } = await r.submit({ wording: WORDING });
    expect(reply.body.proposal).toMatchObject({ feedback: "created", operation: { canonicalId: "G9" } });
    expect(r.calls).toHaveLength(1);
  });

  test("a writer that exits non-zero fails with its sentence once goal list shows no such goal", async () => {
    const r = await rig();
    r.answerWith(refusal("soma could not add the goal: exit 2\n"));
    r.listWith(listing(row("G4", "dropped", WORDING), row("G5", "active", "Another goal")));
    const refused = await r.confirm(await r.propose({ wording: WORDING }));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("soma could not add the goal: exit 2. Nothing was created.");
    expect(r.lists).toEqual([[SOMA, "goal", "list", "--wording"]]);
  });

  test("a refusal after the goal was added answers created with the id goal list shows, also for padded wording", async () => {
    const r = await rig();
    r.answerWith(refusal("soma added a goal but printed no goal id.\n"));
    r.listWith(listing(row("G14", "draft", WORDING)));
    const { reply } = await r.submit({ wording: `  ${WORDING}\t ` });
    expect(reply.body.proposal).toMatchObject({ feedback: "created", operation: { canonicalId: "G14" } });
  });

  test("a refusal stays uncertain when goal list cannot be read", async () => {
    const r = await rig();
    r.answerWith(refusal("soma added a goal but printed no goal id.\n"));
    r.listWith(refusal("soma: goal store locked\n"));
    const { reply } = await r.submit({ wording: WORDING });
    expect(reply.body.proposal.feedback).toBe("uncertain");
  });

  test("after a timeout, Check marks the operation created with the goal's id from goal list without rerunning the writer", async () => {
    const r = await rig();
    r.listWith(listing(row("G15", "draft", WORDING)));
    expect(await r.timeoutThenCheck({ wording: ` ${WORDING} ` })).toStrictEqual({ runs: 1, feedback: ["uncertain", "created"] });
    expect(r.lists).toEqual([[SOMA, "goal", "list", "--wording"]]);
  });

  test("after a timeout, Check fails the operation when goal list proves no such goal", async () => {
    const r = await rig();
    r.listWith(listing(row("G5", "active", "Another goal")));
    expect(await r.timeoutThenCheck({ wording: WORDING })).toStrictEqual({ runs: 1, feedback: ["uncertain", "failed"] });
  });

  test("a wording over several lines is refused before the writer runs", async () => {
    const r = await rig();
    const refused = await r.confirm(await r.propose({ wording: "First line\nsecond line" }));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("The wording must be a single line. Nothing was created.");
    expect(r.calls).toEqual([]);
  });

  test("goal list rows count only for open goals with a wording column", () => {
    const stdout = [row("G1", "draft", " A "), row("G2", "paused", "B\tC"), row("G3", "dropped", "D"), "G4\tactive\tsupports: []", "not a goal"].join("\n");
    expect(openGoals(stdout)).toEqual([{ id: "G1", wording: "A" }, { id: "G2", wording: "B\tC" }]);
  });
});
