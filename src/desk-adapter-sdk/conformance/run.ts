import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { DeskPackageLoader, type DeskPackageCandidate, type DeskTrustedConnectorOptions } from "../../conversations/domain-adapters/package";
import { DeskGenerationStore } from "../../conversations/domain-adapters/package-generation";
import type { ObjectReference } from "../../conversations/domain-adapters/types";
import { probeAction } from "./actions";
import { recordConnector } from "./connectors";
import { listDestinations, probeObservation, probeQuery, schemaIndex, type ProbeEnv } from "./probes";
import { emptyOwnerCalls, overallVerdict, refused, type CapabilityReport, type ConformanceReport, type OwnerCalls } from "./report";
import { ConformanceRefusal, openConformanceRig, SYNTHETIC_CREDENTIAL_HANDLE } from "./rig";

export const CONNECTION_ID = "conformance-connection";

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

export async function exercise(loader: DeskPackageLoader, candidate: DeskPackageCandidate, temp: string, skeleton: Skeleton): Promise<Outcome> {
  const { adapterId, manifest } = candidate;
  const declaration = manifest.declaration;
  const actionIds = declaration.capabilities.filter(capability => capability.kind === "action").map(capability => capability.capabilityId);
  const readIds = declaration.capabilities.filter(capability => capability.kind !== "action").map(capability => capability.capabilityId);
  const registry = loader.registry();
  const capabilities: CapabilityReport[] = [];
  const ownerCalls = emptyOwnerCalls();
  const destinations: ObjectReference[] = [];
  const sample = { schemas: schemaIndex(manifest), destinations, adapterId, connectionId: CONNECTION_ID };
  const groups: (string | undefined)[] = actionIds.length > 0 ? actionIds : [undefined];
  for (const [index, actionId] of groups.entries()) {
    const built = loader.trustedConnector(adapterId, { adapterId, connectionId: CONNECTION_ID }, { authorizeConnection, ...(actionId === undefined ? {} : { actionCapabilityId: actionId }) });
    if (!built.ok) {
      capabilities.push(refused(actionId ?? adapterId, "action", built.error.code, built.error.message));
      continue;
    }
    const plain = built.value.connector;
    if (index === 0) {
      const listed = await listDestinations({ registry, manifest, sample, plain, adapterId, connectionId: CONNECTION_ID });
      destinations.push(...listed.destinations);
      capabilities.push(...listed.reports);
    }
    const { connector, recorded } = recordConnector(plain);
    let rig;
    try {
      rig = await openConformanceRig({
        dir: temp, registry, connector, adapterId, connectionId: CONNECTION_ID, readBindings: manifest.readBindings, readCapabilityIds: readIds,
        writeCapabilityIds: actionId === undefined ? [] : [actionId], writerCapabilityId: actionId ?? plain.support.capabilityId, destinations,
      });
    } catch (error) {
      const code = error instanceof ConformanceRefusal ? error.code : "host_unavailable";
      capabilities.push(refused(actionId ?? adapterId, "action", code, error instanceof Error ? error.message : "The host seam could not open."));
      continue;
    }
    const env: ProbeEnv = { rig, manifest, sample, recorded, plain, adapterId, connectionId: CONNECTION_ID };
    try {
      if (index === 0) {
        for (const binding of manifest.readBindings) {
          if (binding.mode === "query") capabilities.push(await probeQuery(env, binding));
          if (binding.mode === "poll") capabilities.push(await probeObservation(env, binding));
        }
      }
      if (actionId !== undefined) capabilities.push(...await probeAction(env, actionId));
    } finally {
      await rig.close();
      addOwnerCalls(ownerCalls, recorded.ownerCalls);
    }
  }
  return finish({ ...skeleton, actions: actionIds }, capabilities, ownerCalls);
}

export async function executePackage(packageDir: string, temp: string): Promise<Outcome> {
  const skeleton: Skeleton = { packageDir, actions: [], credentialRequests: 0 };
  const { engine, store } = await openConformanceStore(temp);
  try {
    const loader = new DeskPackageLoader({ bundledPackages: [packageDir], store });
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
    return await exercise(loader, candidate, temp, named);
  } finally {
    await engine.close(BACKGROUND_CONTEXT);
  }
}
