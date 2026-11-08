import type { Proposal } from "../../creation";
import type { CreateResult, OperationRecord, ReadbackResult } from "../../types";
import { AT } from "./fixtures";
import type { LegacyContext, LegacySource } from "./legacy";

export function legacyFixture(state: OperationRecord["state"] = "created"): LegacySource {
  const proposal: Proposal = { proposalId: "proposal-example", conversationId: "conversation-example", type: "balance-task", fields: { title: "  Edited title  ", note: "Original\nuser edit", area: "area-example" }, revision: 1, entryId: "entry-example", requestDigest: "legacy-request-digest", dismissed: false, createdAt: AT, updatedAt: AT };
  const record: OperationRecord = { operationId: "conversation-example:proposal-example:1", conversationId: proposal.conversationId, proposalId: proposal.proposalId, revision: 1, owner: "balance-task", state, digest: "legacy-digest", authority: { kind: "confirmation", transport: "web" }, history: [{ state: "proposed", at: AT }, { state, at: AT, detail: "Original history" }], ...(state === "created" ? { canonicalId: "task-example", url: "https://owner.example/tasks/task-example" } : {}) };
  const createResult: CreateResult = state === "created" ? { state, canonicalId: "task-example", url: record.url } : state === "failed" ? { state, error: "Owner connection closed" } : { state: "accepted", receipt: "original-acceptance" };
  const readback: ReadbackResult = state === "created" ? { found: true, canonicalId: "task-example", url: record.url } : { found: false };
  return JSON.parse(JSON.stringify({ proposal, record, ownerReceipts: [{ requestId: "original-owner-request", receipt: "original receipt" }], createResult, readback })) as LegacySource;
}

export function legacyContext(source: LegacySource): LegacyContext {
  return { owner: "balance-task", adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create", fields: structuredClone(source.proposal.fields), destinations: [{ adapterId: "balance", connectionId: "connection-example", objectType: "area", canonicalId: "area-example" }], ...(source.record.canonicalId ? { canonicalReference: { adapterId: "balance", connectionId: "connection-example", objectType: "task", canonicalId: source.record.canonicalId } } : {}) };
}
