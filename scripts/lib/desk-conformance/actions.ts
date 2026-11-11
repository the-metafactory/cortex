import { randomUUID } from "node:crypto";
import { DraftingBindings, type DestinationMatch, type DraftModel, type DraftPolicy, type DraftSources, type ModelRequest } from "../../../src/conversations/domain-adapters/drafting";
import { snapshotDigest } from "../../../src/conversations/domain-adapters/operations/validation";
import { ObjectReadbackSchema, type ApprovedSnapshot, type DispatchRequest, type Json } from "../../../src/conversations/domain-adapters/operations/types";
import type { DispatchOutcome, OperationBridge } from "../../../src/conversations/domain-adapters/operations/dispatch";
import type { DraftingView } from "../../../src/conversations/domain-adapters/registry";
import { ObjectReferenceSchema, type ObjectReference } from "../../../src/conversations/domain-adapters/types";
import { conformant, refused, type CapabilityReport } from "./report";
import { sampleValue } from "./sample";
import type { ProbeEnv } from "./probes";
import { STACK } from "./rig";

const CONVERSATION_TEXT = "Conformance probe: record one new item for the connected adapter.";
const PROPOSAL = "conformance-proposal";
const TURN = "conformance-turn";
const AT = () => new Date().toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message.slice(0, 200) : "The call failed.");

export interface Prepared { input: Json; destinations: ObjectReference[]; view: DraftingView }
export type Preparation = { ok: true; value: Prepared; report?: CapabilityReport } | { ok: false; report: CapabilityReport };

