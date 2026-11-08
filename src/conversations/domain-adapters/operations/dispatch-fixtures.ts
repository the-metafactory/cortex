import { authorityRig } from "../../authority-fixtures";
import { objectRef } from "../fixtures";
import { AT, support } from "./fixtures";
import type { DispatchRequest, OwnerResult, OwnerSupport } from "./types";
import type { WriterBinding } from "./writer-authority";

export interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function ownerResult(request: Pick<DispatchRequest, "operationId" | "attemptId" | "ownerRequestId" | "snapshot">, kind: "accepted" | "succeeded" | "cancelled" | "uncertain", resultId = `result-${kind}`): OwnerResult {
  const base = { lifecycleVersion: "1.0.0" as const, operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId, reportedAt: AT };
  const ref = objectRef("balance", "task", "task-example");
  if (kind === "accepted") return { ...base, result: { kind, ownerRequestId: request.ownerRequestId, receipt: { ticket: "ticket-example" } } };
  if (kind === "succeeded") return { ...base, result: { kind, output: { ref }, evidence: { kind: "effect", evidenceId: `evidence-${resultId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { committed: true }, refs: [ref] } } };
  if (kind === "cancelled") return { ...base, result: { kind, evidence: { kind: "no-effect", evidenceId: `evidence-${resultId}`, observedAt: AT, ownerRequestId: request.ownerRequestId, receipt: { stopped: true }, final: true } } };
  return { ...base, result: { kind, error: { code: "synthetic_unknown", message: "The owner cannot tell." }, ownerRequestId: request.ownerRequestId } };
}

export async function dispatchRig(waitMs = 30_000, maxOutstandingCalls?: number) {
  const rig = await authorityRig({ now: () => new Date(AT) });
  const declared: { support: OwnerSupport | undefined } = { support: { ...support, cancellation: "best-effort", operationLookup: "historical" } };
  const build = () => rig.host.lifecycleBridge(rig.registry, rig.bindings, () => declared.support, waitMs, maxOutstandingCalls);
  const holder = { bridge: build() };
  const original = rig.reopen.bind(rig);
  const reopen = (): Promise<void> => original();
  const binding: WriterBinding = { stack: "test", owner: "synthetic-owner", adapterId: rig.approval.snapshot.adapterId, connectionId: rig.approval.snapshot.connectionId, capabilityId: rig.approval.snapshot.capabilityId };
  const events = () => rig.host.lifecycleJournal(rig.registry).read(rig.approval.operationId);
  const extended = Object.assign(rig, {
    bridge: holder.bridge, binding, declared, events,
    async reopen() { await reopen(); holder.bridge = build(); extended.bridge = holder.bridge; },
    activate: () => holder.bridge.activate(binding, rig.lease),
    dispatch: () => holder.bridge.dispatch(rig.context, rig.approval.operationId, rig.lease),
    async cancel(cancelId = "cancel-example") {
      const authority = await rig.service.confirmCancellation(rig.context, rig.approval.operationId, cancelId);
      if (authority.kind !== "allowed") throw new Error("Synthetic cancellation denied.");
      return holder.bridge.cancel(rig.context, { lifecycleVersion: "1.0.0", operationId: rig.approval.operationId, cancelId, authority: authority.authority, requestedAt: AT }, rig.lease);
    },
  });
  return extended;
}
