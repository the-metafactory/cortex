import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { DraftingBindings } from "../drafting";
import { balanceBinding, balanceResponse, draftingRegistry, FRIDAY, graphBinding, MONDAY, openDraftingRig, type DraftingRig } from "../drafting-fixtures";

const rigs: DraftingRig[] = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map(async rig => { await rig.close(); await rm(rig.root, { recursive: true, force: true }); })); });
async function rig(): Promise<DraftingRig> {
  const opened = await openDraftingRig();
  rigs.push(opened);
  opened.state.response = () => balanceResponse();
  return opened;
}
const make = (r: DraftingRig, extra: Record<string, unknown> = {}) => r.service.make({ conversationId: "conversation-example", entryId: "turn-1", capabilityId: "balance.task.create", connectionId: "connection-example", ...extra });
async function draftOf(r: DraftingRig, extra: Record<string, unknown> = {}) {
  const made = await make(r, extra);
  if (made.kind !== "draft") throw new Error("expected a draft");
  return made.view;
}

describe("drafting binding 1.0.0", () => {
  const fresh = () => new DraftingBindings(draftingRegistry().registry);
  test("accepts exact bindings and returns copies", () => {
    const bindings = fresh();
    expect(bindings.register(balanceBinding()).ok).toBe(true);
    const held = bindings.lookup("balance", "balance.task.create", balanceBinding().inputSchemaRef);
    expect(held?.guidance.guidanceId).toBe("balance-task-guidance");
    if (held) held.guidance.instructions = "mutated";
    expect(bindings.lookup("balance", "balance.task.create", balanceBinding().inputSchemaRef)?.guidance.instructions).not.toBe("mutated");
  });
  test("fails closed on unknown fields, versions, pointers, duplicates and relationship mismatches", () => {
    const bindings = fresh();
    const cases: [unknown, string][] = [
      [{ ...balanceBinding(), extra: true }, "invalid_binding"],
      [{ ...balanceBinding(), bindingVersion: "2.0.0" }, "unsupported_binding_version"],
      [{ ...balanceBinding(), fieldHints: [{ pointer: "title", role: "title" }] }, "invalid_binding"],
      [{ ...balanceBinding(), fieldHints: [{ pointer: "/missing", role: "title" }] }, "invalid_hint"],
      [{ ...balanceBinding(), fieldHints: [{ pointer: "/title", role: "destination" }] }, "invalid_hint"],
      [{ ...balanceBinding(), fieldHints: [{ pointer: "/area", role: "summary" }] }, "invalid_hint"],
      [{ ...balanceBinding(), fieldHints: [{ pointer: "/area", role: "destination", resolveWith: "balance.task.create" }] }, "invalid_hint"],
      [{ ...balanceBinding(), fieldHints: [{ pointer: "/estimate", role: "detail", widget: "long" }] }, "invalid_hint"],
      [{ ...balanceBinding(), inputSchemaRef: { schemaId: "balance.task.create.input", version: "9.0.0" } }, "binding_mismatch"],
      [{ ...balanceBinding(), fieldHints: [{ pointer: "/title", role: "title", widget: "wide" }] }, "invalid_binding"],
    ];
    for (const [raw, code] of cases) {
      const result = bindings.register(raw);
      expect(result.ok ? "ok" : result.error.code).toBe(code);
    }
    expect(bindings.register(graphBinding()).ok).toBe(true);
    expect(bindings.register(graphBinding())).toMatchObject({ ok: false, error: { code: "duplicate_binding" } });
  });
});

