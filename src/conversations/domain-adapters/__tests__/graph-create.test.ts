import { afterEach, expect, test } from "bun:test";
import { CREATE_MAP, CREATE_OTHER_REPOSITORY, CREATE_PARENT, CREATE_REPOSITORY, graphCreateOutput, openGraphCreateRig } from "./fixtures/graph-create-fixtures";
import { DESK_DRAFTS_PATH, type DraftEditorView } from "../../../surface/mc/desk/draft-editor-contract";

type Rig = Awaited<ReturnType<typeof openGraphCreateRig>>;
const rigs: Rig[] = [];
const open = async () => { const rig = await openGraphCreateRig(); rigs.push(rig); return rig; };
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });

async function make(rig: Rig, parent?: string): Promise<DraftEditorView> {
  rig.state.output = graphCreateOutput(parent);
  const response = await rig.call("POST", DESK_DRAFTS_PATH, rig.makeInput);
  expect(response.status).toBe(200);
  return await response.json() as DraftEditorView;
}

test("the loaded graph adapter declares the approved optional create fields and destination relationships", async () => {
  const rig = await open();
  expect(rig.registry.capability("work-graph.node.create")).toMatchObject({ support: "declared", capability: { kind: "action" } });
  expect(rig.read.bindings.handlers["work-graph.node.create"]).toBeUndefined();
  const view = rig.registry.draftingView("work-graph.node.create")!;
  expect(view.root.required).toEqual(["repository", "parent", "title", "checkpoint"]);
  expect(view.relationships.map(item => item.fieldPath)).toEqual(["/repository", "/parent", "/dependencies"]);
  const input = { repository: rig.ref("repository", CREATE_REPOSITORY), parent: rig.ref("node", CREATE_PARENT), title: "Create node", checkpoint: "create-node" };
  const validate = (patch: Record<string, unknown>) => rig.registry.validateInput({ capabilityId: "work-graph.node.create", inputSchemaRef: view.inputSchemaRef, input: { ...input, ...patch } }, null).ok;
  expect(validate({})).toBe(true);
  expect(validate({ autonomy: "propose", kind: "build" })).toBe(true);
  for (const patch of [{ repository: CREATE_REPOSITORY }, { autonomy: "claim" }, { kind: "epic" }, { parent: rig.ref("map", CREATE_MAP) }]) expect(validate(patch)).toBe(false);
});

test("repositories, linked maps and nodes and exact references resolve through scoped reads without browsing", async () => {
  const rig = await open();
  expect(await rig.resolve(CREATE_REPOSITORY, "repository")).toEqual({ kind: "unique", ref: rig.ref("repository", CREATE_REPOSITORY) });
  expect(await rig.resolve("Lifecycle map")).toEqual({ kind: "unique", ref: rig.ref("node", CREATE_MAP) });
  expect(await rig.resolve(CREATE_PARENT)).toEqual({ kind: "unique", ref: rig.ref("node", CREATE_PARENT) });
  expect(await rig.resolve(`${CREATE_REPOSITORY}#14`)).toEqual({ kind: "unique", ref: rig.ref("node", `${CREATE_REPOSITORY}#14`) });
  expect(await rig.resolve("12")).toEqual({ kind: "unique", ref: rig.ref("node", `${CREATE_REPOSITORY}#12`) });
  expect(await rig.resolve("Shared title")).toEqual({ kind: "multiple", refs: [rig.ref("node", CREATE_PARENT), rig.ref("node", `${CREATE_OTHER_REPOSITORY}#13`)] });
  expect(await rig.resolve("desk", "repository")).toEqual({ kind: "multiple", refs: [rig.ref("repository", CREATE_REPOSITORY), rig.ref("repository", CREATE_OTHER_REPOSITORY)] });
  expect(await rig.resolve("unknown parent")).toEqual({ kind: "none" });
  expect(await rig.resolve(`${CREATE_REPOSITORY}#999`)).toEqual({ kind: "none" });
  expect(rig.reads.every(argv => argv[1] === "graph" && argv[2] === "node" && argv.includes("--read-repo"))).toBe(true);
  expect(rig.soma.calls).toEqual([]);
});

test("ambiguous and unknown generated references stay unresolved and alternatives remain visible", async () => {
  const rig = await open();
  const ambiguous = await make(rig, "Shared title");
  const field = ambiguous.view.draft.fields["/parent"];
  expect(field).toMatchObject({ presence: "absent", unresolved: "ambiguous_reference" });
  expect(field?.alternatives.map(item => item.value)).toEqual([rig.ref("node", CREATE_PARENT), rig.ref("node", `${CREATE_OTHER_REPOSITORY}#13`)]);
  const confirm = await rig.call("POST", `${DESK_DRAFTS_PATH}/${ambiguous.view.draft.draftId}/confirm`, { revision: ambiguous.view.draft.revision });
  expect(await confirm.json()).toMatchObject({ confirmation: { kind: "blocked" } });
  const unknownRig = await open();
  const unknown = await make(unknownRig, "Unknown map");
  expect(unknown.view.draft.fields["/parent"]).toMatchObject({ presence: "absent", unresolved: "missing_reference", alternatives: [] });
  expect(rig.soma.calls).toEqual([]);
  expect(unknownRig.soma.calls).toEqual([]);
});

