import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { balanceResponse, FRIDAY, MONDAY, openDraftingRig } from "../src/conversations/domain-adapters/drafting-fixtures";

const rig = await openDraftingRig();
try {
  rig.state.response = () => balanceResponse();
  const made = await rig.service.make({ conversationId: "conversation-example", entryId: "turn-1", capabilityId: "balance.task.create", connectionId: "connection-example" });
  assert.equal(made.kind, "draft");
  if (made.kind !== "draft") throw new Error("unreachable");
  const id = made.view.draft.draftId;
  assert.equal(made.view.draft.fields["/area"]?.origin, "suggested");
  console.log(`drafted ${id}: title generated, area/project suggested, status=${made.view.status}`);

  await rig.service.edit(id, made.view.draft.revision, "/title", { kind: "set", value: "Audit restart receipts" });
  await rig.service.edit(id, made.view.draft.revision + 1, "/note", { kind: "omit" });
  rig.state.items.push({ id: "turn-2", kind: "turn", revision: "1", digest: "d3", restriction: "cloud", text: "Include a crash immediately after acceptance; perhaps Friday or Monday.", at: "2026-11-08T10:05:00.000Z" });
  rig.state.head = "2";
  const outdated = await rig.service.read(id);
  assert.ok(outdated?.outdated.includes("conversation-changed"));
  rig.state.response = () => balanceResponse({ title: "Overwrite attempt", due: { pointer: "/due", citations: ["turn-2"], alternatives: [{ value: FRIDAY, citations: ["turn-2"] }, { value: MONDAY, citations: ["turn-2"] }] } });
  const refreshed = await rig.service.refresh(id, made.view.draft.revision + 2);
  assert.equal(refreshed.kind, "applied");
  if (refreshed.kind !== "applied") throw new Error("unreachable");
  assert.equal(refreshed.view.draft.fields["/title"]?.value, "Audit restart receipts");
  assert.equal(refreshed.view.draft.fields["/note"]?.presence, "absent");
  assert.equal(refreshed.view.draft.fields["/due"]?.unresolved, "conflict");
  console.log(`refresh kept edited title and cleared note; due alternatives ${FRIDAY} / ${MONDAY} unresolved`);

  const revision = refreshed.view.draft.revision;
  rig.state.onGenerate = async () => { rig.state.onGenerate = undefined; await rig.service.edit(id, revision, "/title", { kind: "set", value: "Edited during generation" }); };
  assert.deepEqual(await rig.service.refresh(id, revision), { kind: "stale" });
  console.log("stale generation discarded after an intervening edit");

  await rig.reopen();
  const reopened = await rig.service.read(id);
  assert.equal(reopened?.draft.fields["/title"]?.value, "Edited during generation");
  assert.equal(reopened?.draft.fields["/note"]?.origin, "user");
  const again = await rig.service.make({ conversationId: "conversation-example", entryId: "turn-1", capabilityId: "balance.task.create", connectionId: "connection-example" });
  assert.ok(again.kind === "draft" && again.reopened && again.view.draft.draftId === id);
  console.log(`reopened ${id} after host restart with edits and clears intact`);

  rig.state.localOnly.add("turn-1");
  for (const item of rig.state.items) if (item.id === "turn-1") item.restriction = "local";
  rig.state.lanes = ["cloud"];
  const before = rig.state.requests.length;
  const denied = await rig.service.refresh(id, reopened?.draft.revision ?? 0);
  assert.equal(denied.kind, "kept");
  assert.equal(rig.state.requests.length, before);
  assert.deepEqual((await rig.service.read(id))?.draft.limitations.map(item => item.code), ["model_unavailable"]);
  const cloudView = await rig.service.read(id, "cloud");
  assert.ok(cloudView && cloudView.withheld.length > 0);
  console.log(`cloud release denied: model calls unchanged, ${cloudView.withheld.length} derived fields withheld from a cloud audience`);

  assert.deepEqual(rig.owner, { mutations: 0, queries: 0 });
  console.log("owner mutation calls: 0");
} finally {
  await rig.close();
  await rm(rig.root, { recursive: true, force: true });
}
