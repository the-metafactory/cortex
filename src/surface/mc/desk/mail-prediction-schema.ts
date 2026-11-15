export const PREDICTED_ACTIONS = ["archive", "junk", "trash", "reply", "plan", "todo", "keep"] as const;
export type PredictedAction = (typeof PREDICTED_ACTIONS)[number];

export const SIMILARITY_BASES = ["content", "sender"] as const;
export type SimilarityBasis = (typeof SIMILARITY_BASES)[number];
