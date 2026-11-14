export const PREDICTED_ACTIONS = ["archive", "junk", "trash", "reply", "plan", "todo", "keep"] as const;
export type PredictedAction = (typeof PREDICTED_ACTIONS)[number];
export const MAIL_CORRECTIONS = ["not-bulk", "matters", ...PREDICTED_ACTIONS] as const;
export type MailCorrection = (typeof MAIL_CORRECTIONS)[number];
