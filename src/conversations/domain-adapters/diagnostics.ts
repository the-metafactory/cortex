import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";
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

const ConnectionRecordSchema = z.object({ status: ConnectionStatusSchema, events: z.array(DiagnosticEventSchema) }).strict();
const StateSchema = z.object({ version: z.literal(1), connections: z.record(z.string(), ConnectionRecordSchema) }).strict();
type DiagnosticState = z.infer<typeof StateSchema>;

const EMPTY_STATUS: ConnectionStatus = { state: "unavailable", lastSuccessAt: null, lastAttemptAt: null, reason: "not_reported" };
const DiagnosticsDoc = defineDoc<{ state: JsonObject }>({ kind: "cortex.desk-adapter-diagnostics", version: 1, scope: "session", initial: () => ({ state: { version: 1, connections: {} } }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50 });

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

const later = (left: string | null, right: string): string => left !== null && Date.parse(left) > Date.parse(right) ? left : right;
const allow = (status: ConnectionStatus, event: DiagnosticEvent): ConnectionStatus => ({ ...status, lastAttemptAt: later(status.lastAttemptAt, event.at) });

function observe(status: ConnectionStatus, event: DiagnosticEvent): ConnectionStatus {
  const next = allow(status, event);
  if (event.event === "desk.adapter.connection_status") return { ...next, state: event.state, reason: event.errorCode ?? null };
  if (event.event === "desk.adapter.trigger_fired" && event.state === "fenced") return { ...next, state: "fenced", reason: event.errorCode };
  if (event.event === "desk.adapter.operation_state" && event.state === "succeeded") return next.state === "fenced" ? { ...next, lastSuccessAt: later(next.lastSuccessAt, event.at) } : { ...next, lastSuccessAt: later(next.lastSuccessAt, event.at), state: "available", reason: null };
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
      await this.mutate(state => {
        const current = state.connections[event.connectionId] ?? { status: EMPTY_STATUS, events: [] };
        const kept = [...current.events, event].slice(-ADAPTER_EVENT_CAPACITY);
        state.connections[event.connectionId] = { status: observe(current.status, event), events: kept };
      });
      return { stored: true, event };
    } catch (error) {
      this.log(`desk-adapter-diagnostics: event not stored: ${error instanceof Error ? error.message : String(error)}`);
      return { stored: false, code: "store_failed" };
    }
  }

  async events(connectionId: string): Promise<DiagnosticEvent[]> {
    return (await this.load()).connections[connectionId]?.events.map(event => ({ ...event })) ?? [];
  }

  async status(connectionId: string, fallback?: ConnectionStatus): Promise<ConnectionStatus> {
    const stored = (await this.load()).connections[connectionId]?.status;
    const base = stored ?? fallback ?? EMPTY_STATUS;
    if (await this.options.fenced?.(connectionId)) return { ...base, state: "fenced", reason: base.state === "fenced" && base.reason !== null ? base.reason : "binding_fenced" };
    if (base.state === "available" && base.lastSuccessAt !== null && this.now().getTime() - Date.parse(base.lastSuccessAt) > this.staleAfterMs) return { ...base, state: "stale", reason: "last_success_too_old" };
    return base;
  }

  private async load(): Promise<DiagnosticState> {
    const doc = await this.engine.snapshot(DiagnosticsDoc, this.context);
    return StateSchema.parse(doc?.state ?? { version: 1, connections: {} });
  }

  private async mutate(change: (state: DiagnosticState) => void): Promise<void> {
    await this.engine.commit(async tx => {
      const doc = await tx.doc(DiagnosticsDoc);
      const state = StateSchema.parse(doc.state);
      change(state);
      doc.state = JSON.parse(JSON.stringify(StateSchema.parse(state))) as JsonObject;
    }, this.context);
  }
}
