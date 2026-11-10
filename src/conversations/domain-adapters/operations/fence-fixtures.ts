import { objectRef } from "../fixtures";
import { ownerResult } from "./dispatch-fixtures";
import { reconcileRig, type RigOptions } from "./reconciliation-fixtures";
import type { FenceTarget, PrincipalNotifier } from "./triggers";
import type { OwnerResult } from "./types";

export type FenceRig = Awaited<ReturnType<typeof reconcileRig>>;

export const fenceTarget = (rig: { binding: Pick<FenceRig["binding"], "adapterId" | "connectionId" | "capabilityId"> }): FenceTarget => ({ adapterId: rig.binding.adapterId, connectionId: rig.binding.connectionId, capabilityId: rig.binding.capabilityId });

export async function openFenceRig(notify: PrincipalNotifier, options: RigOptions = {}): Promise<FenceRig> {
  const rig = await reconcileRig({ ...options, notify });
  await rig.begin();
  return rig;
}

export async function firstAttempt(rig: FenceRig): Promise<string> {
  const entry = (await rig.events())?.journal.events.find(item => item.event.kind === "attempt-prepared");
  if (entry?.event.kind !== "attempt-prepared") throw new Error("Synthetic attempt is unavailable.");
  return entry.event.attempt.attemptId;
}

export const requestFor = async (rig: FenceRig) => ({ operationId: rig.approval.operationId, attemptId: await firstAttempt(rig), ownerRequestId: rig.approval.ownerRequestId, snapshot: rig.approval.snapshot });

export async function successFor(rig: FenceRig, resultId: string, canonicalId: string): Promise<OwnerResult> {
  const base = ownerResult(await requestFor(rig), "succeeded", resultId);
  if (base.result.kind !== "succeeded") throw new Error("Synthetic success is unavailable.");
  const ref = objectRef("balance", "task", canonicalId);
  return { ...base, result: { kind: "succeeded", output: { ref }, evidence: { ...base.result.evidence, refs: [ref] } } };
}

export async function successWithoutEvidence(rig: FenceRig): Promise<unknown> {
  const base = ownerResult(await requestFor(rig), "succeeded");
  if (base.result.kind !== "succeeded") throw new Error("Synthetic success is unavailable.");
  return { ...base, result: { kind: "succeeded", output: base.result.output } };
}