describe("durable drafts", () => {
  test("Make persists a typed suggested draft and reopens the same revision after a host restart", async () => {
    const r = await rig();
    const view = await draftOf(r);
    const { fields } = view.draft;
    expect(fields["/title"]).toMatchObject({ origin: "generated", presence: "present" });
    expect(fields["/area"]).toMatchObject({ origin: "suggested", value: { canonicalId: "area-example" } });
    expect(fields["/priority"]).toMatchObject({ origin: "default", value: "normal" });
    expect(view.draft.manifest?.items.map(item => item.id)).toEqual(["turn-1", "outcome-1"]);
    expect(view.status).toBe("ready-for-confirmation");
    await r.reopen();
    const again = await make(r);
    expect(again).toMatchObject({ kind: "draft", reopened: true });
    if (again.kind === "draft") expect(again.view.draft).toEqual(view.draft);
    expect(r.state.requests).toHaveLength(1);
  });

  test("New draft is distinct and multiple matches require selection", async () => {
    const r = await rig();
    const first = await draftOf(r);
    const second = await draftOf(r, { newDraft: true });
    expect(second.draft.draftId).not.toBe(first.draft.draftId);
    const chosen = await make(r);
    expect(chosen.kind).toBe("select");
    if (chosen.kind !== "select") return;
    expect(chosen.candidates.map(candidate => candidate.draftId).sort()).toEqual([first.draft.draftId, second.draft.draftId].sort());
    const picked = await make(r, { selectDraftId: first.draft.draftId });
    expect(picked).toMatchObject({ kind: "draft", reopened: true });
  });

  test("edits and deliberate clearing survive restart and refresh; due alternatives stay unresolved", async () => {
    const r = await rig();
    const created = await draftOf(r);
    const id = created.draft.draftId;
    await r.service.edit(id, 2, "/title", { kind: "set", value: "Audit restart receipts" });
    const cleared = await r.service.edit(id, 3, "/note", { kind: "omit" });
    expect(cleared.draft.fields["/note"]).toMatchObject({ origin: "principal", presence: "absent" });
    r.state.items.push({ id: "turn-2", kind: "turn", revision: "1", digest: "d3", restriction: "cloud", text: "Include a crash immediately after acceptance; perhaps Friday or Monday.", at: "2026-11-08T10:05:00.000Z" });
    r.state.head = "2";
    const stale = await r.reopen().then(service => service.read(id));
    expect(stale?.outdated).toContain("conversation-changed");
    expect(stale?.draft.revision).toBe(4);
    r.state.response = () => balanceResponse({ title: "Replaced title", due: { pointer: "/due", citations: ["turn-2"], alternatives: [{ value: FRIDAY, citations: ["turn-2"] }, { value: MONDAY, citations: ["turn-2"] }] } });
    const refreshed = await r.service.refresh(id, 4);
    if (refreshed.kind !== "applied") throw new Error("expected refresh");
    const { fields } = refreshed.view.draft;
    expect(fields["/title"]).toMatchObject({ origin: "principal", value: "Audit restart receipts" });
    expect(fields["/note"]).toMatchObject({ origin: "principal", presence: "absent" });
    expect(fields["/due"]).toMatchObject({ unresolved: "conflict", presence: "absent" });
    expect(fields["/due"]?.alternatives.map(item => item.value)).toEqual([FRIDAY, MONDAY]);
    expect(refreshed.view.status).toBe("needs-input");
    expect(refreshed.view.blocking).toContainEqual({ pointer: "/due", code: "unresolved" });
    expect(refreshed.view.outdated).toEqual([]);
    expect((await r.service.details(id, "/due", "cloud"))?.alternatives).toHaveLength(2);
    expect(refreshed.view.draft.manifest?.items.map(item => item.id)).toContain("turn-2");
    const chosen = await r.service.chooseAlternative(id, refreshed.view.draft.revision, "/due", 1);
    expect(chosen.draft.fields["/due"]).toMatchObject({ origin: "principal", value: MONDAY });
    expect(chosen.status).toBe("ready-for-confirmation");
  });

  test("regenerate-field is the only way to release a user-owned field", async () => {
    const r = await rig();
    const created = await draftOf(r);
    const id = created.draft.draftId;
    await r.service.edit(id, 2, "/title", { kind: "set", value: "Mine" });
    r.state.response = () => balanceResponse({ title: "Fresh generated title" });
    const plain = await r.service.refresh(id, 3);
    if (plain.kind !== "applied") throw new Error("expected refresh");
    expect(plain.view.draft.fields["/title"]?.value).toBe("Mine");
    const released = await r.service.regenerateField(id, plain.view.draft.revision, "/title");
    if (released.kind !== "applied") throw new Error("expected regenerate");
    expect(released.view.draft.fields["/title"]).toMatchObject({ origin: "generated", value: "Fresh generated title" });
  });

  test("a compound edit owns the whole subtree", async () => {
    const r = await rig();
    r.state.response = () => ({ fields: [{ pointer: "/tags", value: ["a", "b"], citations: ["turn-1"] }, ...balanceResponse().fields] });
    const created = await draftOf(r);
    expect(created.draft.fields["/tags"]?.origin).toBe("suggested");
    const edited = await r.service.edit(created.draft.draftId, created.draft.revision, "/tags", { kind: "set", value: ["a"] });
    r.state.response = () => ({ fields: [{ pointer: "/tags", value: ["a", "b", "c"], citations: ["turn-1"] }] });
    const refreshed = await r.service.refresh(created.draft.draftId, edited.draft.revision);
    if (refreshed.kind !== "kept" && refreshed.kind !== "applied") throw new Error("expected result");
    expect(refreshed.view.draft.fields["/tags"]?.value).toEqual(["a"]);
  });

  test("a stale generation is discarded after an intervening edit", async () => {
    const r = await rig();
    const created = await draftOf(r);
    const id = created.draft.draftId;
    r.state.onGenerate = async () => { r.state.onGenerate = undefined; await r.service.edit(id, 2, "/title", { kind: "set", value: "Edited mid-flight" }); };
    r.state.response = () => balanceResponse({ title: "Obsolete result" });
    expect(await r.service.refresh(id, 2)).toEqual({ kind: "stale" });
    const latest = await r.service.read(id);
    expect(latest?.draft.fields["/title"]?.value).toBe("Edited mid-flight");
    expect(latest?.draft.revision).toBe(3);
  });
});

