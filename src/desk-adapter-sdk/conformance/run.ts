import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { DeskPackageLoader, type DeskPackageCandidate, type DeskTrustedConnectorOptions } from "../../conversations/domain-adapters/package";
import { DeskGenerationStore } from "../../conversations/domain-adapters/package-generation";
import type { MailConnectionBinding, MailReadSource } from "../../conversations/domain-adapters/mail-read";
import type { ObjectReference } from "../../conversations/domain-adapters/types";
import type { TrustedConnector } from "../../conversations/authority";
import { probeAction } from "./actions";
import { CONFORMANCE_CONNECTION_ID } from "./connection";
import { recordConnector, type Recorded } from "./connectors";
import { listDestinations, probeReads, runQuery, schemaIndex, type ProbeEnv } from "./probes";
import { emptyOwnerCalls, overallVerdict, refused, type CapabilityReport, type ConformanceMailQuery, type ConformanceReport, type OwnerCalls } from "./report";
import { ConformanceRefusal, openConformanceRig, SYNTHETIC_CREDENTIAL_HANDLE, type ConformanceRig } from "./rig";


export const authorizeConnection: DeskTrustedConnectorOptions["authorizeConnection"] = current =>
  Promise.resolve({ version: 1, available: current.status === "active" && current.credentialHandle === SYNTHETIC_CREDENTIAL_HANDLE, revision: "conformance-credential-1" });

export type Skeleton = Pick<ConformanceReport, "packageDir" | "packageId" | "adapterId" | "actions" | "credentialRequests">;
export type Outcome = Omit<ConformanceReport, "networkRequests">;

const addOwnerCalls = (total: OwnerCalls, more: OwnerCalls): void => {
  total.dispatch += more.dispatch;
  total.cancel += more.cancel;
  total.lookup += more.lookup;
  total.readback += more.readback;
};

export function finish(skeleton: Skeleton, capabilities: CapabilityReport[], ownerCalls: OwnerCalls): Outcome {
  return { ...skeleton, ...overallVerdict(capabilities), capabilities, ownerCalls };
}

export function stopped(skeleton: Skeleton, status: "refused" | "not-run", code: string, reason: string): Outcome {
  return { ...skeleton, status, code, reason, capabilities: [], ownerCalls: emptyOwnerCalls() };
}

export async function openConformanceStore(dir: string): Promise<{ engine: Harness; store: DeskGenerationStore }> {
  const engine = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.sqlite")), { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  return { engine, store: new DeskGenerationStore(engine) };
}

// glossary-ignore: run
/** The fake Mail source's one binding for the run's connection and this adapter, if it has exactly one. */
export function conformanceMailBinding(mail: MailReadSource | undefined, adapterId: string): MailConnectionBinding | undefined {
  return mailBindingFor(mail, adapterId, CONFORMANCE_CONNECTION_ID);
}

