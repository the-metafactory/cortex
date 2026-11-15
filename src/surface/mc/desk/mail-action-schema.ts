import { PREDICTED_ACTIONS } from "./mail-prediction-schema";
export { PREDICTED_ACTIONS, type PredictedAction } from "./mail-prediction-schema";
export const MAIL_CORRECTIONS = ["not-bulk", "matters", ...PREDICTED_ACTIONS] as const;
export type MailCorrection = (typeof MAIL_CORRECTIONS)[number];
