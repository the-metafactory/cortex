import type { QuerySource } from "../reads/query-types";
import type { ObjectReference } from "../types";
import { flowSchemaRef } from "./schema";

export type FlowReadCapability = "flow.saved.query" | "flow.saved.read";

export const flowQuerySource = (connectionId: string, destination: ObjectReference, capabilityId: FlowReadCapability, name?: string): QuerySource => ({
  adapterId: "flow",
  connectionId,
  capabilityId,
  inputSchemaRef: flowSchemaRef(`${capabilityId}.input`),
  destinations: [destination],
  input: name === undefined ? { stack: destination } : { ref: { ...destination, objectType: "saved", canonicalId: name } },
});
