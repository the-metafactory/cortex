import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ApprovedSnapshot } from "./types";
import { canonicalWire } from "./validation";
import type { DiagnosticRecorder } from "../diagnostics";

const text = z.string().min(1);
const actionText = z.string().trim().min(1);
const time = z.iso.datetime({ offset: false });
const DAY_MS = 24 * 60 * 60 * 1000;

export const FENCE_TRIGGER_KINDS = ["duplicate_owner_object", "success_without_owner_evidence", "destination_denied_at_connector", "canary_secret_leaked", "repeated_uncertain", "readback_failed", "adapter_crash"] as const;
export type FenceTriggerKind = (typeof FENCE_TRIGGER_KINDS)[number];

export const HARD_TRIGGERS: ReadonlySet<FenceTriggerKind> = new Set<FenceTriggerKind>(["duplicate_owner_object", "success_without_owner_evidence", "destination_denied_at_connector", "canary_secret_leaked"]);
export const isHardTrigger = (kind: FenceTriggerKind): boolean => HARD_TRIGGERS.has(kind);

export const FenceTargetSchema = z.object({ adapterId: text, connectionId: text, capabilityId: text, stack: text.nullable().optional(), owner: text.nullable().optional() }).strict();
export type FenceTarget = z.infer<typeof FenceTargetSchema>;

export const FenceEvidenceSchema = z.object({ operationId: text.optional(), ownerRequestId: text.optional(), resultId: text.optional(), canaryId: text.optional(), refs: z.array(text).optional(), detail: text.optional() }).strict();
export type FenceEvidence = z.infer<typeof FenceEvidenceSchema>;

export const FenceSignalSchema = z.object({ kind: z.enum(FENCE_TRIGGER_KINDS), target: FenceTargetSchema, at: time.optional(), evidence: FenceEvidenceSchema.default({}) }).strict();
export type FenceSignal = z.infer<typeof FenceSignalSchema>;
export type FenceSignalInput = z.input<typeof FenceSignalSchema>;

export const FenceRecordSchema = z.object({
  version: z.literal(1), fenceId: text, target: FenceTargetSchema, targetKey: text, state: z.enum(["fenced", "open"]),
  trigger: FenceSignalSchema, message: text, at: time, liftedBy: text.optional(), liftReason: text.optional(), liftedAt: time.optional(),
}).strict();
export type FenceRecord = z.infer<typeof FenceRecordSchema>;

export const PrincipalNoticeSchema = z.object({
  version: z.literal(1), notificationId: text, at: time, effect: z.enum(["mutation-off", "notify-only"]),
  trigger: z.enum(FENCE_TRIGGER_KINDS), target: FenceTargetSchema, targetKey: text, title: text, body: text, delivered: z.boolean(),
}).strict();
export type PrincipalNotice = z.infer<typeof PrincipalNoticeSchema>;
export type PrincipalNotifier = (notice: PrincipalNotice) => void | Promise<void>;

const UncertainObservationSchema = z.object({ targetKey: text, at: time, operationId: text.optional() }).strict();
const StateSchema = z.object({ version: z.literal(1), fences: z.record(text, z.array(FenceRecordSchema)), notices: z.array(PrincipalNoticeSchema), uncertain: z.array(UncertainObservationSchema) }).strict();
type FenceState = z.infer<typeof StateSchema>;
const EMPTY_STATE: FenceState = { version: 1, fences: {}, notices: [], uncertain: [] };