function referencesAt(view: DraftingView, input: Json): ObjectReference[] {
  const record = isRecord(input) ? input : {};
  return view.relationships.flatMap(relationship => [record[relationship.fieldPath.slice(1)]].flat()).flatMap(value => {
    const parsed = ObjectReferenceSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function syntheticModel(env: ProbeEnv): DraftModel {
  return {
    lanes: () => Promise.resolve(["local"] as const),
    generate: (request: ModelRequest) => {
      const properties = isRecord(request.schema) && isRecord((request.schema as Record<string, unknown>).properties) ? (request.schema as { properties: Record<string, unknown> }).properties : {};
      const required = isRecord(request.schema) && Array.isArray((request.schema as Record<string, unknown>).required) ? (request.schema as { required: string[] }).required : [];
      const roles = new Map(request.fieldHints.map(hint => [hint.pointer, hint.role]));
      const wanted = request.targets.filter(pointer => roles.has(pointer) || required.includes(pointer.slice(1)));
      const fields = wanted.map(pointer => roles.get(pointer) === "destination"
        ? { pointer, labels: ["conformance destination"], citations: [TURN] }
        : { pointer, value: sampleValue(properties[pointer.slice(1)], env.sample), citations: [TURN] });
      return Promise.resolve({ modelId: "conformance-model", output: { fields } });
    },
  };
}

function destinationResolver(env: ProbeEnv) {
  return {
    resolve: ({ objectType }: { objectType?: string }): Promise<DestinationMatch> => {
      const match = env.sample.destinations.find(ref => objectType === undefined || ref.objectType === objectType);
      return Promise.resolve(match ? { kind: "unique", ref: match } : { kind: "none" });
    },
  };
}

/** Drafts the probe input for one action capability, through the drafting binding when the package declares one. */
export async function prepareAction(env: ProbeEnv, capabilityId: string, view: DraftingView): Promise<Preparation> {
  const { rig, manifest } = env;
  const binding = manifest.draftingBindings.find(item => item.capabilityId === capabilityId);
  if (!binding) {
    const input = sampleValue(env.sample.schemas.get(`urn:desk-schema:${view.inputSchemaRef.schemaId}:${view.inputSchemaRef.version}`), env.sample) as Json;
    return { ok: true, value: { input, destinations: referencesAt(view, input), view } };
  }
  const bindings = new DraftingBindings(rig.registry);
  const registered = bindings.register(binding);
  if (!registered.ok) return { ok: false, report: refused(capabilityId, "draft", registered.error.code, registered.error.message) };
  const sources: DraftSources = {
    capture: ({ entryId }) => Promise.resolve({ boundary: { entryId, revision: "1" }, items: [{ id: TURN, kind: "turn", revision: "1", digest: "turn-digest", restriction: "cloud", text: CONVERSATION_TEXT, at: AT() }], unavailable: 0 }),
    head: () => Promise.resolve("1"),
  };
  const policy: DraftPolicy = { revision: () => Promise.resolve("policy-1"), readable: () => Promise.resolve(true), releasable: () => Promise.resolve(true) };
  const service = rig.host.drafts({ registry: rig.registry, bindings, sources, policy, model: syntheticModel(env), destinations: destinationResolver(env) });
  try {
    const made = await service.make({ conversationId: rig.conversationId, entryId: TURN, capabilityId, connectionId: env.connectionId });
    if (made.kind !== "draft") return { ok: false, report: refused(capabilityId, "draft", "draft_ambiguous", "The draft service asked to choose between existing drafts.") };
    const handoff = await service.handoff(made.view.draft.draftId, made.view.draft.revision);
    if (!handoff.ok) {
      const why = handoff.blocking[0]?.code ?? handoff.outdated[0] ?? "draft_blocked";
      return { ok: false, report: refused(capabilityId, "draft", why, `The drafting binding left ${handoff.blocking.length} field(s) blocking confirmation.`) };
    }
    const input = handoff.handoff.input as Json;
    return { ok: true, value: { input, destinations: handoff.handoff.destinations, view }, report: conformant(capabilityId, "draft", `drafted ${Object.keys(isRecord(input) ? input : {}).length} field(s) from the drafting binding`) };
  } catch (error) {
    return { ok: false, report: refused(capabilityId, "draft", "draft_failed", messageOf(error)) };
  }
}

/** Builds the approved snapshot the Cortex runtime confirms, from the capability view and the prepared input. */
export function snapshotForAction(env: ProbeEnv, capabilityId: string, prepared: Prepared): ApprovedSnapshot {
  const { view } = prepared;
  const body = {
    provenance: { conversationId: env.rig.conversationId, proposalId: PROPOSAL, revision: 1, entryId: null, link: `?desk=conversation&conversation=${env.rig.conversationId}` },
    adapterId: env.adapterId, connectionId: env.connectionId, capabilityId,
    inputSchemaRef: view.inputSchemaRef, outputSchemaRef: view.outputSchemaRef, errorSchemaRef: view.errorSchemaRef,
    input: prepared.input, destinations: prepared.destinations, sources: [], policy: "local" as const,
  };
  return { ...body, digest: snapshotDigest(body) };
}

function createdRef(raw: unknown): ObjectReference | null {
  const result = isRecord(raw) && isRecord(raw.result) && isRecord(raw.result.evidence) ? raw.result.evidence.refs : undefined;
  const parsed = ObjectReferenceSchema.safeParse(Array.isArray(result) ? result[0] : undefined);
  return parsed.success ? parsed.data : null;
}

async function authorizeRead(env: ProbeEnv, ref: ObjectReference): Promise<void> {
  const { rig } = env;
  const connection = rig.connection;
  const revision = Number(connection.connectionRevision);
  connection.connectionRevision = String(revision + 1);
  connection.readDestinations = [...connection.readDestinations, ref];
  await rig.service.publishHostRecord({ kind: "connection", value: connection }, revision);
  await rig.service.publishHostRecord({
    kind: "restriction",
    value: { version: 1, status: "active", restrictionRef: randomUUID(), source: ref, ownerRevision: "conformance-owner-1", decisionRef: "conformance-provenance", audiences: ["web", "discord", "model", "view"], egress: "cloud", readScope: [connection.principalRef], resolverBinding: "conformance-restriction-resolver", revision: "1" },
  }, 0);
}

/** Reads the created object back through the Cortex runtime readback and the released Render target. */
export async function probeReadback(env: ProbeEnv, capabilityId: string, ref: ObjectReference | null): Promise<CapabilityReport> {
  const { rig } = env;
  const target = env.plain.readbackCapabilityId ?? capabilityId;
  if (!env.plain.readback) return refused(target, "readback", "readback_unavailable", "The package supplies no readback call for its action.");
  if (!ref) return refused(target, "readback", "no_created_object", "The owner result named no created object to read back.");
  try {
    await authorizeRead(env, ref);
    const projection = await rig.service.readback(rig.context, { lifecycleVersion: "1.0.0", ref }, rig.sink);
    if (projection.kind !== "released") return refused(target, "readback", projection.reason.code, "The host withheld the readback.");
    const readback = ObjectReadbackSchema.safeParse(projection.value);
    if (!readback.success || readback.data.result.kind !== "present") return refused(target, "readback", readback.success ? `readback_${readback.data.result.kind}` : "invalid_readback", "The owner did not return the created object as present.");
    return conformant(target, "readback", `read back ${ref.objectType} ${ref.canonicalId}`, 1);
  } catch (error) {
    return refused(target, "readback", "readback_failed", messageOf(error));
  }
}

export interface DispatchRun {
  operationId: string;
  bridge: OperationBridge;
  outcome?: DispatchOutcome;
  request?: DispatchRequest;
}

export type DispatchAttempt = { run: DispatchRun; report: CapabilityReport; ref: ObjectReference | null };

/** Confirms the snapshot, activates the writer bridge and makes exactly one dispatch call for it. */
export async function confirmAndDispatch(env: ProbeEnv, capabilityId: string, snapshot: ApprovedSnapshot, waitMs = 10_000): Promise<DispatchAttempt> {
  const { rig } = env;
  const operationId = `${rig.conversationId}:${PROPOSAL}:1`;
  const confirmed = await rig.service.confirm(rig.context, { operationId, idempotencyKey: operationId, ownerRequestId: "conformance-request", snapshot });
  const bridge = rig.host.lifecycleBridge(rig.registry, rig.bindings, () => env.plain.support, waitMs);
  const run: DispatchRun = { operationId, bridge };
  if (confirmed.kind !== "allowed") return { run, report: refused(capabilityId, "action", confirmed.reason.code, "The host did not allow the confirmation."), ref: null };
  const binding = { stack: STACK, owner: env.plain.writerOwner, adapterId: env.adapterId, connectionId: env.connectionId, capabilityId };
  if (!await bridge.activate(binding, rig.lease)) return { run, report: refused(capabilityId, "action", "writer_inactive", "The host did not activate the dispatch bridge."), ref: null };
  const outcome = await bridge.dispatch(rig.context, operationId, rig.lease);
  if (outcome.kind !== "timed-out") await bridge.settled();
  run.outcome = outcome;
  const state = outcome.kind === "refused" ? outcome.reason.code : outcome.operation.journal.state;
  if (outcome.kind !== "settled" || state !== "succeeded") return { run, report: refused(capabilityId, "action", state, `The confirmed dispatch ended as ${outcome.kind}.`), ref: null };
  return { run, report: conformant(capabilityId, "action", "confirmed dispatch succeeded with owner evidence", 0), ref: createdRef(env.recorded.dispatches.at(-1)) };
}

export async function probeAction(env: ProbeEnv, capabilityId: string): Promise<CapabilityReport[]> {
  const view = env.rig.registry.draftingView(capabilityId);
  if (!view) return [refused(capabilityId, "action", "capability_unknown", "The registry does not describe this action capability.")];
  const prepared = await prepareAction(env, capabilityId, view);
  const reports: CapabilityReport[] = prepared.report ? [prepared.report] : [];
  if (!prepared.ok) return reports;
  try {
    const dispatched = await confirmAndDispatch(env, capabilityId, snapshotForAction(env, capabilityId, prepared.value));
    reports.push(dispatched.report);
    if (dispatched.report.verdict === "conformant") reports.push(await probeReadback(env, capabilityId, dispatched.ref));
  } catch (error) {
    reports.push(refused(capabilityId, "action", "dispatch_failed", messageOf(error)));
  }
  return reports;
}
