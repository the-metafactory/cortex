import { afterEach, expect, test } from "bun:test";
import { CREATE_MAP, CREATE_OTHER_REPOSITORY, CREATE_PARENT, CREATE_REPOSITORY, graphCreateOutput, openGraphCreateRig } from "../../../surface/mc/desk/fixtures/graph-create";
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
  expect(await rig.confirm(ambiguous.view.draft)).toMatchObject({ kind: "blocked" });
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
  const result = await rig.confirm(made.view.draft);
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error(result.reason);
  const stored = await rig.journal.read(result.operationId);
  expect(stored?.journal.state).toBe("succeeded");
  expect(stored?.journal.snapshot).toMatchObject({ input: { autonomy: "approve", kind: "grilling", repository: rig.ref("repository", CREATE_REPOSITORY), parent: rig.ref("node", CREATE_MAP) }, provenance: { conversationId: rig.makeInput.conversationId, entryId: "entry-example" } });
  expect((await rig.authority.inspectHostRecords()).confirmations).toHaveLength(1);
  expect(rig.soma.calls).toHaveLength(1);
  await rig.confirm(made.view.draft);
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
    if (denial === "stale") {
      const result = await rig.call("POST", `${DESK_DRAFTS_PATH}/${draftId}/confirm`, { revision });
      expect(result.status).toBe(409);
    } else expect(await rig.confirm(made.view.draft)).toMatchObject({ kind: "blocked" });
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
  const confirmation = await rig.confirm(draft);
  expect(confirmation.kind).toBe("accepted");
  if (confirmation.kind !== "accepted") throw new Error(confirmation.reason);
  expect((await rig.journal.read(confirmation.operationId))?.journal.snapshot).toMatchObject({ input: { autonomy: "propose", kind: "research", dependencies: [rig.ref("node", CREATE_PARENT), rig.ref("node", `${CREATE_REPOSITORY}#14`)] } });
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


test("Mission Control rejects graphDrafts alongside a supplied drafts surface", async () => {
  const rig = await open();
  let accessed = false;
  expect(() => rig.serve({ drafts: () => { accessed = true; return rig.editor; } })).toThrow("Configure only one of drafts, graphDrafts, balanceDrafts or flowDrafts");
  expect(accessed).toBe(false);
  expect(rig.soma.calls).toEqual([]);
});

test("Mission Control installs graph drafting and confirms through its HTTP entry", async () => {
  const rig = await open();
  const server = rig.serve();
  const targets = await server.call("GET", DESK_DRAFTS_PATH);
  expect(targets.status).toBe(200);
  expect(await targets.json()).toMatchObject({ targets: [{ connectionId: rig.connectionId, capabilityId: "work-graph.node.create" }] });
  rig.state.output = graphCreateOutput();
  const response = await server.call("POST", DESK_DRAFTS_PATH, rig.makeInput);
  expect(response.status).toBe(200);
  const made = await response.json() as DraftEditorView;
  expect(made.view.status).toBe("ready-for-confirmation");
  expect(rig.soma.calls).toEqual([]);
  expect((await rig.authority.inspectHostRecords()).confirmations).toHaveLength(0);
  expect(await server.confirm(made.view.draft)).toMatchObject({ kind: "accepted" });
  expect(rig.soma.calls).toHaveLength(1);
  expect((await rig.authority.inspectHostRecords()).confirmations).toHaveLength(1);
});

test("one draft batch reads each linked owner node once across parent and dependency labels", async () => {
  const rig = await open();
  rig.state.output = { fields: [...graphCreateOutput().fields, { pointer: "/dependencies", labels: ["Lifecycle map", "Shared title", "Unknown node"], citations: ["turn-example"] }] };
  const made = await rig.editor.service.make(rig.makeInput);
  if (made.kind !== "draft") throw new Error("Expected draft");
  expect(made.view.draft.fields["/parent"]?.value).toEqual(rig.ref("node", CREATE_MAP));
  expect(made.view.draft.fields["/dependencies"]?.unresolved).toBe("ambiguous_reference");
  expect(rig.reads.map(argv => argv[3]).sort()).toEqual([CREATE_MAP, `${CREATE_REPOSITORY}#12`, `${CREATE_OTHER_REPOSITORY}#13`].sort());
  await rig.editor.service.refresh(made.view.draft.draftId, made.view.draft.revision);
  expect(rig.reads).toHaveLength(6);
  expect(rig.soma.calls).toEqual([]);
});

test("confirmation shares current reference reads and never reuses drafting reads", async () => {
  const rig = await open();
  rig.state.output = { fields: [...graphCreateOutput().fields, { pointer: "/dependencies", labels: [CREATE_MAP, `${CREATE_REPOSITORY}#14`], citations: ["turn-example"] }] };
  const made = await rig.editor.service.make(rig.makeInput);
  if (made.kind !== "draft") throw new Error("Expected draft");
  rig.reads.splice(0);
  expect(await rig.confirm(made.view.draft)).toMatchObject({ kind: "accepted" });
  expect(rig.reads.map(argv => argv[3]).sort()).toEqual([CREATE_MAP, `${CREATE_REPOSITORY}#14`].sort());
  expect(rig.soma.calls).toHaveLength(1);
});
