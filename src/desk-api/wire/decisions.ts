export type DecisionAction = "ranger.rule" | "ranger.approve" | "ranger.retry" | "ranger.run-now";

export type DecisionOutcomeState = "not-requested" | "pending" | "accepted" | "queued" | "failed";

export interface DecisionOutcome {
  state: DecisionOutcomeState;
  detail: string | null;
  at: number;
}

export interface DeskDecision {
  id: string;
  key: string;
  title: string;
  target: { repo: string; nodeId: string; link: string | null };
  action: DecisionAction;
  text: string | null;
  decidedAt: number;
  outcome: DecisionOutcome;
  withdrawable: false;
  supersededBy: { id: string; decidedAt: number } | null;
}
