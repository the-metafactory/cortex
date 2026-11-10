import { AT, support } from "./fixtures";
import { deferred, dispatchRig, ownerResult } from "./dispatch-fixtures";
import { ObjectReader } from "./readback";
import { OperationReconciler } from "./reconciliation";
import type { DispatchRequest, OperationLookup, OwnerSupport } from "./types";
import type { PrincipalNotifier } from "./triggers";

export type SyntheticDedup = "none" | { retentionMs: number };
export interface RigOptions { dedup?: SyntheticDedup; lookupWaitMs?: number; ownerWaitMs?: number; notify?: PrincipalNotifier }

const supportFor = (dedup: SyntheticDedup): OwnerSupport => ({ ...support, cancellation: "best-effort", operationLookup: "historical", dedup: dedup === "none" ? { kind: "none" } : { kind: "guaranteed", scope: "connection-capability", retentionMs: dedup.retentionMs, bindsSnapshot: true, concurrent: true } });

export async function reconcileRig(options: RigOptions = {}) {
  const clock = { at: new Date(AT) };
  const rig = await dispatchRig(options.ownerWaitMs ?? 20, undefined, () => new Date(clock.at), options.notify);
  rig.declared.support = supportFor(options.dedup ?? "none");
  const owner = { effects: new Map<string, string>(), attempts: [] as string[], reveal: false, hangFirst: true };
  const never = deferred<unknown>();
  rig.hooks.dispatch = request => {
    owner.attempts.push(request.attemptId);
    const first = owner.attempts.length === 1;
    if (!owner.effects.has(request.ownerRequestId)) owner.effects.set(request.ownerRequestId, "task-example");
    if (first && owner.hangFirst) { clock.at = new Date(Date.parse(AT) + 30_000); return never.promise; }
    return Promise.resolve(ownerResult(request, "succeeded", `replay-${request.attemptId}`));
  };
  const unknown: OperationLookup["result"] = { kind: "unknown", reason: { code: "synthetic_unknown", message: "No historical evidence." } };
  const answer = (result: OperationLookup["result"]): OperationLookup => ({ lifecycleVersion: "1.0.0", operationId: rig.approval.operationId, checkedAt: clock.at.toISOString(), result });
  rig.hooks.lookup = () => {
    if (!owner.reveal) return Promise.resolve(answer(unknown));
    const request = { operationId: rig.approval.operationId, attemptId: owner.attempts[0] ?? "", ownerRequestId: rig.approval.ownerRequestId, snapshot: rig.approval.snapshot } satisfies Pick<DispatchRequest, "operationId" | "attemptId" | "ownerRequestId" | "snapshot">;
    return Promise.resolve(answer({ kind: "known", response: ownerResult(request, "succeeded", "result-late") }));
  };
  const build = (): OperationReconciler => new OperationReconciler({ journal: rig.host.lifecycleJournal(rig.registry), authority: rig.host.lifecycleAuthority(rig.registry, rig.bindings), bridge: rig.bridge, supportFor: () => rig.declared.support, fences: rig.host.lifecycleFences(), now: () => new Date(clock.at), ...(options.lookupWaitMs === undefined ? {} : { lookupWaitMs: () => options.lookupWaitMs ?? 0 }) });
  const state = { reconciler: build() };
  const reopen = rig.reopen.bind(rig);
  const reader = () => new ObjectReader({ authority: rig.host.lifecycleAuthority(rig.registry, rig.bindings), waitMs: () => options.lookupWaitMs ?? 50 });
  const extended = Object.assign(rig, {
    clock, owner, answer, unknown,
    reconciler: () => state.reconciler,
    reader,
    tick(ms: number) { clock.at = new Date(clock.at.getTime() + ms); },
    setClock(ms: number) { clock.at = new Date(Date.parse(AT) + ms); },
    async reopen() { await reopen(); state.reconciler = build(); },
    async begin() {
      const confirmed = await rig.confirm();
      if (confirmed.kind !== "allowed") throw new Error("Synthetic confirmation denied.");
      if (!await rig.activate()) throw new Error("Synthetic bridge activation failed.");
    },
    advance: () => state.reconciler.advance(rig.context, rig.approval.operationId, rig.lease, rig.sink),
    check: () => state.reconciler.check(rig.context, rig.approval.operationId, rig.sink),
  });
  return extended;
}