describe("model candidates", () => {
  test("unsupported citations, invalid values and unauthorised fields never become sourced values", async () => {
    const r = await rig();
    r.state.response = () => ({ fields: [
      { pointer: "/title", value: "Forged citation", citations: ["not-in-manifest"] },
      { pointer: "/estimate", value: "not a number", citations: ["turn-1"] },
      { pointer: "/authority", value: "grant", citations: ["turn-1"] },
      { pointer: "/area", labels: ["Unknown area"], citations: ["turn-1"] },
    ] });
    const view = await draftOf(r);
    expect(view.draft.fields["/title"]).toMatchObject({ presence: "absent", unresolved: "unsupported_citation" });
    expect(view.draft.fields["/estimate"]).toMatchObject({ unresolved: "invalid_candidate" });
    expect(view.draft.fields["/authority"]).toBeUndefined();
    expect(view.draft.fields["/area"]).toMatchObject({ unresolved: "missing_reference" });
    expect(view.status).toBe("needs-input");
    expect(view.blocking.map(item => item.pointer)).toEqual(expect.arrayContaining(["/title", "/area"]));
  });

  test("model strings never mint references and ambiguous destinations show alternatives", async () => {
    const r = await rig();
    r.state.destinations.set("Reliability area", { kind: "multiple", refs: [{ adapterId: "balance", connectionId: "connection-example", objectType: "area", canonicalId: "a1" }, { adapterId: "balance", connectionId: "connection-example", objectType: "area", canonicalId: "a2" }] });
    r.state.response = () => ({ fields: [{ pointer: "/area", value: { adapterId: "balance", connectionId: "c", objectType: "area", canonicalId: "forged" }, citations: ["turn-1"] }, { pointer: "/project", labels: ["Reliability area"], citations: ["turn-1"] }] });
    const view = await draftOf(r);
    expect(view.draft.fields["/area"]).toMatchObject({ unresolved: "unresolved_reference", presence: "absent" });
    expect(view.draft.fields["/project"]?.unresolved).toBe("ambiguous_reference");
    expect(view.draft.fields["/project"]?.alternatives).toHaveLength(2);
  });

  test("missing required fields block confirmation while optional absence is allowed", async () => {
    const r = await rig();
    r.state.response = () => ({ fields: [{ pointer: "/title", value: "Only a title", citations: ["turn-1"] }] });
    const view = await draftOf(r);
    expect(view.blocking).toEqual([{ pointer: "/area", code: "required_missing" }]);
    const edited = await r.service.edit(view.draft.draftId, view.draft.revision, "/area", { kind: "set", value: { adapterId: "balance", connectionId: "connection-example", objectType: "area", canonicalId: "area-example" } });
    expect(edited.status).toBe("ready-for-confirmation");
  });
});

