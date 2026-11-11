import { afterEach, describe, expect, test } from "bun:test";
import { FLOW_EDITOR_FILES } from "../../../../conversations/domain-adapters/flow/editor-ui";
import { flowEditorProjection } from "../flow-editor";
import { FLOW_DRAFT_DEFINITION, openFlowEditorRig, type FlowEditorRig } from "./fixtures/flow-editor-fixtures";

let rig: FlowEditorRig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

describe("flowEditorProjection", () => {
  test("lists steps and reports no findings for a valid definition", () => {
    const projection = flowEditorProjection("F_EDITOR_DRAFT", FLOW_DRAFT_DEFINITION);
    expect(projection.findings).toEqual([]);
    expect(projection.steps).toHaveLength(1);
  });

  test("reports invalid YAML, a mismatched name and an empty action list as findings", () => {
    expect(flowEditorProjection("F_X", "name: [").findings[0]?.message).toContain("not valid YAML");
    expect(flowEditorProjection("F_X", "name: F_Y\nactions:\n  - A_ONE\n").findings.map(item => item.message)).toContain("The name and the definition's name differ.");
    expect(flowEditorProjection("F_X", "name: F_X\nactions: []\n").findings.map(item => item.message)).toContain("The definition needs a non-empty actions list.");
    expect(flowEditorProjection("bad", "name: bad\nactions:\n  - A_ONE\n").findings[0]?.message).toContain("must start with F_");
  });
});

describe("Flow editor package assets", () => {
  test("offers no run, schedule, delete, save or approve control", () => {
    const markup = FLOW_EDITOR_FILES["ui/flow-editor.html"]?.body ?? "";
    const labels = [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
    expect(labels).toEqual(["Apply edit", "Review in Desk"]);
  });
});

describe("Flow editor frame", () => {
  test("projects the draft with steps and findings and an editable draft", async () => {
    rig = await openFlowEditorRig();
    const reply = await rig.send(1, "ui:ready", { mount: rig.binding.mount });
    expect(reply.messages.map(message => message.type)).toEqual(["host:projection", "host:draft"]);
    const projection = reply.messages[0];
    expect(projection?.type === "host:projection" && projection.body.object).toMatchObject({ name: "F_EDITOR_DRAFT", findings: [] });
    const view = await rig.readDraft();
    expect(view.outdated).toEqual([]);
    expect(view.status).toBe("ready-for-confirmation");
  });

  test("an edit reaches the host draft as a principal edit with the new findings", async () => {
    rig = await openFlowEditorRig();
    await rig.send(1, "ui:ready", { mount: rig.binding.mount });
    const before = await rig.readDraft();
    const reply = await rig.send(2, "draft:change", { draftId: rig.draftId, baseRevision: before.draft.revision, changes: [{ pointer: "/definition", change: { kind: "set", value: "name: F_EDITOR_DRAFT\nactions: []\n" } }] });
    const after = await rig.readDraft();
    expect(after.draft.fields["/definition"]).toMatchObject({ origin: "principal", value: "name: F_EDITOR_DRAFT\nactions: []\n" });
    expect(after.draft.revision).toBeGreaterThan(before.draft.revision);
    const projection = reply.messages.find(message => message.type === "host:projection");
    expect(projection?.type === "host:projection" && projection.body.object).toMatchObject({ findings: [{ message: "The definition needs a non-empty actions list." }] });
    expect(rig.flow.saveCalls()).toBe(0);
  });

  test("a stale edit is refused and leaves the draft unchanged", async () => {
    rig = await openFlowEditorRig();
    await rig.send(1, "ui:ready", { mount: rig.binding.mount });
    const before = await rig.readDraft();
    const reply = await rig.send(2, "draft:change", { draftId: rig.draftId, baseRevision: before.draft.revision + 5, changes: [{ pointer: "/name", change: { kind: "set", value: "F_OTHER" } }] });
    expect(reply.messages.at(-1)).toMatchObject({ type: "host:reply", body: { outcome: "stale" } });
    expect((await rig.readDraft()).draft.revision).toBe(before.draft.revision);
  });

  test("a proposal asks for host review but saves nothing", async () => {
    rig = await openFlowEditorRig();
    await rig.send(1, "ui:ready", { mount: rig.binding.mount });
    const before = await rig.readDraft();
    const reply = await rig.send(2, "action:propose", { draftId: rig.draftId, revision: before.draft.revision });
    expect(reply.messages.at(-1)).toMatchObject({ type: "host:reply", body: { outcome: "accepted" } });
    expect(rig.flow.saveCalls()).toBe(0);
    expect(await rig.flow.host.lifecycleJournal(rig.flow.registry).read(`${before.draft.conversationId}:${before.draft.draftId}:${before.draft.revision}`)).toBeNull();
  });

  test("host confirmation can save the frame draft with its source authority", async () => {
    rig = await openFlowEditorRig();
    const view = await rig.readDraft();
    const handoff = await rig.draftEditor.service.handoff(rig.draftId, view.draft.revision);
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) throw new Error("Synthetic Flow draft is not ready for confirmation.");
    const confirmed = await rig.draftEditor.confirm?.({ handoff: handoff.handoff, principal: rig.flow.actor.principal, transport: "web", audience: "local" });
    expect(confirmed).toMatchObject({ kind: "accepted" });
    expect(rig.flow.saveCalls()).toBe(1);
    expect(rig.flow.noActivationCalls()).toBe(true);
  });

  for (const type of ["flow:save", "host:approve", "action:confirm"]) {
    test(`a forged ${type} message retires the frame without saving or editing`, async () => {
      rig = await openFlowEditorRig();
      await rig.send(1, "ui:ready", { mount: rig.binding.mount });
      const before = await rig.readDraft();
      await expect(rig.send(2, type, { draftId: rig.draftId })).rejects.toThrow("unavailable");
      await expect(rig.send(3, "ui:resize", { height: 1 })).rejects.toThrow("unavailable");
      expect(await rig.readDraft()).toEqual(before);
      expect(rig.flow.saveCalls()).toBe(0);
    });
  }

  test("a package that no longer matches the release falls back to the host card", async () => {
    rig = await openFlowEditorRig();
    await rig.send(1, "ui:ready", { mount: rig.binding.mount });
    const before = await rig.readDraft();
    rig.assets.connections.set("principal-example", []);
    await expect(rig.send(2, "ui:resize", { height: 10 })).rejects.toThrow("unavailable");
    expect(await rig.readDraft()).toEqual(before);
  });
});
