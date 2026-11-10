import { enableConnection, type ConnectionSetupRig } from "../connection-setup-fixtures";
import type { ConnectionView } from "../connection-setup";
import { validateEnvelope } from "../../bus/myelin/envelope-validator";
import type { AdapterDiagnostics } from "./diagnostics";

export interface BusClientStub {
  published: unknown[];
  publish(envelope: unknown): boolean;
}

export const busClient = (): BusClientStub => ({ published: [], publish(envelope: unknown): boolean { if (!validateEnvelope(envelope).ok) return false; this.published.push(envelope); return true; } });

export interface SyntheticDiagnostics {
  diagnostics: AdapterDiagnostics;
  available: ConnectionView;
  stale: ConnectionView;
  fenced: ConnectionView;
  unavailable: ConnectionView;
  fenceTarget: { adapterId: string; connectionId: string; capabilityId: string };
  recent: string;
  older: string;
}

export async function syntheticDiagnostics(rig: ConnectionSetupRig): Promise<SyntheticDiagnostics> {
  const diagnostics = rig.host().adapterDiagnostics();
  const available = await enableConnection(rig);
  const stale = await enableConnection(rig);
  const fenced = await enableConnection(rig);
  const unavailable = await enableConnection(rig);
  const recent = new Date(Date.now() - 60_000).toISOString();
  const older = new Date(Date.now() - 3_600_000).toISOString();
  await diagnostics.record({ event: "desk.adapter.operation_state", adapterId: available.packageId, connectionId: available.connectionId, capabilityId: "example.object.read", state: "succeeded", at: recent });
  await diagnostics.record({ event: "desk.adapter.operation_state", adapterId: stale.packageId, connectionId: stale.connectionId, capabilityId: "example.object.read", state: "succeeded", at: older });
  await diagnostics.record({ event: "desk.adapter.query_refused", adapterId: available.packageId, connectionId: available.connectionId, capabilityId: "example.object.read", state: "refused", errorCode: "denied" });
  await diagnostics.record({ event: "desk.adapter.query_partial", adapterId: available.packageId, connectionId: available.connectionId, capabilityId: "example.object.read", state: "partial", errorCode: "budget_exhausted" });
  const fenceTarget = { adapterId: fenced.packageId, connectionId: fenced.connectionId, capabilityId: "example.object.create" };
  await rig.host().lifecycleFences().trigger({ kind: "duplicate_owner_object", target: fenceTarget });
  const off = await rig.http("local", "POST", `/api/desk/connections/${unavailable.connectionId}/disable`, { expectedRevision: unavailable.revision });
  if (off.status !== 200) throw new Error(`synthetic disable failed with HTTP ${off.status}`);
  return { diagnostics, available, stale, fenced, unavailable, fenceTarget, recent, older };
}
