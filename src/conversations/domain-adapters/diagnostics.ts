import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDocFamily, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { z } from "zod";
import { OperationStateSchema } from "./operations/types";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const time = z.iso.datetime({ offset: true });

export const CONNECTION_STATUS_VALUES = ["available", "unavailable", "stale", "fenced"] as const;
export type AdapterConnectionState = (typeof CONNECTION_STATUS_VALUES)[number];

export const DIAGNOSTIC_EVENT_NAMES = [
  "desk.adapter.connection_status",
  "desk.adapter.query_refused",
  "desk.adapter.query_partial",
  "desk.adapter.operation_state",
  "desk.adapter.trigger_fired",
] as const;
export type DiagnosticEventName = (typeof DIAGNOSTIC_EVENT_NAMES)[number];

export const DIAGNOSTIC_EVENT_KEYS = ["event", "adapterId", "connectionId", "capabilityId", "state", "errorCode", "at"] as const;

export const ADAPTER_EVENT_CAPACITY = 500;
export const STALE_AFTER_MS = 15 * 60 * 1000;

const head = { adapterId: identifier, connectionId: identifier, capabilityId: identifier.optional(), at: time };
export const DiagnosticEventSchema = z.discriminatedUnion("event", [
  z.object({ ...head, event: z.literal("desk.adapter.connection_status"), state: z.enum(CONNECTION_STATUS_VALUES), errorCode: identifier.optional() }).strict(),
  z.object({ ...head, event: z.literal("desk.adapter.query_refused"), state: z.literal("refused"), errorCode: identifier }).strict(),
  z.object({ ...head, event: z.literal("desk.adapter.query_partial"), state: z.literal("partial"), errorCode: identifier.optional() }).strict(),
  z.object({ ...head, event: z.literal("desk.adapter.operation_state"), state: OperationStateSchema, errorCode: identifier.optional() }).strict(),
  z.object({ ...head, event: z.literal("desk.adapter.trigger_fired"), state: z.enum(["fenced", "notify-only"]), errorCode: identifier }).strict(),
]);
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;

export const ConnectionStatusSchema = z.object({
  state: z.enum(CONNECTION_STATUS_VALUES),
  lastSuccessAt: time.nullable(),
  lastAttemptAt: time.nullable(),
  reason: identifier.nullable(),
}).strict();
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

const ConnectionRecordSchema = z.object({ reported: z.boolean(), status: ConnectionStatusSchema, events: z.array(DiagnosticEventSchema) }).strict();
type ConnectionRecord = z.infer<typeof ConnectionRecordSchema>;

