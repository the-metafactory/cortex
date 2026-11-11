import type { SavedFlow } from "../../../conversations/saved-flow-contract";

export const FLOW_CARD_PATH = "/api/desk/flows/card";
export const flowCardPath = (ref: string, operation: string): string =>
  `${FLOW_CARD_PATH}?ref=${encodeURIComponent(ref)}&operation=${encodeURIComponent(operation)}`;

export interface FlowReceipt { name: string; sha256: string }

export type FlowSavedList = { enabled: false } | { enabled: true; flows: SavedFlow[] };
export type FlowSavedDefinition =
  | { enabled: false }
  | { enabled: true; state: "available"; name: string; sha256: string; yaml: string }
  | { enabled: true; state: "unavailable" }
  | { enabled: true; state: "withheld" };
export interface FlowCardFacts { name: string; sha256: string; savedAt: string; origin: "conversation" | "cli"; conversationId: string | null }
export type FlowSavedCard =
  | { enabled: false }
  | { enabled: true; state: "unrecorded" }
  | { enabled: true; state: "unavailable"; receipt: FlowReceipt }
  | { enabled: true; state: "withheld"; receipt: FlowReceipt }
  | ({ enabled: true; state: "available"; receipt: FlowReceipt; changed: boolean } & FlowCardFacts);
