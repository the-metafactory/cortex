import { randomUUID } from "node:crypto";
import type { TrustedConnector } from "../../conversations/authority";
import type { DeskAdapterPackage } from "../../conversations/domain-adapters/package";
import { validateObservationBatch } from "../../conversations/domain-adapters/reads/observation-types";
import { validateQueryPage } from "../../conversations/domain-adapters/reads/query-validation";
import { QueryPageSchema, type QueryResult, type QuerySource } from "../../conversations/domain-adapters/reads/query-types";
import type { ReadBinding } from "../../conversations/domain-adapters/reads/types";
import type { DomainAdapterRegistry } from "../../conversations/domain-adapters/registry";
import type { ObjectReference } from "../../conversations/domain-adapters/types";
import type { Recorded } from "./connectors";
import { conformant, refused, refusedBy, type CapabilityReport } from "./report";
import type { ConformanceRig } from "./rig";
import { sampleValue, schemaUrn, type SampleContext } from "./sample";

const MAX_PAGES = 8;

export interface ProbeEnv {
  rig: ConformanceRig;
  manifest: DeskAdapterPackage;
  sample: SampleContext;
  recorded: Recorded;
  plain: TrustedConnector;
  adapterId: string;
  connectionId: string;
}

export function schemaIndex(manifest: DeskAdapterPackage): Map<string, unknown> {
  return new Map(manifest.declaration.schemas.map(schema => [schemaUrn(schema.schemaId, schema.version), schema.schema]));
}

function inputFor(env: Pick<ProbeEnv, "sample">, binding: ReadBinding): unknown {
  return sampleValue(env.sample.schemas.get(schemaUrn(binding.inputSchemaRef.schemaId, binding.inputSchemaRef.version)), env.sample);
}

function sourceFor(env: ProbeEnv, binding: ReadBinding): QuerySource {
  return {
    adapterId: env.adapterId, connectionId: env.connectionId, capabilityId: binding.capabilityId, inputSchemaRef: binding.inputSchemaRef,
    destinations: [...env.sample.destinations], input: inputFor(env, binding) as QuerySource["input"],
  };
}

const firstLine = (text: string): string => (text.split("\n")[0] ?? text).slice(0, 200);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "The package call failed.");

export type DestinationEnv = Pick<ProbeEnv, "manifest" | "sample" | "plain" | "adapterId" | "connectionId"> & { registry: DomainAdapterRegistry };

export async function listDestinations(env: DestinationEnv): Promise<{ destinations: ObjectReference[]; reports: CapabilityReport[] }> {
  const destinations: ObjectReference[] = [];
  const reports: CapabilityReport[] = [];
  for (const binding of env.manifest.readBindings.filter(item => item.mode === "destinations")) {
    const id = binding.capabilityId;
    const seed: ObjectReference = { adapterId: env.adapterId, connectionId: env.connectionId, objectType: binding.objectType, canonicalId: "root" };
    if (!env.plain.query) {
      reports.push(refused(id, "destinations", "query_unavailable", "The package supplies no query call for its destinations listing."));
      continue;
    }
    let raw: unknown;
    try {
      raw = await env.plain.query({ readVersion: "1.0.0", queryId: randomUUID(), capabilityId: id, input: inputFor(env, binding) as QuerySource["input"], destinations: [seed], limit: 20 }, new AbortController().signal);
    } catch (error) {
      reports.push(refused(id, "destinations", "invalid_query_page", firstLine(messageOf(error))));
      continue;
    }
    const page = QueryPageSchema.safeParse(raw);
    const listed = page.success ? page.data.annotations.map(annotation => annotation.ref) : [];
    const foreign = listed.some(ref => ref.adapterId !== env.adapterId || ref.connectionId !== env.connectionId);
    if (!page.success || foreign || listed.length === 0 || !env.registry.validateOutput(id, page.data.payload).ok) {
      reports.push(refused(id, "destinations", foreign ? "invalid_destination" : "invalid_query_page", "The destinations listing is empty, malformed or names another adapter or connection."));
      continue;
    }
    destinations.push(...listed);
    reports.push(conformant(id, "destinations", `${listed.length} destination(s) listed`));
  }
  return { destinations, reports };
}