describe("failure and policy behaviour", () => {
  test("invalid output, model failure and no lane keep the manual draft with a safe limitation", async () => {
    const r = await rig();
    const created = await draftOf(r);
    const id = created.draft.draftId;
    await r.service.edit(id, created.draft.revision, "/title", { kind: "set", value: "Manual" });
    const base = (await r.service.read(id))?.draft.revision ?? 0;
    const attempts: [() => void, string][] = [
      [() => { r.state.response = () => ({ unexpected: true }); }, "invalid_output"],
      [() => { r.state.response = () => balanceResponse(); r.state.modelFails = true; }, "model_failed"],
      [() => { r.state.modelFails = false; r.state.lanes = []; }, "model_unavailable"],
    ];
    for (const [arrange, code] of attempts) {
      arrange();
      const result = await r.service.refresh(id, base);
      expect(result.kind).toBe("kept");
      const view = await r.service.read(id);
      expect(view?.draft.limitations.map(item => item.code)).toEqual([code]);
      expect(view?.draft.fields["/title"]?.value).toBe("Manual");
      expect(view?.draft.revision).toBe(base);
    }
  });

  test("local-only sources never reach a cloud lane and the draft is withheld from cloud audiences", async () => {
    const r = await rig();
    r.state.items.push({ id: "local-1", kind: "linked", revision: "1", digest: "d9", restriction: "local", text: "Local-only evidence.", at: "2026-11-08T10:01:00.000Z" });
    r.state.localOnly.add("local-1");
    r.state.lanes = ["cloud"];
    const refused = await draftOf(r);
    expect(r.state.requests).toHaveLength(0);
    expect(refused.draft.limitations.map(item => item.code)).toEqual(["model_unavailable"]);
    r.state.lanes = ["local"];
    const created = await r.service.refresh(refused.draft.draftId, refused.draft.revision);
    if (created.kind !== "applied") throw new Error("expected local generation");
    expect(r.state.requests.map(request => request.lane)).toEqual(["local"]);
    const cloud = await r.service.read(refused.draft.draftId, "cloud");
    expect(cloud?.withheld).toEqual(expect.arrayContaining(["/title", "/area"]));
    expect(cloud?.draft.fields["/title"]).toBeUndefined();
    expect(cloud?.draft.manifest?.items).toEqual([]);
    expect((await r.service.read(refused.draft.draftId, "local"))?.draft.fields["/title"]).toBeDefined();
  });

  test("an alternative citing a local-only source is withheld whole from a cloud audience", async () => {
    const r = await rig();
    r.state.items.push({ id: "local-1", kind: "linked", revision: "1", digest: "d9", restriction: "local", text: "Local-only evidence.", at: "2026-11-08T10:01:00.000Z" });
    r.state.localOnly.add("local-1");
    r.state.lanes = ["local"];
    r.state.response = () => balanceResponse({ due: { pointer: "/due", citations: ["turn-1", "local-1"], alternatives: [{ value: FRIDAY, citations: ["turn-1", "local-1"] }, { value: MONDAY, citations: ["turn-1"] }] } });
    const created = await draftOf(r);
    const cloud = await r.service.details(created.draft.draftId, "/due", "cloud");
    expect(cloud?.alternatives.map(item => item.value)).toEqual([MONDAY]);
    const local = await r.service.details(created.draft.draftId, "/due", "local");
    expect(local?.alternatives.map(item => item.value)).toEqual([FRIDAY, MONDAY]);
  });

  test("revoked sources are omitted without disclosure and mark an existing draft outdated", async () => {
    const r = await rig();
    const created = await draftOf(r);
    r.state.denied.add("outcome-1");
    const reread = await r.service.read(created.draft.draftId);
    expect(reread?.outdated).toContain("source-unavailable");
    expect(await r.service.details(created.draft.draftId, "/note")).toMatchObject({ hiddenSources: 1, sources: [{ id: "turn-1" }] });
    const refreshed = await r.service.refresh(created.draft.draftId, created.draft.revision);
    if (refreshed.kind !== "applied") throw new Error("expected refresh");
    expect(refreshed.view.draft.manifest?.items.map(item => item.id)).toEqual(["turn-1"]);
    expect(refreshed.view.draft.manifest?.omissions).toEqual([{ reason: "not-permitted" }]);
    expect(JSON.stringify(refreshed.view.draft.manifest)).not.toContain("outcome-1");
  });

  test("policy changing after the model ran discards the output", async () => {
    const r = await rig();
    const created = await draftOf(r);
    r.state.onGenerate = () => { r.state.policyRevision = "policy-2"; return Promise.resolve(); };
    r.state.response = () => balanceResponse({ title: "Must not land" });
    const result = await r.service.refresh(created.draft.draftId, created.draft.revision);
    expect(result.kind).toBe("kept");
    const view = await r.service.read(created.draft.draftId);
    expect(view?.draft.fields["/title"]?.value).toBe("Review receipt persistence across restart");
    expect(view?.draft.limitations[0]?.code).toBe("release_denied");
    expect(view?.outdated).toContain("policy-changed");
  });

  test("truncation is visible and never presented as complete coverage", async () => {
    const r = await openDraftingRig(undefined, 120);
    rigs.push(r);
    r.state.response = () => balanceResponse();
    r.state.items.push({ id: "turn-0", kind: "turn", revision: "1", digest: "d0", restriction: "cloud", text: "x".repeat(400), at: "2026-11-08T09:00:00.000Z" });
    const view = await draftOf(r);
    expect(view.draft.manifest?.truncated).toBe(true);
    expect(view.draft.manifest?.omissions).toContainEqual({ reason: "context-limit", id: "turn-0" });
    expect(view.draft.limitations.map(item => item.code)).toContain("context_truncated");
    expect(r.state.requests[0]?.sources.map(source => source.id)).toEqual(["turn-1"]);
  });
});

