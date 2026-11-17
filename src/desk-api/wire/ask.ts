import type { ParserRouting } from "./parser-routing";
import type { CapabilityRefusal } from "./routines";
import type { DeskPhrase } from "./phrases";

export const ASK_KINDS = ["reminder", "note", "capture", "task", "goal", "calendar", "routine", "conversation", "row"] as const;

export type AskKind = (typeof ASK_KINDS)[number];

export interface DeskProposal {
  kind: AskKind;
  label: string;
  fields: Record<string, unknown>;
  at?: number;
  end?: number;
  problem?: string;
  unwritable?: true;
  via: "parser" | "rules";
  automatic?: boolean;
  routing?: Extract<ParserRouting, { kind: "selected" }>;
  alternative?: ConversationOffer;
  capabilities?: CapabilityRefusal;
}

export interface ConversationOffer {
  kind: "conversation";
  label: string;
  fields: { text: string; area?: string };
}

/** Added to the body of an ask that answered or failed through a routed parser. The English `error` of a failure stays through 1.x. */
export interface DeskAskRouting {
  routingPhrase?: DeskPhrase;
}