function queryRefusal(env: ProbeEnv, binding: ReadBinding, source: QuerySource, result: QueryResult | undefined): { code: string; detail: string } {
  const entry = env.recorded.queries.filter(item => item.request.capabilityId === binding.capabilityId).at(-1);
  if (entry?.failure !== undefined) return { code: "invalid_query_page", detail: firstLine(entry.failure) };
  if (entry?.raw !== undefined) {
    try {
      validateQueryPage(env.rig.registry, binding, { queryId: entry.request.queryId, source, head: "", limit: entry.request.limit, seen: {} }, entry.raw);
    } catch (error) {
      return { code: messageOf(error), detail: "The host refused the page the package returned." };
    }
  }
  const group = result?.groups.find(item => item.status !== "ok");
  return { code: group?.reason?.code ?? result?.reason?.code ?? result?.status ?? "query_refused", detail: "The host withheld the read." };
}

export async function probeQuery(env: ProbeEnv, binding: ReadBinding): Promise<CapabilityReport> {
  const id = binding.capabilityId;
  const { rig } = env;
  if (env.sample.destinations.length === 0) return refused(id, "query", "no_destination", "No destination could be listed, so no read is admitted.");
  const source = sourceFor(env, binding);
  const runner = rig.host.readQueries(rig.registry, rig.bindings);
  const before = rig.sends.length;
  try {
    let request = await runner.create(rig.context, [source], rig.sink);
    let pages = 0;
    for (;;) {
      const result = await runner.run(rig.context, request, rig.sink);
      pages++;
      const clean = !result.restartRequired && result.groups.length > 0 && result.groups.every(group => group.status === "ok");
      if (!clean) return refusedBy(id, "query", queryRefusal(env, binding, source, result));
      if (result.continuation === undefined || pages >= MAX_PAGES) break;
      request = { ...request, continuation: result.continuation };
    }
    return conformant(id, "query", `${pages} page(s), ${rig.sends.length - before} release(s)`, rig.sends.length - before);
  } catch (error) {
    return refused(id, "query", "query_failed", firstLine(messageOf(error)));
  } finally {
    runner.close();
  }
}

function observationRefusal(env: ProbeEnv, binding: ReadBinding, source: QuerySource): { code: string; detail: string } {
  const entry = env.recorded.observations.filter(item => item.request.source.capabilityId === binding.capabilityId).at(-1);
  if (entry?.failure !== undefined) return { code: "invalid_observation", detail: firstLine(entry.failure) };
  if (entry?.raw !== undefined) {
    try {
      validateObservationBatch(env.rig.registry, binding, source, entry.raw);
    } catch (error) {
      return { code: messageOf(error), detail: "The host refused the batch the package returned." };
    }
  }
  return { code: "observation_refused", detail: "The host withheld the observation." };
}

export async function probeObservation(env: ProbeEnv, binding: ReadBinding): Promise<CapabilityReport> {
  const id = binding.capabilityId;
  const { rig } = env;
  if (env.sample.destinations.length === 0) return refused(id, "observation", "no_destination", "No destination could be listed, so no read is admitted.");
  const source = sourceFor(env, binding);
  const store = rig.host.readObservations(rig.registry, rig.bindings);
  const before = rig.sends.length;
  try {
    const checked = await store.check(rig.context, source, rig.sink, "poll");
    if (checked.status !== "ok") return refusedBy(id, "observation", observationRefusal(env, binding, source));
    const released = await store.read(rig.context, source, rig.sink);
    if (released.kind !== "released") return refused(id, "observation", released.reason.code, "The host withheld the stored observations.");
    return conformant(id, "observation", `${checked.changed} change(s), ${rig.sends.length - before} release(s)`, rig.sends.length - before);
  } catch (error) {
    return refused(id, "observation", "observation_failed", firstLine(messageOf(error)));
  }
}
