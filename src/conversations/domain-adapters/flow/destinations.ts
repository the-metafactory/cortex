import { authorityHash } from "../../authority-records";
import type { QueryPage } from "../reads/query-types";
import type { ObjectReference } from "../types";
import { FLOW_ADAPTER_ID, flowSchemaRef } from "./schema";

export const FLOW_DESTINATIONS_CAPABILITY = "flow.destinations";
export const flowStackRef = (connectionId: string, stack: string): ObjectReference => ({ adapterId: FLOW_ADAPTER_ID, connectionId, objectType: "stack", canonicalId: stack });

export function flowDestinationsPage(connectionId: string, stack: string, at = new Date().toISOString()): QueryPage {
  const ref = flowStackRef(connectionId, stack);
  const value = { label: stack };
  return {
    readVersion: "1.0.0", payload: { items: [value] }, observedAt: at, ordering: "provider",
    snapshot: { kind: "stable", id: authorityHash({ connectionId, stack }) },
    annotations: [{ pointer: "/items/0", ref, schemaRef: flowSchemaRef("flow.stack"), destination: ref, position: 0, evidence: { evidenceId: `flow.stack.${stack}`, revision: authorityHash(value), observedAt: at } }],
  };
}