test("Desk confirms an immutable defaulted graph snapshot through authority and files once", async () => {
  const rig = await open();
  const made = await make(rig);
  expect(made.view.status).toBe("ready-for-confirmation");
  const path = `${DESK_DRAFTS_PATH}/${made.view.draft.draftId}`;
  await rig.call("GET", path);
  const handoff = await rig.editor.service.handoff(made.view.draft.draftId, made.view.draft.revision);
  expect(handoff.ok).toBe(true);
  expect(rig.soma.calls).toEqual([]);
  expect((await rig.authority.inspectHostRecords()).confirmations).toHaveLength(0);
  const confirmed = await rig.call("POST", `${path}/confirm`, { revision: made.view.draft.revision });
  const result = await confirmed.json() as { confirmation: { kind: string; operationId: string } };
  expect(result.confirmation.kind).toBe("accepted");
  const stored = await rig.journal.read(result.confirmation.operationId);
  expect(stored?.journal.state).toBe("succeeded");
  expect(stored?.journal.snapshot).toMatchObject({ input: { autonomy: "approve", kind: "grilling", repository: rig.ref("repository", CREATE_REPOSITORY), parent: rig.ref("node", CREATE_MAP) }, provenance: { conversationId: rig.makeInput.conversationId, entryId: "entry-example" } });
  expect((await rig.authority.inspectHostRecords()).confirmations).toHaveLength(1);
  expect(rig.soma.calls).toHaveLength(1);
  await rig.call("POST", `${path}/confirm`, { revision: made.view.draft.revision });
  expect(rig.soma.calls).toHaveLength(1);
});

test("current scope, authentication, source policy and stale edits block graph creation", async () => {
  for (const denial of ["untick", "session", "source", "source-authority", "write-policy", "stale"] as const) {
    const rig = await open();
    const made = await make(rig);
    const { draftId, revision } = made.view.draft;
    if (denial === "untick") await rig.untick(CREATE_REPOSITORY);
    if (denial === "session") rig.state.sessionEnabled = false;
    if (denial === "source") rig.state.sourceAvailable = false;
    if (denial === "source-authority") rig.state.sourceRestrictionsAvailable = false;
    if (denial === "write-policy") rig.policy.writesAllowed = false;
    if (denial === "stale") await rig.editor.service.edit(draftId, revision, "/title", { kind: "set", value: "Edited title" });
    const result = await rig.call("POST", `${DESK_DRAFTS_PATH}/${draftId}/confirm`, { revision });
    if (denial === "stale") expect(result.status).toBe(409);
    else expect(await result.json()).toMatchObject({ confirmation: { kind: "blocked" } });
    expect(rig.soma.calls).toEqual([]);
  }
});

test("dependencies resolve to node references and explicit autonomy and kind survive confirmation", async () => {
  const rig = await open();
  rig.state.output = { fields: [...graphCreateOutput().fields,
    { pointer: "/dependencies", labels: [CREATE_PARENT, `${CREATE_REPOSITORY}#14`], citations: ["turn-example"] },
    { pointer: "/autonomy", value: "propose", citations: ["turn-example"] },
    { pointer: "/kind", value: "research", citations: ["turn-example"] },
  ] };
  const made = await rig.editor.service.make(rig.makeInput);
  if (made.kind !== "draft") throw new Error("Expected draft");
  const draft = made.view.draft;
  const result = await rig.call("POST", `${DESK_DRAFTS_PATH}/${draft.draftId}/confirm`, { revision: draft.revision });
  const confirmation = await result.json() as { confirmation: { kind: string; operationId: string } };
  expect(confirmation.confirmation.kind).toBe("accepted");
  expect((await rig.journal.read(confirmation.confirmation.operationId))?.journal.snapshot).toMatchObject({ input: { autonomy: "propose", kind: "research", dependencies: [rig.ref("node", CREATE_PARENT), rig.ref("node", `${CREATE_REPOSITORY}#14`)] } });
  expect(rig.soma.calls).toHaveLength(1);
});

test("the Desk authority callback rejects forged handoffs and a foreign principal", async () => {
  const rig = await open();
  const made = await make(rig);
  const result = await rig.editor.service.handoff(made.view.draft.draftId, made.view.draft.revision);
  if (!result.ok || !rig.editor.confirm) throw new Error("Expected graph handoff");
  for (const handoff of [{ ...result.handoff, input: { title: "Forged node" } }, { ...result.handoff, connectionId: "other" }]) {
    expect(await rig.editor.confirm({ handoff, principal: rig.principal.principal, transport: "web", audience: "cloud" })).toMatchObject({ kind: "blocked" });
  }
  expect(await rig.editor.confirm({ handoff: result.handoff, principal: "foreign", transport: "web", audience: "cloud" })).toMatchObject({ kind: "blocked" });
  expect((await rig.authority.inspectHostRecords()).confirmations).toHaveLength(0);
  expect(rig.soma.calls).toEqual([]);
});

test("connection and conversation mismatches expose no graph references", async () => {
  const rig = await open();
  for (const patch of [{ connectionId: "other" }, { conversationId: "other" }, { objectType: "map" }, { capabilityId: "other" }]) {
    expect(await rig.destinations.resolve({ capabilityId: "work-graph.destinations", connectionId: rig.connectionId, conversationId: rig.makeInput.conversationId, objectType: "node", label: CREATE_PARENT, ...patch })).toEqual({ kind: "unavailable" });
  }
  expect(rig.reads).toEqual([]);
});

test("a local-only repository releases neither destination metadata nor linked node names into a cloud draft", async () => {
  const rig = await open();
  await rig.localRepository(CREATE_REPOSITORY);
  expect(await rig.resolve(CREATE_REPOSITORY, "repository")).toEqual({ kind: "none" });
  expect(await rig.resolve("Lifecycle map")).toEqual({ kind: "none" });
  expect(await rig.resolve(CREATE_PARENT)).toEqual({ kind: "none" });
  expect(rig.reads.some(argv => argv[3]?.startsWith(CREATE_REPOSITORY))).toBe(false);
  expect(rig.soma.calls).toEqual([]);
});
