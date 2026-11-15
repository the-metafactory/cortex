import { z } from "zod";
import type { DeskAdapterConnection, DeskMailExecutionBridge, DeskMailExecutionMethod, DeskMailOperationContext } from "../../desk-sdk";
import { replySubject } from "./mail/reply-subject";
import { unsubscribeMethod } from "../../surface/mc/desk/mail-unsubscribe";
import { admittedCallKey, admittedDispatch, admittedLookup, connectionKey, DeskBackendUnavailableError } from "./package-backend";
import { mailBindingFor } from "./mail-read";
import type { MailExecutionConnections } from "./mail-execution-source";
import type { OperationJournalStore } from "./operations/journal";
import type { MailConnectionBinding, MailReadSource } from "./mail-read-source";
import { ownerResultKit } from "./operations/owner-results";
import type { LookupRequest } from "./operations/types";
import { canonicalWire, snapshotDigest } from "./operations/validation";

export interface MailExecutionSource extends MailExecutionConnections {
  journal(): OperationJournalStore;
}

const MAIL_EXECUTION_METHODS: readonly DeskMailExecutionMethod[] = ["draft", "lookup", "move", "restore", "lookupMove", "unsubscribe", "lookupUnsubscribe"];

const METHODS: Record<string, readonly DeskMailExecutionMethod[]> = {
  "mail.reply-draft.create": ["draft", "lookup"],
  "mail.move": ["move", "lookupMove"],
  "mail.trash": ["move", "lookupMove"],
  "mail.restore": ["restore", "lookupMove"],
  "mail.unsubscribe": ["unsubscribe", "lookupUnsubscribe"],
};
const LOOKUPS = new Set<DeskMailExecutionMethod>(["lookup", "lookupMove", "lookupUnsubscribe"]);
const REQUIRED: Record<string, readonly DeskMailExecutionMethod[]> = {
  ...METHODS,
  "mail.move": ["move", "restore", "lookupMove"],
  "mail.trash": ["move", "restore", "lookupMove"],
};
const nativeBase = { version: z.literal(1), requestId: z.string().regex(/^[A-Za-z0-9._:@-]{1,200}$/), account: z.string().min(1), messageId: z.string().min(1) };
const nativeContext = z.object({ operationId: z.string().min(1), attemptId: z.string().min(1), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const NATIVE_INPUT: Record<string, z.ZodType> = {
  draft: z.object({ ...nativeBase, recipient: z.string().min(1), subject: z.string().min(1), body: z.string() }).strict(),
  move: z.object({ ...nativeBase, context: nativeContext, action: z.enum(["move", "trash"]), target: z.enum(["archive", "junk", "trash"]) }).strict(),
  restore: z.object({ ...nativeBase, context: nativeContext, action: z.literal("restore"), from: z.string().min(1) }).strict(),
  unsubscribe: z.object({ ...nativeBase, context: nativeContext }).strict(),
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code: string, message: string): never => { throw new DeskBackendUnavailableError({ code, message }); };

export function mailExecutionBridge(source: MailReadSource | undefined, execution: MailExecutionSource | undefined, adapterId: string, published: () => boolean): DeskMailExecutionBridge {
  const bindingOf = (connection: DeskAdapterConnection): MailConnectionBinding => {
    if (!published()) return fail("adapter_unavailable", "This adapter generation is not published.");
    const binding = source ? mailBindingFor(source, adapterId, connection) : null;
    if (!binding) return fail("mail_execution_unavailable", "This connection has no host-selected Mail binding.");
    return binding;
  };
  const admitted = (connection: DeskAdapterConnection): void => {
    bindingOf(connection);
    if (admittedCallKey() !== connectionKey(connection) || (!admittedDispatch() && !admittedLookup())) fail("mail_execution_unadmitted", "Mail execution requires the current admitted dispatch or historical lookup.");
  };
  const scoped = (context: DeskMailOperationContext, connection: DeskAdapterConnection): MailConnectionBinding => {
    admitted(connection);
    const binding = bindingOf(connection);
    const snapshot = context.snapshot;
    const target = snapshot.target;
    if (snapshot.adapterId !== connection.adapterId || snapshot.connectionId !== connection.connectionId || !METHODS[snapshot.capabilityId] || snapshotDigest(snapshot) !== snapshot.digest) return fail("mail_execution_scope", "The approved operation does not belong to this Mail connection.");
    if (target?.adapterId !== connection.adapterId || target.connectionId !== connection.connectionId || target.objectType !== "message" || !record(snapshot.input) || canonicalWire(snapshot.input.message) !== canonicalWire(target)) return fail("mail_execution_scope", "The approved message target does not match its input.");
    const [destination] = snapshot.destinations;
    if (snapshot.destinations.length !== 1 || destination?.adapterId !== connection.adapterId || destination.connectionId !== connection.connectionId || destination.objectType !== "account" || destination.canonicalId !== binding.account) return fail("mail_execution_scope", "The approved account does not match the host binding.");
    return binding;
  };
  const lookupContext = async (connection: DeskAdapterConnection, request: LookupRequest): Promise<DeskMailOperationContext> => {
    admitted(connection);
    const actual = admittedLookup();
    if (!actual || canonicalWire(actual) !== canonicalWire(request)) return fail("mail_execution_unadmitted", "Historical context requires the exact lookup the Cortex runtime admitted.");
    if (!execution) return fail("mail_execution_unavailable", "The host supplies no Mail execution provider.");
    const found = await ownerResultKit("mail").approvedForLookup(execution.journal(), request, new Date().toISOString(), "Mail");
    if ("reply" in found) return fail("mail_execution_context", "The original Mail operation is unavailable.");
    const snapshot = found.stored.journal.snapshot;
    if ("kind" in snapshot) return fail("mail_execution_context", "The original Mail snapshot is unavailable.");
    const context = { operationId: request.operationId, attemptId: found.attempt.attemptId, ownerRequestId: request.ownerRequestId, snapshotDigest: snapshot.digest, snapshot };
    scoped(context, connection);
    if (canonicalWire(admittedLookup()) !== canonicalWire(request)) return fail("mail_execution_unadmitted", "The historical lookup has finished.");
    return structuredClone(context);
  };
  const contextOf = async (connection: DeskAdapterConnection): Promise<DeskMailOperationContext> => {
    admitted(connection);
    const dispatch = admittedDispatch();
    if (dispatch) return { operationId: dispatch.operationId, attemptId: dispatch.attemptId, ownerRequestId: dispatch.ownerRequestId, snapshotDigest: dispatch.snapshot.digest, snapshot: dispatch.snapshot };
    const lookup = admittedLookup();
    if (!lookup) return fail("mail_execution_unadmitted", "The Mail call has finished.");
    return lookupContext(connection, lookup);
  };
  return {
    connection(connection) {
      const binding = bindingOf(connection);
      const provider = execution?.connection(binding);
      return provider?.version === 1 ? { version: provider.version, methods: MAIL_EXECUTION_METHODS.filter(method => typeof provider[method] === "function") } : null;
    },
    lookupContext,
    async invoke(connection, method, raw) {
      const context = await contextOf(connection);
      const binding = scoped(context, connection);
      const provider = execution?.connection(binding);
      if (provider?.version !== 1 || !MAIL_EXECUTION_METHODS.includes(method) || typeof provider[method] !== "function") return fail("mail_execution_unavailable", "The versioned Mail connection does not offer this method.");
      const invoke = provider[method];
      const snapshot = context.snapshot;
      if (!METHODS[snapshot.capabilityId]?.includes(method)) return fail("mail_execution_scope", "The method does not belong to this approved capability.");
      if (REQUIRED[snapshot.capabilityId]?.some(required => typeof provider[required] !== "function")) return fail("mail_execution_unavailable", "The connection does not provide this action's recovery and restoration methods.");
      const parsed = (LOOKUPS.has(method) ? z.string() : NATIVE_INPUT[method])?.safeParse(raw);
      if (!parsed?.success) return fail("mail_execution_scope", "The native request does not match its closed protocol shape.");
      const input = parsed.data;
      const requestId = `${snapshot.capabilityId}:${context.ownerRequestId}`;
      if (LOOKUPS.has(method)) {
        if (input !== requestId) return fail("mail_execution_scope", "The lookup belongs to another owner request.");
      } else {
        if (!admittedDispatch() || !record(input) || input.version !== 1 || input.requestId !== requestId || input.account !== binding.account || input.messageId !== snapshot.target?.canonicalId) return fail("mail_execution_scope", "The provider call does not match the approved message and account.");
        const original = snapshot.input;
        if (!record(original)) return fail("mail_execution_scope", "The approved Mail input is invalid.");
        if (method === "draft") {
          const mail = source?.listings().find(listing => listing.id === binding.sourceId)?.mail.find(item => item.id === input.messageId && item.account === binding.account);
          if (!mail || input.recipient !== mail.from.address || input.subject !== replySubject(mail.subject) || input.body !== original.body) return fail("mail_execution_scope", "The draft must keep the approved body and the listed recipient and subject.");
        } else {
          const expected = { operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest };
          if (canonicalWire(input.context) !== canonicalWire(expected)) return fail("mail_execution_scope", "The provider call does not match the approved attempt.");
          if (method === "move" && (input.action !== (snapshot.capabilityId === "mail.trash" ? "trash" : "move") || input.target !== (snapshot.capabilityId === "mail.trash" ? "trash" : original.target))) return fail("mail_execution_scope", "The move destination differs from the approved action.");
          if (method === "restore" && (input.action !== "restore" || input.from !== original.from)) return fail("mail_execution_scope", "The restore precondition differs from the approved location.");
          if (method === "unsubscribe") {
            const mail = source?.listings().find(listing => listing.id === binding.sourceId)?.mail.find(item => item.id === input.messageId && item.account === binding.account);
            if (unsubscribeMethod(mail?.headers)?.kind !== "one-click") return fail("mail_execution_unavailable", "This listed message does not offer one-click unsubscribe.");
          }
        }
      }
      admitted(connection);
      const value = z.json().parse(await invoke.call(provider, structuredClone(input)));
      if (record(value) && typeof value.account === "string" && value.account !== binding.account) return fail("mail_execution_scope", "The provider result belongs to another account.");
      if (method === "lookupMove" && record(value) && value.status === "found") {
        const original = value.request;
        const expected = { operationId: context.operationId, attemptId: context.attemptId, snapshotDigest: context.snapshotDigest };
        if (!record(original) || typeof original.action !== "string" || original.requestId !== requestId || original.account !== binding.account || original.messageId !== snapshot.target?.canonicalId || `mail.${original.action}` !== snapshot.capabilityId || canonicalWire(original.context) !== canonicalWire(expected)) return fail("mail_execution_scope", "The historical move result belongs to another approved attempt.");
      }
      return value;
    },
  };
}