describe("destination, schema and handoff", () => {
  test("changing destination preserves edits and exposes unsupported fields instead of dropping them", async () => {
    const r = await rig();
    const created = await draftOf(r);
    const moved = await r.service.changeDestination(created.draft.draftId, created.draft.revision, { connectionId: "connection-other", capabilityId: "work-graph.node.create" });
    expect(moved.draft.fields["/title"]?.value).toBe("Review receipt persistence across restart");
    expect(moved.unsupported).toEqual(expect.arrayContaining(["/area", "/note"]));
    expect(moved.draft.fields["/area"]).toBeDefined();
    expect(moved.outdated).toEqual(expect.arrayContaining(["schema-changed", "destination-changed"]));
    expect(moved.status).toBe("needs-input");
    await expect(r.service.migrate(created.draft.draftId, moved.draft.revision, { acknowledged: true })).rejects.toThrow("no schema migration");
  });

  test("handoff validates the exact revision, excludes unsupported fields and makes no owner calls", async () => {
    const r = await rig();
    const created = await draftOf(r);
    const id = created.draft.draftId;
    const handoff = await r.service.handoff(id, created.draft.revision, { proposalId: "proposal-example", operationId: "operation-example" });
    if (!handoff.ok) throw new Error("expected handoff");
    expect(handoff.handoff).toMatchObject({ draftRevision: created.draft.revision, policy: "cloud", existing: { proposalId: "proposal-example" } });
    expect(handoff.handoff.destinations.map(ref => ref.canonicalId)).toEqual(["area-example", "project-example"]);
    expect(handoff.handoff.input).toMatchObject({ title: "Review receipt persistence across restart", priority: "normal" });
    await r.service.edit(id, created.draft.revision, "/title", { kind: "set", value: "Changed" });
    await expect(r.service.handoff(id, created.draft.revision)).rejects.toThrow("revision changed");
    r.state.denied.add("turn-1");
    expect((await r.service.handoff(id, created.draft.revision + 1))).toMatchObject({ ok: false, outdated: ["source-unavailable"] });
    expect(r.owner).toEqual({ mutations: 0, queries: 0 });
  });
});
