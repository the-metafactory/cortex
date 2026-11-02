import type { MailCorrection } from "./mail-actions";
import type { MoveTarget } from "./mail-move";

export const CORRECTION_MOVES: Partial<Record<MailCorrection, MoveTarget>> = { archive: "archive", junk: "junk", trash: "trash" };