function mailBindingFor(mail: MailReadSource | undefined, adapterId: string, connectionId: string): MailConnectionBinding | undefined {
  const matches = mail?.connections().filter(binding => binding.adapterId === adapterId && binding.connectionId === connectionId) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

// glossary-ignore: host, run
interface ConnectionSeam { connectionId: string; plain: TrustedConnector; destinations: readonly ObjectReference[]; actionId?: string; mailBinding?: MailConnectionBinding }

async function openConnection(loader: DeskPackageLoader, candidate: DeskPackageCandidate, temp: string, seam: ConnectionSeam): Promise<{ rig: ConformanceRig; recorded: Recorded }> {
  const { adapterId, manifest } = candidate;
  const readIds = manifest.declaration.capabilities.filter(capability => capability.kind !== "action").map(capability => capability.capabilityId);
  const { connector, recorded } = recordConnector(seam.plain);
  const rig = await openConformanceRig({
    dir: temp, registry: loader.registry(), connector, adapterId, connectionId: seam.connectionId, readBindings: manifest.readBindings, readCapabilityIds: readIds,
    writeCapabilityIds: seam.actionId === undefined ? [] : [seam.actionId], writerCapabilityId: seam.actionId ?? seam.plain.support.capabilityId, destinations: seam.destinations,
    ...(seam.mailBinding ? { mailBinding: seam.mailBinding } : {}),
  });
  return { rig, recorded };
}

const refusalOf = (error: unknown): { code: string; detail: string } =>
  ({ code: error instanceof ConformanceRefusal ? error.code : "host_unavailable", detail: error instanceof Error ? error.message : "The host seam could not open." });

const releasedObjects = (pages: readonly unknown[]): unknown[] => pages.flatMap(page => {
  const objects = (page as { objects?: unknown } | null)?.objects;
  return Array.isArray(objects) ? objects.map(object => (object as { value?: unknown } | null)?.value) : [];
});

async function readMailConnection(loader: DeskPackageLoader, candidate: DeskPackageCandidate, temp: string, mailBinding: MailConnectionBinding): Promise<ConformanceMailQuery[]> {
  const { adapterId, manifest } = candidate;
  const { connectionId } = mailBinding;
  const queries = manifest.readBindings.filter(binding => binding.mode === "query");
  const refusedAll = ({ code, detail }: { code: string; detail: string }): ConformanceMailQuery[] =>
    queries.map(binding => ({ connectionId, capabilityId: binding.capabilityId, verdict: "refused", code, detail, pages: [], objects: [] }));
  const built = loader.trustedConnector(adapterId, { adapterId, connectionId }, { authorizeConnection });
  if (!built.ok) return refusedAll({ code: built.error.code, detail: built.error.message });
  const plain = built.value.connector;
  const sample = { schemas: schemaIndex(manifest), destinations: [] as ObjectReference[], adapterId, connectionId };
  sample.destinations.push(...(await listDestinations({ registry: loader.registry(), manifest, sample, plain, adapterId, connectionId })).destinations);
  let opened;
  try {
    opened = await openConnection(loader, candidate, temp, { connectionId, plain, destinations: sample.destinations, mailBinding });
  } catch (error) {
    return refusedAll(refusalOf(error));
  }
  const { rig, recorded } = opened;
  try {
    const env: ProbeEnv = { rig, manifest, sample, recorded, plain, adapterId, connectionId };
    const dataPolicy = rig.restrictions[0]?.egress;
    const answered: ConformanceMailQuery[] = [];
    for (const binding of queries) {
      const { report, pages } = await runQuery(env, binding);
      answered.push({
        connectionId, capabilityId: report.capabilityId, verdict: report.verdict, ...(report.code === undefined ? {} : { code: report.code }), detail: report.detail,
        ...(dataPolicy === undefined ? {} : { dataPolicy }), pages, objects: releasedObjects(pages),
      });
    }
    return answered;
  } finally {
    await rig.close();
  }
}

async function readMailConnections(loader: DeskPackageLoader, candidate: DeskPackageCandidate, temp: string, mail: MailReadSource, outcome: Outcome): Promise<Outcome> {
  const connectionIds = [...new Set(mail.connections().filter(binding => binding.adapterId === candidate.adapterId).map(binding => binding.connectionId))];
  const mailQueries: ConformanceMailQuery[] = [];
  for (const connectionId of connectionIds) {
    const binding = mailBindingFor(mail, candidate.adapterId, connectionId);
    if (binding) mailQueries.push(...await readMailConnection(loader, candidate, temp, binding));
  }
  return { ...outcome, ...overallVerdict([...outcome.capabilities, ...mailQueries]), mailQueries };
}

export async function exercise(loader: DeskPackageLoader, candidate: DeskPackageCandidate, temp: string, skeleton: Skeleton, mail?: MailReadSource): Promise<Outcome> {
  const { adapterId, manifest } = candidate;
  const mailBinding = conformanceMailBinding(mail, adapterId);
  const declaration = manifest.declaration;
  const actionIds = declaration.capabilities.filter(capability => capability.kind === "action").map(capability => capability.capabilityId);
  const registry = loader.registry();
  const capabilities: CapabilityReport[] = [];
  const ownerCalls = emptyOwnerCalls();
  const destinations: ObjectReference[] = [];
  const sample = { schemas: schemaIndex(manifest), destinations, adapterId, connectionId: CONFORMANCE_CONNECTION_ID };
  const groups: (string | undefined)[] = actionIds.length > 0 ? actionIds : [undefined];
  for (const [index, actionId] of groups.entries()) {
    const built = loader.trustedConnector(adapterId, { adapterId, connectionId: CONFORMANCE_CONNECTION_ID }, { authorizeConnection, ...(actionId === undefined ? {} : { actionCapabilityId: actionId }) });
    if (!built.ok) {
      capabilities.push(refused(actionId ?? adapterId, "action", built.error.code, built.error.message));
      continue;
    }
    const plain = built.value.connector;
    if (index === 0) {
      const listed = await listDestinations({ registry, manifest, sample, plain, adapterId, connectionId: CONFORMANCE_CONNECTION_ID });
      destinations.push(...listed.destinations);
      capabilities.push(...listed.reports);
    }
    let opened;
    try {
      opened = await openConnection(loader, candidate, temp, { connectionId: CONFORMANCE_CONNECTION_ID, plain, destinations, ...(actionId === undefined ? {} : { actionId }), ...(mailBinding ? { mailBinding } : {}) });
    } catch (error) {
      const { code, detail } = refusalOf(error);
      capabilities.push(refused(actionId ?? adapterId, "action", code, detail));
      continue;
    }
    const { rig, recorded } = opened;
    const env: ProbeEnv = { rig, manifest, sample, recorded, plain, adapterId, connectionId: CONFORMANCE_CONNECTION_ID };
    try {
      if (index === 0) capabilities.push(...await probeReads(env, mailBinding ? mailBinding.dataPolicy ?? "local" : undefined));
      if (actionId !== undefined) capabilities.push(...await probeAction(env, actionId));
    } finally {
      await rig.close();
      addOwnerCalls(ownerCalls, recorded.ownerCalls);
    }
  }
  return finish({ ...skeleton, actions: actionIds }, capabilities, ownerCalls);
}

export async function executePackage(packageDir: string, temp: string, mail?: MailReadSource): Promise<Outcome> {
  const skeleton: Skeleton = { packageDir, actions: [], credentialRequests: 0 };
  const { engine, store } = await openConformanceStore(temp);
  try {
    const loader = new DeskPackageLoader({ bundledPackages: [packageDir], store, ...(mail ? { mail } : {}) });
    const discovery = await loader.discover();
    const candidate = discovery.candidates[0];
    if (!candidate) {
      const issue = discovery.issues[0];
      return stopped(skeleton, "refused", issue?.code ?? "no_package", issue?.message ?? "No Desk adapter package was found in the directory.");
    }
    const named = { ...skeleton, packageId: candidate.packageId, adapterId: candidate.adapterId };
    if (candidate.state.state === "unavailable") return stopped(named, "refused", candidate.state.code, candidate.state.message);
    if (!candidate.manifest.setup.authMethods.some(method => method.kind === "local")) {
      const kinds = candidate.manifest.setup.authMethods.map(method => method.kind).join(" and ");
      return stopped(named, "not-run", "authentication_unsupported", `The package declares only ${kinds} authentication. The harness requests no credential, so it ran nothing.`);
    }
    const activated = await loader.activate(candidate.packageId);
    if (!activated.ok) return stopped(named, "refused", activated.error.code, activated.error.message);
    const outcome = await exercise(loader, candidate, temp, named, mail);
    return mail ? await readMailConnections(loader, candidate, temp, mail, outcome) : outcome;
  } finally {
    await engine.close(BACKGROUND_CONTEXT);
  }
}