const FenceDoc = defineDoc<{ state: JsonObject }>({ kind: "cortex.desk-binding-fence", version: 1, scope: "session", initial: () => ({ state: store(EMPTY_STATE) }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });

const TITLES: Record<FenceTriggerKind, string> = {
  duplicate_owner_object: "An owner lookup returned two objects for one operation.",
  success_without_owner_evidence: "A success result arrived without owner evidence.",
  destination_denied_at_connector: "A denied destination reached the owner connector.",
  canary_secret_leaked: "A canary secret leaked.",
  repeated_uncertain: "Three uncertain results landed on one binding within 24 hours.",
  readback_failed: "A readback failed.",
  adapter_crash: "An adapter crashed.",
};
const MUTATION_OFF = "The binding's mutation is off, its drafts are kept and its reads continue. Fix the cause, then lift the fence with a reason.";
const NOTIFY_ONLY = "Mutation stays on. Review the binding; no fence was applied.";

export const fenceKey = (target: FenceTarget): string => canonicalWire([target.adapterId, target.connectionId, target.capabilityId]);
export function fenceTargetOf(snapshot: Pick<ApprovedSnapshot, "adapterId" | "connectionId" | "capabilityId">, extra: Pick<FenceTarget, "stack" | "owner"> = {}): FenceTarget {
  return { adapterId: snapshot.adapterId, connectionId: snapshot.connectionId, capabilityId: snapshot.capabilityId, ...extra };
}

export interface FenceGate {
  isFenced(target: FenceTarget): Promise<boolean>;
  trigger(signal: FenceSignalInput): Promise<unknown>;
}
export interface FenceSink { trigger(signal: FenceSignalInput): Promise<unknown> }
export interface FenceOutcome { fenced: boolean; notification: PrincipalNotice | null; fence: FenceRecord | null }
export interface FenceLift { principal: string; reason: string }
export class FenceConflict extends Error {}

const asState = (value: JsonObject): FenceState => StateSchema.parse(value);
const store = (state: FenceState): JsonObject => JSON.parse(JSON.stringify(state)) as JsonObject;
export class FencePersistenceError extends Error {
  constructor(readonly kind: FenceTriggerKind, readonly failure: unknown) {
    super(`The ${kind} trigger did not persist, so its fence is not recorded: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
}
export async function signalFence(sink: FenceSink | undefined, signal: FenceSignalInput): Promise<void> {
  if (!sink) return;
  try { await sink.trigger(signal); }
  catch (error) {
    if (isHardTrigger(signal.kind)) throw new FencePersistenceError(signal.kind, error);
    console.error(`desk-fence: the ${signal.kind} trigger did not persist: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const noticeFor = (signal: FenceSignal, at: string): PrincipalNotice => {
  const effect = isHardTrigger(signal.kind) ? "mutation-off" as const : "notify-only" as const;
  return { version: 1, notificationId: randomUUID(), at, effect, trigger: signal.kind, target: signal.target, targetKey: fenceKey(signal.target), title: TITLES[signal.kind], body: effect === "mutation-off" ? MUTATION_OFF : NOTIFY_ONLY, delivered: false };
};

export class BindingFenceStore implements FenceGate, FenceSink {
  private readonly now: () => Date;

  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private notifier?: PrincipalNotifier, private readonly context: Context = BACKGROUND_CONTEXT, now?: () => Date, private diagnostics?: DiagnosticRecorder) {
    this.now = now ?? (() => new Date());
  }

  attachDiagnostics(diagnostics: DiagnosticRecorder): void {
    this.diagnostics = diagnostics;
  }

  private async state(): Promise<FenceState> {
    const doc = await this.engine.snapshot(FenceDoc, this.context);
    return asState(doc?.state ?? store(EMPTY_STATE));
  }

  private mutate<T>(change: (state: FenceState) => T): Promise<T> {
    return this.engine.commit(async tx => {
      const doc = await tx.doc(FenceDoc);
      const before = doc.state;
      const state = asState(before);
      const result = change(state);
      const after = store(state);
      if (canonicalWire(after) !== canonicalWire(before)) doc.state = after;
      return result;
    }, this.context);
  }

  async read(target: FenceTarget): Promise<FenceRecord | null> {
    return (await this.state()).fences[fenceKey(target)]?.at(-1) ?? null;
  }

  async isFenced(target: FenceTarget): Promise<boolean> {
    return (await this.read(target))?.state === "fenced";
  }

  async isConnectionFenced(connectionId: string): Promise<boolean> {
    const state = await this.state();
    return Object.values(state.fences).some(records => {
      const head = records.at(-1);
      return head?.state === "fenced" && head.target.connectionId === connectionId;
    });
  }

  async notices(): Promise<PrincipalNotice[]> {
    return (await this.state()).notices;
  }

  async pending(): Promise<PrincipalNotice[]> {
    return (await this.state()).notices.filter(notice => !notice.delivered);
  }

  async trigger(raw: FenceSignalInput): Promise<FenceOutcome> {
    const signal = FenceSignalSchema.parse(raw);
    const at = signal.at ?? this.now().toISOString();
    const targetKey = fenceKey(signal.target);
    const committed = await this.mutate(state => {
      const head = state.fences[targetKey]?.at(-1);
      const notice = isHardTrigger(signal.kind) ? this.fence(state, signal, targetKey, at, head) : this.observe(state, signal, targetKey, at);
      if (notice) state.notices.push(notice);
      return { notice, head: state.fences[targetKey]?.at(-1) ?? null };
    });
    const notification = committed.notice ? await this.deliver(committed.notice) : null;
    const fenced = committed.head?.state === "fenced";
    await this.diagnostics?.record({ event: "desk.adapter.trigger_fired", adapterId: signal.target.adapterId, connectionId: signal.target.connectionId, capabilityId: signal.target.capabilityId, state: fenced ? "fenced" : "notify-only", errorCode: signal.kind, at });
    return { fenced, notification, fence: committed.head };
  }

  private fence(state: FenceState, signal: FenceSignal, targetKey: string, at: string, head: FenceRecord | undefined): PrincipalNotice | null {
    if (head?.state === "fenced") return null;
    const record: FenceRecord = { version: 1, fenceId: randomUUID(), target: signal.target, targetKey, state: "fenced", trigger: signal, message: MUTATION_OFF, at };
    state.fences[targetKey] = [...(state.fences[targetKey] ?? []), record];
    return noticeFor(signal, at);
  }

  private observe(state: FenceState, signal: FenceSignal, targetKey: string, at: string): PrincipalNotice | null {
    if (signal.kind !== "repeated_uncertain") return noticeFor(signal, at);
    const cutoff = Date.parse(at) - DAY_MS;
    state.uncertain = state.uncertain.filter(item => item.targetKey !== targetKey || Date.parse(item.at) >= cutoff);
    state.uncertain.push({ targetKey, at, ...(signal.evidence.operationId === undefined ? {} : { operationId: signal.evidence.operationId }) });
    const matching = state.uncertain.filter(item => item.targetKey === targetKey);
    if (matching.length < 3) return null;
    const third = matching[matching.length - 3];
    const prior = state.notices.findLast(item => item.targetKey === targetKey && item.trigger === "repeated_uncertain");
    if (third !== undefined && prior !== undefined && Date.parse(prior.at) >= Date.parse(third.at)) return null;
    return noticeFor(signal, at);
  }

  async attachNotifier(notifier: PrincipalNotifier): Promise<void> {
    this.notifier = notifier;
    for (const notice of await this.pending()) await this.deliver(notice);
  }

  private async deliver(notice: PrincipalNotice): Promise<PrincipalNotice> {
    const notifier = this.notifier;
    if (!notifier) return notice;
    try {
      await notifier(notice);
      await this.mutate(state => {
        const found = state.notices.find(item => item.notificationId === notice.notificationId);
        if (found) found.delivered = true;
      });
      return { ...notice, delivered: true };
    } catch (error) {
      console.error(`desk-fence: principal notice ${notice.notificationId} was not delivered: ${error instanceof Error ? error.message : String(error)}`);
      return notice;
    }
  }

  async lift(target: FenceTarget, action: FenceLift): Promise<FenceRecord> {
    const principal = actionText.parse(action.principal);
    const reason = actionText.parse(action.reason);
    const at = this.now().toISOString();
    const key = fenceKey(target);
    const record = await this.mutate(state => {
      const head = state.fences[key]?.at(-1);
      if (head?.state !== "fenced") throw new FenceConflict("Only a fenced binding can be lifted.");
      const lifted: FenceRecord = { version: 1, fenceId: randomUUID(), target, targetKey: key, state: "open", trigger: head.trigger, message: head.message, at, liftedBy: principal, liftReason: reason, liftedAt: at };
      state.fences[key] = [...(state.fences[key] ?? []), lifted];
      return lifted;
    });
    await this.diagnostics?.record({ event: "desk.adapter.connection_status", adapterId: target.adapterId, connectionId: target.connectionId, state: "available", at });
    return record;
  }
}
