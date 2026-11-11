import { describe, expect, spyOn, test } from "bun:test";
import { openFlowCutoverRig, flowCutoverConfirm } from "./fixtures/flow-cutover-fixtures";
import { readOperationEvidence } from "../operations/legacy";
import { flowSaveRequest } from "./fixtures/flow-save-fixtures";
import { conversationSources } from "../../../surface/mc/desk/conversation-sources";
import { ConversationCreation } from "../../creation";

describe("explicit per-binding Flow cutover", () => {
  test("malformed persisted grants are ignored by the panel and refused at dispatch", async () => {
    const rig = await openFlowCutoverRig();
    try {
      await rig.activate();
      await rig.confirm(await rig.propose("F_GRANTED"), true);
      const grant = (await rig.creation.grants(rig.actor.principal))[0]!;
      await rig.host.changeCreation(() => ({ result: null, grants: { [grant.grantId]: { ...grant, binding: { ...grant.binding, grantId: 42 } } } }));
      expect(await rig.creation.grants(rig.actor.principal)).toEqual([]);
      expect((await rig.propose("F_BAD_GRANT")).feedback).toBe("proposed");
      const request = flowSaveRequest();
      request.provenance.conversationId = rig.id;
      const saves = rig.saveCalls();
      expect(await rig.cutover.lifecycle.create(request, { kind: "grant", grantId: grant.grantId, scope: grant.scope }, rig.actor)).toMatchObject({ state: "failed" });
      expect(rig.saveCalls()).toBe(saves);
    } finally { await rig.close(); }
  });

  test("card refresh resolves each lifecycle revision and grant snapshot once for many records", async () => {
    const rig = await openFlowCutoverRig();
    const reads = spyOn(rig.authority, "inspectHostRecords");
    const revisions = spyOn(rig.cutover.lifecycle, "reviewRevision");
    const lifecycles = spyOn(rig.host, "creationLifecycle");
    try {
      await rig.seed();
      await rig.activate();
      for (let i = 0; i < 5; i++) await rig.propose(`F_DRAFT_${i}`);
      const legacy = (await rig.creation.grants(rig.actor.principal))[0]!;
      await rig.host.changeCreation(() => ({ result: null, grants: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`legacy-${i}`, { ...legacy, grantId: `legacy-${i}` }])) }));
      reads.mockClear(); revisions.mockClear(); lifecycles.mockClear();
      const view = await rig.creation.list(rig.id, rig.actor);
      expect(view.proposals).toHaveLength(8);
      expect(view.grants).toHaveLength(6);
      expect(view.grants.every(grant => grant.renewalRequired)).toBe(true);
      expect(revisions).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(lifecycles).toHaveBeenCalledTimes(2);
    } finally {
      reads.mockRestore(); revisions.mockRestore(); lifecycles.mockRestore();
      await rig.close();
    }
  });

  for (const releaseAllowed of [true, false]) {
    test(`standing permission refusal preserves the ${releaseAllowed ? "saved" : "pending"} result`, async () => {
      const rig = await openFlowCutoverRig();
      try {
        await rig.activate();
        rig.hooks.afterSave = async () => {
          rig.policy.writesAllowed = false;
          rig.policy.releaseAllowed = releaseAllowed;
        };
        const result = await rig.confirm(await rig.propose("F_GRANT_REFUSED"), true);
        expect(result.feedback).toBe(releaseAllowed ? "created" : "accepted");
        expect(result.proposal.grantNotice).toContain("Standing permission was not granted");
        expect((await rig.creation.list(rig.id, rig.actor)).proposals[0]?.proposal.grantNotice).toBe(result.proposal.grantNotice);
        expect(await rig.pulse.savedCount()).toBe(1);
        expect(await rig.creation.grants(rig.actor.principal)).toEqual([]);
        rig.policy.writesAllowed = true;
        rig.policy.releaseAllowed = true;
        expect((await rig.propose("F_NEXT_REQUIRES_APPROVAL")).feedback).toBe("proposed");
      } finally { await rig.close(); }
    });
  }

  test("preserves edited proposal identity, historic receipt and running request; fresh approval saves once and renews save-only authority", async () => {
    const rig = await openFlowCutoverRig();
    try {
      const before = await rig.seed();
      const plan = await rig.plan();
      const active = await rig.cutover.cutover(plan, rig.steps(), 0);
      expect(active.phase).toBe("active");
      const view = await rig.creation.list(rig.id, rig.actor);
      const draft = view.proposals.find(item => item.proposal.proposalId === before.draft.proposal.proposalId)!;
      expect(draft.proposal).toEqual(before.draft.proposal);
      expect(draft.digest).not.toBe(before.draft.digest);
      expect(draft.feedback).toBe("proposed");
      await expect(rig.confirm(before.draft)).rejects.toThrow("review it again");
      expect(view.proposals.find(item => item.proposal.proposalId === before.saved.proposal.proposalId)?.operation).toEqual(before.saved.operation);
      const savedEvidence = readOperationEvidence(await rig.cutover.journal.read(before.saved.operation?.operationId ?? ""));
      expect(savedEvidence.kind).toBe("legacy");
      if (savedEvidence.kind !== "legacy") throw new Error("Missing saved receipt import");
      expect(savedEvidence.source.record).toEqual(before.saved.operation!);
      expect(savedEvidence.source.proposal.conversationId).toBe(rig.id);
      expect(view.grants).toContainEqual(expect.objectContaining({ grantId: before.grantId, renewalRequired: true }));
      const imported = readOperationEvidence(await rig.cutover.journal.read(before.running.operationId));
      expect(imported.kind).toBe("legacy");
      if (imported.kind !== "legacy") throw new Error("Missing import");
      expect(imported.lifecycle.journal.state).toBe("uncertain");
      expect(imported.retryAllowed).toBe(false);
      expect(imported.lifecycle.journal.ownerRequestId).toMatch(/^conv-/);
      const checked = await rig.creation.check(rig.id, before.running.proposalId, rig.actor);
      expect(checked.feedback).toBe("created");
      expect(checked.operation?.canonicalId).toBe("F_LEGACY_RUNNING");
      const approved = await rig.confirm(draft, true);
      expect(approved.feedback).toBe("created");
      expect((await rig.confirm(approved, true)).operation).toEqual(approved.operation);
      const renewed = (await rig.creation.grants(rig.actor.principal)).find(grant => !grant.renewalRequired)!;
      expect(renewed.binding).toMatchObject({ adapterId: "flow", connectionId: "flow-example", capabilityId: "flow.saved.create" });
      const grantRecord = (await rig.authority.inspectHostRecords()).records[`grant:${renewed.binding?.grantId ?? ""}`]?.at(-1);
      expect(grantRecord).toMatchObject({ kind: "grant", value: { constraints: { capabilityIds: ["flow.saved.create"], connectionId: "flow-example" } } });
      expect((await rig.propose("F_NEXT_SAVE")).feedback).toBe("created");
      await rig.creation.revoke(renewed.grantId, rig.actor);
      const repeatedAfterRevoke = await rig.confirm(approved, true);
      expect(repeatedAfterRevoke.operation).toEqual(approved.operation);
      expect(repeatedAfterRevoke.proposal.grantNotice).toContain("Standing permission was not granted");
      expect((await rig.propose("F_ASK_AGAIN")).feedback).toBe("proposed");
      expect((await rig.pulse.command(["show", "F_LEGACY_EDITED"])).code).toBe(0);
      expect(await rig.pulse.savedCount()).toBe(4);
      expect(rig.noActivationCalls()).toBe(true);
      expect(await rig.cutover.cutover(plan, rig.steps(), active.revision)).toEqual(active);
    } finally { await rig.close(); }
  });

  for (const stage of ["disable", "stop", "verify", "prepare", "enable"] as const) {
    test(`a failed ${stage} leaves Flow mutation off, native creation usable and sidecars readable after a reader downgrade`, async () => {
      const rig = await openFlowCutoverRig();
      try {
        const seeded = await rig.seed();
        const plan = await rig.plan();
        const steps = rig.steps();
        steps[stage] = async () => { throw new Error(`Synthetic ${stage} failure`); };
        await expect(rig.cutover.cutover(plan, steps, 0)).rejects.toThrow(`Synthetic ${stage}`);
        expect((await rig.host.lifecycleWriters().read(JSON.stringify({ adapterId: "flow", capabilityId: "flow.saved.create", connectionId: "flow-example", owner: "flow", stack: "test" })))?.phase).not.toBe("active");
        const beforeCalls = rig.pulse.calls.length;
        await rig.host.attachSources(conversationSources({ db: rig.db, desk: () => rig.desk, runFlow: rig.pulse.run }));
        expect((await rig.host.writers.flow!.create(flowSaveRequest())).state).toBe("failed");
        expect(rig.pulse.calls.length).toBe(beforeCalls);
        expect((await rig.creation.grants(rig.actor.principal))[0]?.renewalRequired).toBe(true);
        expect((await rig.host.operations(rig.id)).find(record => record.operationId === seeded.saved.operation?.operationId)).toEqual(seeded.saved.operation ?? undefined);
        const note = await rig.confirm(await rig.propose("A native note", "desk-note"));
        expect(note.feedback).toBe("created");
        if (["prepare", "enable"].includes(stage)) expect(readOperationEvidence(await rig.cutover.journal.read(seeded.running.operationId)).kind).toBe("legacy");
      } finally { await rig.close(); }
    });
  }

  test("uncertain saves check the owner by original request ID without a replay; hard triggers fence lifecycle and legacy", async () => {
    const rig = await openFlowCutoverRig();
    try {
      await rig.activate();
      const draft = await rig.propose("F_AFTER_CUTOVER");
      rig.pulse.state.mode = "timeout";
      const uncertain = await rig.confirm(draft);
      expect(uncertain.feedback).toBe("uncertain");
      const checked = await rig.creation.check(rig.id, draft.proposal.proposalId, rig.actor);
      expect(checked.feedback).toBe("created");
      expect(rig.saveCalls()).toBe(1);
      await rig.host.lifecycleFences().trigger({ kind: "duplicate_owner_object", target: { adapterId: "flow", connectionId: "flow-example", capabilityId: "flow.saved.create" }, evidence: { operationId: checked.operation?.operationId ?? "synthetic" } });
      const second = await rig.propose("F_FENCED");
      expect((await rig.confirm(second)).feedback).toBe("failed");
      expect(rig.saveCalls()).toBe(1);
      expect(await rig.host.lifecycleWriters().legacyOwnerAllowed("test", "flow")).toBe(false);
      expect(flowCutoverConfirm(checked).revision).toBe(1);
    } finally { await rig.close(); }
  });

  test("a reopened read-only host retains the fenced epoch and exact sidecar bytes and cannot restart native Flow saving", async () => {
    const rig = await openFlowCutoverRig();
    try {
      const seeded = await rig.seed();
      const active = await rig.activate();
      const before = await rig.cutover.journal.read(seeded.running.operationId);
      const saves = rig.saveCalls();
      const host = await rig.downgrade();
      expect(await host.lifecycleJournal(rig.registry).read(seeded.running.operationId)).toEqual(before);
      expect(await host.lifecycleWriters().read(active.bindingKey)).toEqual(active);
      expect(await host.writers.flow!.create(flowSaveRequest())).toMatchObject({ state: "failed" });
      expect(rig.saveCalls()).toBe(saves);
      const view = await new ConversationCreation(host).list(rig.id, rig.actor);
      expect(view.proposals.find(item => item.proposal.proposalId === seeded.saved.proposal.proposalId)?.operation).toEqual(seeded.saved.operation);
      expect(view.grants[0]?.renewalRequired).toBe(true);
    } finally { await rig.close(); }
  });

  test("an incomplete import inventory disables mutation without deleting the draft or legacy evidence", async () => {
    const rig = await openFlowCutoverRig();
    try {
      const seeded = await rig.seed();
      const plan = await rig.plan();
      plan.sources = [];
      await expect(rig.cutover.cutover(plan, rig.steps(), 0)).rejects.toThrow("inventory changed");
      expect(await rig.host.lifecycleWriters().legacyOwnerAllowed("test", "flow")).toBe(false);
      expect((await rig.creation.list(rig.id, rig.actor)).proposals.find(item => item.proposal.proposalId === seeded.draft.proposal.proposalId)?.proposal).toEqual(seeded.draft.proposal);
      expect((await rig.host.operations(rig.id)).find(record => record.operationId === seeded.running.operationId)?.state).toBe("running");
    } finally { await rig.close(); }
  });

  test("a retargeted connection cannot release the old save receipt and denied write scope makes zero owner calls", async () => {
    const rig = await openFlowCutoverRig();
    try {
      await rig.activate();
      rig.hooks.afterSave = async () => {
        rig.connection.connectionRevision = "2";
        await rig.authority.publishHostRecord({ kind: "connection", value: { ...rig.connection, accountScope: { stack: "test", account: "another-local-owner" } } }, 1);
      };
      const result = await rig.confirm(await rig.propose("F_PRIVATE_RECEIPT"));
      expect(result.feedback).toBe("accepted");
      expect(result.operation?.canonicalId).toBeUndefined();
      expect((await rig.cutover.journal.read(result.operation?.operationId ?? ""))?.journal.state).toBe("succeeded");
      const checked = await rig.creation.check(rig.id, result.proposal.proposalId, rig.actor);
      expect(checked.operation?.canonicalId).toBeUndefined();
      rig.connection.connectionRevision = "3";
      rig.connection.writeDestinations = [];
      await rig.authority.publishHostRecord({ kind: "connection", value: rig.connection }, 2);
      const beforeCalls = rig.saveCalls();
      await rig.confirm(await rig.propose("F_DENIED"));
      expect(rig.saveCalls()).toBe(beforeCalls);
    } finally { await rig.close(); }
  });
});