const EMPTY_STATUS: ConnectionStatus = { state: "unavailable", lastSuccessAt: null, lastAttemptAt: null, reason: "not_reported" };
const EMPTY_RECORD: ConnectionRecord = { reported: false, status: EMPTY_STATUS, events: [] };
const DiagnosticsDoc = defineDocFamily<{ record: JsonObject | null }, string>({ kind: "cortex.desk-adapter-diagnostics", version: 1, scope: "session", family: true, initial: () => ({ record: null }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });

export type DiagnosticOutcome = { stored: true; event: DiagnosticEvent } | { stored: false; code: "invalid_event" | "store_failed" };
export interface DiagnosticRecorder {
  record(input: unknown): Promise<DiagnosticOutcome>;
  events(connectionId: string): Promise<DiagnosticEvent[]>;
}
export interface ConnectionStatusReader extends DiagnosticRecorder {
  status(connectionId: string, fallback?: ConnectionStatus): Promise<ConnectionStatus>;
}
export interface AdapterDiagnosticsOptions {
  now?: () => Date;
  log?: (line: string) => void;
  fenced?: (connectionId: string) => Promise<boolean>;
  staleAfterMs?: number;
  context?: Context;
}

const latest = (left: string | null, right: string | null): string | null => left === null ? right : right === null ? left : Date.parse(left) > Date.parse(right) ? left : right;
const reports = (event: DiagnosticEvent): boolean => event.event === "desk.adapter.connection_status" || (event.event === "desk.adapter.operation_state" && event.state === "succeeded");

function observe(status: ConnectionStatus, event: DiagnosticEvent): ConnectionStatus {
  const next = { ...status, lastAttemptAt: latest(status.lastAttemptAt, event.at) };
  if (event.event === "desk.adapter.connection_status") return { ...next, state: event.state, reason: event.errorCode ?? null };
  if (event.event === "desk.adapter.trigger_fired" && event.state === "fenced") return { ...next, state: "fenced", reason: event.errorCode };
  if (event.event === "desk.adapter.operation_state" && event.state === "succeeded") return next.state === "fenced" ? { ...next, lastSuccessAt: latest(next.lastSuccessAt, event.at) } : { ...next, lastSuccessAt: latest(next.lastSuccessAt, event.at), state: "available", reason: null };
  return next;
}

const issueReport = (error: z.ZodError): string => error.issues.map(issue => `${issue.code}@${issue.path.join(".") || "event"}`).join(",");

export class AdapterDiagnostics implements ConnectionStatusReader {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly staleAfterMs: number;
  private readonly context: Context;

  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly options: AdapterDiagnosticsOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (line => { console.error(line); });
    this.staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
    this.context = options.context ?? BACKGROUND_CONTEXT;
  }

  async record(raw: unknown): Promise<DiagnosticOutcome> {
    const candidate = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...raw, at: (raw as { at?: unknown }).at ?? this.now().toISOString() } : raw;
    const parsed = DiagnosticEventSchema.safeParse(candidate);
    if (!parsed.success) {
      this.log(`desk-adapter-diagnostics: refused ${issueReport(parsed.error)}`);
      return { stored: false, code: "invalid_event" };
    }
    const event = parsed.data;
    try {
      await this.engine.commit(async tx => {
        const doc = await tx.doc(DiagnosticsDoc, event.connectionId, event.connectionId);
        const current = doc.record ? ConnectionRecordSchema.parse(doc.record) : EMPTY_RECORD;
        const next: ConnectionRecord = { reported: current.reported || reports(event), status: observe(current.status, event), events: [...current.events, event].slice(-ADAPTER_EVENT_CAPACITY) };
        doc.record = JSON.parse(JSON.stringify(next)) as JsonObject;
      }, this.context);
      return { stored: true, event };
    } catch (error) {
      this.log(`desk-adapter-diagnostics: event not stored: ${error instanceof Error ? error.message : String(error)}`);
      return { stored: false, code: "store_failed" };
    }
  }

  async events(connectionId: string): Promise<DiagnosticEvent[]> {
    return (await this.load(connectionId))?.events.map(event => ({ ...event })) ?? [];
  }

  async status(connectionId: string, fallback?: ConnectionStatus): Promise<ConnectionStatus> {
    return this.compose(connectionId, await this.load(connectionId), fallback);
  }

  private async compose(connectionId: string, record: ConnectionRecord | null, fallback?: ConnectionStatus): Promise<ConnectionStatus> {
    const base = record?.reported ? record.status : fallback === undefined ? record?.status ?? EMPTY_STATUS : {
      ...fallback,
      lastSuccessAt: latest(fallback.lastSuccessAt, record?.status.lastSuccessAt ?? null),
      lastAttemptAt: latest(fallback.lastAttemptAt, record?.status.lastAttemptAt ?? null),
    };
    if (await this.options.fenced?.(connectionId)) return { ...base, state: "fenced", reason: base.state === "fenced" && base.reason !== null ? base.reason : "binding_fenced" };
    if (base.state === "available" && base.lastSuccessAt !== null && this.now().getTime() - Date.parse(base.lastSuccessAt) > this.staleAfterMs) return { ...base, state: "stale", reason: "last_success_too_old" };
    return base;
  }

  private async load(connectionId: string): Promise<ConnectionRecord | null> {
    const doc = await this.engine.snapshot(DiagnosticsDoc, connectionId, this.context);
    return doc?.record ? ConnectionRecordSchema.parse(doc.record) : null;
  }
}
